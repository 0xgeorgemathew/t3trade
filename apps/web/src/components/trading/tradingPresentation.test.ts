import type { PersistedWatch, TradingMissionStatus } from "@t3tools/trading-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MISSION_STATUS_LABELS,
  deriveCompletionSummary,
  deriveMissionHistoryRow,
  settledMissions,
  deriveReviewMarkers,
  deriveMissionStrip,
  deriveRejectedOrder,
  deriveWakeupCard,
  describeEntryPermission,
  describeTradingAccount,
  describeWatch,
  deriveUpNextItems,
  deriveWatchConditions,
  deriveWatchLifecycle,
  formatAge,
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
  deriveChartPastMarkers,
  deriveChartTimeMarkers,
  deriveNextReassessmentAt,
  derivePositionLedger,
  deriveRoundTrips,
  formatFixed3,
  MAX_DRAWN_TIME_MARKERS,
  derivePausedExposure,
  deriveStrategyPlan,
  deriveTriggerExpiryMillis,
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
  type WatchStreamItem,
  type WatchStreamRow,
} from "./tradingPresentation";

/** The single-watch rows of a stream, for assertions about a row's own fields. */
const watchRows = (stream: ReadonlyArray<WatchStreamItem>): ReadonlyArray<WatchStreamRow> =>
  stream.filter((item): item is WatchStreamRow => item.kind === "watch");

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

describe("deriveWatchLifecycle", () => {
  const base = {
    id: "watch-a",
    missionId: "mission-1",
    watch: {
      type: "price_cross" as const,
      market: "ETH" as const,
      priceSource: "mark" as const,
      direction: "above" as const,
      price: 1900,
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  const firedAtIso = new Date(1_700_000_120_000).toISOString();

  it("puts the armed rows first and orders everything settled newest first", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "older-fire", status: "consumed" as const, updatedAt: 1_700_000_060_000 },
        { ...base, id: "still-armed", status: "active" as const },
        { ...base, id: "newer-fire", status: "triggered" as const, updatedAt: 1_700_000_120_000 },
        { ...base, id: "retired", status: "cancelled" as const, updatedAt: 1_700_000_090_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(stream.map((row) => row.id)).toEqual([
      "still-armed",
      "newer-fire",
      "retired",
      "older-fire",
    ]);
    expect(watchRows(stream).map((row) => row.state)).toEqual([
      "armed",
      "triggered",
      "disarmed",
      "triggered",
    ]);
    // Armed rows date from when they were armed; settled ones from when they
    // settled — the row's timestamp always means the state it is showing.
    expect(stream[0]?.atMillis).toBe(base.createdAt);
    expect(stream[1]?.atMillis).toBe(1_700_000_120_000);
  });

  // The four dead ends are not interchangeable: a level someone cancelled, a
  // level a newer prediction moved, and a clock that ran out are different
  // facts about why the mission is no longer watching it.
  it("separates expiry from cancellation, and names a replacement as one", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "expired", status: "expired" as const, updatedAt: 1_700_000_120_000 },
        { ...base, id: "replaced", status: "superseded" as const, updatedAt: 1_700_000_110_000 },
        { ...base, id: "cancelled", status: "cancelled" as const, updatedAt: 1_700_000_100_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(watchRows(stream).map((row) => [row.state, row.outcomeLabel])).toEqual([
      ["expired", "expired"],
      ["disarmed", "replaced"],
      ["disarmed", "cancelled"],
    ]);
  });

  // The stream labels each row with the prediction that armed it, so an
  // operator can see which read a level belongs to without opening the plan.
  it("carries the prediction version through, and leaves it null when there is none", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "runtime-armed", status: "active" as const, predictionVersion: 4 },
        { ...base, id: "model-armed", status: "active" as const },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(watchRows(stream).map((row) => row.predictionVersion)).toEqual([4, null]);
  });

  it("pairs a firing with the decision that followed it, preferring it over the wake", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "fired", status: "triggered" as const, updatedAt: 1_700_000_120_000 },
      ] as PersistedWatch[],
      missionTimeline: [
        // Newest first, as the projection sends them.
        {
          at: new Date(1_700_000_150_000).toISOString(),
          kind: "strategy_published" as const,
          label: "published short below the range",
        },
        { at: firedAtIso, kind: "wake" as const, label: "woke on ETH mark above 1900" },
        {
          at: new Date(1_700_000_000_000).toISOString(),
          kind: "wake" as const,
          label: "an earlier wake that must not match",
        },
      ],
    });
    expect(watchRows(stream)[0]?.actionLabel).toBe("published short below the range");
  });

  it("falls back to the wake when no decision has landed yet", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "fired", status: "triggered" as const, updatedAt: 1_700_000_120_000 },
      ] as PersistedWatch[],
      missionTimeline: [
        { at: firedAtIso, kind: "wake" as const, label: "woke on ETH mark above 1900" },
      ],
    });
    expect(watchRows(stream)[0]?.actionLabel).toBe("woke on ETH mark above 1900");
  });

  it("carries no action for a watch that was retired rather than fired", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "retired", status: "cancelled" as const, updatedAt: 1_700_000_120_000 },
      ] as PersistedWatch[],
      missionTimeline: [
        { at: firedAtIso, kind: "wake" as const, label: "a wake that has nothing to do with it" },
      ],
    });
    expect(watchRows(stream)[0]?.actionLabel).toBeNull();
  });

  // One replan supersedes every level of the prediction before it, so a mission
  // that re-levels every few minutes buried its fired rows under a wall of
  // near-identical cancels. The burst is one row now.
  it("folds a burst of supersessions into one group row", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "a", status: "superseded" as const, updatedAt: 1_700_000_120_000 },
        { ...base, id: "b", status: "superseded" as const, updatedAt: 1_700_000_119_000 },
        { ...base, id: "c", status: "superseded" as const, updatedAt: 1_700_000_118_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(stream).toHaveLength(1);
    const group = stream[0]!;
    expect(group.kind).toBe("group");
    if (group.kind !== "group") return;
    expect(group.count).toBe(3);
    expect(group.outcomeLabel).toBe("replaced");
    // The group dates from its newest member, and holds them in stream order.
    expect(group.atMillis).toBe(1_700_000_120_000);
    expect(group.members.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("names a superseded PnL watch retired — nothing replaced it, its position ended", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        {
          ...base,
          id: "target",
          watch: { type: "pnl_above" as const, market: "ETH" as const, valueUsd: 2 },
          status: "superseded" as const,
          updatedAt: 1_700_000_120_000,
        },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(watchRows(stream).map((row) => row.outcomeLabel)).toEqual(["retired"]);
  });

  it("names a mixed burst retired rather than replaced", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "a", status: "superseded" as const, updatedAt: 1_700_000_120_000 },
        { ...base, id: "b", status: "cancelled" as const, updatedAt: 1_700_000_119_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(stream[0]?.kind).toBe("group");
    expect(stream[0]?.kind === "group" ? stream[0].outcomeLabel : null).toBe("retired");
  });

  // A firing is the event the operator follows to the decision it produced. It
  // never disappears into a group, even landing in the middle of one.
  it("keeps a firing out of a burst that surrounds it", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "a", status: "superseded" as const, updatedAt: 1_700_000_120_000 },
        { ...base, id: "fired", status: "triggered" as const, updatedAt: 1_700_000_119_500 },
        { ...base, id: "b", status: "superseded" as const, updatedAt: 1_700_000_119_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(stream.map((item) => item.kind)).toEqual(["watch", "watch", "watch"]);
    expect(watchRows(stream).map((row) => row.id)).toEqual(["a", "fired", "b"]);
  });

  it("leaves two bursts nine seconds apart as two groups", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "a", status: "superseded" as const, updatedAt: 1_700_000_120_000 },
        { ...base, id: "b", status: "superseded" as const, updatedAt: 1_700_000_119_000 },
        { ...base, id: "c", status: "superseded" as const, updatedAt: 1_700_000_111_000 },
        { ...base, id: "d", status: "superseded" as const, updatedAt: 1_700_000_110_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(stream.map((item) => item.kind)).toEqual(["group", "group"]);
    expect(stream.map((item) => (item.kind === "group" ? item.count : null))).toEqual([2, 2]);
  });

  it("leaves a lone cancel as an ordinary row", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        { ...base, id: "only", status: "cancelled" as const, updatedAt: 1_700_000_120_000 },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(stream.map((item) => item.kind)).toEqual(["watch"]);
  });

  // The row draws its own icon, triangle and figure from these, rather than
  // re-reading the sentence it used to print.
  it("carries the predicate's type, direction and qualifier as fields", () => {
    const { stream } = deriveWatchLifecycle({
      watches: [
        {
          ...base,
          id: "candle",
          status: "active" as const,
          watch: {
            type: "candle_close" as const,
            market: "ETH" as const,
            interval: "5m" as const,
            direction: "below" as const,
            price: 1900,
          },
        },
        {
          ...base,
          id: "metric",
          status: "active" as const,
          watch: {
            type: "metric_threshold" as const,
            market: "ETH" as const,
            metric: "volume_ratio" as const,
            direction: "above" as const,
            value: 2,
          },
        },
        {
          ...base,
          id: "giveback",
          status: "active" as const,
          watch: {
            type: "pnl_giveback" as const,
            market: "ETH" as const,
            drawdownUsd: 3,
          },
        },
      ] as PersistedWatch[],
      missionTimeline: [],
    });
    expect(
      watchRows(stream).map((row) => [row.watchType, row.direction, row.intervalLabel]),
    ).toEqual([
      ["candle_close", "below", "5m"],
      ["metric_threshold", "above", "volume ratio"],
      // A give-back measures a fall from a moving peak, so it has no side.
      ["pnl_giveback", null, null],
    ]);
  });
});

describe("formatAge", () => {
  it("says just now until a minute has passed, then never counts seconds again", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(59_000)).toBe("just now");
    expect(formatAge(60_000)).toBe("1m ago");
    expect(formatAge(4 * 60_000 + 59_000)).toBe("4m ago");
    expect(formatAge(3_600_000)).toBe("1h 0m ago");
    expect(formatAge(3_600_000 + 12 * 60_000)).toBe("1h 12m ago");
  });
});

describe("composer controls", () => {
  it("names the network only when the account id does", () => {
    expect(describeTradingAccount("local-hyperliquid-testnet")).toBe("Hyperliquid · Testnet");
    expect(describeTradingAccount("prod-hyperliquid-mainnet")).toBe("Hyperliquid · Mainnet");
    // Guessing "mainnet" for an unlabelled account is the expensive direction.
    expect(describeTradingAccount("account-7")).toBe("account-7");
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
      strategy: { stop: { maximumPlannedLossUsd: 20 } },
    });
    expect(summary.plannedLossUsd).toBe(20);
    // Net -24 against a planned -20: 4 worse than planned.
    expect(summary.netResultUsd).toBe(-24);
    expect(summary.deviationFromPlanUsd).toBe(-4);
  });

  // Plan 34 step 7.3. The plan's number is one the model writes off the
  // authority's per-position ceiling; on a mission whose entry filled an
  // eighth of its request that was $63 against $1.70 actually risked, and
  // "versus plan" was arithmetic on a position that never existed.
  it("prefers what was actually at stake over what the plan said would be", () => {
    const summary = deriveCompletionSummary({
      result: { ...result, realizedPnlUsd: -0.29, plannedLossAtStopUsd: 1.7 },
      strategy: { stop: { maximumPlannedLossUsd: 63.26 } },
    });
    expect(summary.plannedLossUsd).toBe(1.7);
    // Net -6.29 against 1.70 really at stake.
    expect(summary.deviationFromPlanUsd).toBeCloseTo(-4.59, 10);
  });

  it("falls back to the plan's number when no entry record carries one", () => {
    const summary = deriveCompletionSummary({
      result: { ...result, plannedLossAtStopUsd: null },
      strategy: { stop: { maximumPlannedLossUsd: 20 } },
    });
    expect(summary.plannedLossUsd).toBe(20);
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

  // Settled missions survive server-side now (plan 27 H1); this filter is what
  // keeps the workspace cards to the missions that can still act.
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

describe("mission history (plan 27 H3)", () => {
  const mission = (id: string, status: TradingMissionStatus) => ({ id, status });

  it("settledMissions is the complement of visibleMissions", () => {
    const all = [
      mission("revoked-newest", "revoked"),
      mission("live", "position_open"),
      mission("completed-oldest", "completed"),
    ];
    expect(settledMissions(all).map((m) => m.id)).toEqual(["revoked-newest", "completed-oldest"]);
  });

  const settledMission = {
    id: "mission_h3",
    threadId: "thread_h3",
    market: "ETH",
    status: "completed" as TradingMissionStatus,
    strategy: { intent: "long" },
    result: {
      realizedPnlUsd: 25,
      feesPaidUsd: 2,
      fillCount: 4,
      firstFillAt: "2026-08-13T06:00:00.000Z",
      lastFillAt: "2026-08-13T06:45:00.000Z",
    },
    updatedAt: "2026-08-13T07:00:00.000Z",
  };

  it("compresses a settled mission to one ledger line", () => {
    const row = deriveMissionHistoryRow(settledMission);
    expect(row.market).toBe("ETH");
    expect(row.direction).toBe("Long");
    expect(row.statusLabel).toBe(MISSION_STATUS_LABELS.completed);
    // §16.2: fees netted exactly once.
    expect(row.netUsd).toBe(23);
    expect(row.netLabel).toBe("+$23.00");
    // Cents survive under ten dollars: at whole-dollar rounding a $2 fee and a
    // $2.49 fee printed the same figure, and fees are small by construction.
    expect(row.feesLabel).toBe("$2.00");
    expect(row.durationLabel).toBe("45m 0s");
    expect(row.settledAtIso).toBe("2026-08-13T07:00:00.000Z");
  });

  it("labels a stand-aside mission in the direction column", () => {
    // The intent is the direction column's whole source now; a mission that
    // never entered reads as the side it never took.
    expect(
      deriveMissionHistoryRow({ ...settledMission, strategy: { intent: "stand_aside" } }).direction,
    ).toBe("Stand aside");
  });

  it("omits direction and duration a mission never had", () => {
    const row = deriveMissionHistoryRow({
      ...settledMission,
      strategy: null,
      result: {
        realizedPnlUsd: 0,
        feesPaidUsd: 0,
        fillCount: 1,
        firstFillAt: "2026-08-13T06:00:00.000Z",
        lastFillAt: "2026-08-13T06:00:00.000Z",
      },
    });
    expect(row.direction).toBeNull();
    // One fill is not a round trip, so no traded duration is claimed.
    expect(row.durationLabel).toBeNull();
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
    activeStrategy: { market: "ETH", intent: "long" },
    pendingEvents: [{ summary: "external_close" }, { summary: "fill" }],
  };

  it("reads one line out of a full wakeup payload", () => {
    const card = deriveWakeupCard(JSON.stringify(wakeup));

    expect(card).not.toBeNull();
    expect(card?.causeLabel).toBe("market watch triggered");
    expect(card?.marketLabel).toBe("ETH · 3,142.5");
    expect(card?.pendingEventCount).toBe(2);
    expect(card?.bootstrap).toBe(false);
    expect(card?.rawJson).toContain('"missionId": "mission_1"');
  });

  // No version numbers ride the wakeup any more (plan 29 step 4.2): neither
  // the payload nor the card carries one, and a regression on either side
  // would have to invent the word to fail this.
  it("carries no version field anywhere in the card", () => {
    const card = deriveWakeupCard(JSON.stringify(wakeup))!;
    expect(JSON.stringify(card)).not.toContain("version");
    expect(JSON.stringify(card)).not.toContain("Version");
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
    expect(card?.pendingEventCount).toBe(0);
  });

  // A field the web build has never heard of must not knock the card back to
  // raw JSON: the server is free to enrich the snapshot without a web release.
  it("still renders when the payload carries unknown fields", () => {
    const card = deriveWakeupCard(JSON.stringify({ ...wakeup, somethingNew: { a: 1 } }));
    expect(card?.causeLabel).toBe("market watch triggered");
  });

  // The server renders the wakeup as flat key=value text now, not JSON — the
  // card has to read that form too or every wake goes back to a wall of text.
  it("reads one line out of the flat key=value rendering", () => {
    const flat = [
      "trading-harness-wakeup",
      "kind:",
      "  trading-harness-wakeup",
      "missionId:",
      "  mission_1",
      "cause:",
      "  scheduled_reassessment",
      "marketSnapshot:",
      "  market=BTC",
      "  markPrice=64517",
      "  bestBidOffer:",
      "    bidPrice=64497 askPrice=64520",
      "pendingEvents:",
      "  [0] category=market summary=candle closed",
      "  [1] category=timer summary=reassessment due",
      "activeStrategy:",
      "  market=BTC",
      "  intent=long",
      "mandate-and-authority: call trading_look",
    ].join("\n");

    const card = deriveWakeupCard(flat);

    expect(card).not.toBeNull();
    expect(card?.causeLabel).toBe("scheduled reassessment");
    expect(card?.marketLabel).toBe("BTC · 64,517");
    expect(card?.pendingEventCount).toBe(2);
    expect(card?.bootstrap).toBe(false);
    expect(card?.rawJson).toBe(flat);
  });

  // The beacon keys its tone and its icon off the literal cause, not off the
  // humanized label — a label exists to be read, and matching on prose would
  // break the moment the wording improved.
  it("carries the raw cause beside the humanized label", () => {
    const card = deriveWakeupCard(JSON.stringify(wakeup))!;

    expect(card.cause).toBe("market_watch_triggered");
    expect(card.causeLabel).toBe("market watch triggered");
    expect(card.occurredAtMillis).toBe(1_700_000);
  });

  // "A watch fired" is not one event: a P&L floor being hit and a price level
  // being crossed read differently, and the payload names which.
  it("reads the triggering watch's type, from either payload shape", () => {
    const fromJson = deriveWakeupCard(
      JSON.stringify({
        ...wakeup,
        triggeringWatch: { id: "w1", status: "triggered", watch: { type: "pnl_above" } },
      }),
    );
    expect(fromJson?.triggeringWatchType).toBe("pnl_above");

    const fromFlat = deriveWakeupCard(
      [
        "trading-harness-wakeup",
        "cause:",
        "  market_watch_triggered",
        "occurredAt:",
        "  1700000",
        "triggeringWatch:",
        "  id=w1 status=triggered",
        "  type=price_cross",
        "marketSnapshot:",
        "  market=BTC",
      ].join("\n"),
    );
    expect(fromFlat?.triggeringWatchType).toBe("price_cross");
    expect(fromFlat?.cause).toBe("market_watch_triggered");
    expect(fromFlat?.occurredAtMillis).toBe(1_700_000);
  });

  // A wake with no watch behind it must not borrow one, or a scheduled
  // reassessment would render with a fired-watch icon.
  it("names no watch type when the wake was not a watch", () => {
    const card = deriveWakeupCard(
      JSON.stringify({ ...wakeup, cause: "scheduled_reassessment", triggeringWatch: undefined }),
    );
    expect(card?.triggeringWatchType).toBeNull();
  });

  it("leaves anything that is not a wakeup alone", () => {
    expect(deriveWakeupCard("what is the price of ETH?")).toBeNull();
    expect(deriveWakeupCard('{"kind":"something-else","cause":"x"}')).toBeNull();
    expect(deriveWakeupCard('{"kind":"trading-harness-wakeup",')).toBeNull();
    expect(deriveWakeupCard("")).toBeNull();
  });
});

describe("deriveStrategyPlan", () => {
  // A plan mirroring the eight-field contract shape, accessed structurally —
  // the same way the projection hands it to the derivation.
  const strategy = {
    market: "ETH",
    intent: "long",
    entry: {
      triggers: [
        { description: "1m candle closes above 1860", timeframe: "1m", priceLevel: 1860 },
        { description: "mark reclaims the ema" },
      ],
      urgency: "patient",
      initialNotionalUsd: 500,
    },
    stop: {
      method: "previous_swing_low",
      price: 1840,
      maximumPlannedLossUsd: 20,
    },
    target: { profitUsd: 18.5 },
    invalidation: ["1m candle closes back below 1855", "mark loses the ema and rolls over"],
    reassess: { afterMinutes: 45 },
    because: "Trend up on the 1m (directionScore positive); buy the first pullback.",
  } as const;

  const mission = { position: null, strategy };

  it("returns null before a strategy has been published", () => {
    expect(deriveStrategyPlan({ strategy: null })).toBeNull();
  });

  it("carries the narrative as the one prose field, and null when none was published", () => {
    expect(deriveStrategyPlan(mission)?.because).toBe(
      "Trend up on the 1m (directionScore positive); buy the first pullback.",
    );

    // The schema decodes an omitted because to "" — the card must not render
    // an empty headline.
    const without = deriveStrategyPlan({
      position: null,
      strategy: { ...strategy, because: "  " },
    })!;
    expect(without.because).toBeNull();
  });

  it("flattens entry triggers and invalidation into prose lists", () => {
    const plan = deriveStrategyPlan(mission)!;
    expect(plan.entryTriggers).toEqual(["1m candle closes above 1860", "mark reclaims the ema"]);
    expect(plan.invalidation).toEqual([
      "1m candle closes back below 1855",
      "mark loses the ema and rolls over",
    ]);
  });

  // The trigger union's string branch is an input affordance only; the
  // persisted/encoded form is always { description }. A bare string here would
  // be malformed, and the guard returns null rather than rendering it raw.
  it("ignores a trigger element that is not the decoded object shape", () => {
    const plan = deriveStrategyPlan({
      position: null,
      strategy: {
        ...strategy,
        entry: {
          ...strategy.entry,
          triggers: [
            { description: "1m candle closes above 1860" },
            "bare prose string",
            { noDescription: true },
          ],
        },
      },
    })!;
    expect(plan.entryTriggers).toEqual(["1m candle closes above 1860"]);
  });

  it("combines the stop method and price into one readable line", () => {
    expect(deriveStrategyPlan(mission)?.stopSummary).toBe("previous swing low · 1,840");
  });

  it("falls back to the method alone when no stop price is set", () => {
    const plan = deriveStrategyPlan({
      position: null,
      strategy: { ...strategy, stop: { ...strategy.stop, price: undefined } },
    })!;
    expect(plan.stopSummary).toBe("previous swing low");
  });

  // The target leg is optional on the new document: a plan that named no rung
  // reads null, and so does every stand-aside.
  it("carries the profit target when the plan named one, null when it did not", () => {
    expect(deriveStrategyPlan(mission)?.targetUsd).toBe(18.5);
    expect(
      deriveStrategyPlan({
        position: null,
        strategy: { ...strategy, target: {} },
      })?.targetUsd,
    ).toBeNull();
  });

  // The stand-aside publish: the turn read the market, found nothing worth
  // taking after costs, and recorded that — as the intent, not a code on a
  // trade plan. The flag is what stops the panel from drawing a target level
  // on a trade that was declined.
  it("flags a stand-aside plan from its intent", () => {
    const plan = deriveStrategyPlan({
      position: null,
      strategy: { ...strategy, intent: "stand_aside" },
    })!;
    expect(plan.isStandAside).toBe(true);
  });

  it("does not flag an ordinary plan as a stand-aside", () => {
    expect(deriveStrategyPlan(mission)?.isStandAside).toBe(false);
  });

  // The intent is the direction every surface labels the plan with now — the
  // stand-down code it used to be is gone, and the label is its replacement.
  it("labels the intent as prose a surface can print directly", () => {
    expect(deriveStrategyPlan(mission)?.intentLabel).toBe("Long");
    expect(
      deriveStrategyPlan({ position: null, strategy: { ...strategy, intent: "short" } })
        ?.intentLabel,
    ).toBe("Short");
    expect(
      deriveStrategyPlan({ position: null, strategy: { ...strategy, intent: "stand_aside" } })
        ?.intentLabel,
    ).toBe("Stand aside");
  });

  // Plan 29 step 4.7: no version field may appear in anything the surfaces
  // derive. The document has no version, so the derivation cannot invent one —
  // and a regression would have to add the word to fail this.
  it("carries no version field anywhere in the derived plan", () => {
    const plan = deriveStrategyPlan(mission)!;
    expect(JSON.stringify(plan)).not.toContain("version");
    expect(JSON.stringify(plan)).not.toContain("Version");
  });

  it("derives the phase from what the mission holds, not from a named action", () => {
    // Flat is waiting; a position is holding — the two states the old
    // nine-value currentAction collapsed to (plan 29 step 4.4).
    expect(deriveStrategyPlan(mission)?.planPhase).toBe("waiting");
    expect(deriveStrategyPlan({ ...mission, position: { size: 0 } })?.planPhase).toBe("waiting");
    expect(deriveStrategyPlan({ ...mission, position: { size: -0.3 } })?.planPhase).toBe("holding");
  });

  it("humanizes the entry urgency as the order-type line", () => {
    // urgency is the only order knob the model names now; the old
    // orderPreference echo is gone.
    expect(deriveStrategyPlan(mission)?.orderType).toBe("patient");
    expect(
      deriveStrategyPlan({
        position: null,
        strategy: { ...strategy, entry: { ...strategy.entry, urgency: "now" } },
      })?.orderType,
    ).toBe("now");
  });

  it("carries the reassess window the plan declared", () => {
    expect(deriveStrategyPlan(mission)?.reassessMinutes).toBe(45);
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

  it("carries the met flag from a triggered watch while the position is open", () => {
    expect(
      deriveChartConditions(
        { watches: [{ ...priceCross, status: "triggered" as const }] },
        {
          entryPrice: 1_900,
          size: 0.5,
        },
      )[0],
    ).toMatchObject({ met: true });
  });

  it("drops a fired watch once the mission is flat", () => {
    // The stop and target of a closed trade are levels nothing is waiting on.
    // Left drawn, they stayed on the chart with a tick beside them for the
    // rest of the session, next to the position card that had gone.
    expect(
      deriveChartConditions({ watches: [{ ...priceCross, status: "triggered" as const }] }),
    ).toEqual([]);
    // An armed one still is waiting, so it stays.
    expect(deriveChartConditions({ watches: [priceCross] })).toHaveLength(1);
  });
});

describe("deriveNextReassessmentAt", () => {
  const reassessment = (id: string, runAt: number, status: "active" | "consumed" = "active") => ({
    id,
    missionId: "mission-1",

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

  it("keys a marker by its rank, so a re-arm is the same marker moving", () => {
    // A reassessment is re-armed on every wake: the row that carried it is
    // consumed and a new row, minutes further out, takes its place. Keyed by
    // row id the chart unmounts one rule and mounts another, so the reset reads
    // as two rules rather than as one sliding right. Keyed by rank, the nearest
    // reassessment is one continuous thing whatever row is carrying it.
    const before = deriveChartTimeMarkers({ watches: [reassessment("row-1", 1_700_000_120_000)] });
    const after = deriveChartTimeMarkers({ watches: [reassessment("row-2", 1_700_000_600_000)] });

    expect(before[0]?.key).toBe("reassess-0");
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.at).toBeGreaterThan(before[0]!.at);
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

describe("deriveRoundTrips", () => {
  const fill = (over: {
    readonly orderId: number;
    readonly tradedAt: string;
    readonly filledSize: number;
    readonly avgFillPrice: number;
    readonly feeUsd: number;
    readonly closedPnl: number;
    readonly direction?: string;
  }) => over;

  // The projection hands fills over newest first, so every fixture below is in
  // that order — pairing that only worked on a sorted input would pass a test
  // and fail on the real thing.
  const openLong = fill({
    orderId: 1,
    tradedAt: "2026-08-06T12:00:00.000Z",
    filledSize: 0.2631,
    avgFillPrice: 1_899.8,
    feeUsd: 0.02,
    closedPnl: 0,
    direction: "Open Long",
  });
  const closeLong = fill({
    orderId: 2,
    tradedAt: "2026-08-06T12:06:00.000Z",
    filledSize: 0.2631,
    avgFillPrice: 1_900.16,
    feeUsd: 0.02,
    closedPnl: 0.14,
    direction: "Close Long",
  });

  it("pairs an open with the close that ended it", () => {
    const trips = deriveRoundTrips([closeLong, openLong]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.direction).toBe("long");
    expect(trips[0]!.size).toBe(0.2631);
    expect(trips[0]!.entryPrice).toBe(1_899.8);
    expect(trips[0]!.exitPrice).toBe(1_900.16);
    expect(trips[0]!.openOrderRef).toBe("1");
    expect(trips[0]!.orderRef).toBe("2");
    expect(trips[0]!.closedAtMillis).toBe(Date.parse("2026-08-06T12:06:00.000Z"));
    expect(trips[0]!.openedAtMillis).toBe(Date.parse("2026-08-06T12:00:00.000Z"));
  });

  // The whole point of the pill's net figure: what the pair cost, not what the
  // exchange attributed to the closing leg alone.
  it("nets BOTH legs' fees out of the realised PnL", () => {
    const trips = deriveRoundTrips([closeLong, openLong]);

    expect(trips[0]!.closedPnlUsd).toBe(0.14);
    expect(trips[0]!.feesUsd).toBeCloseTo(0.04, 10);
    expect(trips[0]!.netUsd).toBeCloseTo(0.1, 10);
  });

  // The projection carries a bounded window of fills. A position whose opening
  // fill has scrolled off it was still a position the mission held, so it is
  // reported with the half that is known rather than dropped.
  it("reports a close whose open is off the window, with a null entry", () => {
    const trips = deriveRoundTrips([closeLong]);

    expect(trips).toHaveLength(1);
    expect(trips[0]!.entryPrice).toBeNull();
    expect(trips[0]!.openedAtMillis).toBeNull();
    expect(trips[0]!.openOrderRef).toBeNull();
    // Only the closing leg's fee is known, so only it is charged.
    expect(trips[0]!.feesUsd).toBeCloseTo(0.02, 10);
  });

  // The position on the panel right now is the stat grid's subject. An open
  // with no close is not history and must not be reported as though it were.
  it("excludes the position that is still open", () => {
    expect(deriveRoundTrips([openLong])).toEqual([]);
  });

  it("returns completed trips newest first", () => {
    const secondOpen = fill({
      orderId: 3,
      tradedAt: "2026-08-06T12:10:00.000Z",
      filledSize: 0.5,
      avgFillPrice: 1_910,
      feeUsd: 0.03,
      closedPnl: 0,
      direction: "Open Short",
    });
    const secondClose = fill({
      orderId: 4,
      tradedAt: "2026-08-06T12:20:00.000Z",
      filledSize: 0.5,
      avgFillPrice: 1_905,
      feeUsd: 0.03,
      closedPnl: 2.5,
      direction: "Close Short",
    });

    const trips = deriveRoundTrips([secondClose, secondOpen, closeLong, openLong]);

    expect(trips.map((trip) => trip.orderRef)).toEqual(["4", "2"]);
    expect(trips[0]!.direction).toBe("short");
  });

  // A reversal is one fill doing two things, and its single fee must be
  // charged once — to the leg it closed.
  it("reads a reversal as a close and an open, charging its fee once", () => {
    // One fill of 0.5262: 0.2631 of it gives the long back, 0.2631 takes the
    // short on. That is what a reversal is on the wire.
    const reverse = fill({
      orderId: 5,
      tradedAt: "2026-08-06T12:06:00.000Z",
      filledSize: 0.5262,
      avgFillPrice: 1_900.16,
      feeUsd: 0.02,
      closedPnl: 0.14,
      direction: "Long > Short",
    });
    const closeShort = fill({
      orderId: 6,
      tradedAt: "2026-08-06T12:09:00.000Z",
      filledSize: 0.2631,
      avgFillPrice: 1_890,
      feeUsd: 0.02,
      closedPnl: 1,
      direction: "Close Short",
    });

    const trips = deriveRoundTrips([closeShort, reverse, openLong]);

    expect(trips).toHaveLength(2);
    // Newest first: the short the reversal opened, then the long it closed.
    expect(trips[0]!.direction).toBe("short");
    expect(trips[0]!.entryPrice).toBe(1_900.16);
    expect(trips[0]!.feesUsd).toBeCloseTo(0.02, 10);
    expect(trips[0]!.size).toBeCloseTo(0.2631, 10);
    expect(trips[1]!.direction).toBe("long");
    expect(trips[1]!.feesUsd).toBeCloseTo(0.04, 10);
    // Only the half of the fill that gave the long back is the long's exit.
    expect(trips[1]!.size).toBeCloseTo(0.2631, 10);
  });

  // Plan 34 step 4: the live ledger's rows were individually wrong while the
  // column total stayed right. Mission 38502fa8, replayed at the per-order
  // grain the projection serves: one 0.474 short opened as a single order,
  // banked in three rungs.
  it("splits an open leg across the closes that consume it", () => {
    const openShort = fill({
      orderId: 57_981_716_530,
      tradedAt: "2026-08-17T22:11:20.144Z",
      filledSize: 0.474,
      avgFillPrice: 1_905.11,
      feeUsd: 0.406359,
      closedPnl: 0,
      direction: "Open Short",
    });
    const firstRung = fill({
      orderId: 57_981_968_170,
      tradedAt: "2026-08-17T22:20:32.315Z",
      filledSize: 0.0956,
      avgFillPrice: 1_903.7,
      feeUsd: 0.027299,
      closedPnl: 0.134796,
      direction: "Close Short",
    });
    const secondRung = fill({
      orderId: 57_981_979_732,
      tradedAt: "2026-08-17T22:20:55.664Z",
      filledSize: 0.0394,
      avgFillPrice: 1_903.7,
      feeUsd: 0.011248,
      closedPnl: 0.055554,
      direction: "Close Short",
    });
    const finalRung = fill({
      orderId: 57_982_033_147,
      tradedAt: "2026-08-17T22:22:38.725Z",
      filledSize: 0.339,
      avgFillPrice: 1_904.82,
      feeUsd: 0.290579,
      closedPnl: 0.09743,
      direction: "Close Short",
    });

    const trips = deriveRoundTrips([finalRung, secondRung, firstRung, openShort]);

    expect(trips).toHaveLength(3);
    // Every row knows where it was entered — none of them used to.
    for (const trip of trips) {
      expect(trip.entryPrice).toBeCloseTo(1_905.11, 10);
      expect(trip.openOrderRef).toBe("57981716530");
    }
    // Each rung pays its own share of the opening fee, in proportion to the
    // exposure it took off. Newest first.
    expect(trips[2]!.netUsd).toBeCloseTo(0.02554, 4);
    expect(trips[1]!.netUsd).toBeCloseTo(0.010528, 4);
    expect(trips[0]!.netUsd).toBeCloseTo(-0.483772, 4);
    // And the total is what it always was: the mission's real net.
    const total = trips.reduce((sum, trip) => sum + trip.netUsd, 0);
    expect(total).toBeCloseTo(-0.447705, 6);
  });

  // `side` alone cannot tell an open from a close, so an unlabelled fill is
  // skipped rather than paired into a position that never happened.
  it("skips a fill the exchange did not label", () => {
    expect(deriveRoundTrips([{ ...closeLong, direction: undefined }])).toEqual([]);
  });

  it("drops fills with an unparseable timestamp", () => {
    expect(deriveRoundTrips([{ ...closeLong, tradedAt: "not a date" }])).toEqual([]);
  });
});

describe("derivePositionLedger", () => {
  const trip = {
    direction: "long" as const,
    size: 0.2631,
    entryPrice: 1_899.8,
    exitPrice: 1_900.16,
    netUsd: 0.1,
    closedPnlUsd: 0.14,
    feesUsd: 0.04,
    closedAtMillis: 1_700_000_060_000,
    openedAtMillis: 1_700_000_000_000,
    orderRef: "2",
    openOrderRef: "1",
  };
  const position = {
    size: 0.5,
    entryPrice: 1_864.2,
    unrealisedPnl: 2.6,
    marginUsed: 186.42,
  };

  it("puts the open position first, marked active, with the mark as its exit", () => {
    const rows = derivePositionLedger({
      position,
      markPrice: 1_869.4,
      trips: [trip],
      openedAtMillis: 1_699_999_000_000,
    });

    expect(rows.map((row) => row.isActive)).toEqual([true, false]);
    const open = rows[0]!;
    expect(open.exitPrice).toBe(1_869.4);
    // The open row's money figure is what it is holding, not what it settled.
    expect(open.netUsd).toBe(2.6);
    expect(open.closedPnlUsd).toBeNull();
    expect(open.feesUsd).toBeNull();
    expect(open.marginUsd).toBe(186.42);
    expect(open.openedAtMillis).toBe(1_699_999_000_000);
  });

  it("reads the side off the sign of the exposure", () => {
    const [row] = derivePositionLedger({
      position: { ...position, size: -0.5 },
      markPrice: 1_869.4,
      trips: [],
      openedAtMillis: null,
    });
    expect(row?.direction).toBe("short");
    expect(row?.size).toBe(0.5);
  });

  it("commits a notional from the price the position opened at", () => {
    const rows = derivePositionLedger({
      position,
      markPrice: 1_869.4,
      trips: [trip],
      openedAtMillis: null,
    });
    expect(rows[0]!.notionalUsd).toBeCloseTo(932.1, 6);
    expect(rows[1]!.notionalUsd).toBeCloseTo(499.837_38, 6);
  });

  // The exit price is not a stand-in for an unknown entry: a position that ran
  // a long way would report a notional it never had.
  it("states no notional when the opening price is off the fill window", () => {
    const rows = derivePositionLedger({
      position: null,
      markPrice: 1_869.4,
      trips: [{ ...trip, entryPrice: null }],
      openedAtMillis: null,
    });
    expect(rows[0]!.notionalUsd).toBeNull();
    expect(rows[0]!.entryPrice).toBeNull();
  });

  it("shows only settled rows when the mission is flat", () => {
    expect(
      derivePositionLedger({
        position: { size: 0, unrealisedPnl: 0 },
        markPrice: 1_869.4,
        trips: [trip],
        openedAtMillis: null,
      }).map((row) => row.isActive),
    ).toEqual([false]);
  });

  it("leaves the open row's exit empty when no mark has been read", () => {
    const [row] = derivePositionLedger({
      position,
      markPrice: null,
      trips: [],
      openedAtMillis: null,
    });
    expect(row?.exitPrice).toBeNull();
  });
});

describe("formatFixed3", () => {
  // Fixed, not trimmed: equal widths are what let the ledger's price column
  // right-align and have its arrows line up too.
  it("always shows three decimals, and rounds a longer figure to them", () => {
    expect(formatFixed3(0.5)).toBe("0.500");
    expect(formatFixed3(0.2631)).toBe("0.263");
    expect(formatFixed3(1_899.8)).toBe("1,899.800");
    expect(formatFixed3(1_900.16)).toBe("1,900.160");
    expect(formatFixed3(2.9999999999999996)).toBe("3.000");
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
        strategy: { stop: { price: 1_890 } },
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
    expect(items[0]?.label).toBe("wake at +$2.00");
    expect(items[0]?.chip).toBe("target");
    // The target's price, resolved through the exposure it is measured on.
    expect(items[0]?.priceLevel).toBe(1_902);
  });

  it("measures a target's distance from the evaluator's net reading, not gross PnL", () => {
    // The evaluator compares net of the exit still to pay, so a position gross
    // at the target is not yet at it. Reading the gross figure said "at it".
    const items = deriveUpNextItems(
      {
        ...flatMission,
        position: { size: 1, entryPrice: 1_900, unrealisedPnl: 2 },
        watches: [
          {
            ...watch("near", { type: "pnl_above", market: "ETH", valueUsd: 2 }, "profit_target"),
            lastObservedValue: 1.75,
          },
        ],
      },
      NOW,
    );
    expect(items[0]?.detail).toBe("$0.25 away");
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
        // Flat is the waiting phase now — there is no named action to gate on.
        strategy: {
          entry: {
            triggers: [
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
          entry: { triggers: [{ description: "…", priceLevel: 1_899 }] },
        },
      },
      NOW,
    );
    expect(items).toEqual([]);
  });
});

describe("deriveChartPastMarkers", () => {
  it("parses the projection's ISO moments into axis millis, order preserved", () => {
    const markers = deriveChartPastMarkers({
      missionTimeline: [
        { at: "2026-08-06T12:03:00.000Z", kind: "stop_adjusted", label: "trail_peak" },
        {
          at: "2026-08-06T12:00:00.000Z",
          kind: "wake",
          label: "scheduled_reassessment",
          cause: "scheduled_reassessment",
        },
      ],
    });

    expect(markers.map((marker) => marker.kind)).toEqual(["stop_adjusted", "wake"]);
    expect(markers[0]!.at).toBe(Date.parse("2026-08-06T12:03:00.000Z"));
    expect(markers[1]!.at).toBe(Date.parse("2026-08-06T12:00:00.000Z"));
  });

  // A tick at a time it did not happen is worse than no tick, so an entry whose
  // moment will not parse is dropped rather than filed at zero.
  it("drops an entry with an unparseable moment", () => {
    expect(
      deriveChartPastMarkers({
        missionTimeline: [{ at: "not-a-time", kind: "wake", label: "user_message" }],
      }),
    ).toEqual([]);
  });

  it("reads a failed run off the label the projection composed", () => {
    const markers = deriveChartPastMarkers({
      missionTimeline: [
        {
          at: "2026-08-06T12:00:00.000Z",
          kind: "wake",
          label: "market_watch_triggered (failed)",
          cause: "market_watch_triggered",
        },
      ],
    });
    expect(markers[0]).toMatchObject({ failed: true, cause: "market_watch_triggered" });
  });

  it("is empty for a mission with no timeline at all", () => {
    expect(deriveChartPastMarkers({})).toEqual([]);
  });
});

describe("deriveTriggerExpiryMillis", () => {
  const publishedAt = 1_700_000_000_000;

  it("is the publish plus the plan's own freshness window", () => {
    expect(
      deriveTriggerExpiryMillis({
        position: null,
        strategy: { updatedAt: publishedAt, reassess: { afterMinutes: 90 } },
      }),
    ).toBe(publishedAt + 90 * 60_000);
  });

  it("is null while a position is held", () => {
    // `reassess` bounds an UNtriggered plan. The levels a holding mission
    // watches — its profit rung, its stop proximity — are not on that clock,
    // and cutting them short in the gutter would say they lapse when they do
    // not.
    expect(
      deriveTriggerExpiryMillis({
        position: { size: 0.4 },
        strategy: { updatedAt: publishedAt, reassess: { afterMinutes: 90 } },
      }),
    ).toBeNull();
  });

  it("is null before a plan is published", () => {
    expect(deriveTriggerExpiryMillis({ position: null, strategy: null })).toBeNull();
  });
});
