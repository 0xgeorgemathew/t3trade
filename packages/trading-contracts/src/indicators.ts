/**
 * On-demand indicator readings for `trading_look`'s `candles` scope.
 *
 * The model pulls the indicator it is reasoning with — `ema(20)`, `rsi(14)` —
 * instead of deriving it from raw bars in context or receiving a fixed panel
 * it may not read. The server computes on bars it already fetched for the
 * candle read, so a reading costs no extra exchange call.
 *
 * Each reading reports `value` (over every fetched bar, the in-progress one
 * included) and `previous` (the same computation one bar back). The pair is
 * what a crossover or slope check needs: `ema(20) > ema(50)` now and not one
 * bar ago IS the cross, with no series riding back in the response.
 *
 * @module indicators
 */
import * as Schema from "effect/Schema";

import type { MarketCandle } from "./market.ts";

export const IndicatorKind = Schema.Literals(["ema", "sma", "rsi", "vwap"]);
export type IndicatorKind = typeof IndicatorKind.Type;

/**
 * The period each kind computes with when the request names none.
 *
 * `vwap`'s 0 means "the whole fetched window" — a session-style read. A vwap
 * request may still name a period to read the volume-weighted price of just
 * the recent bars.
 */
export const DEFAULT_INDICATOR_PERIODS: Readonly<Record<IndicatorKind, number>> = {
  ema: 20,
  sma: 20,
  rsi: 14,
  vwap: 0,
};

/**
 * The longest period a request may name. The candle read it computes on
 * fetches at most a few hundred bars; a period near or past that answers with
 * `insufficient bars` anyway, so the schema says so upfront.
 */
export const INDICATOR_MAX_PERIOD = 200;

/** How many indicator requests one look computes. */
export const INDICATOR_MAX_REQUESTS = 6;

export const IndicatorRequest = Schema.Struct({
  kind: IndicatorKind,
  /** Bars the computation spans. Defaults per kind; 0 is only vwap's whole window. */
  period: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: INDICATOR_MAX_PERIOD }),
    ),
  ),
});
export type IndicatorRequest = typeof IndicatorRequest.Type;

export const IndicatorReading = Schema.Struct({
  kind: IndicatorKind,
  /** The period actually computed with — the kind's default when unnamed. */
  period: Schema.Number,
  /**
   * The latest reading, over every fetched bar including the in-progress one.
   * Absent when the window holds too few bars (or, for vwap, no volume) —
   * absence states "could not be computed", never a zero that reads as a
   * value.
   */
  value: Schema.optional(Schema.Number),
  /** The same computation one bar back. `value` against `previous` is this bar's cross or slope. */
  previous: Schema.optional(Schema.Number),
});
export type IndicatorReading = typeof IndicatorReading.Type;

/** Six significant digits, matching the precision doctrine for derived prices. */
const round = (value: number): number =>
  Number.isFinite(value) ? Number(value.toPrecision(6)) : value;

const sma = (closes: ReadonlyArray<number>, period: number): number | undefined => {
  if (period < 1 || closes.length < period) return undefined;
  const window = closes.slice(-period);
  return window.reduce((sum, close) => sum + close, 0) / period;
};

const ema = (closes: ReadonlyArray<number>, period: number): number | undefined => {
  if (period < 1 || closes.length < period) return undefined;
  // Standard seeding: the SMA of the first `period` closes, then the
  // recursive smoothing over everything after it.
  const seed = closes.slice(0, period).reduce((sum, close) => sum + close, 0) / period;
  const k = 2 / (period + 1);
  let value = seed;
  for (const close of closes.slice(period)) {
    value = close * k + value * (1 - k);
  }
  return value;
};

/** Wilder's RSI: needs `period + 1` closes for the first `period` deltas. */
const rsi = (closes: ReadonlyArray<number>, period: number): number | undefined => {
  if (period < 1 || closes.length < period + 1) return undefined;
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (delta > 0) averageGain += delta / period;
    else averageLoss += -delta / period;
  }
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    averageGain = (averageGain * (period - 1) + Math.max(0, delta)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -delta)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
};

/** Volume-weighted average of the typical price. `period` 0 spans the whole window. */
const vwap = (candles: ReadonlyArray<MarketCandle>, period: number): number | undefined => {
  const window = period > 0 ? candles.slice(-period) : candles;
  if (window.length === 0) return undefined;
  let weighted = 0;
  let volume = 0;
  for (const candle of window) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    weighted += typical * candle.volume;
    volume += candle.volume;
  }
  return volume === 0 ? undefined : weighted / volume;
};

const computeValue = (
  kind: IndicatorKind,
  period: number,
  candles: ReadonlyArray<MarketCandle>,
): number | undefined => {
  const closes = candles.map((candle) => candle.close);
  switch (kind) {
    case "ema":
      return ema(closes, period);
    case "sma":
      return sma(closes, period);
    case "rsi":
      return rsi(closes, period);
    case "vwap":
      return vwap(candles, period);
  }
};

/**
 * One reading: the request's indicator over the fetched bars, and the same
 * computation one bar back. Pure — the caller supplies the bars it already
 * fetched, oldest first.
 */
export const computeIndicator = (
  request: IndicatorRequest,
  candles: ReadonlyArray<MarketCandle>,
): IndicatorReading => {
  const period = request.period ?? DEFAULT_INDICATOR_PERIODS[request.kind];
  const value = computeValue(request.kind, period, candles);
  const previous = computeValue(request.kind, period, candles.slice(0, -1));
  return {
    kind: request.kind,
    period,
    ...(value === undefined ? {} : { value: round(value) }),
    ...(previous === undefined ? {} : { previous: round(previous) }),
  };
};
