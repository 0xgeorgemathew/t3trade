import { describe, expect, it } from "vite-plus/test";

import {
  MISSION_STATUS_LABELS,
  deriveCompletionSummary,
  deriveMissionStrip,
  deriveRejectedOrder,
  describeWatch,
  formatDuration,
  formatUsd,
  humanizeLiteral,
  isMissionComplete,
  isPositionDataStale,
  shouldShowMissionStrip,
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
  const armed = {
    status: "waiting" as const,
    position: null,
    authority: { maximumCumulativeLossUsd: 100 },
  };
  const exposed = {
    status: "position_open" as const,
    position: { size: 0.5 },
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
    expect(deriveMissionStrip({ ...exposed, position: { size: -0.25 } }).exposureLabel).toBe(
      "Short 0.25",
    );
    expect(deriveMissionStrip(armed).exposureLabel).toBe("Flat");
  });
});

describe("stale-data banner", () => {
  const now = 1_700_000_000_000;

  it("stays quiet on a fresh position read", () => {
    const observedAt = new Date(now - 1_000).toISOString();
    expect(isPositionDataStale({ position: { observedAt } }, now)).toBe(false);
  });

  it("fires once the read passes the 5s account window", () => {
    const observedAt = new Date(now - 6_000).toISOString();
    expect(isPositionDataStale({ position: { observedAt } }, now)).toBe(true);
  });

  it("stays quiet when there is no position to be stale about", () => {
    expect(isPositionDataStale({ position: null }, now)).toBe(false);
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
