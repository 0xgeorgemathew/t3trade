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
import { ACTIVE_TRADING_POLICY, type TradingPolicy } from "./policy.ts";
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
 *
 * Policy, not physics: read from the version in force so a calibrated value
 * reaches this arithmetic and the playbook prose in the same change.
 */
export const DIRECTION_SCORE_THRESHOLD = ACTIVE_TRADING_POLICY.momentum.directionScoreThreshold;

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

/**
 * Whether the last close actually went through a level, or only wicked at it.
 *
 * The distinction the momentum and ORB playbooks both turn on: "a 1m candle
 * must CLOSE beyond a boundary, not merely trade through it". It was doctrine
 * with no measurement behind it, so a harness had to eyeball candles to apply
 * it. `wickOnly` is the failed break stated as a fact.
 */
export const StructureBreakout = Schema.Struct({
  direction: Schema.Literals(["up", "down"]),
  /** The swing the break is measured against. */
  level: Price,
  /** The last close is beyond the level. This is a break. */
  closedBeyond: Schema.Boolean,
  /** The bar traded through the level and closed back inside. This is not. */
  wickOnly: Schema.Boolean,
});
export type StructureBreakout = typeof StructureBreakout.Type;

/**
 * A setup the arithmetic can see, scored, with the level it lives at.
 *
 * Not a recommendation and not a permission — nothing in the runtime reads
 * these. It is the same evidence the playbooks ask the harness to assemble by
 * hand out of six other fields, assembled once and consistently, so that "there
 * was no setup" and "there was a setup and I did not see it" stop looking
 * identical in the decision funnel.
 */
export const CandidateSetup = Schema.Struct({
  kind: Schema.Literals(["momentum_breakout", "range_reversion", "opening_range_break"]),
  direction: Schema.Literals(["up", "down"]),
  interval: MarketCandleInterval,
  /** 0 to 1. Every component that feeds it is named in `rationale`. */
  score: Schema.Number,
  /** The price the setup triggers at — the level to arm a watch on. */
  level: Price,
  /**
   * Whether the trigger is only true on a bar close.
   *
   * A breakout is: a wick through the level is not the setup. A range touch is
   * not: the boundary is the price, and waiting for the close gives back the
   * edge. This is what decides whether the watch to arm is a `candle_close` or
   * a `price_cross`.
   */
  closeConfirmed: Schema.Boolean,
  rationale: Schema.String,
});
export type CandidateSetup = typeof CandidateSetup.Type;

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
  /**
   * Where the last close sits between the window's swing low (0) and swing
   * high (100). Near 50 is mid-range; near an extreme is a boundary.
   */
  positionInRangePercent: Schema.optional(Schema.Number),
  /**
   * How much the swing range moved between the window's first and second half,
   * as a percentage of the first half's height.
   *
   * The measurement behind "the swing range has been stable across the
   * window" — the classify playbook's evidence for a range, which until now the
   * harness had to assert rather than read. Low is stable. Absent when either
   * half has no pivots to measure.
   */
  rangeStabilityPercent: Schema.optional(Schema.Number),
  /**
   * Bars whose high (or low) came within a fifth of an ATR of the swing.
   *
   * "Confirm the market has turned at each boundary more than once" and the
   * ORB's "at least two touches of each boundary", as counts. One touch is a
   * level price happened to reach; three is a level it keeps failing at.
   */
  swingHighTouches: Schema.optional(Schema.Number),
  swingLowTouches: Schema.optional(Schema.Number),
  breakout: Schema.optional(StructureBreakout),
  /**
   * The last impulse ended within `IMPULSE_FRESH_BARS` bars.
   *
   * "A momentum entry taken twenty bars after the impulse finished is not a
   * momentum entry" — `lastImpulse.ageBars` already said so, and this is the
   * threshold applied so two harnesses cannot pick two different ones.
   */
  impulseIsFresh: Schema.optional(Schema.Boolean),
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
  /** Every setup the measurements support, best score first. Often empty. */
  setups: Schema.Array(CandidateSetup),
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

const callDirection = (score: number, threshold: number): MomentumDirection => {
  if (score >= threshold) return "up";
  if (score <= -threshold) return "down";
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

/**
 * How near a bar has to come to a swing to count as having touched it.
 *
 * A fifth of an ATR: close enough that the market plainly reacted to the level,
 * far enough that an exact-tick match is not required — real touches rarely
 * print the same price twice.
 */
const TOUCH_TOLERANCE_ATR = 0.2;

/** Bars an impulse may be old and still be the one a momentum entry is on. */
export const IMPULSE_FRESH_BARS = 5;

/** Bars whose high (or low) came within `tolerance` of `level`. */
function countTouches(
  candles: ReadonlyArray<MarketCandle>,
  level: number,
  kind: "high" | "low",
  tolerance: number,
): number {
  let touches = 0;
  for (const bar of candles) {
    const distance = kind === "high" ? level - bar.high : bar.low - level;
    if (distance <= tolerance && distance >= -tolerance) touches += 1;
  }
  return touches;
}

/**
 * How much the swing range moved between the window's two halves.
 *
 * Each half is measured by its own high-to-low travel, which needs no pivots
 * and so still answers on a window too short to hold four of them. Zero means
 * the range is exactly as tall as it was; the classify playbook's "stable swing
 * range" is a small number here.
 */
function measureRangeStability(candles: ReadonlyArray<MarketCandle>): number | undefined {
  const half = Math.floor(candles.length / 2);
  if (half < 2) return undefined;
  const spanOf = (bars: ReadonlyArray<MarketCandle>) =>
    Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low));
  const first = spanOf(candles.slice(0, half));
  const second = spanOf(candles.slice(half));
  if (first <= 0) return undefined;
  return (Math.abs(second - first) / first) * 100;
}

/**
 * Whether the last bar broke a swing, and whether it stayed broken.
 *
 * A break is only a break on the close. A bar whose high went through the swing
 * and whose close came back inside is the failed break both playbooks name, and
 * it is reported as one rather than as no break at all.
 */
function readBreakout(
  candles: ReadonlyArray<MarketCandle>,
  swingHigh: number | undefined,
  swingLow: number | undefined,
): StructureBreakout | undefined {
  const bar = candles[candles.length - 1];
  if (bar === undefined) return undefined;

  if (swingHigh !== undefined && (bar.close > swingHigh || bar.high > swingHigh)) {
    return {
      direction: "up",
      level: swingHigh,
      closedBeyond: bar.close > swingHigh,
      wickOnly: bar.high > swingHigh && bar.close <= swingHigh,
    };
  }
  if (swingLow !== undefined && (bar.close < swingLow || bar.low < swingLow)) {
    return {
      direction: "down",
      level: swingLow,
      closedBeyond: bar.close < swingLow,
      wickOnly: bar.low < swingLow && bar.close >= swingLow,
    };
  }
  return undefined;
}

/** Measure one timeframe. Pure arithmetic over the bars it is handed. */
export function analyseTimeframe(
  input: {
    readonly interval: MarketCandleInterval;
    readonly candles: ReadonlyArray<MarketCandle>;
  },
  /**
   * The thresholds to read with. Defaults to the version in force; a replay
   * passes a candidate so the same bars can be re-read under other numbers.
   */
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): MomentumTimeframeContext {
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
  const touchTolerance = atrUsd * TOUCH_TOLERANCE_ATR;
  const rangeStabilityPercent = measureRangeStability(candles);
  const breakout = readBreakout(candles, swingHighPrice, swingLowPrice);

  return {
    interval,
    barsObserved: candles.length,
    sufficientData: candles.length >= MIN_MOMENTUM_BARS && referencePrice > 0,
    // `Price` is strictly positive; an empty window has no reference price and
    // is already reported as insufficient.
    referencePrice: referencePrice > 0 ? referencePrice : 1,
    directionScore,
    direction: callDirection(directionScore, policy.momentum.directionScoreThreshold),
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
    ...(swingHighPrice !== undefined &&
    swingLowPrice !== undefined &&
    swingHighPrice > swingLowPrice
      ? {
          positionInRangePercent:
            ((referencePrice - swingLowPrice) / (swingHighPrice - swingLowPrice)) * 100,
        }
      : {}),
    ...(rangeStabilityPercent === undefined ? {} : { rangeStabilityPercent }),
    ...(swingHighPrice === undefined
      ? {}
      : { swingHighTouches: countTouches(candles, swingHighPrice, "high", touchTolerance) }),
    ...(swingLowPrice === undefined
      ? {}
      : { swingLowTouches: countTouches(candles, swingLowPrice, "low", touchTolerance) }),
    ...(breakout === undefined ? {} : { breakout }),
    ...(found === null ? {} : { impulseIsFresh: found.impulse.ageBars <= IMPULSE_FRESH_BARS }),
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
          ? `all ${measured.length} measured timeframes are chopping — no directional edge; a stable swing range here is a range_reversion regime, not a wait`
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
export function analyseMomentum(
  input: {
    readonly market: string;
    readonly measuredAt: number;
    readonly frames: ReadonlyArray<{
      readonly interval: MarketCandleInterval;
      readonly candles: ReadonlyArray<MarketCandle>;
    }>;
  },
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): MarketStructure {
  const timeframes = input.frames.map((frame) => analyseTimeframe(frame, policy));
  return {
    market: input.market,
    measuredAt: input.measuredAt,
    timeframes,
    alignment: readAlignment(timeframes),
    setups: findCandidateSetups(timeframes, policy),
  };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The setups each timeframe's measurements support.
 *
 * Three shapes, each with the conditions its playbook already states, applied
 * as arithmetic rather than as prose the harness re-derives every turn. A
 * timeframe with insufficient data contributes nothing.
 */
export function findCandidateSetups(
  frames: ReadonlyArray<MomentumTimeframeContext>,
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): ReadonlyArray<CandidateSetup> {
  const setups: Array<CandidateSetup> = [];
  const edgePercent = policy.rangeReversion.edgePercent;
  const stabilityLimit = policy.rangeReversion.stabilityPercent;
  const minTouches = policy.rangeReversion.minBoundaryTouches;

  for (const frame of frames) {
    if (!frame.sufficientData) continue;
    const expansion = frame.atrExpansionRatio ?? 1;

    // A break of a swing, confirmed on the close. A wick through the level is
    // deliberately not a setup: it is the failure this measurement exists to
    // separate out.
    const breakout = frame.breakout;
    if (breakout !== undefined && breakout.closedBeyond) {
      const aligned =
        (breakout.direction === "up" && frame.directionScore > 0) ||
        (breakout.direction === "down" && frame.directionScore < 0);
      // The armed breakout's own close is allowed to lead the slower
      // direction score (the playbook states that exception explicitly), but
      // contracting ATR is not a breakout entry. This structural gate is
      // shared by the live setup read and replay.
      if (expansion <= 1) continue;
      const touches =
        (breakout.direction === "up" ? frame.swingHighTouches : frame.swingLowTouches) ?? 0;
      const openingRangeTested =
        (frame.swingHighTouches ?? 0) >= policy.openingRange.minBoundaryTouches &&
        (frame.swingLowTouches ?? 0) >= policy.openingRange.minBoundaryTouches;
      const score = clamp01(
        0.4 *
          clamp01(Math.abs(frame.directionScore) / policy.momentum.directionScoreThreshold / 2) +
          0.3 * clamp01(expansion - 1) +
          0.2 * (frame.impulseIsFresh === true ? 1 : 0) +
          0.1 * (aligned ? 1 : 0),
      );
      setups.push({
        kind: openingRangeTested ? "opening_range_break" : "momentum_breakout",
        direction: breakout.direction,
        interval: frame.interval,
        score,
        level: breakout.level,
        closeConfirmed: true,
        rationale:
          `close ${breakout.direction === "up" ? "above" : "below"} ${breakout.level} with ` +
          `directionScore ${frame.directionScore.toFixed(2)}, atrExpansionRatio ${expansion.toFixed(2)}, ` +
          `${touches} prior touches, impulse ${frame.impulseIsFresh === true ? "fresh" : "stale"}`,
      });
      continue;
    }

    // A boundary of a range that has held its height and been tested on both
    // sides. Chop is the requirement here, not a disqualification.
    const position = frame.positionInRangePercent;
    const stability = frame.rangeStabilityPercent;
    if (
      position === undefined ||
      stability === undefined ||
      stability > stabilityLimit ||
      frame.direction !== "flat" ||
      (frame.swingHighTouches ?? 0) < minTouches ||
      (frame.swingLowTouches ?? 0) < minTouches
    ) {
      continue;
    }

    const atLow = position <= edgePercent;
    const atHigh = position >= 100 - edgePercent;
    if (!atLow && !atHigh) continue;

    const level = (atLow ? frame.swingLowPrice : frame.swingHighPrice) ?? frame.referencePrice;
    setups.push({
      kind: "range_reversion",
      // Long off the floor, short off the ceiling.
      direction: atLow ? "up" : "down",
      interval: frame.interval,
      score: clamp01(
        0.6 * (1 - stability / stabilityLimit) + 0.4 * (1 - Math.abs(50 - position) / 50),
      ),
      level,
      // The boundary is the price. Waiting for a close gives back the edge the
      // range is paying for.
      closeConfirmed: false,
      rationale:
        `${position.toFixed(0)}% into a range whose height moved ${stability.toFixed(0)}% across the window, ` +
        `tested ${frame.swingLowTouches}x low and ${frame.swingHighTouches}x high`,
    });
  }

  return [...setups].sort((left, right) => right.score - left.score);
}
