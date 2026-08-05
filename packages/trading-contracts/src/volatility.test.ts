import { describe, expect, it } from "@effect/vitest";

import type { MarketCandle } from "./market.ts";
import { MIN_VOLATILITY_BARS, measureVolatility } from "./volatility.ts";

/**
 * A window that oscillates by a fixed amount every bar, so every measurement
 * has an arithmetic answer a reader can check by hand: each bar's true range is
 * `2 * amplitude`, and the most a close can travel in either direction is
 * `amplitude` (from a trough close up to the next peak high, or the mirror).
 */
const zigzag = (bars: number, base: number, amplitude: number): Array<MarketCandle> =>
  Array.from({ length: bars }, (_unused, index) => {
    const up = index % 2 === 0;
    const close = up ? base + amplitude : base - amplitude;
    return {
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000,
      open: up ? base - amplitude : base + amplitude,
      close,
      high: base + amplitude,
      low: base - amplitude,
      volume: 1,
    };
  });

describe("measureVolatility", () => {
  const candles = zigzag(120, 4_000, 10);
  const measured = measureVolatility({
    market: "ETH",
    interval: "1m",
    candles,
    measuredAt: 1_700_000,
  });

  it("measures the true range of the window rather than assuming one", () => {
    // Every bar spans base ± 10, so the true range is 20 on every bar.
    expect(measured.atrUsd).toBeCloseTo(20, 6);
    // Percentages are relative to the last close in the window, 3,990 here.
    expect(measured.referencePrice).toBe(3_990);
    expect(measured.atrPercent).toBeCloseTo((20 / 3_990) * 100, 6);
    expect(measured.swingRangeUsd).toBeCloseTo(20, 6);
    expect(measured.barsObserved).toBe(120);
    expect(measured.sufficientData).toBe(true);
  });

  it("reports the move price actually delivered over each holding period", () => {
    const tenBars = measured.horizons.find((horizon) => horizon.holdBars === 10);
    expect(tenBars).toBeDefined();
    expect(tenBars?.holdMinutes).toBe(10);
    expect(tenBars?.samples).toBe(110);
    // From a trough close (3,990) the best the next bars offer is 4,010; from a
    // peak close (4,010) the upside is 0. Half the windows start at each, so
    // the median favourable move is the midpoint of 0 and 20.
    expect(tenBars?.favourableUpUsd.p75).toBeCloseTo(20, 6);
    expect(tenBars?.favourableDownUsd.p75).toBeCloseTo(20, 6);
  });

  it("reaches an hour-scale hold on 1m data without being asked to", () => {
    // The scalp rides a 30-60 minute oscillation, so the default menu has to
    // reach that far or the measurement cannot see the move being traded.
    const hourly = measured.horizons.find((horizon) => horizon.holdBars === 60);
    expect(hourly).toBeDefined();
    expect(hourly?.holdMinutes).toBe(60);
    expect(hourly?.samples).toBe(60);
    expect(hourly?.favourableUpUsd.p75).toBeCloseTo(20, 6);
  });

  it("publishes where the mark sits in the range instead of leaving it to be re-derived", () => {
    expect(measured.swingHighUsd).toBeCloseTo(4_010, 6);
    expect(measured.swingLowUsd).toBeCloseTo(3_990, 6);
    // The last close is the trough, 3,990, so the mark is sitting on the floor.
    expect(measured.positionInRangePercent).toBeCloseTo(0, 6);
    // A symmetric zigzag pays a long and a short the same, so the ratio is 1.
    expect(measured.excursionSymmetryRatio).toBeCloseTo(1, 6);
  });

  // The range read on a window that has no range. See `./rangeScalp.test.ts`
  // for the same fields over a window shaped like one worth scalping.
  it("calls a window with no height mid-range rather than inventing an edge", () => {
    const flat = measureVolatility({
      market: "ETH",
      interval: "1m",
      candles: Array.from({ length: 40 }, (_unused, index) => ({
        openTime: index * 60_000,
        closeTime: (index + 1) * 60_000,
        open: 4_000,
        close: 4_000,
        high: 4_000,
        low: 4_000,
        volume: 1,
      })),
      measuredAt: 1_700_000,
    });
    // A window with no height has no edges; mid-range is the honest answer.
    expect(flat.swingRangeUsd).toBe(0);
    expect(flat.positionInRangePercent).toBe(50);
    expect(flat.excursionSymmetryRatio).toBe(0);
  });

  it("says when the window is too short to measure from", () => {
    const thin = measureVolatility({
      market: "ETH",
      interval: "1m",
      candles: zigzag(MIN_VOLATILITY_BARS - 1, 4_000, 10),
      measuredAt: 1_700_000,
    });
    expect(thin.sufficientData).toBe(false);
  });

  it("does not invent a measurement from an empty window", () => {
    const empty = measureVolatility({
      market: "ETH",
      interval: "1m",
      candles: [],
      measuredAt: 1_700_000,
    });
    expect(empty.sufficientData).toBe(false);
    expect(empty.atrUsd).toBe(0);
    expect(empty.swingRangeUsd).toBe(0);
    expect(empty.horizons).toHaveLength(0);
  });

  it("drops a holding period the window cannot supply enough samples for", () => {
    const short = measureVolatility({
      market: "ETH",
      interval: "1m",
      candles: zigzag(40, 4_000, 10),
      measuredAt: 1_700_000,
      holdHorizons: [5, 39],
    });
    expect(short.horizons.map((horizon) => horizon.holdBars)).toEqual([5]);
  });
});
