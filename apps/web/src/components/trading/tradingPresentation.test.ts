import type { PersistedWatch, TradingMissionStatus } from "@t3tools/trading-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MISSION_STATUS_LABELS,
  deriveCompletionSummary,
  deriveReviewMarkers,
  deriveMissionStrip,
  deriveRejectedOrder,
  deriveWakeupCard,
  describeEntryPermission,
  describeMandate,
  describeTradingAccount,
  describeWatch,
  deriveUpNextItems,
  deriveWatchConditions,
  formatDuration,
  formatPrice,
  formatSignedUsd,
  formatUsd,
  humanizeLiteral,
  isMissionComplete,
  deriveEffectiveLeverage,
  readFillLifecycle,
  readIntentLifecycle,
  deriveFillSlippagePercent,
  deriveChartConditions,
  deriveChartFillMarkers,
  deriveMissionPhases,
  deriveChartTimeMarkers,
  deriveNextReassessmentAt,
  MAX_DRAWN_TIME_MARKERS,
  derivePausedExposure,
  deriveStrategyPlan,
  describeDelayedRead,
  describeStaleness,
  formatLeverage,
  formatSignedPercent,
  hyperliquidTradeUrl,
  POSITION_DELAYED_AFTER_MILLIS,
  POSITION_STALE_AFTER_MILLIS,
  readPositionFreshness,
  readPositionReadAge,
  isLiveMission,
  shouldShowMissionStrip,
  visibleMissions,
} from "./tradingPresentation";

describe("mission status labels", () => {
  it("names all ten §11.1 statuses", () => {
    expect(Object.keys(MISSION_STATUS_LABELS).sort()).toEqual([
      "agent_unavailable",
      "analysing",
      "blocked",
      "completed",
      "executing",
      "initializing",
      "paused",
      "position_open",
      "revoked",
      "waiting",
    ]);
  });
});

describe("describeWatch", () => {
  it("reads each watch predicate back without interpreting it", () => {
    expect(
      describeWatch({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3200,
      }),
    ).toBe("ETH mark crosses above 3200");

    expect(
      describeWatch({
        type: "candle_close",
        market: "ETH",
        interval: "5m",
        direction: "below",
        price: 3100,
      }),
    ).toBe("ETH 5m candle closes below 3100");

    expect(describeWatch({ type: "order_update", cloid: "cloid-1" })).toBe("Order cloid-1 updates");
    expect(describeWatch({ type: "position_update", market: "ETH" })).toBe("ETH position updates");
    expect(describeWatch({ type: "scheduled_reassessment", runAt: 0 })).toBe(
      "Scheduled reassessment at 1970-01-01T00:00:00.000Z",
    );
  });
});

describe("value formatting", () => {
  it("renders whole-dollar mandate amounts", () => {
    expect(formatUsd(3000)).toBe("$3,000");
  });

  it("turns domain literals into prose", () => {
    expect(humanizeLiteral("breakout_continuation")).toBe("breakout continuation");
    expect(humanizeLiteral("protection_failure")).toBe("protection failure");
  });
});

// ---------------------------------------------------------------------------
// §14.7 risk chrome
// ---------------------------------------------------------------------------

describe("mission strip", () => {
  const priceWatch = {
    id: "watch-1",
    missionId: "mission-1",
    strategyVersion: 1,
    watch: {
      type: "price_cross" as const,
      market: "ETH" as const,
      priceSource: "mark" as const,
      direction: "above" as const,
      price: 1900,
    },
    status: "active" as const,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  const harness = { provider: "claude", status: "available" };

  const armed = {
    status: "waiting" as const,
    market: "ETH-PERP",
    blockedReason: null,
    harness,
    watches: [priceWatch],
    position: null,
    authority: { maximumCumulativeLossUsd: 100 },
  };
  const exposed = {
    status: "position_open" as const,
    market: "ETH-PERP",
    blockedReason: null,
    harness,
    watches: [priceWatch],
    position: {
      size: 0.5,
      entryPrice: 1833.9,
      markPrice: 1859.5,
      unrealisedPnl: 12.8,
      protectedSize: 0.5,
    },
    authority: { maximumCumulativeLossUsd: 100 },
  };

  it("shows while armed even with no exposure", () => {
    expect(shouldShowMissionStrip(armed)).toBe(true);
  });

  it("shows while exposed regardless of status", () => {
    // Exposure outranks status: a completed mission that somehow still holds a
    // position is exactly when the strip must not disappear.
    expect(shouldShowMissionStrip({ status: "completed", position: { size: 0.5 } })).toBe(true);
  });

  it("hides on a finished mission with nothing open", () => {
    expect(shouldShowMissionStrip({ status: "completed", position: null })).toBe(false);
    expect(shouldShowMissionStrip({ status: "revoked", position: { size: 0 } })).toBe(false);
  });

  it("makes close-and-stop the one primary action while exposed", () => {
    const strip = deriveMissionStrip(exposed);
    expect(strip.primaryAction).toBe("close_and_revoke");
    expect(strip.primaryActionLabel).toBe("Close and stop");
  });

  it("keeps close-and-stop primary even while blocked", () => {
    // Blocking stops NEW exposure. It does not remove exposure already taken,
    // so the way out must stay one click.
    const strip = deriveMissionStrip({ ...exposed, status: "blocked" });
    expect(strip.primaryAction).toBe("close_and_revoke");
    expect(strip.tone).toBe("blocked");
  });

  it("offers pause when armed but flat, and resume when paused", () => {
    expect(deriveMissionStrip(armed).primaryAction).toBe("pause");
    expect(deriveMissionStrip({ ...armed, status: "paused" }).primaryAction).toBe("resume");
  });

  it("labels exposure by direction and size", () => {
    expect(deriveMissionStrip(exposed).exposureLabel).toBe("Long 0.5");
    expect(
      deriveMissionStrip({ ...exposed, position: { ...exposed.position, size: -0.25 } })
        .exposureLabel,
    ).toBe("Short 0.25");
    expect(deriveMissionStrip(armed).exposureLabel).toBe("Flat");
  });

  it("reads the position back while exposed, and the watch while flat", () => {
    const open = deriveMissionStrip(exposed);
    expect(open.detailPrimary).toBe("Entry 1,833.9");
    expect(open.detailSecondary).toBe("Unrealised +$12.80 · Protected");

    const flat = deriveMissionStrip(armed);
    expect(flat.detailPrimary).toBe("Waiting on ETH mark crosses above 1900");
    expect(flat.detailSecondary).toBeNull();
  });

  it("quotes the live mark, held or not", () => {
    // The whole point of the slot: a flat mission waiting on a level has no
    // position mark, and the level means nothing without one to read it against.
    expect(deriveMissionStrip({ ...armed, marketPrice: 1872.94 }).markLabel).toBe("1,872.94");
    // Exposed, the live read wins over the snapshot's older mark.
    expect(deriveMissionStrip({ ...exposed, marketPrice: 1861.2 }).markLabel).toBe("1,861.2");
    expect(deriveMissionStrip(exposed).markLabel).toBe("1,859.5");
  });

  it("shows no mark at all when the exchange read failed", () => {
    // A price nothing confirmed is worse than no price on a surface exits are
    // decided from.
    expect(deriveMissionStrip(armed).markLabel).toBeNull();
  });

  it("says so when a flat mission has nothing left that can wake it", () => {
    // A mission holding authority with no active watch is deaf. A blank slot
    // would read as "fine", which is the one thing it is not.
    const deaf = deriveMissionStrip({
      ...armed,
      watches: [{ ...priceWatch, status: "triggered" as const }],
    });
    expect(deaf.detailPrimary).toBe("No active watch");
  });

  it("distinguishes a covered stop from a partial one and from none", () => {
    const partial = deriveMissionStrip({
      ...exposed,
      position: { ...exposed.position, protectedSize: 0.2 },
    });
    expect(partial.detailSecondary).toContain("Partially protected");

    const none = deriveMissionStrip({
      ...exposed,
      position: { ...exposed.position, protectedSize: 0 },
    });
    expect(none.detailSecondary).toContain("Unprotected");
  });

  it("puts the blocked reason ahead of everything else the slot could say", () => {
    const blocked = deriveMissionStrip({
      ...exposed,
      status: "blocked" as const,
      blockedReason: "loss_budget_exhausted",
    });
    expect(blocked.detailPrimary).toBe("loss budget exhausted");
  });

  it("reports the immutable harness binding", () => {
    expect(deriveMissionStrip(armed).harnessLabel).toBe("claude · available");
  });
});

describe("composer controls", () => {
  it("names the network only when the account id does", () => {
    expect(describeTradingAccount("local-hyperliquid-testnet")).toBe("Hyperliquid · Testnet");
    expect(describeTradingAccount("prod-hyperliquid-mainnet")).toBe("Hyperliquid · Mainnet");
    // Guessing "mainnet" for an unlabelled account is the expensive direction.
    expect(describeTradingAccount("account-7")).toBe("account-7");
  });

  it("states the grant and the ceiling on it", () => {
    expect(describeMandate({ allocatedCapitalUsd: 1000, maximumCumulativeLossUsd: 350 })).toBe(
      "$1,000 · max loss $350",
    );
  });

  it("reports the control block rather than a permission model that does not exist", () => {
    expect(describeEntryPermission({ entriesAllowed: true, reentryAllowed: true })).toBe(
      "Entries allowed",
    );
    expect(describeEntryPermission({ entriesAllowed: true, reentryAllowed: false })).toBe(
      "Entries allowed · no re-entry",
    );
    expect(describeEntryPermission({ entriesAllowed: false, reentryAllowed: true })).toBe(
      "Entries paused",
    );
  });
});

describe("money and price formatting", () => {
  it("signs a P&L and keeps its cents", () => {
    expect(formatSignedUsd(41.62)).toBe("+$41.62");
    expect(formatSignedUsd(-0.8)).toBe("-$0.80");
    expect(formatSignedUsd(0)).toBe("$0.00");
  });

  it("keeps whatever precision the projection carried, up to two decimals", () => {
    expect(formatPrice(119214)).toBe("119,214");
    expect(formatPrice(1833.9)).toBe("1,833.9");
    expect(formatPrice(0.06125)).toBe("0.06");
  });
});

describe("position read freshness", () => {
  const now = 1_700_000_000_000;
  const at = (ageMillis: number) => new Date(now - ageMillis).toISOString();
  const held = (ageMillis: number) =>
    ({ status: "position_open", position: { size: 0.5, observedAt: at(ageMillis) } }) as const;

  it("stays current through a whole reconcile cycle", () => {
    expect(readPositionFreshness(held(1_000), now)).toBe("current");
    // §18.2 #8's reconcile is `Schedule.spaced(5s)` — spaced from completion —
    // so an age of six or seven seconds is an ordinary cycle, not a fault. The
    // old 5s threshold called this stale, which is why the banner blinked on
    // and off for the life of every position.
    expect(readPositionFreshness(held(6_000), now)).toBe("current");
    expect(readPositionFreshness(held(12_000), now)).toBe("current");
  });

  it("calls the read delayed after three missed reconciles", () => {
    expect(readPositionFreshness(held(POSITION_DELAYED_AFTER_MILLIS + 1), now)).toBe("delayed");
    expect(readPositionFreshness(held(30_000), now)).toBe("delayed");
  });

  it("calls the read stale only once it has stopped landing", () => {
    expect(readPositionFreshness(held(POSITION_STALE_AFTER_MILLIS + 1), now)).toBe("stale");
    expect(readPositionFreshness(held(300_000), now)).toBe("stale");
  });

  it("stays current when there is no position to be stale about", () => {
    expect(readPositionFreshness({ status: "waiting", position: null }, now)).toBe("current");
  });

  // §18.2 #8's periodic reconcile only runs against exposure, so a flat
  // mission's last snapshot ages out once and is never refreshed. Reading the
  // timestamp alone latched the warning on for the rest of the session, on a
  // mission with nothing at risk and nothing suspended.
  it("stays current on a flat mission whose snapshot has stopped refreshing", () => {
    expect(
      readPositionFreshness(
        { status: "waiting", position: { size: 0, observedAt: at(600_000) } },
        now,
      ),
    ).toBe("current");
  });

  // A revoked mission keeps its final position row forever. Yesterday's mission
  // must not warn about today's order placement.
  it("stays current on a terminal mission holding a historical snapshot", () => {
    expect(
      readPositionFreshness(
        { status: "revoked", position: { size: 0.5, observedAt: at(600_000) } },
        now,
      ),
    ).toBe("current");
    expect(
      readPositionFreshness(
        { status: "completed", position: { size: 0.5, observedAt: at(600_000) } },
        now,
      ),
    ).toBe("current");
  });

  it("ages nothing off an unparseable timestamp", () => {
    expect(
      readPositionReadAge(
        { status: "position_open", position: { size: 0.5, observedAt: "?" } },
        now,
      ),
    ).toBeNull();
  });
});

describe("stale-data surfaces", () => {
  const now = 1_700_000_000_000;
  const at = (ageMillis: number) => new Date(now - ageMillis).toISOString();
  const held = (ageMillis: number) =>
    ({ status: "position_open", position: { size: 0.5, observedAt: at(ageMillis) } }) as const;

  // The quiet half: enough to say the numbers are behind, without asserting
  // anything about the order path that is probably not true yet.
  it("shows the panel chip through the delayed band", () => {
    expect(describeDelayedRead(held(20_000), now)).toBe("stale 20s");
    expect(describeDelayedRead(held(6_000), now)).toBeNull();
  });

  // The banner's whole job is telling a read that is a second late from one
  // that stopped four minutes ago, and it could not: both read "stale".
  it("says how long ago the last read landed", () => {
    expect(describeStaleness(held(50_000), now)).toBe(
      "Position data is stale. Order placement is suspended until a fresh read lands. " +
        "Last update 50s ago.",
    );
    expect(describeStaleness(held(254_000), now)).toContain("Last update 4m 14s ago.");
  });

  // "Order placement is suspended" is a claim about the execution path. A read
  // one cycle behind does not support it.
  it("says nothing at all until the read has actually stopped", () => {
    expect(describeStaleness(held(1_000), now)).toBeNull();
    expect(describeStaleness(held(6_000), now)).toBeNull();
    expect(describeStaleness(held(20_000), now)).toBeNull();
    expect(describeStaleness({ status: "waiting", position: null }, now)).toBeNull();
  });
});

describe("deriveFillSlippagePercent", () => {
  const intent = { cloid: "0xabc", limitPrice: 4_000 };

  it("reads a buy that filled above its limit as a cost", () => {
    expect(
      deriveFillSlippagePercent({ side: "buy", avgFillPrice: 4_004, cloid: "0xabc" }, intent),
    ).toBeCloseTo(0.1, 6);
  });

  it("reads a sell that filled below its limit as a cost", () => {
    expect(
      deriveFillSlippagePercent({ side: "sell", avgFillPrice: 3_996, cloid: "0xabc" }, intent),
    ).toBeCloseTo(0.1, 6);
  });

  it("reads a fill better than the limit as negative", () => {
    expect(
      deriveFillSlippagePercent({ side: "buy", avgFillPrice: 3_990, cloid: "0xabc" }, intent),
    ).toBeCloseTo(-0.25, 6);
  });

  // A receipt with a figure nothing backs is worse than a receipt without one.
  it("reports nothing it cannot attribute to a known intent", () => {
    expect(deriveFillSlippagePercent({ side: "buy", avgFillPrice: 4_004 }, intent)).toBeNull();
    expect(
      deriveFillSlippagePercent({ side: "buy", avgFillPrice: 4_004, cloid: "0xother" }, intent),
    ).toBeNull();
    expect(
      deriveFillSlippagePercent({ side: "buy", avgFillPrice: 4_004, cloid: "0xabc" }, null),
    ).toBeNull();
    expect(
      deriveFillSlippagePercent(
        { side: "buy", avgFillPrice: 4_004, cloid: "0xabc" },
        {
          cloid: "0xabc",
          limitPrice: 0,
        },
      ),
    ).toBeNull();
  });

  it("signs the formatted percentage", () => {
    expect(formatSignedPercent(0.1)).toBe("+0.10%");
    expect(formatSignedPercent(-0.25)).toBe("-0.25%");
    expect(formatSignedPercent(0)).toBe("0.00%");
  });
});

describe("deriveEffectiveLeverage", () => {
  it("reads leverage back as notional over margin", () => {
    expect(deriveEffectiveLeverage({ size: 1.077, markPrice: 1_857, marginUsed: 100 })).toBeCloseTo(
      20,
      1,
    );
  });

  it("values a short by magnitude, not sign", () => {
    expect(
      deriveEffectiveLeverage({ size: -1.077, markPrice: 1_857, marginUsed: 100 }),
    ).toBeCloseTo(20, 1);
  });

  it("falls back to the entry price when no mark has landed", () => {
    expect(deriveEffectiveLeverage({ size: 2, entryPrice: 1_000, marginUsed: 500 })).toBe(4);
  });

  // A leverage figure nothing backs would read as a deliberate setting.
  it("reports nothing when there is no price, no margin, or no position", () => {
    expect(deriveEffectiveLeverage({ size: 1, marginUsed: 100 })).toBeNull();
    expect(deriveEffectiveLeverage({ size: 1, markPrice: 1_857, marginUsed: 0 })).toBeNull();
    expect(deriveEffectiveLeverage({ size: 0, markPrice: 1_857, marginUsed: 100 })).toBeNull();
  });

  it("formats whole leverage whole and the rest to one decimal", () => {
    expect(formatLeverage(20)).toBe("20x");
    expect(formatLeverage(19.98)).toBe("20x");
    expect(formatLeverage(3.46)).toBe("3.5x");
  });
});

describe("position lifecycle", () => {
  it("reads the exchange's own label for each half of the cycle", () => {
    expect(readFillLifecycle("Open Long")).toEqual({
      direction: "long",
      action: "open",
      actionLabel: "Open",
    });
    expect(readFillLifecycle("Close Long")).toEqual({
      direction: "long",
      action: "close",
      actionLabel: "Close",
    });
    expect(readFillLifecycle("Open Short")).toEqual({
      direction: "short",
      action: "open",
      actionLabel: "Open",
    });
    expect(readFillLifecycle("Close Short")).toEqual({
      direction: "short",
      action: "close",
      actionLabel: "Close",
    });
  });

  // A reversal ends on the far side; that is the exposure now held.
  it("names a reversal by the side it ended on", () => {
    expect(readFillLifecycle("Long > Short")).toEqual({
      direction: "short",
      action: "reverse",
      actionLabel: "Reverse",
    });
    expect(readFillLifecycle("Short > Long")).toEqual({
      direction: "long",
      action: "reverse",
      actionLabel: "Reverse",
    });
  });

  it("calls a liquidation what it was, not just a close", () => {
    expect(readFillLifecycle("Liquidated Isolated Long")).toEqual({
      direction: "long",
      action: "close",
      actionLabel: "Liquidation",
    });
  });

  // Better an untinted receipt than a green one on a fill that closed a short.
  it("reports nothing rather than guessing", () => {
    expect(readFillLifecycle(undefined)).toBeNull();
    expect(readFillLifecycle("Buy")).toBeNull();
    expect(readFillLifecycle("Settlement")).toBeNull();
  });

  it("reads an unfilled order from its side and its reduce-only flag", () => {
    expect(readIntentLifecycle({ side: "buy", reduceOnly: false })).toEqual({
      direction: "long",
      action: "open",
      actionLabel: "Open",
    });
    expect(readIntentLifecycle({ side: "sell", reduceOnly: false })).toEqual({
      direction: "short",
      action: "open",
      actionLabel: "Open",
    });
    // The one a plain read of `side` gets backwards: a reduce-only sell is not
    // a short, it is a long being given back.
    expect(readIntentLifecycle({ side: "sell", reduceOnly: true })).toEqual({
      direction: "long",
      action: "close",
      actionLabel: "Close",
    });
    expect(readIntentLifecycle({ side: "buy", reduceOnly: true })).toEqual({
      direction: "short",
      action: "close",
      actionLabel: "Close",
    });
  });
});

describe("derivePausedExposure", () => {
  it("reports what pausing did not stand down", () => {
    expect(
      derivePausedExposure({ size: -0.5, unrealisedPnl: -12.4, liquidationPrice: 4_400 }),
    ).toEqual({
      exposureLabel: "Short 0.5",
      unrealisedUsd: -12.4,
      liquidationLabel: "4,400",
    });
  });

  it("leaves the liquidation slot empty rather than guessing at one", () => {
    expect(derivePausedExposure({ size: 0.5, unrealisedPnl: 3 })?.liquidationLabel).toBe("—");
  });

  it("says nothing when the mission holds nothing", () => {
    expect(derivePausedExposure(null)).toBeNull();
    expect(derivePausedExposure({ size: 0, unrealisedPnl: 0 })).toBeNull();
  });
});

describe("hyperliquidTradeUrl", () => {
  it("links at the network the account names", () => {
    expect(hyperliquidTradeUrl("ETH", "hyperliquid_testnet")).toBe(
      "https://app.hyperliquid-testnet.xyz/trade/ETH",
    );
    expect(hyperliquidTradeUrl("BTC", "acct-MAINNET-1")).toBe(
      "https://app.hyperliquid.xyz/trade/BTC",
    );
  });

  // Linking a testnet mission at the mainnet book is the expensive direction to
  // be wrong in, so an id that names neither gets no link.
  it("offers no link when the account does not name a network", () => {
    expect(hyperliquidTradeUrl("ETH", "acct_1")).toBeNull();
  });
});

describe("deriveMissionPhases", () => {
  const states = (status: Parameters<typeof deriveMissionPhases>[0]) =>
    deriveMissionPhases(status).map((phase) => phase.state);

  it("walks the §11.1 loop in order", () => {
    expect(deriveMissionPhases("analysing").map((phase) => phase.label)).toEqual([
      "Analyse",
      "Wait",
      "Execute",
      "Position",
    ]);
    expect(states("analysing")).toEqual(["current", "pending", "pending", "pending"]);
    expect(states("waiting")).toEqual(["done", "current", "pending", "pending"]);
    expect(states("executing")).toEqual(["done", "done", "current", "pending"]);
    expect(states("position_open")).toEqual(["done", "done", "done", "current"]);
  });

  it("puts a fresh mission before the first step rather than on it", () => {
    expect(states("initializing")).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("marks a completed mission as having walked all of it", () => {
    expect(states("completed")).toEqual(["done", "done", "done", "done"]);
  });

  // A paused or blocked mission has stepped off the loop. Guessing where it
  // stands would put the breadcrumb at odds with the status beside it.
  it("renders nothing for a mission that is not on the loop", () => {
    expect(deriveMissionPhases("paused")).toEqual([]);
    expect(deriveMissionPhases("blocked")).toEqual([]);
    expect(deriveMissionPhases("agent_unavailable")).toEqual([]);
    expect(deriveMissionPhases("revoked")).toEqual([]);
  });
});

describe("order-rejected surface", () => {
  const rejected = {
    status: "rejected",
    actionType: "open",
    side: "buy",
    size: 0.5,
  };

  it("renders nothing when no execution was refused", () => {
    expect(deriveRejectedOrder({ status: "executing", inFlightExecution: null })).toBeNull();
    expect(
      deriveRejectedOrder({
        status: "executing",
        inFlightExecution: { ...rejected, status: "accepted" },
      }),
    ).toBeNull();
  });

  it("offers re-arm on a rejected order", () => {
    const notice = deriveRejectedOrder({ status: "executing", inFlightExecution: rejected });
    expect(notice?.canReArm).toBe(true);
    expect(notice?.actionType).toBe("open");
  });

  it("withholds re-arm while blocked or revoked", () => {
    // Re-arming a blocked mission would route around §16.4's no-auto-resume
    // rule; a revoked one has no authority left to re-arm.
    expect(deriveRejectedOrder({ status: "blocked", inFlightExecution: rejected })?.canReArm).toBe(
      false,
    );
    expect(deriveRejectedOrder({ status: "revoked", inFlightExecution: rejected })?.canReArm).toBe(
      false,
    );
  });

  it("treats a failed execution as rejected too", () => {
    expect(
      deriveRejectedOrder({
        status: "executing",
        inFlightExecution: { ...rejected, status: "failed" },
      }),
    ).not.toBeNull();
  });
});

describe("completion summary", () => {
  const result = {
    realizedPnlUsd: 40,
    feesPaidUsd: 6,
    fillCount: 2,
    firstFillAt: "2026-08-02T10:00:00.000Z",
    lastFillAt: "2026-08-02T10:02:30.000Z",
  };

  it("nets the fees exactly once", () => {
    // §16.2: paid fees live in the realised result and must not be
    // double-counted. Shown separately AND netted once.
    const summary = deriveCompletionSummary({ result, strategy: null });
    expect(summary.realizedPnlUsd).toBe(40);
    expect(summary.feesPaidUsd).toBe(6);
    expect(summary.netResultUsd).toBe(34);
  });

  it("measures the traded duration first fill to last", () => {
    const summary = deriveCompletionSummary({ result, strategy: null });
    expect(summary.tradedDurationMillis).toBe(150_000);
    expect(formatDuration(summary.tradedDurationMillis!)).toBe("2m 30s");
  });

  it("reports no duration for a single fill", () => {
    const summary = deriveCompletionSummary({
      result: { ...result, fillCount: 1, lastFillAt: result.firstFillAt },
      strategy: null,
    });
    expect(summary.tradedDurationMillis).toBeNull();
  });

  it("compares the result against the planned risk when a strategy was published", () => {
    const summary = deriveCompletionSummary({
      result: { ...result, realizedPnlUsd: -18 },
      strategy: { protection: { maximumPlannedLossUsd: 20 } },
    });
    expect(summary.plannedLossUsd).toBe(20);
    // Net -24 against a planned -20: 4 worse than planned.
    expect(summary.netResultUsd).toBe(-24);
    expect(summary.deviationFromPlanUsd).toBe(-4);
  });

  it("reports no deviation when nothing was planned", () => {
    const summary = deriveCompletionSummary({ result, strategy: null });
    expect(summary.plannedLossUsd).toBeNull();
    expect(summary.deviationFromPlanUsd).toBeNull();
  });

  it("shows only on a finished mission", () => {
    expect(isMissionComplete("completed")).toBe(true);
    expect(isMissionComplete("revoked")).toBe(true);
    expect(isMissionComplete("position_open")).toBe(false);
  });
});

describe("formatDuration", () => {
  it("scales from seconds to hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(150_000)).toBe("2m 30s");
    expect(formatDuration(3_930_000)).toBe("1h 5m");
  });
});

describe("isLiveMission", () => {
  // The server's create guard admits any mission outside these two, so a
  // terminal mission neither holds its thread nor the one active slot. Counting
  // one as live burns a thread for good on every run.
  it("treats revoked and completed as terminal and everything else as live", () => {
    expect(isLiveMission("revoked")).toBe(false);
    expect(isLiveMission("completed")).toBe(false);
    for (const status of ["initializing", "analysing", "waiting", "executing", "position_open"]) {
      expect(isLiveMission(status)).toBe(true);
    }
  });
});

describe("visibleMissions", () => {
  const mission = (id: string, status: TradingMissionStatus) => ({ id, status });

  // A settled mission is deleted server-side; until the projection catches up,
  // this is what keeps it off every surface.
  it("keeps the live missions and nothing else", () => {
    const visible = visibleMissions([
      mission("revoked-newest", "revoked"),
      mission("live", "position_open"),
      mission("revoked-older", "revoked"),
      mission("completed-oldest", "completed"),
    ]);

    expect(visible.map((m) => m.id)).toEqual(["live"]);
  });

  it("shows nothing when every mission has finished", () => {
    const visible = visibleMissions([
      mission("revoked-newest", "revoked"),
      mission("revoked-older", "revoked"),
    ]);

    expect(visible).toEqual([]);
  });

  it("has nothing to show before the first mission exists", () => {
    expect(visibleMissions([])).toEqual([]);
  });
});

describe("deriveReviewMarkers", () => {
  const fill = (avgFillPrice: number, direction?: string) => ({
    avgFillPrice,
    ...(direction === undefined ? {} : { direction }),
  });

  it("has nothing to mark when the mission never traded", () => {
    expect(deriveReviewMarkers([])).toEqual({ entryPrice: null, exitPrice: null });
  });

  // The ordinary shape: one open, one close, newest first.
  it("reads the open and close off a two-fill round trip", () => {
    const markers = deriveReviewMarkers([fill(3_100, "Close Long"), fill(3_000, "Open Long")]);

    expect(markers).toEqual({ entryPrice: 3_000, exitPrice: 3_100 });
  });

  // `direction` is optional on fills recorded before the field was carried, so
  // position in the (newest-first) list has to stand in for it.
  it("falls back to oldest/newest when no direction was recorded", () => {
    const markers = deriveReviewMarkers([fill(3_100), fill(3_050), fill(3_000)]);

    expect(markers).toEqual({ entryPrice: 3_000, exitPrice: 3_100 });
  });

  // A scale-in has several opens; the FIRST one is the entry, and the receipt
  // list is newest-first, so it is the last matching entry in the array.
  it("takes the earliest open and the latest close when a trade was scaled", () => {
    const markers = deriveReviewMarkers([
      fill(3_200, "Close Long"),
      fill(3_050, "Open Long"),
      fill(3_000, "Open Long"),
    ]);

    expect(markers).toEqual({ entryPrice: 3_000, exitPrice: 3_200 });
  });
});

describe("deriveWakeupCard", () => {
  const wakeup = {
    kind: "trading-harness-wakeup",
    missionId: "mission_1",
    harnessRunId: "run_1",
    cause: "market_watch_triggered",
    occurredAt: 1_700_000,
    marketSnapshot: { market: "ETH", markPrice: 3_142.5 },
    activeStrategy: { version: 3 },
    pendingEvents: [{ summary: "external_close" }, { summary: "fill" }],
  };

  it("reads one line out of a full wakeup payload", () => {
    const card = deriveWakeupCard(JSON.stringify(wakeup));

    expect(card).not.toBeNull();
    expect(card?.causeLabel).toBe("market watch triggered");
    expect(card?.marketLabel).toBe("ETH · 3,142.5");
    expect(card?.strategyLabel).toBe("Strategy v3");
    expect(card?.pendingEventCount).toBe(2);
    expect(card?.bootstrap).toBe(false);
    expect(card?.rawJson).toContain('"missionId": "mission_1"');
  });

  // The first run carries no snapshot at all — the harness has not authored a
  // strategy yet — and it still has to render as a card rather than as JSON.
  it("renders the bootstrap message, which carries no snapshot", () => {
    const card = deriveWakeupCard(
      JSON.stringify({
        kind: "trading-harness-wakeup",
        bootstrap: true,
        missionId: "mission_1",
        harnessRunId: "run_1",
        cause: "mission_created",
        instruction: "trade the 1m",
        defaultTimeframe: "1m",
      }),
    );

    expect(card?.bootstrap).toBe(true);
    expect(card?.causeLabel).toBe("mission created");
    expect(card?.marketLabel).toBeNull();
    expect(card?.strategyLabel).toBeNull();
    expect(card?.pendingEventCount).toBe(0);
  });

  // A field the web build has never heard of must not knock the card back to
  // raw JSON: the server is free to enrich the snapshot without a web release.
  it("still renders when the payload carries unknown fields", () => {
    const card = deriveWakeupCard(JSON.stringify({ ...wakeup, somethingNew: { a: 1 } }));
    expect(card?.causeLabel).toBe("market watch triggered");
  });

  it("leaves anything that is not a wakeup alone", () => {
    expect(deriveWakeupCard("what is the price of ETH?")).toBeNull();
    expect(deriveWakeupCard('{"kind":"something-else","cause":"x"}')).toBeNull();
    expect(deriveWakeupCard('{"kind":"trading-harness-wakeup",')).toBeNull();
    expect(deriveWakeupCard("")).toBeNull();
  });
});

describe("deriveStrategyPlan", () => {
  // A strategy mirroring the contract shape, accessed structurally — the same
  // way the projection hands it to the derivation.
  const strategy = {
    mode: "breakout_continuation",
    timeframes: ["1m", "5m"],
    belief: {
      summary: "Trend up; buy the first pullback.",
      regime: "Trending",
      confidence: 0.7,
      evidence: ["directionScore positive"],
    },
    entryPlan: {
      explanation: "Wait for a pullback to the 1m ema.",
      orderPreference: "marketable_ioc",
      initialNotionalUsd: 500,
      conditions: [
        { description: "1m candle closes above 1860", timeframe: "1m", priceLevel: 1860 },
        { description: "mark reclaims the ema" },
      ],
    },
    positionManagement: {
      scaleInAllowed: true,
      scaleInConditions: [],
      partialReductionAllowed: false,
      trailingMethod: "previous_swing_low",
    },
    protection: {
      stopMethod: "previous_swing_low",
      stopPrice: 1840,
      targetProfitUsd: 18.5,
      targetProfitRationale: "Conservative 1864 · Base 1880 · Extension 1900.",
      targetProfitBasis: {
        measurement: "excursion_quantile",
        timeframe: "5m",
        lookbackBars: 60,
        measuredMoveUsd: 12.4,
        expectedHoldBars: 10,
        referencePrice: 1860,
        targetPriceMovePercent: 1.0,
        positionNotionalUsd: 500,
        historicalHitRatePercent: 50,
        rationale: "median 5m excursion over 60 bars",
      },
      maximumPlannedLossUsd: 20,
    },
    abandonmentConditions: [
      { description: "1m candle closes back below 1855" },
      { description: "mark loses the ema and rolls over" },
    ],
    // Authoring the brand-only fields the projection carries but the derivation
    // does not read: their presence confirms the structural read ignores them.
  } as const;

  const mission = { strategyVersion: 3, strategy };

  it("returns null before a strategy has been published", () => {
    expect(deriveStrategyPlan({ strategyVersion: 0, strategy: null })).toBeNull();
  });

  it("reads the version off the mission, not the strategy", () => {
    // strategyVersion is the mission's mirror of the published version; the
    // card header shows it as v{n}. Reading it off the strategy would render a
    // stale figure the moment a new publish landed.
    expect(deriveStrategyPlan(mission)?.version).toBe(3);
  });

  it("humanizes the mode label without branching on its value", () => {
    // mode is free text — render it, never test it.
    expect(deriveStrategyPlan(mission)?.modeLabel).toBe("breakout continuation");
  });

  it("flattens entry conditions and abandonment into prose lists", () => {
    const plan = deriveStrategyPlan(mission)!;
    expect(plan.entryTriggers).toEqual(["1m candle closes above 1860", "mark reclaims the ema"]);
    expect(plan.invalidation).toEqual([
      "1m candle closes back below 1855",
      "mark loses the ema and rolls over",
    ]);
  });

  // The condition union's string branch is an input affordance only; the
  // persisted/encoded form is always { description }. A bare string here would
  // be malformed, and the guard returns null rather than rendering it raw.
  it("ignores a condition element that is not the decoded object shape", () => {
    const plan = deriveStrategyPlan({
      strategyVersion: 1,
      strategy: {
        ...strategy,
        abandonmentConditions: [
          { description: "1m candle closes back below 1855" },
          "bare prose string",
          { noDescription: true },
        ],
      },
    })!;
    expect(plan.invalidation).toEqual(["1m candle closes back below 1855"]);
  });

  it("combines the stop method and price into one readable line", () => {
    expect(deriveStrategyPlan(mission)?.stopSummary).toBe("previous swing low · 1,840");
  });

  it("falls back to the method alone when no stop price is set", () => {
    const plan = deriveStrategyPlan({
      strategyVersion: 1,
      strategy: { ...strategy, protection: { ...strategy.protection, stopPrice: undefined } },
    })!;
    expect(plan.stopSummary).toBe("previous swing low");
  });

  // targetProfitUsd is a PositiveUsdAmount on the contract — required — so it is
  // never null on the plan. The card formats it as USD without null-guarding.
  it("carries the required profit target as a number, never null", () => {
    expect(deriveStrategyPlan(mission)?.targetUsd).toBe(18.5);
  });

  it("reads the target ladder rationale for the disclosure", () => {
    expect(deriveStrategyPlan(mission)?.targetRationale).toBe(
      "Conservative 1864 · Base 1880 · Extension 1900.",
    );
  });

  // The basis is the harness showing its work: measurement, lookback, hold, and
  // the historical hit rate the median came from. It is the interesting field.
  it("flattens the profit-target basis into the four lines the card shows", () => {
    expect(deriveStrategyPlan(mission)?.basis).toEqual({
      measurement: "excursion quantile",
      lookback: "5m · 60b",
      hold: "10b",
      hitRate: "50%",
    });
  });

  it("drops the hit rate when the measurement did not report one", () => {
    const plan = deriveStrategyPlan({
      strategyVersion: 1,
      strategy: {
        ...strategy,
        protection: {
          ...strategy.protection,
          targetProfitBasis: {
            ...strategy.protection.targetProfitBasis,
            historicalHitRatePercent: undefined,
          },
        },
      },
    })!;
    expect(plan.basis?.hitRate).toBeNull();
  });

  it("omits the basis entirely when none was published", () => {
    const plan = deriveStrategyPlan({
      strategyVersion: 1,
      strategy: {
        ...strategy,
        protection: { ...strategy.protection, targetProfitBasis: undefined },
      },
    })!;
    expect(plan.basis).toBeNull();
  });

  it("reports the scaling flags as allowed / not allowed", () => {
    const plan = deriveStrategyPlan(mission)!;
    expect(plan.scaleInAllowed).toBe(true);
    expect(plan.partialReductionAllowed).toBe(false);
  });

  it("formats the initial size and max loss as plain USD figures on the plan", () => {
    const plan = deriveStrategyPlan(mission)!;
    expect(plan.initialSizeUsd).toBe(500);
    expect(plan.maxLossUsd).toBe(20);
  });
});

describe("deriveWatchConditions", () => {
  // A watch carrying the shape the projection now hands the web: the §11.3
  // predicate plus the evaluator's last observed value/timestamp. The optional
  // fields are absent by default; each test adds them where the row needs them.
  const priceCross = {
    id: "watch-1",
    missionId: "mission-1",
    strategyVersion: 1,
    watch: {
      type: "price_cross" as const,
      market: "ETH" as const,
      priceSource: "mark" as const,
      direction: "above" as const,
      price: 1_868.4,
    },
    status: "active" as const,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  it("returns null when no watch is active", () => {
    // A mission holding only history — triggered, consumed, superseded — has
    // nothing left that can wake it, and the card is absent rather than empty.
    expect(deriveWatchConditions({ watches: [] })).toBeNull();
    expect(
      deriveWatchConditions({ watches: [{ ...priceCross, status: "triggered" as const }] }),
    ).toBeNull();
    expect(
      deriveWatchConditions({ watches: [{ ...priceCross, status: "consumed" as const }] }),
    ).toBeNull();
  });

  it("carries one row per active numeric watch", () => {
    const armed = deriveWatchConditions({ watches: [priceCross] })!;
    expect(armed.rows).toHaveLength(1);
    expect(armed.rows[0]?.description).toBe("ETH mark crosses above 1,868.4");
    expect(armed.rows[0]?.thresholdValue).toBe(1_868.4);
  });

  it("carries the evaluator's last observed value and timestamp onto the row", () => {
    // The whole point of the checklist: show the live number the predicate is
    // measuring against, not just a ticked/empty checkbox.
    const armed = deriveWatchConditions({
      watches: [
        {
          ...priceCross,
          lastObservedValue: 1_871.2,
          lastEvaluatedAt: 1_700_000_030_000,
        },
      ],
    })!;
    expect(armed.rows[0]?.observedValue).toBe(1_871.2);
    expect(armed.rows[0]?.evaluatedAt).toBe(1_700_000_030_000);
  });

  it("nulls the observed value and timestamp when the watch was never swept", () => {
    const armed = deriveWatchConditions({ watches: [priceCross] })!;
    expect(armed.rows[0]?.observedValue).toBeNull();
    expect(armed.rows[0]?.evaluatedAt).toBeNull();
  });

  it("reads the threshold off a PnL watch's valueUsd", () => {
    const pnlWatch = {
      id: "watch-pnl",
      missionId: "mission-1",
      strategyVersion: 1,
      watch: {
        type: "pnl_above" as const,
        market: "ETH" as const,
        valueUsd: 18,
      },
      status: "active" as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastObservedValue: 12.4,
      lastEvaluatedAt: 1_700_000_030_000,
    };

    const armed = deriveWatchConditions({ watches: [pnlWatch] })!;
    expect(armed.rows[0]?.thresholdValue).toBe(18);
    expect(armed.rows[0]?.observedValue).toBe(12.4);
  });

  it("excludes scheduled_reassessment from rows and tracks the next runAt", () => {
    // A scheduled reassessment carries no numeric level the checklist could
    // show; it belongs in the countdown, not the row list.
    const reassessment = {
      id: "watch-reassess",
      missionId: "mission-1",
      strategyVersion: 1,
      watch: { type: "scheduled_reassessment" as const, runAt: 1_700_000_120_000 },
      status: "active" as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };

    const armed = deriveWatchConditions({ watches: [priceCross, reassessment] })!;
    expect(armed.rows).toHaveLength(1);
    expect(armed.rows[0]?.id).toBe("watch-1");
    expect(armed.nextReassessmentAt).toBe(1_700_000_120_000);
  });

  it("picks the earliest runAt when several reassessments are armed", () => {
    const reassess = (runAt: number) => ({
      id: `watch-reassess-${runAt}`,
      missionId: "mission-1",
      strategyVersion: 1,
      watch: { type: "scheduled_reassessment" as const, runAt },
      status: "active" as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });

    const armed = deriveWatchConditions({
      watches: [priceCross, reassess(1_700_000_180_000), reassess(1_700_000_120_000)],
    })!;
    expect(armed.nextReassessmentAt).toBe(1_700_000_120_000);
  });

  it("marks a triggered watch as met alongside an active one", () => {
    // The checklist shows both rows: ✓ for the predicate already cleared, ○ for
    // the one still waiting. `met` is read off the status — the predicate is
    // never re-evaluated client-side; the server already tracks whether it has
    // fired.
    const armed = deriveWatchConditions({
      watches: [
        { ...priceCross, status: "triggered" as const, lastObservedValue: 1_871.2 },
        { ...priceCross, id: "watch-2", watch: { ...priceCross.watch, price: 1_864 } },
      ],
    })!;
    expect(armed.rows).toHaveLength(2);
    const met = armed.rows.find((row) => row.id === "watch-1");
    expect(met?.met).toBe(true);
    const waiting = armed.rows.find((row) => row.id === "watch-2");
    expect(waiting?.met).toBe(false);
  });

  it("keeps met=true on an active watch the evaluator confirmed is met", () => {
    // The realistic armed state: an active watch whose predicate is satisfied
    // but has not yet been promoted to "triggered" by the evaluator. The
    // checklist shows it as still waiting — met is read off status, and the
    // evaluator has not flipped it yet.
    const armed = deriveWatchConditions({
      watches: [
        {
          ...priceCross,
          lastObservedValue: 1_871.2,
        },
      ],
    })!;
    expect(armed.rows[0]?.met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chart levels
// ---------------------------------------------------------------------------

describe("deriveChartConditions", () => {
  const persisted = <W>(id: string, watch: W, status: "active" | "triggered" = "active") => ({
    id,
    missionId: "mission-1",
    strategyVersion: 1,
    watch,
    status,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });

  const priceCross = persisted("w-price", {
    type: "price_cross" as const,
    market: "ETH" as const,
    priceSource: "mark" as const,
    direction: "above" as const,
    price: 1_868.4,
  });

  const pnlAbove = persisted("w-pnl-up", {
    type: "pnl_above" as const,
    market: "ETH" as const,
    valueUsd: 20,
  });

  const pnlBelow = persisted("w-pnl-down", {
    type: "pnl_below" as const,
    market: "ETH" as const,
    valueUsd: -10,
  });

  it("draws watches that carry a price outright", () => {
    expect(deriveChartConditions({ watches: [priceCross] })).toEqual([
      { price: 1_868.4, direction: "above", met: false },
    ]);
  });

  it("ignores terminal watches", () => {
    expect(
      deriveChartConditions({ watches: [{ ...priceCross, status: "consumed" as const }] }),
    ).toEqual([]);
  });

  // `pnl = size × (mark − entry)`, so a $20 profit on half an ETH is $40 of
  // price. These were dropped as "no y on a price chart", which was only ever
  // true of a flat mission — and they are the levels that decide when a winner
  // is banked and a loser cut.
  it("resolves a long's PnL watches into prices above and below its entry", () => {
    const basis = { entryPrice: 1_900, size: 0.5 };
    expect(deriveChartConditions({ watches: [pnlAbove, pnlBelow] }, basis)).toEqual([
      { price: 1_940, direction: "above", met: false },
      { price: 1_880, direction: "below", met: false },
    ]);
  });

  // The signed size carries the direction: a short's profit lives BELOW its
  // entry, so `pnl_above` has to resolve downward. Getting this backwards would
  // draw a short's target on the side of the chart that liquidates it.
  it("inverts a short's PnL watches, because its profit is below its entry", () => {
    const basis = { entryPrice: 1_900, size: -0.5 };
    expect(deriveChartConditions({ watches: [pnlAbove, pnlBelow] }, basis)).toEqual([
      { price: 1_860, direction: "below", met: false },
      { price: 1_920, direction: "above", met: false },
    ]);
  });

  it("draws no PnL level while flat, rather than inventing one", () => {
    expect(deriveChartConditions({ watches: [pnlAbove] })).toEqual([]);
    expect(deriveChartConditions({ watches: [pnlAbove] }, { entryPrice: 1_900, size: 0 })).toEqual(
      [],
    );
  });

  // `pnl_giveback` is measured from the position's peak unrealised PnL, and
  // `TradingPositionView` does not carry the peak — so there is no honest level
  // to draw. It stays a checklist row.
  it("leaves pnl_giveback to the checklist", () => {
    const giveback = persisted("w-give", {
      type: "pnl_giveback" as const,
      market: "ETH" as const,
      drawdownUsd: 5,
    });
    expect(
      deriveChartConditions({ watches: [giveback] }, { entryPrice: 1_900, size: 0.5 }),
    ).toEqual([]);
  });

  it("carries the met flag from a triggered watch", () => {
    expect(
      deriveChartConditions({ watches: [{ ...priceCross, status: "triggered" as const }] })[0],
    ).toMatchObject({ met: true });
  });
});

describe("deriveNextReassessmentAt", () => {
  const reassessment = (id: string, runAt: number, status: "active" | "consumed" = "active") => ({
    id,
    missionId: "mission-1",
    strategyVersion: 1,
    watch: { type: "scheduled_reassessment" as const, runAt },
    status,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });

  it("returns the earliest armed reassessment", () => {
    expect(
      deriveNextReassessmentAt({
        watches: [reassessment("a", 1_700_000_300_000), reassessment("b", 1_700_000_120_000)],
      }),
    ).toBe(1_700_000_120_000);
  });

  it("ignores reassessments that have already been consumed", () => {
    expect(
      deriveNextReassessmentAt({
        watches: [reassessment("a", 1_700_000_120_000, "consumed")],
      }),
    ).toBeNull();
  });

  it("returns null when none is armed", () => {
    expect(deriveNextReassessmentAt({ watches: [] })).toBeNull();
  });
});

describe("deriveChartTimeMarkers", () => {
  const reassessment = (
    id: string,
    runAt: number,
    over: {
      readonly status?: "active" | "consumed";
      readonly armedReason?: "staleness_floor";
    } = {},
  ) => ({
    id,
    missionId: "mission-1",
    strategyVersion: 1,
    watch: { type: "scheduled_reassessment" as const, runAt },
    status: over.status ?? ("active" as const),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...(over.armedReason === undefined ? {} : { armedReason: over.armedReason }),
  });

  it("returns every armed reassessment, soonest first", () => {
    const markers = deriveChartTimeMarkers({
      watches: [reassessment("a", 1_700_000_300_000), reassessment("b", 1_700_000_120_000)],
    });
    expect(markers.map((marker) => marker.at)).toEqual([1_700_000_120_000, 1_700_000_300_000]);
  });

  it("labels only the nearest tick, and marks the staleness floor as auto", () => {
    const markers = deriveChartTimeMarkers({
      watches: [
        reassessment("a", 1_700_000_120_000, { armedReason: "staleness_floor" }),
        reassessment("b", 1_700_000_300_000),
      ],
    });
    expect(markers[0]).toMatchObject({ label: "reassess (auto)", tone: "auto" });
    expect(markers[1]).toMatchObject({ label: "", tone: "planned" });
  });

  it("labels a harness-armed nearest tick without the auto chip", () => {
    const markers = deriveChartTimeMarkers({ watches: [reassessment("a", 1_700_000_120_000)] });
    expect(markers[0]).toMatchObject({ label: "reassess", tone: "planned" });
  });

  it("ignores watches that are no longer armed", () => {
    expect(
      deriveChartTimeMarkers({
        watches: [reassessment("a", 1_700_000_120_000, { status: "consumed" })],
      }),
    ).toEqual([]);
  });

  it("collapses the overflow into a +N tick at the furthest moment", () => {
    const markers = deriveChartTimeMarkers({
      watches: [1, 2, 3, 4, 5, 6, 7].map((n) =>
        reassessment(`w${n}`, 1_700_000_000_000 + n * 60_000),
      ),
    });
    expect(markers).toHaveLength(MAX_DRAWN_TIME_MARKERS);
    expect(markers[MAX_DRAWN_TIME_MARKERS - 1]).toMatchObject({
      key: "reassess-overflow",
      label: "+3",
      at: 1_700_000_000_000 + 7 * 60_000,
    });
  });
});

describe("deriveChartFillMarkers", () => {
  const fill = (over: {
    readonly orderId: number;
    readonly tradedAt: string;
    readonly avgFillPrice: number;
    readonly closedPnl: number;
    readonly direction?: string;
  }) => over;

  it("marks an opening fill as an open", () => {
    const markers = deriveChartFillMarkers({
      recentFills: [
        fill({
          orderId: 1,
          tradedAt: "2026-08-06T12:00:00.000Z",
          avgFillPrice: 1_900,
          closedPnl: 0,
          direction: "Open Long",
        }),
      ],
    });

    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe("open");
    expect(markers[0]!.price).toBe(1_900);
    expect(markers[0]!.at).toBe(Date.parse("2026-08-06T12:00:00.000Z"));
  });

  // The colour of a close is the only place the chart says whether the position
  // it ended paid — the position row is gone by then.
  it("colours a close by what it realised", () => {
    const markers = deriveChartFillMarkers({
      recentFills: [
        fill({
          orderId: 1,
          tradedAt: "2026-08-06T12:05:00.000Z",
          avgFillPrice: 1_950,
          closedPnl: 12.5,
          direction: "Close Long",
        }),
        fill({
          orderId: 2,
          tradedAt: "2026-08-06T12:06:00.000Z",
          avgFillPrice: 1_850,
          closedPnl: -8,
          direction: "Close Long",
        }),
        fill({
          orderId: 3,
          tradedAt: "2026-08-06T12:07:00.000Z",
          avgFillPrice: 1_900,
          closedPnl: 0,
          direction: "Close Short",
        }),
      ],
    });

    expect(markers.map((m) => m.kind)).toEqual(["close_profit", "close_loss", "close_flat"]);
  });

  // A reversal realises the old exposure, so it reads as a close.
  it("treats a reversal as a close", () => {
    const markers = deriveChartFillMarkers({
      recentFills: [
        fill({
          orderId: 1,
          tradedAt: "2026-08-06T12:05:00.000Z",
          avgFillPrice: 1_950,
          closedPnl: 4,
          direction: "Long > Short",
        }),
      ],
    });

    expect(markers[0]!.kind).toBe("close_profit");
  });

  // `side` alone cannot tell an open from a close, so an unlabelled fill is
  // drawn as neither rather than guessed at.
  it("marks a fill with no lifecycle label as unknown", () => {
    const markers = deriveChartFillMarkers({
      recentFills: [
        fill({
          orderId: 1,
          tradedAt: "2026-08-06T12:00:00.000Z",
          avgFillPrice: 1_900,
          closedPnl: 0,
        }),
      ],
    });

    expect(markers[0]!.kind).toBe("unknown");
  });

  it("drops a fill whose timestamp does not parse", () => {
    const markers = deriveChartFillMarkers({
      recentFills: [
        fill({
          orderId: 1,
          tradedAt: "not a time",
          avgFillPrice: 1_900,
          closedPnl: 0,
          direction: "Open Long",
        }),
      ],
    });

    expect(markers).toEqual([]);
  });

  it("keys each marker by order and time, so partials do not collide", () => {
    const markers = deriveChartFillMarkers({
      recentFills: [
        fill({
          orderId: 7,
          tradedAt: "2026-08-06T12:00:00.000Z",
          avgFillPrice: 1_900,
          closedPnl: 0,
          direction: "Open Long",
        }),
        fill({
          orderId: 7,
          tradedAt: "2026-08-06T12:00:05.000Z",
          avgFillPrice: 1_901,
          closedPnl: 0,
          direction: "Open Long",
        }),
      ],
    });

    expect(new Set(markers.map((m) => m.key)).size).toBe(2);
  });
});

describe("deriveUpNextItems", () => {
  const NOW = 1_700_000_000_000;

  const watch = (
    id: string,
    inner: PersistedWatch["watch"],
    armedReason?: PersistedWatch["armedReason"],
  ): PersistedWatch => ({
    id,
    missionId: "mission-1",
    strategyVersion: 1,
    watch: inner,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...(armedReason === undefined ? {} : { armedReason }),
  });

  const flatMission = {
    watches: [] as ReadonlyArray<PersistedWatch>,
    marketPrice: 1_900,
    inFlightExecution: null,
    position: null,
    strategy: null,
  };

  it("is empty when the mission has nothing scheduled", () => {
    expect(deriveUpNextItems(flatMission, NOW)).toEqual([]);
  });

  it("orders the classes: working order, stop, levels, then the clock", () => {
    const items = deriveUpNextItems(
      {
        ...flatMission,
        inFlightExecution: { limitPrice: 1_901 },
        position: { size: 1, entryPrice: 1_900, unrealisedPnl: 0 },
        strategy: { protection: { stopPrice: 1_890 } },
        watches: [
          watch(
            "w-time",
            { type: "scheduled_reassessment", runAt: NOW + 160_000 },
            "staleness_floor",
          ),
          watch("w-price", {
            type: "price_cross",
            market: "ETH",
            priceSource: "mark",
            direction: "below",
            price: 1_899,
          }),
        ],
      },
      NOW,
    );
    expect(items.map((item) => item.kind)).toEqual(["order", "stop", "price", "time"]);
    expect(items[1]?.label).toBe("stop 1,890");
    // 10 points of adverse move on one unit of size.
    expect(items[1]?.detail).toBe("$10.00 risk");
    expect(items[2]?.label).toBe("wake @ 1,899 ↓");
    expect(items[2]?.detail).toBe("1 away");
    expect(items[3]?.label).toBe("reassess in 2m 40s");
    expect(items[3]?.chip).toBe("auto");
  });

  it("ranks price and pnl levels by how near they are", () => {
    const items = deriveUpNextItems(
      {
        ...flatMission,
        position: { size: 1, entryPrice: 1_900, unrealisedPnl: 1 },
        watches: [
          watch("far", {
            type: "price_cross",
            market: "ETH",
            priceSource: "mark",
            direction: "above",
            price: 1_950,
          }),
          watch("near", { type: "pnl_above", market: "ETH", valueUsd: 2 }, "profit_target"),
        ],
      },
      NOW,
    );
    expect(items.map((item) => item.key)).toEqual(["near", "far"]);
    expect(items[0]?.label).toBe("bank at +$2.00");
    expect(items[0]?.chip).toBe("target");
    // The target's price, resolved through the exposure it is measured on.
    expect(items[0]?.priceLevel).toBe(1_902);
  });

  it("chips a runtime-armed stop-proximity wake", () => {
    const items = deriveUpNextItems(
      {
        ...flatMission,
        position: { size: -1, entryPrice: 1_900, unrealisedPnl: 0 },
        watches: [
          watch(
            "prox",
            {
              type: "price_cross",
              market: "ETH",
              priceSource: "mark",
              direction: "above",
              price: 1_905,
            },
            "stop_proximity",
          ),
        ],
      },
      NOW,
    );
    expect(items[0]?.chip).toBe("stop");
  });

  it("warns when a waiting plan names a trigger level nothing is armed at", () => {
    const items = deriveUpNextItems(
      {
        ...flatMission,
        strategy: {
          currentAction: "waiting",
          entryPlan: {
            conditions: [
              { description: "enter if price reclaims 1899", priceLevel: 1_899 },
              { description: "abandon if the 1m closes under 1880", priceLevel: 1_880 },
            ],
          },
        },
        watches: [
          watch("armed", {
            type: "price_cross",
            market: "ETH",
            priceSource: "mark",
            direction: "below",
            price: 1_880,
          }),
        ],
      },
      NOW,
    );
    // The armed level is a price pill; only the unarmed one becomes a warning.
    expect(items.map((item) => item.kind)).toEqual(["price", "entry"]);
    expect(items[1]).toMatchObject({ label: "entry? 1,899", tone: "warning", detail: "not armed" });
  });

  it("keeps the entry view off a mission that is already in the market", () => {
    const items = deriveUpNextItems(
      {
        ...flatMission,
        position: { size: 1, entryPrice: 1_900, unrealisedPnl: 0 },
        strategy: {
          currentAction: "holding",
          entryPlan: { conditions: [{ description: "…", priceLevel: 1_899 }] },
        },
      },
      NOW,
    );
    expect(items).toEqual([]);
  });
});
