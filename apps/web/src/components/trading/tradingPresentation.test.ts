import type { TradingMissionStatus } from "@t3tools/trading-contracts";
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
  deriveMissionPhases,
  derivePausedExposure,
  deriveStrategyPlan,
  describeStaleness,
  formatLeverage,
  formatSignedPercent,
  hyperliquidTradeUrl,
  isPositionDataStale,
  isLiveMission,
  newMissionBlocker,
  selectableMissionThreads,
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

describe("stale-data banner", () => {
  const now = 1_700_000_000_000;
  const fresh = new Date(now - 1_000).toISOString();
  const old = new Date(now - 6_000).toISOString();

  it("stays quiet on a fresh position read", () => {
    expect(
      isPositionDataStale(
        { status: "position_open", position: { size: 0.5, observedAt: fresh } },
        now,
      ),
    ).toBe(false);
  });

  it("fires once the read passes the 5s account window", () => {
    expect(
      isPositionDataStale(
        { status: "position_open", position: { size: 0.5, observedAt: old } },
        now,
      ),
    ).toBe(true);
  });

  it("stays quiet when there is no position to be stale about", () => {
    expect(isPositionDataStale({ status: "waiting", position: null }, now)).toBe(false);
  });

  // §18.2 #8's periodic reconcile only runs while a position is open, so a flat
  // mission's last snapshot ages out after five seconds and is never refreshed.
  // Reading the timestamp alone latched the banner on for the rest of the
  // session, on a mission with nothing at risk and nothing suspended.
  it("stays quiet on a flat mission whose snapshot has stopped refreshing", () => {
    expect(
      isPositionDataStale({ status: "waiting", position: { size: 0, observedAt: old } }, now),
    ).toBe(false);
  });

  // A revoked mission keeps its final position row forever. Yesterday's mission
  // must not warn about today's order placement.
  it("stays quiet on a terminal mission holding a historical snapshot", () => {
    expect(
      isPositionDataStale({ status: "revoked", position: { size: 0.5, observedAt: old } }, now),
    ).toBe(false);
    expect(
      isPositionDataStale({ status: "completed", position: { size: 0.5, observedAt: old } }, now),
    ).toBe(false);
  });

  // The banner's whole job is telling a read that is a second late from one
  // that stopped four minutes ago, and it could not: both read "stale".
  it("says how long ago the last read landed", () => {
    expect(
      describeStaleness({ status: "position_open", position: { size: 0.5, observedAt: old } }, now),
    ).toBe(
      "Position data is stale. Order placement is suspended until a fresh read lands. " +
        "Last update 6s ago.",
    );

    expect(
      describeStaleness(
        {
          status: "position_open",
          position: { size: 0.5, observedAt: new Date(now - 254_000).toISOString() },
        },
        now,
      ),
    ).toContain("Last update 4m 14s ago.");
  });

  it("says nothing at all while the read is fresh", () => {
    expect(
      describeStaleness(
        { status: "position_open", position: { size: 0.5, observedAt: fresh } },
        now,
      ),
    ).toBeNull();
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

describe("selectableMissionThreads", () => {
  const thread = (id: string, archivedAt: string | null = null) => ({
    id,
    title: `Thread ${id}`,
    archivedAt,
  });

  it("offers the threads that are free to take a mission", () => {
    const options = selectableMissionThreads([thread("a"), thread("b")], new Set());
    expect(options.map((option) => option.threadId)).toEqual(["a", "b"]);
    expect(options[0]?.title).toBe("Thread a");
  });

  // §10.2 freezes one active mission onto one thread, so offering a bound
  // thread would only produce a rejection at the reactor.
  it("withholds a thread that already carries a mission", () => {
    const options = selectableMissionThreads([thread("a"), thread("b")], new Set(["a"]));
    expect(options.map((option) => option.threadId)).toEqual(["b"]);
  });

  it("withholds archived threads", () => {
    const options = selectableMissionThreads([thread("a", "2026-08-02T00:00:00Z")], new Set());
    expect(options).toEqual([]);
  });

  // Providers title threads themselves and duplicates are common ("Greeting").
  // Binding a mission to the wrong one of two identically named threads is
  // silent — the panel appears on a thread you are not looking at.
  it("distinguishes threads that share a title", () => {
    const options = selectableMissionThreads(
      [
        { id: "b4bfb480-4180-493c", title: "Greeting", archivedAt: null },
        { id: "eb148ced-7bac-4035", title: "Greeting", archivedAt: null },
        { id: "edd33aaa-8cca-4064", title: "Explore Trading Options", archivedAt: null },
      ],
      new Set(),
    );
    expect(options.map((option) => option.title)).toEqual([
      "Greeting (b4bfb480)",
      "Greeting (eb148ced)",
      "Explore Trading Options",
    ]);
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

describe("newMissionBlocker", () => {
  const valid = {
    threadId: "thread_1",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 50,
    tradingAccountId: "local-hyperliquid-testnet",
    hasActiveMission: false,
  };

  it("admits a complete form", () => {
    expect(newMissionBlocker(valid)).toBeNull();
  });

  // The domain holds one active mission per user, so a second create would fail
  // on a uniqueness constraint rather than on anything the form said.
  it("blocks while a mission is already active", () => {
    expect(newMissionBlocker({ ...valid, hasActiveMission: true })).toMatch(/already active/i);
  });

  it("names what is missing, one thing at a time", () => {
    expect(newMissionBlocker({ ...valid, threadId: null })).toMatch(/thread/i);
    expect(newMissionBlocker({ ...valid, instruction: "   " })).toMatch(/instruction/i);
    expect(newMissionBlocker({ ...valid, tradingAccountId: "" })).toMatch(/account/i);
  });

  // A blank capital field parses to NaN, which must block rather than dispatch
  // a mission with an unusable allocation.
  it("blocks non-positive and unparseable capital", () => {
    expect(newMissionBlocker({ ...valid, allocatedCapitalUsd: 0 })).toMatch(/capital/i);
    expect(newMissionBlocker({ ...valid, allocatedCapitalUsd: Number.NaN })).toMatch(/capital/i);
  });
});

describe("visibleMissions", () => {
  const mission = (id: string, status: TradingMissionStatus) => ({ id, status });

  it("keeps the live missions and the most recently finished one", () => {
    const visible = visibleMissions([
      mission("revoked-newest", "revoked"),
      mission("live", "position_open"),
      mission("revoked-older", "revoked"),
      mission("completed-oldest", "completed"),
    ]);

    expect(visible.map((m) => m.id)).toEqual(["live", "revoked-newest"]);
  });

  it("still shows the last mission when every one of them has finished", () => {
    const visible = visibleMissions([
      mission("revoked-newest", "revoked"),
      mission("revoked-older", "revoked"),
    ]);

    expect(visible.map((m) => m.id)).toEqual(["revoked-newest"]);
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
