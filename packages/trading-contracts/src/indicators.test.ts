/**
 * The on-demand indicator readings a look computes — the model pulls
 * `ema(20)` instead of deriving it from raw bars in context.
 *
 * The arithmetic is pinned against hand-computed values on tiny series; the
 * insufficient-bars cases pin that "could not be computed" is an absent
 * `value`, never a zero.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  computeIndicator,
  DEFAULT_INDICATOR_PERIODS,
  INDICATOR_MAX_REQUESTS,
} from "./indicators.ts";
import type { MarketCandle } from "./market.ts";

/** A bar whose typical price is its close (high = low = close). */
const bar = (close: number, volume = 1): MarketCandle =>
  ({
    openTime: 0,
    closeTime: 0,
    open: close,
    close,
    high: close,
    low: close,
    volume,
    trades: 1,
  }) as MarketCandle;

describe("computeIndicator", () => {
  it("computes the SMA over the last `period` bars, and one bar back", () => {
    const candles = [1, 2, 3, 4, 5].map((close) => bar(close));
    const reading = computeIndicator({ kind: "sma", period: 3 }, candles);
    expect(reading.value).toBe(4); // (3+4+5)/3
    expect(reading.previous).toBe(3); // (2+3+4)/3
  });

  it("seeds the EMA with the first-period SMA, then smooths", () => {
    // Seed = SMA(1,2,3) = 2; k = 0.5. Then 4: 3; then 5: 4.
    const candles = [1, 2, 3, 4, 5].map((close) => bar(close));
    const reading = computeIndicator({ kind: "ema", period: 3 }, candles);
    expect(reading.value).toBe(4);
    expect(reading.previous).toBe(3);
  });

  it("computes Wilder's RSI, and reports 100 on a loss-free window", () => {
    const rising = [1, 2, 3, 4, 5].map((close) => bar(close));
    expect(computeIndicator({ kind: "rsi", period: 3 }, rising).value).toBe(100);

    // Alternating ±1 deltas: equal average gain and loss → RSI 50.
    const chop = [4, 5, 4, 5, 4, 5, 4, 5, 4].map((close) => bar(close));
    const reading = computeIndicator({ kind: "rsi", period: 4 }, chop);
    expect(reading.value).toBeGreaterThan(35);
    expect(reading.value).toBeLessThan(65);
  });

  it("volume-weights the VWAP, whole window by default", () => {
    // 10 on 3 volume, 20 on 1 volume: (30 + 20) / 4 = 12.5.
    const candles = [bar(10, 3), bar(20, 1)];
    const reading = computeIndicator({ kind: "vwap" }, candles);
    expect(reading.period).toBe(DEFAULT_INDICATOR_PERIODS.vwap);
    expect(reading.value).toBe(12.5);
    // One bar back only the first bar exists.
    expect(reading.previous).toBe(10);
  });

  it("windows the VWAP when the request names a period", () => {
    const candles = [bar(10, 1), bar(20, 1), bar(30, 1)];
    expect(computeIndicator({ kind: "vwap", period: 2 }, candles).value).toBe(25);
  });

  it("states 'could not be computed' as an absent value, never a zero", () => {
    const short = [bar(1), bar(2)].slice(0, 2);
    const reading = computeIndicator({ kind: "ema", period: 20 }, short);
    expect(reading.value).toBeUndefined();
    expect(reading.previous).toBeUndefined();
    expect(reading.period).toBe(20);

    // A window with volume 0 has no volume-weighted price.
    expect(computeIndicator({ kind: "vwap" }, [bar(10, 0)]).value).toBeUndefined();

    // Just enough bars for `value` but not for `previous`: the pair degrades
    // one side at a time.
    const exact = [1, 2, 3].map((close) => bar(close));
    const edge = computeIndicator({ kind: "sma", period: 3 }, exact);
    expect(edge.value).toBe(2);
    expect(edge.previous).toBeUndefined();
  });

  it("defaults the period per kind", () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(i + 1));
    expect(computeIndicator({ kind: "ema" }, candles).period).toBe(20);
    expect(computeIndicator({ kind: "rsi" }, candles).period).toBe(14);
  });

  it("caps one look at a handful of requests", () => {
    // The cap itself is enforced at the handler; the constant is the contract.
    expect(INDICATOR_MAX_REQUESTS).toBe(6);
  });
});
