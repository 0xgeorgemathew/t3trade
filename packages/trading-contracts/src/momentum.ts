/**
 * Momentum context - the structure a directional thesis is supposed to rest on.
 *
 * `measureVolatility` answers "how far does this thing move?" It cannot answer
 * "which way is it going, is it speeding up, where did the last leg start, and
 * how much of it has already been given back?" — and those are the questions a
 * momentum entry is actually a bet on. Without them the harness read a single
 * quiet 1m window, saw a number, and published a target off it.
 *
 * Everything here is deterministic arithmetic over candles the exchange served,
 * measured on several timeframes at once so a 1m impulse can be checked against
 * the 15m structure it is running into. No model, no indicator library, no
 * smoothing beyond a stated average, and nothing that needs tuning to mean what
 * it says.
 *
 * @module TradingMomentum
 */
import { Schema } from "effect";
import { MarketCandle, MarketCandleInterval } from "./market.ts";
import { ExchangeMarket, Price, UnixMillis } from "./primitives.ts";

/** The timeframes the momentum read covers, fastest first. */
export const MOMENTUM_TIMEFRAMES: ReadonlyArray<MarketCandleInterval> = ["1m", "5m", "15m", "1h"];

/** Bars of history each timeframe is measured over. */
export const MOMENTUM_LOOKBACK_BARS = 120;

/** Bars in each ATR leg of the expansion ratio. Matches `ATR_PERIOD`. */
const ATR_LEG_BARS = 14;

/**
 * Fewest bars a timeframe is willing to speak from. Below this the pivots are
 * noise and the ratios are arithmetic on nothing.
 */
export const MIN_MOMENTUM_BARS = 30;

/**
 * Bars either side of a bar that must not exceed it before it counts as a
 * swing.
 *
 * Three is small enough that a 1m read still finds the structure inside a
 * twenty-minute leg, and large enough that a single wick does not become a
 * level. A pivot is only confirmed once those later bars exist, so the newest
 * three bars can never be pivots — which is the point: a high that price is
 * still making is not yet a swing high.
 */
export const SWING_PIVOT_BARS = 3;

/**
 * How decisive a directional score has to be before the timeframe is called.
 *
 * Below this the window spent most of its travel undoing itself, which is
 * chop — and "chop" is a more useful answer than a direction with a small
 * number attached.
 */
export const DIRECTION_SCORE_THRESHOLD = 0.15;

export const MomentumDirection = Schema.Literals(["up", "down", "flat"]);
export type MomentumDirection = typeof MomentumDirection.Type;

/**
 * The last completed directional leg on this timeframe.
 *
 * Measured pivot to pivot: from the swing low that started it to the swing high
 * that ended it, or the mirror. `ageBars` is how many bars have printed since
 * that end — a momentum entry taken twenty bars after the impulse finished is
 * not a momentum entry.
 */
export const MomentumImpulse = Schema.Struct({
  direction: Schema.Literals(["up", "down"]),
  startPrice: Price,
  endPrice: Price,
  /** Absolute travel of the leg, in USD of price. */
  sizeUsd: Schema.Number,
  sizePercent: Schema.Number,
  /** Bars from the leg's start pivot to its end pivot. */
  bars: Schema.Number,
  /** Bars printed since the leg ended. Zero means it just ended. */
  ageBars: Schema.Number,
});
export type MomentumImpulse = typeof MomentumImpulse.Type;

/** What one timeframe says about direction, expansion, and structure. */
export const MomentumTimeframeContext = Schema.Struct({
  interval: MarketCandleInterval,
  barsObserved: Schema.Number,
  /** False when the window is shorter than `MIN_MOMENTUM_BARS`. */
  sufficientData: Schema.Boolean,
  /** The last close; every distance below is measured from it. */
  referencePrice: Price,
  /**
   * Net travel divided by total travel over the window, in [-1, 1].
   *
   * 1.0 is a straight line up, -1.0 a straight line down, and 0 a window that
   * ended where it started however far it went in between. This is the whole
   * directional claim in one number, and it needs no threshold to be honest —
   * `direction` applies one so the caller does not have to.
   */
  directionScore: Schema.Number,
  direction: MomentumDirection,
  atrUsd: Schema.Number,
  atrPercent: Schema.Number,
  /**
   * ATR over the last 14 bars divided by ATR over the 14 before them.
   *
   * Above 1 the market is covering more ground per bar than it just was, which
   * is the condition a momentum entry wants; below 1 the move is running out of
   * range while it is still running out of direction. Absent when the window is
   * too short to hold two legs.
   */
  atrExpansionRatio: Schema.optional(Schema.Number),
  lastImpulse: Schema.optional(MomentumImpulse),
  /** How far price has retraced from the impulse's end, in USD of price. */
  pullbackDepthUsd: Schema.optional(Schema.Number),
  /** That retracement as a percentage of the impulse it is undoing. */
  pullbackPercentOfImpulse: Schema.optional(Schema.Number),
  /** The most recent confirmed swing high, and the distance up to it. */
  swingHighPrice: Schema.optional(Price),
  swingLowPrice: Schema.optional(Price),
  /**
   * Signed distance from the last close to that swing. Positive means the level
   * is still ahead; negative means price has already traded through it, which
   * is a breakout rather than a ceiling.
   */
  distanceToSwingHighUsd: Schema.optional(Schema.Number),
  distanceToSwingLowUsd: Schema.optional(Schema.Number),
});
export type MomentumTimeframeContext = typeof MomentumTimeframeContext.Type;

/** Whether the timeframes agree, and how strongly. */
export const MomentumAlignment = Schema.Struct({
  direction: Schema.Literals(["up", "down", "mixed"]),
  /** Mean `directionScore` across every timeframe with sufficient data. */
  score: Schema.Number,
  agreeingTimeframes: Schema.Number,
  measuredTimeframes: Schema.Number,
  /** One line stating what the agreement or disagreement actually is. */
  note: Schema.String,
});
export type MomentumAlignment = typeof MomentumAlignment.Type;

export const MarketStructure = Schema.Struct({
  market: ExchangeMarket,
  measuredAt: UnixMillis,
  timeframes: Schema.Array(MomentumTimeframeContext),
  alignment: MomentumAlignment,
});
export type MarketStructure = typeof MarketStructure.Type;

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** True range of each bar against its predecessor. One shorter than `candles`. */
const trueRanges = (candles: ReadonlyArray<MarketCandle>): ReadonlyArray<number> => {
  const ranges: Array<number> = [];
  for (let i = 1; i < candles.length; i++) {
    const bar = candles[i];
    const previous = candles[i - 1];
    if (bar === undefined || previous === undefined) continue;
    ranges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      ),
    );
  }
  return ranges;
};

const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Net travel over total travel, close to close.
 *
 * The denominator is every step the window took, so a market that went up ten
 * dollars in a straight line and one that went up ten dollars via forty of
 * whipsaw score very differently — which is the only difference that matters to
 * a momentum thesis.
 */
const directionalEfficiency = (candles: ReadonlyArray<MarketCandle>): number => {
  let net = 0;
  let travelled = 0;
  for (let i = 1; i < candles.length; i++) {
    const close = candles[i]?.close;
    const previous = candles[i - 1]?.close;
    if (close === undefined || previous === undefined) continue;
    net += close - previous;
    travelled += Math.abs(close - previous);
  }
  return travelled === 0 ? 0 : net / travelled;
};

const callDirection = (score: number): MomentumDirection => {
  if (score >= DIRECTION_SCORE_THRESHOLD) return "up";
  if (score <= -DIRECTION_SCORE_THRESHOLD) return "down";
  return "flat";
};

/**
 * Indices of the bars whose high (or low) is not exceeded within
 * `SWING_PIVOT_BARS` either side.
 *
 * The last `SWING_PIVOT_BARS` bars are never candidates: a pivot needs bars
 * after it to be confirmed, and a level price is still making is not a level.
 */
export function findPivots(
  candles: ReadonlyArray<MarketCandle>,
  kind: "high" | "low",
  bars: number = SWING_PIVOT_BARS,
): ReadonlyArray<number> {
  const pivots: Array<number> = [];
  for (let i = bars; i < candles.length - bars; i++) {
    const bar = candles[i];
    if (bar === undefined) continue;
    let isPivot = true;
    for (let j = i - bars; j <= i + bars; j++) {
      if (j === i) continue;
      const other = candles[j];
      if (other === undefined) continue;
      if (kind === "high" ? other.high > bar.high : other.low < bar.low) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push(i);
  }
  return pivots;
}

const last = (values: ReadonlyArray<number>): number | undefined => values[values.length - 1];

/** The latest index in `pivots` that sits before `index`, if any. */
const pivotBefore = (pivots: ReadonlyArray<number>, index: number): number | undefined => {
  for (let i = pivots.length - 1; i >= 0; i--) {
    const pivot = pivots[i];
    if (pivot !== undefined && pivot < index) return pivot;
  }
  return undefined;
};

interface ImpulseWithIndex {
  readonly impulse: MomentumImpulse;
  /** Index of the bar the impulse ended on — where a pullback is measured from. */
  readonly endIndex: number;
}

/**
 * The last leg that ran from one pivot to the opposite one.
 *
 * Which kind of pivot came last decides the direction: a swing high after a
 * swing low means the last completed leg was up. When the opposite pivot is
 * missing — a window that only ever made highs — the leg is measured from the
 * window's own extreme before it, which is the honest floor for "where this
 * started".
 */
function findLastImpulse(candles: ReadonlyArray<MarketCandle>): ImpulseWithIndex | null {
  const highs = findPivots(candles, "high");
  const lows = findPivots(candles, "low");
  const lastHigh = last(highs);
  const lastLow = last(lows);
  if (lastHigh === undefined && lastLow === undefined) return null;

  const up = lastHigh !== undefined && (lastLow === undefined || lastHigh > lastLow);
  const endIndex = (up ? lastHigh : lastLow) as number;
  const startIndex = up ? pivotBefore(lows, endIndex) : pivotBefore(highs, endIndex);

  const priceAt = (index: number, kind: "high" | "low"): number => {
    const bar = candles[index];
    if (bar === undefined) return 0;
    return kind === "high" ? bar.high : bar.low;
  };

  const endPrice = priceAt(endIndex, up ? "high" : "low");
  const startPrice =
    startIndex !== undefined
      ? priceAt(startIndex, up ? "low" : "high")
      : up
        ? Math.min(...candles.slice(0, endIndex + 1).map((bar) => bar.low))
        : Math.max(...candles.slice(0, endIndex + 1).map((bar) => bar.high));

  const sizeUsd = Math.abs(endPrice - startPrice);
  return {
    endIndex,
    impulse: {
      direction: up ? "up" : "down",
      startPrice: startPrice > 0 ? startPrice : 1,
      endPrice: endPrice > 0 ? endPrice : 1,
      sizeUsd,
      sizePercent: startPrice > 0 ? (sizeUsd / startPrice) * 100 : 0,
      bars: startIndex === undefined ? endIndex : endIndex - startIndex,
      ageBars: candles.length - 1 - endIndex,
    },
  };
}

/** How far price has come back off the impulse's end, since it ended. */
function measurePullback(
  candles: ReadonlyArray<MarketCandle>,
  found: ImpulseWithIndex,
): { readonly depthUsd: number; readonly percentOfImpulse: number } | null {
  const since = candles.slice(found.endIndex + 1);
  if (since.length === 0) return null;
  const depthUsd =
    found.impulse.direction === "up"
      ? found.impulse.endPrice - Math.min(...since.map((bar) => bar.low))
      : Math.max(...since.map((bar) => bar.high)) - found.impulse.endPrice;
  const bounded = Math.max(0, depthUsd);
  return {
    depthUsd: bounded,
    percentOfImpulse: found.impulse.sizeUsd > 0 ? (bounded / found.impulse.sizeUsd) * 100 : 0,
  };
}

/** Measure one timeframe. Pure arithmetic over the bars it is handed. */
export function analyseTimeframe(input: {
  readonly interval: MarketCandleInterval;
  readonly candles: ReadonlyArray<MarketCandle>;
}): MomentumTimeframeContext {
  const { candles, interval } = input;
  const referencePrice = candles[candles.length - 1]?.close ?? 0;
  const ranges = trueRanges(candles);
  const atrUsd = mean(ranges.slice(-ATR_LEG_BARS));
  const previousAtr = mean(ranges.slice(-2 * ATR_LEG_BARS, -ATR_LEG_BARS));

  const found = findLastImpulse(candles);
  const pullback = found === null ? null : measurePullback(candles, found);

  const highs = findPivots(candles, "high");
  const lows = findPivots(candles, "low");
  const swingHighIndex = last(highs);
  const swingLowIndex = last(lows);
  const swingHighPrice = swingHighIndex === undefined ? undefined : candles[swingHighIndex]?.high;
  const swingLowPrice = swingLowIndex === undefined ? undefined : candles[swingLowIndex]?.low;

  const directionScore = directionalEfficiency(candles);

  return {
    interval,
    barsObserved: candles.length,
    sufficientData: candles.length >= MIN_MOMENTUM_BARS && referencePrice > 0,
    // `Price` is strictly positive; an empty window has no reference price and
    // is already reported as insufficient.
    referencePrice: referencePrice > 0 ? referencePrice : 1,
    directionScore,
    direction: callDirection(directionScore),
    atrUsd,
    atrPercent: referencePrice > 0 ? (atrUsd / referencePrice) * 100 : 0,
    ...(ranges.length >= 2 * ATR_LEG_BARS && previousAtr > 0
      ? { atrExpansionRatio: atrUsd / previousAtr }
      : {}),
    ...(found === null ? {} : { lastImpulse: found.impulse }),
    ...(pullback === null
      ? {}
      : {
          pullbackDepthUsd: pullback.depthUsd,
          pullbackPercentOfImpulse: pullback.percentOfImpulse,
        }),
    ...(swingHighPrice === undefined
      ? {}
      : { swingHighPrice, distanceToSwingHighUsd: swingHighPrice - referencePrice }),
    ...(swingLowPrice === undefined
      ? {}
      : { swingLowPrice, distanceToSwingLowUsd: referencePrice - swingLowPrice }),
  };
}

/**
 * Read the agreement across the measured timeframes.
 *
 * A direction is only called when strictly more timeframes point that way than
 * the other; anything else is `mixed`, including the case where every timeframe
 * is chopping. Saying "mixed" is the useful answer — a momentum thesis that
 * needs the higher timeframe to disagree with it is a thesis about noise.
 */
function readAlignment(frames: ReadonlyArray<MomentumTimeframeContext>): MomentumAlignment {
  const measured = frames.filter((frame) => frame.sufficientData);
  if (measured.length === 0) {
    return {
      direction: "mixed",
      score: 0,
      agreeingTimeframes: 0,
      measuredTimeframes: 0,
      note: "no timeframe had enough bars to measure; read more history before forming a thesis",
    };
  }

  const ups = measured.filter((frame) => frame.direction === "up").length;
  const downs = measured.filter((frame) => frame.direction === "down").length;
  const score = mean(measured.map((frame) => frame.directionScore));

  if (ups === downs) {
    return {
      direction: "mixed",
      score,
      agreeingTimeframes: 0,
      measuredTimeframes: measured.length,
      note:
        ups === 0
          ? `all ${measured.length} measured timeframes are chopping — no directional edge to trade`
          : `${ups} timeframes point up and ${downs} point down — the timeframes contradict each other`,
    };
  }

  const direction = ups > downs ? ("up" as const) : ("down" as const);
  const agreeing = direction === "up" ? ups : downs;
  const named = measured
    .filter((frame) => frame.direction === direction)
    .map((frame) => frame.interval)
    .join(", ");
  return {
    direction,
    score,
    agreeingTimeframes: agreeing,
    measuredTimeframes: measured.length,
    note: `${agreeing} of ${measured.length} measured timeframes point ${direction} (${named})`,
  };
}

/**
 * Measure the momentum structure across several timeframes at once.
 *
 * The caller owns the exchange reads and hands over one candle window per
 * timeframe; everything below is arithmetic. A timeframe with too few bars is
 * still returned, with `sufficientData: false`, so the harness can see what was
 * missing rather than receive a shorter list than it asked for.
 */
export function analyseMomentum(input: {
  readonly market: string;
  readonly measuredAt: number;
  readonly frames: ReadonlyArray<{
    readonly interval: MarketCandleInterval;
    readonly candles: ReadonlyArray<MarketCandle>;
  }>;
}): MarketStructure {
  const timeframes = input.frames.map(analyseTimeframe);
  return {
    market: input.market,
    measuredAt: input.measuredAt,
    timeframes,
    alignment: readAlignment(timeframes),
  };
}
