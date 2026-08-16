/**
 * Observed volatility - the measured basis a profit target has to come from.
 *
 * A momentum target that is not measured is a guess, and a guessed target is
 * either never reached (the position round-trips) or is left so small that the
 * fees eat it. Everything here is computed from candles the exchange actually
 * served: no model, no assumed distribution, no annualisation.
 *
 * Three measurements are published side by side because they answer three
 * different questions:
 *  - `atr` — how far a single bar travels, high to low, including gaps.
 *  - `realizedVolatilityPercentPerBar` — how much the close moves bar to bar.
 *  - `swingRange` — how much ground the whole window covered.
 *
 * The fourth, `horizons`, is the one a target should normally be read off:
 * for a given holding period it reports the distribution of the move price
 * actually delivered from a bar's close over the next N bars, in both
 * directions. Taking the median means the same move was available in half the
 * historical windows of that length — an attainability claim with a number
 * behind it rather than an adjective.
 *
 * Alongside them sit the range-awareness numbers — `swingHighUsd`,
 * `swingLowUsd`, `positionInRangePercent`, and `excursionSymmetryRatio`. They
 * are the same arithmetic over the same bars, published rather than left for
 * the harness to re-derive on every wake, so a rule like "enter only near the
 * edge" can be checked against a number.
 *
 * @module TradingVolatility
 */
import { Schema } from "effect";
import { MarketCandle, MarketCandleInterval } from "./market.ts";
import { ExchangeMarket, Price, UnixMillis } from "./primitives.ts";

/** Bars of history the wakeup measures volatility over. */
export const VOLATILITY_LOOKBACK_BARS = 120;

/** Bars in the true-range average. Wilder's period, unsmoothed. */
export const ATR_PERIOD = 14;

/**
 * Fewest bars a measurement is willing to speak from.
 *
 * Below this the quantiles are noise dressed as evidence, so the result is
 * published with `sufficientData: false` and the harness is expected to say the
 * data does not support a target rather than read one off it anyway.
 */
export const MIN_VOLATILITY_BARS = 30;

/**
 * Holding periods, in bars of the measured interval, reported by default.
 *
 * The long tail matters as much as the short one: on 1m the first four horizons
 * top out at a twenty-minute view, which cannot see the half-hour to hour-long
 * oscillation a range scalp actually rides. 30 and 60 bars put that swing in
 * the same measurement. At the default 120-bar lookback the 60-bar horizon
 * still has 60 forward windows behind it, well clear of `MIN_HORIZON_SAMPLES`;
 * a shorter window simply drops the horizons it cannot sample.
 */
export const DEFAULT_HOLD_HORIZONS: ReadonlyArray<number> = [3, 5, 10, 20, 30, 60];

/** Fewest forward windows a horizon needs before its quantiles are published. */
const MIN_HORIZON_SAMPLES = 10;

const MINUTES_PER_BAR: Record<MarketCandleInterval, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "1h": 60,
};

/** The 25th, 50th, and 75th percentile of a measured move, in USD of price. */
export const MoveQuantiles = Schema.Struct({
  p25: Schema.Number,
  p50: Schema.Number,
  p75: Schema.Number,
});
export type MoveQuantiles = typeof MoveQuantiles.Type;

/**
 * What price did over one holding period, measured from every bar close in the
 * window that had a full period of bars after it.
 *
 * `favourableUpUsd` is the best move a long could have taken (the highest high
 * of the next `holdBars` bars, less the close it was measured from);
 * `favourableDownUsd` is the mirror for a short. Both are non-negative.
 */
export const VolatilityHorizon = Schema.Struct({
  holdBars: Schema.Number,
  holdMinutes: Schema.Number,
  /** Forward windows the quantiles were computed from. */
  samples: Schema.Number,
  favourableUpUsd: MoveQuantiles,
  favourableDownUsd: MoveQuantiles,
});
export type VolatilityHorizon = typeof VolatilityHorizon.Type;

/**
 * The volatility a market actually produced over a bounded candle window.
 *
 * Published on every wakeup for the mission's primary timeframe, and readable
 * for any other interval through `trading_look`.
 */
export const ObservedVolatility = Schema.Struct({
  market: ExchangeMarket,
  interval: MarketCandleInterval,
  barsObserved: Schema.Number,
  /** The last close in the window; every percent below is relative to it. */
  referencePrice: Price,
  measuredAt: UnixMillis,
  /** False when the window is too short to measure from — see `MIN_VOLATILITY_BARS`. */
  sufficientData: Schema.Boolean,
  atrPeriod: Schema.Number,
  /** Mean true range of the last `atrPeriod` bars, in USD of price. */
  atrUsd: Schema.Number,
  atrPercent: Schema.Number,
  /** Standard deviation of bar-to-bar log returns, as a percent. */
  realizedVolatilityPercentPerBar: Schema.Number,
  /** Highest high less lowest low across the whole window. */
  swingRangeUsd: Schema.Number,
  swingRangePercent: Schema.Number,
  /** Highest high in the window — the range ceiling a scalp sells into. */
  swingHighUsd: Schema.Number,
  /** Lowest low in the window — the range floor a scalp buys at. */
  swingLowUsd: Schema.Number,
  /**
   * Where the reference price sits between the window's low and high, as a
   * percent: 0 is on the floor, 100 is on the ceiling, 50 is mid-range.
   *
   * This is what makes "enter only near the edge" a checkable rule rather than
   * a judgement call — the harness reads the number instead of re-deriving it
   * from the candles every wake. A window with no height reports 50.
   */
  positionInRangePercent: Schema.Number,
  /**
   * Median favourable up move divided by median favourable down move at the
   * longest published horizon.
   *
   * Near 1 the window paid longs and shorts alike, which is what ranging looks
   * like; far from 1 one side has been paying and the window is trending. Zero
   * when there is no horizon to read or the downside median is zero.
   */
  excursionSymmetryRatio: Schema.Number,
  horizons: Schema.Array(VolatilityHorizon),
});
export type ObservedVolatility = typeof ObservedVolatility.Type;

const quantile = (sorted: ReadonlyArray<number>, fraction: number): number => {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
};

const quantilesOf = (values: ReadonlyArray<number>): MoveQuantiles => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
  };
};

/** Mean true range over the last `ATR_PERIOD` bars, in USD of price. */
const averageTrueRange = (candles: ReadonlyArray<MarketCandle>): number => {
  const trueRanges: Array<number> = [];
  for (let i = 1; i < candles.length; i++) {
    const bar = candles[i];
    const previous = candles[i - 1];
    if (bar === undefined || previous === undefined) continue;
    trueRanges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      ),
    );
  }
  const window = trueRanges.slice(-ATR_PERIOD);
  if (window.length === 0) return 0;
  return window.reduce((sum, range) => sum + range, 0) / window.length;
};

/** Standard deviation of bar-to-bar log returns, as a percent. */
const realizedVolatilityPercent = (candles: ReadonlyArray<MarketCandle>): number => {
  const returns: Array<number> = [];
  for (let i = 1; i < candles.length; i++) {
    const close = candles[i]?.close;
    const previousClose = candles[i - 1]?.close;
    if (close === undefined || previousClose === undefined || previousClose <= 0) continue;
    returns.push(Math.log(close / previousClose));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * 100;
};

/**
 * The distribution of the move available from a bar close over the next
 * `holdBars` bars, in each direction.
 */
const measureHorizon = (
  candles: ReadonlyArray<MarketCandle>,
  interval: MarketCandleInterval,
  holdBars: number,
): VolatilityHorizon | null => {
  const ups: Array<number> = [];
  const downs: Array<number> = [];

  for (let i = 0; i + holdBars < candles.length; i++) {
    const from = candles[i];
    if (from === undefined) continue;
    const forward = candles.slice(i + 1, i + 1 + holdBars);
    const highest = Math.max(...forward.map((bar) => bar.high));
    const lowest = Math.min(...forward.map((bar) => bar.low));
    ups.push(Math.max(0, highest - from.close));
    downs.push(Math.max(0, from.close - lowest));
  }

  if (ups.length < MIN_HORIZON_SAMPLES) return null;

  return {
    holdBars,
    holdMinutes: holdBars * MINUTES_PER_BAR[interval],
    samples: ups.length,
    favourableUpUsd: quantilesOf(ups),
    favourableDownUsd: quantilesOf(downs),
  };
};

/**
 * Measure the fluctuation a candle window actually produced.
 *
 * Pure arithmetic over the bars it is given — the caller owns the exchange
 * read. A window shorter than `MIN_VOLATILITY_BARS` still returns a value, with
 * `sufficientData: false`, so the harness can see what little there was and say
 * so rather than receive an error it has to interpret.
 */
export function measureVolatility(input: {
  readonly market: string;
  readonly interval: MarketCandleInterval;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly measuredAt: number;
  readonly holdHorizons?: ReadonlyArray<number>;
}): ObservedVolatility {
  const { candles, interval } = input;
  const referencePrice = candles[candles.length - 1]?.close ?? 0;
  const percentOf = (usd: number): number =>
    referencePrice > 0 ? (usd / referencePrice) * 100 : 0;

  const atrUsd = averageTrueRange(candles);
  const highs = candles.map((bar) => bar.high);
  const lows = candles.map((bar) => bar.low);
  const swingHighUsd = candles.length === 0 ? 0 : Math.max(...highs);
  const swingLowUsd = candles.length === 0 ? 0 : Math.min(...lows);
  const swingRangeUsd = swingHighUsd - swingLowUsd;
  const positionInRangePercent =
    swingRangeUsd > 0 ? ((referencePrice - swingLowUsd) / swingRangeUsd) * 100 : 50;

  const horizons = (input.holdHorizons ?? DEFAULT_HOLD_HORIZONS)
    .map((holdBars) => measureHorizon(candles, interval, holdBars))
    .filter((horizon): horizon is VolatilityHorizon => horizon !== null);

  const longest = horizons.reduce<VolatilityHorizon | null>(
    (longestSoFar, horizon) =>
      longestSoFar === null || horizon.holdBars > longestSoFar.holdBars ? horizon : longestSoFar,
    null,
  );
  const downsideMedian = longest?.favourableDownUsd.p50 ?? 0;
  const excursionSymmetryRatio =
    longest !== null && downsideMedian > 0 ? longest.favourableUpUsd.p50 / downsideMedian : 0;

  return {
    market: input.market,
    interval,
    barsObserved: candles.length,
    // `Price` is strictly positive; an empty window has no reference price and
    // is reported as insufficient rather than as a zero-priced market.
    referencePrice: referencePrice > 0 ? referencePrice : 1,
    measuredAt: input.measuredAt,
    sufficientData: candles.length >= MIN_VOLATILITY_BARS && referencePrice > 0,
    atrPeriod: ATR_PERIOD,
    atrUsd,
    atrPercent: percentOf(atrUsd),
    realizedVolatilityPercentPerBar: realizedVolatilityPercent(candles),
    swingRangeUsd,
    swingRangePercent: percentOf(swingRangeUsd),
    swingHighUsd,
    swingLowUsd,
    positionInRangePercent,
    excursionSymmetryRatio,
    horizons,
  };
}
