/**
 * The range-scalp procedure, run end to end over the pure functions it is made
 * of — the acceptance the `range_reversion` playbook in `./playbook.ts` is
 * written against (the doctrine moved out of `POC_DEFAULT_INSTRUCTION`).
 *
 * Every gate the prose states is arithmetic somewhere in this package:
 * `measureVolatility` publishes the range and where the mark sits in it,
 * `estimateTradingCosts` prices the crossing, and `checkProfitTarget` grades
 * the published target. This file walks a window shaped like the audited
 * two-hour ETH window — a $7.30 range oscillating on a ~46-minute cycle — from
 * the regime read to the publish, and pins both endings: the stand-down with
 * its arithmetic shown, and the edge entry that clears its costs.
 *
 * @module RangeScalpAcceptance
 */
import { describe, expect, it } from "@effect/vitest";

import { checkProfitTarget, estimateTradingCosts, type CostEstimateInput } from "./costs.ts";
import type { MarketCandle } from "./market.ts";
import { ACTIVE_TRADING_POLICY } from "./policy.ts";
import { measureVolatility } from "./volatility.ts";

/** The audited window's boundaries, and the height a scalp is paid out of. */
const RANGE_LOW = 3_404.8;
const RANGE_HEIGHT = 7.3;
const RANGE_HIGH = RANGE_LOW + RANGE_HEIGHT;

/**
 * Bars in one full crossing and back — the "cycle" the range read reports.
 *
 * A crossing is half of it, so a hold of roughly 23 bars is what the range
 * pays over, and 46 is the shortest span guaranteed to contain both a touch of
 * the high and a touch of the low.
 */
const CYCLE_BARS = 46;

/**
 * Range height over the round trip at which a range is worth working
 * repeatedly rather than scalping once — read from the policy in force. Not a
 * gate (plan 29 step 3.1 took the entry multiple out); the multiple the
 * assertions below compute is the context the entry question weighs.
 */
const RANGE_COST_MULTIPLE = ACTIVE_TRADING_POLICY.rangeReversion.heightCostMultiple;

/** Share of the range height the scalp actually tries to capture. */
const CAPTURE_FRACTION = 0.65;

/** Where in the cycle bar `index` sits, as 0 on the floor and 1 on the ceiling. */
const cyclePosition = (index: number): number => {
  const phase = index % CYCLE_BARS;
  const half = CYCLE_BARS / 2;
  return phase <= half ? phase / half : (CYCLE_BARS - phase) / half;
};

/**
 * A window that crosses the range and comes back, over and over.
 *
 * Each bar spans the move it made, so the window's high and low are the range's
 * own boundaries rather than something wider invented by wicks. Where the
 * window is cut decides where the last close lands, which is the whole point:
 * the same market reads mid-range on one bar and on an edge a few bars later.
 */
const rangingWindow = (bars: number): Array<MarketCandle> =>
  Array.from({ length: bars }, (_unused, index) => {
    const close = RANGE_LOW + RANGE_HEIGHT * cyclePosition(index);
    const open = index === 0 ? RANGE_LOW : RANGE_LOW + RANGE_HEIGHT * cyclePosition(index - 1);
    return {
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000,
      open,
      close,
      high: Math.max(open, close),
      low: Math.min(open, close),
      volume: 1,
    };
  });

const measure = (bars: number) =>
  measureVolatility({
    market: "ETH",
    interval: "1m",
    candles: rangingWindow(bars),
    measuredAt: 1_700_000,
  });

/** The book a 1 ETH scalp is costed against: a dime wide, deep enough to fill. */
const costsAt = (referencePrice: number, takerFeeBpsPerSide: number): CostEstimateInput => ({
  market: "ETH",
  sizeEth: 1,
  referencePrice,
  takerFeeBpsPerSide,
  feeRateSource: "hyperliquid_user_fees",
  bids: [{ price: referencePrice - 0.05, size: 50 }],
  asks: [{ price: referencePrice + 0.05, size: 50 }],
  measuredAt: 1_700_000,
  freshness: { observedAt: 1_700_000, source: "info_api", staleAfterMillis: 2_000 },
});

describe("the regime read", () => {
  // Cut at 106 bars the 60-bar horizon has exactly one full cycle of start
  // bars behind it, which is the honest window to judge symmetry on.
  const classified = measure(106);

  it("publishes the range the scalp would trade instead of leaving it to be re-derived", () => {
    expect(classified.swingLowUsd).toBeCloseTo(RANGE_LOW, 6);
    expect(classified.swingHighUsd).toBeCloseTo(RANGE_HIGH, 6);
    expect(classified.swingRangeUsd).toBeCloseTo(RANGE_HEIGHT, 6);
    expect(classified.sufficientData).toBe(true);
  });

  it("reads as ranging: symmetric excursions, and the mark between the edges", () => {
    // Longs and shorts were paid the same over the longest hold — the number
    // the instruction classifies on.
    expect(classified.excursionSymmetryRatio).toBeCloseTo(1, 6);
    // Mid-range, so there is nothing to enter yet: this turn arms a boundary
    // watch and waits.
    expect(classified.positionInRangePercent).toBeGreaterThan(20);
    expect(classified.positionInRangePercent).toBeLessThan(80);
  });

  it("shows the oscillation at an hour-scale hold, not just a twenty-minute one", () => {
    const crossing = classified.horizons.find((horizon) => horizon.holdBars === 30);
    const hourly = classified.horizons.find((horizon) => horizon.holdBars === 60);
    expect(crossing?.holdMinutes).toBe(30);
    expect(hourly?.holdMinutes).toBe(60);
    // Held for a full cycle, the median move available in each direction is
    // half the range — a $3.65 swing on a $7.30 range, which is the size of
    // trade being contemplated and is invisible at the old 20-bar cap.
    expect(hourly?.favourableUpUsd.p50).toBeCloseTo(RANGE_HEIGHT / 2, 6);
    expect(hourly?.favourableDownUsd.p50).toBeCloseTo(RANGE_HEIGHT / 2, 6);
    // The p75 reaches most of a crossing, which is what a 60-70% capture is
    // discounted down from.
    expect(hourly?.favourableUpUsd.p75).toBeGreaterThan(RANGE_HEIGHT * CAPTURE_FRACTION);
  });
});

describe("the boundary wake", () => {
  // The same market a few bars later: the watch armed at the floor has fired.
  const atTheFloor = measure(95);

  it("puts the mark on the edge the entry was waiting for", () => {
    expect(atTheFloor.positionInRangePercent).toBeCloseTo(8.7, 1);
    expect(atTheFloor.positionInRangePercent).toBeLessThan(20);
    // Same range as the classifying read — this is a wake, not a new market.
    expect(atTheFloor.swingRangeUsd).toBeCloseTo(RANGE_HEIGHT, 6);
  });

  // The trap the instruction calls out: a window cut on an edge truncates the
  // last cycle, so its raw symmetry ratio skews even though nothing about the
  // market changed. The classification from the mid-range read is what stands.
  it("skews the symmetry ratio purely by where the window was cut", () => {
    expect(atTheFloor.excursionSymmetryRatio).toBeLessThan(0.8);
  });
});

describe("the cost read", () => {
  const referencePrice = measure(95).referencePrice;

  // This range used to be the worked example of a correct refusal: at 2.08x it
  // sat under the 2.2x the playbook then demanded to enter. The entry multiple
  // is gone (plan 29 step 3.1) — the multiple is context the turn weighs, and
  // a range that pays once over is a thin trade, not a forbidden one.
  it("prices the height at just over two round trips at the taker rate", () => {
    const estimate = estimateTradingCosts(costsAt(referencePrice, 5));

    // Two taker fills at 5 bps on ~$3,405 of notional is $3.41, and the dime
    // of spread crossed twice is another $0.10.
    expect(estimate.roundTripUsd).toBeCloseTo(3.505, 3);
    expect(estimate.breakEvenPriceMoveUsd).toBeCloseTo(3.505, 3);
    const multiple = RANGE_HEIGHT / estimate.breakEvenPriceMoveUsd;
    expect(multiple).toBeCloseTo(2.08, 2);
    expect(multiple).toBeLessThan(RANGE_COST_MULTIPLE);
  });

  it("prices the height below one round trip at a punishing fee tier", () => {
    const estimate = estimateTradingCosts(costsAt(referencePrice, 12));

    const multiple = RANGE_HEIGHT / estimate.breakEvenPriceMoveUsd;
    expect(multiple).toBeLessThan(1);
  });

  it("prices the height at five round trips once the fee tier is the one actually paid", () => {
    const estimate = estimateTradingCosts(costsAt(referencePrice, 2));

    expect(estimate.breakEvenPriceMoveUsd).toBeCloseTo(1.462, 3);
    const multiple = RANGE_HEIGHT / estimate.breakEvenPriceMoveUsd;
    expect(multiple).toBeCloseTo(4.99, 2);
    expect(multiple).toBeGreaterThan(RANGE_COST_MULTIPLE);
  });
});

describe("the published target", () => {
  const referencePrice = measure(95).referencePrice;
  // 65% of the range, not the whole crossing: the far boundary rarely gets
  // touched and the scalp is not there to pick the last dollar.
  const measuredMoveUsd = RANGE_HEIGHT * CAPTURE_FRACTION;
  const basis = {
    measuredMoveUsd,
    referencePrice,
    // 1 ETH at the mark, matching the size the costs were estimated at.
    positionNotionalUsd: referencePrice,
  };
  const targetProfitUsd = (measuredMoveUsd / referencePrice) * basis.positionNotionalUsd;

  it("carries the discounted capture, not the full range height", () => {
    expect(targetProfitUsd).toBeCloseTo(4.745, 3);
    expect(targetProfitUsd).toBeLessThan(RANGE_HEIGHT);
  });

  it("publishes clean at the fee tier the range was cleared against", () => {
    const checked = checkProfitTarget({ targetProfitUsd, basis });

    expect([...checked.rejections]).toEqual([]);
    expect([...checked.warnings]).toEqual([]);
  });

  // Cost is not graded at publish (plan 29 step 3.1): the same target a fee
  // tier cannot pay rides through, and the observation's cost context is where
  // the question is weighed.
  it("publishes a thin target without a cost warning", () => {
    const checked = checkProfitTarget({
      targetProfitUsd: 1.7,
      basis: { ...basis, measuredMoveUsd: 1.7 },
    });

    expect([...checked.rejections]).toEqual([]);
    expect([...checked.warnings]).toEqual([]);
  });

  it("rejects a basis that claims the whole range as the move being taken", () => {
    const checked = checkProfitTarget({
      targetProfitUsd,
      basis: { ...basis, measuredMoveUsd: RANGE_HEIGHT },
    });

    expect([...checked.rejections]).toEqual(["target_basis_arithmetic_mismatch"]);
  });
});
