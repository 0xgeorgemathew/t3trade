/**
 * What the momentum read claims, held to arithmetic.
 *
 * Every case here is built from candles whose answer can be worked out by hand,
 * because the whole point of this module is that it models nothing: a number it
 * reports that cannot be recomputed from the bars is a number the harness
 * should not be trading on.
 */
import { assert, describe, it } from "@effect/vitest";

import type { MarketCandle } from "./market.ts";
import {
  analyseMomentum,
  analyseTimeframe,
  classifyRegime,
  compareCandidates,
  DIRECTION_SCORE_THRESHOLD,
  findPivots,
  MIN_MOMENTUM_BARS,
} from "./momentum.ts";

/** A bar with a given close and a fixed range around it. */
const bar = (close: number, spread = 1): MarketCandle => ({
  openTime: 0,
  closeTime: 0,
  open: close,
  close,
  high: close + spread,
  low: close - spread,
  volume: 1,
});

/** `count` bars, each `step` above the last. */
const ramp = (from: number, step: number, count: number): Array<MarketCandle> =>
  Array.from({ length: count }, (_, i) => bar(from + step * i));

/** `count` bars alternating up and down by `step`, ending where they started. */
const chop = (around: number, step: number, count: number): Array<MarketCandle> =>
  Array.from({ length: count }, (_, i) => bar(around + (i % 2 === 0 ? step : -step)));

describe("directionScore", () => {
  it("reads a straight line up as 1", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: ramp(3_000, 1, 40) });
    assert.closeTo(frame.directionScore, 1, 1e-9);
    assert.equal(frame.direction, "up");
  });

  it("reads a straight line down as -1", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: ramp(3_000, -1, 40) });
    assert.closeTo(frame.directionScore, -1, 1e-9);
    assert.equal(frame.direction, "down");
  });

  it("reads a window that ends where it started as chop, however far it travelled", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: chop(3_000, 5, 40) });
    // Net travel is one step; total travel is thirty-eight of them.
    assert.ok(Math.abs(frame.directionScore) < DIRECTION_SCORE_THRESHOLD);
    assert.equal(frame.direction, "flat");
  });
});

describe("recentDirectionScore", () => {
  it("turns before the full-window score when a range starts grinding", () => {
    // Ninety bars of chop, then thirty bars grinding up: the 120-bar score is
    // still under the threshold while the 30-bar score is already decisive.
    const candles = [...chop(3_000, 5, 90), ...ramp(3_000, 1, 30)];
    const frame = analyseTimeframe({ interval: "1m", candles });

    assert.ok(Math.abs(frame.directionScore) < DIRECTION_SCORE_THRESHOLD);
    assert.ok(frame.recentDirectionScore > DIRECTION_SCORE_THRESHOLD);
  });

  it("equals the full-window score when the window is shorter than 30 bars", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: ramp(3_000, 1, 20) });
    assert.closeTo(frame.recentDirectionScore, frame.directionScore, 1e-9);
  });
});

/** A descending zigzag: peaks at 110, 105, 100 and troughs at 95, 90, 85. */
const descendingZigzag = (): Array<MarketCandle> => [
  ...ramp(100, 1, 11), // up to 110
  ...ramp(109, -1, 15), // down to 95
  ...ramp(96, 1, 10), // up to 105
  ...ramp(104, -1, 15), // down to 90
  ...ramp(91, 1, 10), // up to 100
  ...ramp(99, -1, 15), // down to 85
  ...ramp(86, 1, 5), // small recovery that confirms the last low pivot
];

describe("pivotTrend", () => {
  it("counts the trailing run of lower highs and lower lows", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: descendingZigzag() });

    // Highs 110 → 105 → 100 and lows 95 → 90 → 85: two lower steps each.
    assert.equal(frame.pivotTrend.consecutiveLowerHighs, 2);
    assert.equal(frame.pivotTrend.consecutiveLowerLows, 2);
    assert.equal(frame.pivotTrend.consecutiveHigherHighs, 0);
    assert.equal(frame.pivotTrend.consecutiveHigherLows, 0);
  });

  it("reports all zeros when the window has no runs", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: chop(3_000, 5, 40) });
    // Chop peaks print the same high every time; an exact repeat is not a run.
    assert.equal(frame.pivotTrend.consecutiveLowerHighs, 0);
    assert.equal(frame.pivotTrend.consecutiveHigherHighs, 0);
  });
});

describe("swing drift", () => {
  it("reads a range grinding lower as drift even while its height holds", () => {
    // Same ±5 oscillation, ten dollars lower in the second half.
    const candles = [...chop(3_000, 5, 60), ...chop(2_990, 5, 60)];
    const frame = analyseTimeframe({ interval: "1m", candles });

    assert.closeTo(frame.swingHighDriftUsd ?? 0, -10, 1e-9);
    assert.closeTo(frame.swingLowDriftUsd ?? 0, -10, 1e-9);
    // The height itself never moved — this is what stability alone misses.
    assert.ok((frame.rangeStabilityPercent ?? 100) < 1);
  });

  it("is absent when either half is too short to measure", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: ramp(3_000, 1, 3) });
    assert.equal(frame.swingHighDriftUsd, undefined);
    assert.equal(frame.swingLowDriftUsd, undefined);
  });
});

describe("regime", () => {
  it("classifies a straight trend as trending", () => {
    const structure = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [
        { interval: "1m", candles: ramp(3_000, 1, 120) },
        { interval: "5m", candles: ramp(3_000, 2, 120) },
      ],
    });

    assert.equal(structure.regime.classification, "trending");
    assert.ok(structure.regime.evidence.length >= 2);
  });

  it("classifies symmetric chop as ranging", () => {
    const regime = classifyRegime([
      analyseTimeframe({ interval: "1m", candles: chop(3_000, 5, 120) }),
    ]);

    assert.equal(regime.classification, "ranging");
    assert.equal(regime.conflicts.length, 0);
  });

  it("refuses to call a grind-down a range, and names the conflicts", () => {
    // Ninety bars of chop, then thirty bars grinding down: the long score
    // still reads flat while the recent score and the window halves disagree.
    const candles = [...chop(3_000, 5, 90), ...ramp(3_000, -1, 30)];
    const regime = classifyRegime([analyseTimeframe({ interval: "1m", candles })]);

    assert.notEqual(regime.classification, "ranging");
    assert.ok(regime.conflicts.length > 0);
  });

  it("returns transition with no evidence when nothing was measurable", () => {
    const regime = classifyRegime([analyseTimeframe({ interval: "1m", candles: [] })]);
    assert.equal(regime.classification, "transition");
    assert.deepEqual(regime.evidence, []);
  });
});

describe("trend_continuation setup", () => {
  it("scores a drift resuming after a shallow pullback, close-confirmed at the impulse end", () => {
    const structure = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: descendingZigzag() }],
    });

    const continuation = structure.setups.find((setup) => setup.kind === "trend_continuation");
    assert.ok(continuation !== undefined);
    assert.equal(continuation.direction, "down");
    // The trigger is the pullback's own extreme — the impulse end price (the
    // last low's bar low, 84) — armed as a candle close, never a touch.
    assert.closeTo(continuation.level, 84, 1e-9);
    assert.equal(continuation.closeConfirmed, true);
    assert.ok(continuation.score > 0);
  });

  it("reports a too-deep pullback as a near-miss rather than silence", () => {
    // Same zigzag, but the recovery retraces most of the last down leg.
    const candles = [...descendingZigzag(), ...ramp(91, 1, 8)];
    const structure = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles }],
    });

    const continuation = structure.setups.find((setup) => setup.kind === "trend_continuation");
    // Plan 29 step 3.4: a failed internal threshold is reported with its
    // margin, not dropped — an 88% pullback against a 50% cap is 38 points
    // past it, and that number is the context the model weighs.
    assert.ok(continuation !== undefined);
    assert.ok(continuation.rejectedBy !== undefined);
    assert.deepEqual(
      continuation.rejectedBy.map(({ gate }) => gate),
      ["pullback_too_deep"],
    );
    assert.ok(continuation.rejectedBy[0]!.margin > 38);
    // The near-miss says so in its own rationale, so the row stands alone.
    assert.include(continuation.rationale, "near-miss");
    // It sorts behind every clean candidate: once the near-misses start, no
    // clean setup follows them.
    const firstNearMiss = structure.setups.findIndex((setup) => setup.rejectedBy !== undefined);
    assert.ok(firstNearMiss !== -1);
    assert.ok(
      structure.setups.slice(firstNearMiss).every((setup) => setup.rejectedBy !== undefined),
    );
  });

  it("carries no rejectedBy on a setup that cleared every gate", () => {
    const structure = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: descendingZigzag() }],
    });

    const continuation = structure.setups.find((setup) => setup.kind === "trend_continuation");
    assert.ok(continuation !== undefined);
    assert.equal(continuation.rejectedBy, undefined);
    assert.equal(continuation.rationale.includes("near-miss"), false);
  });
});

describe("compareCandidates", () => {
  const structure = () =>
    analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: descendingZigzag() }],
    });

  it("joins each setup with the cost of taking it at the given book", () => {
    const rows = compareCandidates(structure(), { breakEvenPriceMoveUsd: 2 });
    const row = rows.find((candidate) => candidate.strategy === "trend_continuation");

    assert.ok(row !== undefined);
    assert.equal(row.direction, "down");
    // The continuation rides the last impulse: 101 → 84 is 17 USD of move,
    // 8.5x a 2 USD break-even. The multiple is context for the entry question,
    // never a gate — no row carries a requirement any more (plan 29 step 3.1).
    assert.closeTo(row.availableMoveUsd ?? 0, 17, 1e-9);
    assert.closeTo(row.costMultiple ?? 0, 8.5, 1e-9);
    assert.equal("requiredCostMultiple" in row, false);
    assert.equal("clearsCostGate" in row, false);
    // The last close is 90 (end of the 86..90 recovery); the trigger is 84.
    assert.closeTo(row.distanceToTriggerUsd, 6, 1e-9);
  });

  it("carries a thin multiple as a number, not a verdict", () => {
    const rows = compareCandidates(structure(), { breakEvenPriceMoveUsd: 15 });
    const row = rows.find((candidate) => candidate.strategy === "trend_continuation");
    // 17 / 15 = 1.13: a near-break-even trade, reported as arithmetic for the
    // turn to weigh rather than as a failed gate.
    assert.closeTo(row?.costMultiple ?? 0, 17 / 15, 1e-9);
  });

  it("reports unknown costs as absent rather than free", () => {
    const rows = compareCandidates(structure(), null);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.costMultiple, undefined);
    // Everything that needs no book still answers.
    assert.ok(row.note.length > 0);
  });

  it("flags a near-miss row in the table without gating it", () => {
    // The too-deep pullback window: the continuation is on the table only as
    // context, visibly flagged and carrying the same cost arithmetic.
    const near = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: [...descendingZigzag(), ...ramp(91, 1, 8)] }],
    });
    const rows = compareCandidates(near, { breakEvenPriceMoveUsd: 2 });
    const row = rows.find((candidate) => candidate.strategy === "trend_continuation");

    assert.ok(row !== undefined);
    assert.ok(row.rejectedBy !== undefined);
    assert.include(row.note, "NEAR-MISS");
    // Flagged, not gated: the row still carries its move and its multiple.
    assert.ok(row.availableMoveUsd !== undefined);
    assert.ok(row.costMultiple !== undefined);
  });
});

describe("atrExpansionRatio", () => {
  it("reports the recent range against the range before it", () => {
    // Fourteen quiet bars, then fourteen with triple the range.
    const quiet = Array.from({ length: 20 }, () => bar(3_000, 1));
    const loud = Array.from({ length: 14 }, () => bar(3_000, 3));
    const frame = analyseTimeframe({ interval: "1m", candles: [...quiet, ...loud] });
    // Range 2 per quiet bar, 6 per loud one — but the leg boundary bar spans
    // both, so assert the direction and magnitude rather than an exact 3.
    assert.ok((frame.atrExpansionRatio ?? 0) > 2.5);
  });

  it("is absent when the window cannot hold two legs", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: ramp(3_000, 1, 20) });
    assert.equal(frame.atrExpansionRatio, undefined);
  });
});

describe("findPivots", () => {
  it("finds the peak of a rise and fall", () => {
    // Ten bars up to a high of 3,010 at index 9, then ten strictly lower.
    const candles = [...ramp(3_000, 1, 10), ...ramp(3_008, -1, 10)];
    const highs = findPivots(candles, "high");
    assert.deepEqual(highs, [9]);
  });

  it("never confirms a pivot in the newest bars", () => {
    // A high on the very last bar is a high price is still making.
    const candles = ramp(3_000, 1, 20);
    assert.deepEqual(findPivots(candles, "high"), []);
  });
});

describe("lastImpulse", () => {
  it("measures the last leg pivot to pivot and dates it", () => {
    // Down to a low of 2,988 over eleven bars, up to a high of 3,010 over
    // twenty-one, then three quiet bars — too few to confirm a pivot of their
    // own, so the up leg is still the last completed one.
    const candles = [
      ...ramp(3_000, -1, 11),
      ...ramp(2_989, 1, 21),
      ...Array.from({ length: 3 }, () => bar(3_005)),
    ];
    const frame = analyseTimeframe({ interval: "1m", candles });
    const impulse = frame.lastImpulse;

    assert.equal(impulse?.direction, "up");
    // From the swing low's low to the swing high's high.
    assert.closeTo(impulse?.startPrice ?? 0, 2_988, 1e-9);
    assert.closeTo(impulse?.endPrice ?? 0, 3_010, 1e-9);
    assert.closeTo(impulse?.sizeUsd ?? 0, 22, 1e-9);
    // Three quiet bars printed after the leg ended.
    assert.equal(impulse?.ageBars, 3);
  });

  it("measures the pullback against the impulse it is undoing", () => {
    // Twenty bars up to 3,020, then five back down to 3,015 — a quarter given
    // back off a twenty-dollar leg.
    const candles = [
      ...Array.from({ length: 5 }, () => bar(3_000)),
      ...ramp(3_001, 1, 20),
      ...ramp(3_019, -1, 5),
    ];
    const frame = analyseTimeframe({ interval: "1m", candles });

    assert.equal(frame.lastImpulse?.direction, "up");
    assert.ok((frame.pullbackDepthUsd ?? 0) > 0);
    assert.closeTo(
      frame.pullbackDepthUsd ?? 0,
      (frame.lastImpulse?.endPrice ?? 0) - (3_015 - 1),
      1e-9,
    );
  });
});

describe("swing distances", () => {
  it("signs the distance so a broken level reads as a breakout", () => {
    // Rises to a swing high at bar 9, pulls back, then trades clean through it.
    const candles = [...ramp(3_000, 1, 10), ...ramp(3_008, -1, 6), ...ramp(3_004, 2, 12)];
    const frame = analyseTimeframe({ interval: "1m", candles });

    // The last close is above the most recent confirmed swing high, so the
    // distance up to it is negative: it is behind price, not ahead of it.
    assert.ok((frame.distanceToSwingHighUsd ?? 0) < 0);
    // And the swing low below is still a real level underneath.
    assert.ok((frame.distanceToSwingLowUsd ?? 0) > 0);
  });
});

describe("alignment", () => {
  it("calls a direction only when a majority of timeframes agree", () => {
    const context = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [
        { interval: "1m", candles: ramp(3_000, 1, 40) },
        { interval: "5m", candles: ramp(3_000, 2, 40) },
        { interval: "15m", candles: ramp(3_000, -1, 40) },
      ],
    });

    assert.equal(context.alignment.direction, "up");
    assert.equal(context.alignment.agreeingTimeframes, 2);
    assert.equal(context.alignment.measuredTimeframes, 3);
  });

  it("reports contradiction as mixed rather than as a weak direction", () => {
    const context = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [
        { interval: "1m", candles: ramp(3_000, 1, 40) },
        { interval: "15m", candles: ramp(3_000, -1, 40) },
      ],
    });

    assert.equal(context.alignment.direction, "mixed");
    assert.match(context.alignment.note, /contradict/);
  });

  it("says so when every timeframe is chopping", () => {
    const context = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [
        { interval: "1m", candles: chop(3_000, 5, 40) },
        { interval: "5m", candles: chop(3_000, 5, 40) },
      ],
    });

    assert.equal(context.alignment.direction, "mixed");
    assert.match(context.alignment.note, /chopping/);
  });

  it("ignores a timeframe that had too few bars to speak", () => {
    const short = MIN_MOMENTUM_BARS - 1;
    const context = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [
        { interval: "1m", candles: ramp(3_000, 1, 40) },
        { interval: "1h", candles: ramp(3_000, -1, short) },
      ],
    });

    // The short window is still reported, so the harness can see what was
    // missing — it just does not get a vote.
    assert.equal(context.timeframes.length, 2);
    assert.equal(context.timeframes[1]?.sufficientData, false);
    assert.equal(context.alignment.measuredTimeframes, 1);
    assert.equal(context.alignment.direction, "up");
  });

  it("says nothing rather than guessing when no timeframe had enough bars", () => {
    const context = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: ramp(3_000, 1, 5) }],
    });

    assert.equal(context.alignment.direction, "mixed");
    assert.equal(context.alignment.measuredTimeframes, 0);
    assert.match(context.alignment.note, /enough bars/);
  });

  it("survives an empty window without reporting a zero-priced market", () => {
    const context = analyseMomentum({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: [] }],
    });

    const frame = context.timeframes[0];
    assert.equal(frame?.sufficientData, false);
    assert.equal(frame?.barsObserved, 0);
    assert.equal(frame?.referencePrice, 1);
    assert.equal(frame?.lastImpulse, undefined);
  });
});
