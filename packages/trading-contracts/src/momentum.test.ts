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
