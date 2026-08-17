/**
 * Market structure context - the structure a directional thesis is supposed to rest on.
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
 * @module TradingMarketStructure
 */
import { Schema } from "effect";
import { MarketCandle, MarketCandleInterval } from "./market.ts";
import { ACTIVE_TRADING_POLICY, type TradingPolicy } from "./policy.ts";
import { ExchangeMarket, Price, UnixMillis } from "./primitives.ts";

/** The timeframes the momentum read covers, fastest first. */
export const MARKET_STRUCTURE_TIMEFRAMES: ReadonlyArray<MarketCandleInterval> = [
  "1m",
  "5m",
  "15m",
  "1h",
];

/** Bars of history each timeframe is measured over. */
export const MARKET_STRUCTURE_LOOKBACK_BARS = 120;

/** Bars in each ATR leg of the expansion ratio. Matches `ATR_PERIOD`. */
const ATR_LEG_BARS = 14;

/**
 * Fewest bars a timeframe is willing to speak from. Below this the pivots are
 * noise and the ratios are arithmetic on nothing.
 */
export const MIN_MARKET_STRUCTURE_BARS = 30;

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
export const DIRECTION_SCORE_THRESHOLD = ACTIVE_TRADING_POLICY.readings.directionScoreThreshold;

export const MarketDirection = Schema.Literals(["up", "down", "flat"]);
export type MarketDirection = typeof MarketDirection.Type;

/**
 * Bars the recent directional score is measured over.
 *
 * The 120-bar `directionScore` answers "what has this window been doing?";
 * two hours of drift inside it can leave the long score near zero while the
 * last thirty bars grind one way. This shorter window is the one that turns
 * first, so it is measured separately rather than blended in.
 */
export const RECENT_DIRECTION_BARS = 30;

/**
 * The EMA pair the `ema_cross` strategy trades.
 *
 * 9 over 21 is the shortest pair that still smooths a 1m series instead of
 * tracing it, and it is the pair the doctrine names, so the two cannot drift
 * apart. Nothing here is timeframe-specific: the same pair is measured on every
 * interval in {@link MARKET_STRUCTURE_TIMEFRAMES}, and the mission's own timeframe
 * decides which frame's cross it trades.
 */
export const EMA_FAST_PERIOD = 9;
export const EMA_SLOW_PERIOD = 21;

/** Wilder's RSI period, the one every published RSI band assumes. */
export const RSI_PERIOD = 14;

/** RSI at or above this is overbought; at or below its mirror, oversold. */
export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

/**
 * The trailing run of each pivot sequence, counted from the newest pivot back.
 *
 * Three consecutive lower highs is a market being sold at ever-lower levels —
 * structure the 120-bar direction score is too slow to report. Each count is
 * the number of consecutive steps at the END of its pivot sequence going that
 * way; a step the other way, or an exact repeat, ends the run. At most one of
 * each opposing pair is non-zero.
 */
export const PivotTrend = Schema.Struct({
  consecutiveLowerHighs: Schema.Number,
  consecutiveHigherLows: Schema.Number,
  consecutiveLowerLows: Schema.Number,
  consecutiveHigherHighs: Schema.Number,
});
export type PivotTrend = typeof PivotTrend.Type;

/**
 * The last completed directional leg on this timeframe.
 *
 * Measured pivot to pivot: from the swing low that started it to the swing high
 * that ended it, or the mirror. `ageBars` is how many bars have printed since
 * that end — a momentum entry taken twenty bars after the impulse finished is
 * not a momentum entry.
 */
export const SwingImpulse = Schema.Struct({
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
export type SwingImpulse = typeof SwingImpulse.Type;

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
 * The two exponential moving averages the `ema_cross` playbook trades, and
 * where price sits against them.
 *
 * 9 over 21 is the shortest pair that still smooths a 1m series rather than
 * tracing it. `spreadUsd` is fast minus slow, so its SIGN is the bias and its
 * size is how separated the two are; `barsSinceCross` is how long ago that sign
 * last flipped, which is the whole freshness question for a cross entry.
 * Absent when the window is shorter than the slow period.
 */
export const EmaTrend = Schema.Struct({
  fastPeriod: Schema.Number,
  slowPeriod: Schema.Number,
  fastUsd: Schema.Number,
  slowUsd: Schema.Number,
  /** Fast minus slow, in USD of price. Positive is an up bias. */
  spreadUsd: Schema.Number,
  /** The same spread as a percentage of the slow EMA. */
  spreadPercent: Schema.Number,
  /**
   * Bars since the spread last changed sign. Zero means it flipped on the last
   * bar. Absent when the window holds no flip at all — a trend that has been
   * one way for the whole lookback has no cross to be fresh or stale.
   */
  barsSinceCross: Schema.optional(Schema.Number),
  /** Whether the last close sits on the same side of the fast EMA as the bias. */
  closeAgreesWithBias: Schema.Boolean,
  /**
   * The bias as a direction, which is the sign of `spreadUsd` named.
   *
   * Plan 29 step 7.6. The scorer used to derive this, fold it into a verdict,
   * and throw the derivation away; the reading now carries it, so the model
   * reads the same number the detector did.
   */
  direction: MarketDirection,
  /**
   * How far apart the two averages are, in ATRs of the same frame.
   *
   * The one number that separates a cross worth trading from two averages
   * grazing each other in chop, and ATR-normalised so it means the same thing
   * on any market. Zero when the frame has no ATR to normalise by.
   */
  separationAtr: Schema.Number,
});
export type EmaTrend = typeof EmaTrend.Type;

/**
 * Wilder's RSI over the window, and whether it is at an extreme.
 *
 * The one number the `rsi_reversion` playbook turns on. `condition` applies the
 * bands so two harnesses cannot pick two different ones, and
 * `barsSinceEnteringExtreme` says how long the extreme has held — a market that
 * has been overbought for forty bars is trending, not stretched.
 */
export const RsiRead = Schema.Struct({
  period: Schema.Number,
  value: Schema.Number,
  condition: Schema.Literals(["overbought", "oversold", "neutral"]),
  barsSinceEnteringExtreme: Schema.optional(Schema.Number),
});
export type RsiRead = typeof RsiRead.Type;

/**
 * A setup the arithmetic can see, scored, with the level it lives at.
 *
 * Not a recommendation and not a permission — nothing in the runtime reads
 * these. It is the same evidence the playbooks ask the harness to assemble by
 * hand out of six other fields, assembled once and consistently, so that "there
 * was no setup" and "there was a setup and I did not see it" stop looking
 * identical in the decision funnel.
 */
/**
 * One internal threshold a candidate failed, and by how much — plan 29 step
 * 3.4.
 *
 * The detectors used to return `null` on a failed threshold, which made a
 * signal 5% under its requirement indistinguishable from no signal at all. A
 * near-miss row carries every gate it failed with the shortfall in the gate's
 * own unit: required minus observed for a minimum, observed minus allowed for
 * a maximum. A model weighs the margin; nothing gates on it.
 */
export const SetupRejection = Schema.Struct({
  /** The gate that fired, e.g. `ema_separation` or `cross_age`. */
  gate: Schema.String,
  /** The shortfall in the gate's own unit. Smaller is nearer. */
  margin: Schema.Number,
});
export type SetupRejection = typeof SetupRejection.Type;

/** One line naming every gate a near-miss failed, for a row that stands alone. */
const describeRejections = (rejections: ReadonlyArray<SetupRejection>): string =>
  rejections
    .map(({ gate, margin }) => `${gate} short by ${Number(margin.toPrecision(3))}`)
    .join(", ");

export const CandidateSetup = Schema.Struct({
  kind: Schema.Literals([
    "momentum_breakout",
    "range_reversion",
    "opening_range_break",
    "trend_continuation",
    "rsi_reversion",
  ]),
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
  /**
   * The internal thresholds this setup failed, when it failed any — plan 29
   * step 3.4.
   *
   * Absent on a setup that cleared every gate its detector applies: that is a
   * real scored candidate, and anything counting or entering behind "a scored
   * setup" must treat only setups without this field as one. Present, the row
   * is context — a near-miss the model can weigh, never evidence. Frames with
   * insufficient data still contribute nothing at all.
   */
  rejectedBy: Schema.optional(Schema.Array(SetupRejection)),
});
export type CandidateSetup = typeof CandidateSetup.Type;

/** What one timeframe says about direction, expansion, and structure. */
export const TimeframeReading = Schema.Struct({
  interval: MarketCandleInterval,
  barsObserved: Schema.Number,
  /** False when the window is shorter than `MIN_MARKET_STRUCTURE_BARS`. */
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
  direction: MarketDirection,
  /**
   * The same net-over-total travel, over only the last `RECENT_DIRECTION_BARS`
   * bars (the whole window when it is shorter).
   *
   * This is the number that turns first when a range starts grinding one way:
   * the 120-bar score still reads flat while this one is already decisive. A
   * large gap between the two is the transition the classifier names.
   */
  recentDirectionScore: Schema.Number,
  /**
   * The trailing run of each pivot sequence — see {@link PivotTrend}. All
   * zeros when the window has too few pivots to make a run.
   */
  pivotTrend: PivotTrend,
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
  lastImpulse: Schema.optional(SwingImpulse),
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
   * How far the window's ceiling moved between its first and second half, in
   * USD of price: second half's highest high minus the first half's.
   *
   * `rangeStabilityPercent` says whether the range kept its HEIGHT; a range
   * whose height held while both bounds slid ten dollars lower is not stable,
   * it is drifting — the grind this measurement exists to catch. Positive is
   * up, negative is down. Absent when either half is too short to measure.
   */
  swingHighDriftUsd: Schema.optional(Schema.Number),
  /** The same drift for the window's floor: second half's lowest low minus the first half's. */
  swingLowDriftUsd: Schema.optional(Schema.Number),
  /**
   * Median favourable up move over median favourable down move, measured from
   * each bar close over the next `EXCURSION_HORIZON_BARS` bars.
   *
   * Near 1 the window paid longs and shorts alike (ranging); far from 1 one
   * side has been paying (trending). The same measurement `ObservedVolatility`
   * publishes, computed here per timeframe so the regime classifier can read
   * it without a second tool call. Absent when the window is too short to
   * sample or the downside median is zero.
   */
  excursionSymmetryRatio: Schema.optional(Schema.Number),
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
   * The 9/21 EMA pair on this timeframe — see {@link EmaTrend}.
   *
   * Measured on every timeframe alongside the structural features, so the
   * indicator strategies compete in the same tournament from the same read
   * rather than needing a second tool call.
   */
  ema: Schema.optional(EmaTrend),
  /** Wilder's RSI(14) on this timeframe — see {@link RsiRead}. */
  rsi: Schema.optional(RsiRead),
  /**
   * The last impulse ended within `IMPULSE_FRESH_BARS` bars.
   *
   * "A momentum entry taken twenty bars after the impulse finished is not a
   * momentum entry" — `lastImpulse.ageBars` already said so, and this is the
   * threshold applied so two harnesses cannot pick two different ones.
   */
  impulseIsFresh: Schema.optional(Schema.Boolean),
});
export type TimeframeReading = typeof TimeframeReading.Type;

/** Whether the timeframes agree, and how strongly. */
export const TimeframeAlignment = Schema.Struct({
  direction: Schema.Literals(["up", "down", "mixed"]),
  /** Mean `directionScore` across every timeframe with sufficient data. */
  score: Schema.Number,
  agreeingTimeframes: Schema.Number,
  measuredTimeframes: Schema.Number,
  /** One line stating what the agreement or disagreement actually is. */
  note: Schema.String,
});
export type TimeframeAlignment = typeof TimeframeAlignment.Type;

/**
 * The classify playbook's regime read, applied in code.
 *
 * A verdict, not a permission: the harness may overrule it, but it has to say
 * why, against the named evidence. `evidence[]` is every measured feature that
 * voted for the classification; `conflicts[]` names every feature pair that
 * disagreed, because the turns where the features disagree are exactly the
 * turns a transition begins and the classifier refuses to paper over them.
 */
export const MarketRegime = Schema.Struct({
  classification: Schema.Literals(["trending", "ranging", "transition"]),
  evidence: Schema.Array(Schema.String),
  /**
   * The disagreeing feature pairs, bounded to
   * {@link MAX_REGIME_CONFLICTS} — plan 33 fix D.
   *
   * Every trending fact against every ranging one is a cross product: four of
   * each is sixteen lines, and a real four-timeframe read produced eighty-four
   * — nearly 9k characters restating the same dozen labels. The bound is not a
   * silent one: when pairs were dropped, the last entry says how many, so a
   * turn reading a short list can tell "they agreed" from "there was more".
   */
  conflicts: Schema.Array(Schema.String),
});
export type MarketRegime = typeof MarketRegime.Type;

/**
 * One row of the strategy tournament — a scored setup joined with the cost of
 * taking it and the distance to its trigger.
 *
 * Every candidate in one table, so the turn that picks a strategy compares the
 * whole field instead of the one setup it happened to look at. Evidence, never
 * permission: nothing compares `costMultiple` against anything any more (plan
 * 29 step 3.1) — it is the context the single question reads, *is the expected
 * move bigger than the round trip?*, and the harness still writes its own
 * reason for the candidate it runs and the ones it declines.
 */
export const StrategyCandidate = Schema.Struct({
  /** The playbook the candidate belongs to — same literals as `CandidateSetup.kind`. */
  strategy: Schema.Literals([
    "momentum_breakout",
    "range_reversion",
    "opening_range_break",
    "trend_continuation",
    "rsi_reversion",
  ]),
  direction: Schema.Literals(["up", "down"]),
  interval: MarketCandleInterval,
  /** The setup's own 0-1 score, copied so the table sorts the same way `setups[]` does. */
  score: Schema.Number,
  /** The price the candidate triggers at — the level to arm. */
  level: Price,
  /** True: arm a `candle_close`. False: a `price_cross` at the boundary. */
  closeConfirmed: Schema.Boolean,
  /** How far the last close sits from the trigger, in USD of price. */
  distanceToTriggerUsd: Schema.Number,
  /**
   * The move the candidate's playbook says is on offer: the range height for
   * a reversion or ORB, the last impulse's size for a breakout or
   * continuation. Absent when the frame could not measure it.
   */
  availableMoveUsd: Schema.optional(Schema.Number),
  /**
   * `availableMoveUsd` over the break-even price move at the current book.
   * Absent when no cost estimate was readable — absence is "unknown", never
   * "free". Context, not a gate.
   */
  costMultiple: Schema.optional(Schema.Number),
  /**
   * The internal gates this candidate failed, copied from its setup — plan 29
   * step 3.4. Absent on a real candidate; present, the row is a flagged
   * near-miss the model weighs, never a scored setup.
   */
  rejectedBy: Schema.optional(Schema.Array(SetupRejection)),
  /** The setup's own rationale, carried through so the row stands alone. */
  note: Schema.String,
});
export type StrategyCandidate = typeof StrategyCandidate.Type;

export const MarketStructure = Schema.Struct({
  market: ExchangeMarket,
  measuredAt: UnixMillis,
  timeframes: Schema.Array(TimeframeReading),
  alignment: TimeframeAlignment,
  /** The computed regime verdict — evidence for the classify turn, never permission. */
  regime: MarketRegime,
  /** Every setup the measurements support, best score first. Often empty. */
  setups: Schema.Array(CandidateSetup),
  /**
   * The tournament view of `setups[]`: each candidate joined with the cost of
   * taking it at the current book — see {@link StrategyCandidate}. Attached by
   * the structure read when it can price one; the pure analysis leaves it
   * absent.
   */
  candidates: Schema.optional(Schema.Array(StrategyCandidate)),
});
export type MarketStructure = typeof MarketStructure.Type;

/**
 * One timeframe as it rides back to a model — plan 34 step 1.2.
 *
 * `TimeframeReading` carries thirty measured features per frame because the
 * detectors score on them; four frames of it is 4,700 characters on every
 * look, and nothing downstream of the detectors reads twenty-six of them. This
 * is the half a turn actually reasons with: which way, how fast, how far, and
 * where the boundaries are. The full reading is still what
 * {@link analyseMarketStructure} computes and what `setups[]` and
 * `candidates[]` are scored from — this bounds only the echo.
 */
export const TimeframeDigest = Schema.Struct({
  interval: MarketCandleInterval,
  /** False when the window is shorter than `MIN_MARKET_STRUCTURE_BARS`. */
  sufficientData: Schema.Boolean,
  /** The last close; the swing distances are measured from it. */
  referencePrice: Price,
  direction: MarketDirection,
  directionScore: Schema.Number,
  /** The same score over only the last `RECENT_DIRECTION_BARS` bars. */
  recentDirectionScore: Schema.Number,
  atrUsd: Schema.Number,
  atrPercent: Schema.Number,
  swingHighPrice: Schema.optional(Price),
  swingLowPrice: Schema.optional(Price),
});
export type TimeframeDigest = typeof TimeframeDigest.Type;

/** One frame, cut to what a turn reads. */
export const digestTimeframe = (frame: TimeframeReading): TimeframeDigest => ({
  interval: frame.interval,
  sufficientData: frame.sufficientData,
  referencePrice: frame.referencePrice,
  direction: frame.direction,
  directionScore: frame.directionScore,
  recentDirectionScore: frame.recentDirectionScore,
  atrUsd: frame.atrUsd,
  atrPercent: frame.atrPercent,
  ...(frame.swingHighPrice === undefined ? {} : { swingHighPrice: frame.swingHighPrice }),
  ...(frame.swingLowPrice === undefined ? {} : { swingLowPrice: frame.swingLowPrice }),
});

/**
 * The structure read as `trading_look` returns it.
 *
 * Same verdicts, less echo: the per-frame readings are digested, and `setups[]`
 * is dropped whenever `candidates[]` is present — a candidate carries every
 * field of the setup it was built from plus the cost of taking it, so shipping
 * both was the same table twice.
 */
export const ObservedMarketStructure = Schema.Struct({
  market: ExchangeMarket,
  measuredAt: UnixMillis,
  timeframes: Schema.Array(TimeframeDigest),
  alignment: TimeframeAlignment,
  regime: MarketRegime,
  /** Present only when the read could not price a candidate table. */
  setups: Schema.optional(Schema.Array(CandidateSetup)),
  candidates: Schema.optional(Schema.Array(StrategyCandidate)),
});
export type ObservedMarketStructure = typeof ObservedMarketStructure.Type;

/** {@link ObservedMarketStructure} from the full read. */
export const digestMarketStructure = (structure: MarketStructure): ObservedMarketStructure => ({
  market: structure.market,
  measuredAt: structure.measuredAt,
  timeframes: structure.timeframes.map(digestTimeframe),
  alignment: structure.alignment,
  regime: structure.regime,
  ...(structure.candidates === undefined
    ? { setups: structure.setups }
    : { candidates: structure.candidates }),
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/**
 * The EMA series over `values`, seeded with the simple average of the first
 * `period` samples.
 *
 * One entry per input from index `period - 1` onward, so the last element is
 * the current EMA. Empty when the window is shorter than the period — an EMA
 * of fewer bars than its own period is a number with no smoothing in it.
 */
export function exponentialMovingAverage(
  values: ReadonlyArray<number>,
  period: number,
): ReadonlyArray<number> {
  if (period <= 0 || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  let average = mean(values.slice(0, period));
  const series: Array<number> = [average];
  for (const value of values.slice(period)) {
    average = (value - average) * multiplier + average;
    series.push(average);
  }
  return series;
}

/**
 * The 9/21 EMA read for one window — see {@link EmaTrend}.
 *
 * The two series are aligned on their shared tail (the slow one starts later),
 * so `barsSinceCross` counts bars of the input, not offsets of an array.
 */
export function readEmaTrend(
  candles: ReadonlyArray<MarketCandle>,
  atrUsd: number = 0,
): EmaTrend | undefined {
  const closes = candles.map((candle) => candle.close);
  const fast = exponentialMovingAverage(closes, EMA_FAST_PERIOD);
  const slow = exponentialMovingAverage(closes, EMA_SLOW_PERIOD);
  if (fast.length === 0 || slow.length === 0) return undefined;

  // Both series end on the last bar, so aligning on the shorter tail pairs the
  // two EMAs of the same bar.
  const paired = slow.length;
  const fastTail = fast.slice(fast.length - paired);
  const spreads = fastTail.map((value, index) => value - slow[index]!);
  const currentSpread = spreads[spreads.length - 1]!;
  const slowUsd = slow[slow.length - 1]!;
  const fastUsd = fastTail[fastTail.length - 1]!;

  // Walk back to the newest bar whose spread had the other sign; the bars
  // since it are the age of the cross.
  let barsSinceCross: number | undefined;
  const currentIsUp = currentSpread >= 0;
  for (let index = spreads.length - 2; index >= 0; index -= 1) {
    if (spreads[index]! >= 0 !== currentIsUp) {
      barsSinceCross = spreads.length - 1 - index - 1;
      break;
    }
  }

  const lastClose = closes[closes.length - 1] ?? fastUsd;
  return {
    fastPeriod: EMA_FAST_PERIOD,
    slowPeriod: EMA_SLOW_PERIOD,
    fastUsd,
    slowUsd,
    spreadUsd: currentSpread,
    spreadPercent: slowUsd > 0 ? (currentSpread / slowUsd) * 100 : 0,
    ...(barsSinceCross === undefined ? {} : { barsSinceCross }),
    closeAgreesWithBias: currentIsUp ? lastClose >= fastUsd : lastClose <= fastUsd,
    direction: currentIsUp ? "up" : "down",
    separationAtr: atrUsd > 0 ? Math.abs(currentSpread) / atrUsd : 0,
  };
}

/**
 * Wilder's RSI over the window — see {@link RsiRead}.
 *
 * Smoothed the way Wilder defined it (an EMA of gains and losses with a 1/period
 * multiplier), not as a simple average of the last 14 bars, because every
 * published overbought/oversold band assumes the smoothed form.
 */
export function readRsi(candles: ReadonlyArray<MarketCandle>): RsiRead | undefined {
  if (candles.length < RSI_PERIOD + 1) return undefined;
  const closes = candles.map((candle) => candle.close);

  const gains: Array<number> = [];
  const losses: Array<number> = [];
  for (let index = 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }

  let averageGain = mean(gains.slice(0, RSI_PERIOD));
  let averageLoss = mean(losses.slice(0, RSI_PERIOD));
  const values: Array<number> = [];
  const push = (): void => {
    // No losses at all is RSI 100 by definition, not a division by zero.
    const strength = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
    values.push(strength);
  };
  push();
  for (let index = RSI_PERIOD; index < gains.length; index += 1) {
    averageGain = (averageGain * (RSI_PERIOD - 1) + gains[index]!) / RSI_PERIOD;
    averageLoss = (averageLoss * (RSI_PERIOD - 1) + losses[index]!) / RSI_PERIOD;
    push();
  }

  const value = values[values.length - 1]!;
  const condition =
    value >= RSI_OVERBOUGHT
      ? ("overbought" as const)
      : value <= RSI_OVERSOLD
        ? ("oversold" as const)
        : ("neutral" as const);

  // How long the extreme has held: a market overbought for forty bars is
  // trending, and that is the reversion trap this count exists to expose.
  let barsSinceEnteringExtreme: number | undefined;
  if (condition !== "neutral") {
    const isExtreme = (sample: number): boolean =>
      condition === "overbought" ? sample >= RSI_OVERBOUGHT : sample <= RSI_OVERSOLD;
    let bars = 0;
    for (let index = values.length - 2; index >= 0 && isExtreme(values[index]!); index -= 1) {
      bars += 1;
    }
    barsSinceEnteringExtreme = bars;
  }

  return {
    period: RSI_PERIOD,
    value,
    condition,
    ...(barsSinceEnteringExtreme === undefined ? {} : { barsSinceEnteringExtreme }),
  };
}

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

const callDirection = (score: number, threshold: number): MarketDirection => {
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
  readonly impulse: SwingImpulse;
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
 * How far each swing bound moved between the window's two halves, in USD.
 *
 * The half split matches `measureRangeStability`: that function reports
 * whether the range kept its height, this one reports whether the bounds kept
 * their place. A range grinding lower holds its height while both drifts go
 * negative, which is how a "stable" range hides a trend.
 */
function measureSwingDrift(
  candles: ReadonlyArray<MarketCandle>,
): { readonly highDriftUsd: number; readonly lowDriftUsd: number } | undefined {
  const half = Math.floor(candles.length / 2);
  if (half < 2) return undefined;
  const first = candles.slice(0, half);
  const second = candles.slice(half);
  return {
    highDriftUsd:
      Math.max(...second.map((bar) => bar.high)) - Math.max(...first.map((bar) => bar.high)),
    lowDriftUsd:
      Math.min(...second.map((bar) => bar.low)) - Math.min(...first.map((bar) => bar.low)),
  };
}

/** The trailing same-direction run at the end of a pivot price sequence. */
function trailingRun(prices: ReadonlyArray<number>, direction: "up" | "down"): number {
  let run = 0;
  for (let i = prices.length - 1; i > 0; i--) {
    const step = (prices[i] ?? 0) - (prices[i - 1] ?? 0);
    if (direction === "up" ? step > 0 : step < 0) run += 1;
    else break;
  }
  return run;
}

/** The trailing runs of both pivot sequences — see {@link PivotTrend}. */
function readPivotTrend(
  candles: ReadonlyArray<MarketCandle>,
  highPivots: ReadonlyArray<number>,
  lowPivots: ReadonlyArray<number>,
): PivotTrend {
  const highPrices = highPivots.map((index) => candles[index]?.high ?? 0);
  const lowPrices = lowPivots.map((index) => candles[index]?.low ?? 0);
  return {
    consecutiveLowerHighs: trailingRun(highPrices, "down"),
    consecutiveHigherLows: trailingRun(lowPrices, "up"),
    consecutiveLowerLows: trailingRun(lowPrices, "down"),
    consecutiveHigherHighs: trailingRun(highPrices, "up"),
  };
}

/** Bars ahead each excursion sample looks — matches `RECENT_DIRECTION_BARS`. */
const EXCURSION_HORIZON_BARS = 30;

/** Fewest excursion samples before the ratio means anything. */
const MIN_EXCURSION_SAMPLES = 20;

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/**
 * Median favourable up move over median favourable down move.
 *
 * Same measurement as `ObservedVolatility.excursionSymmetryRatio`, at one
 * fixed horizon, so the regime classifier can hold the excursion symmetry the
 * classify playbook asks about against the rest of the structure read.
 */
function measureExcursionSymmetry(candles: ReadonlyArray<MarketCandle>): number | undefined {
  const ups: Array<number> = [];
  const downs: Array<number> = [];
  for (let i = 0; i + EXCURSION_HORIZON_BARS < candles.length; i++) {
    const from = candles[i];
    if (from === undefined) continue;
    const forward = candles.slice(i + 1, i + 1 + EXCURSION_HORIZON_BARS);
    ups.push(Math.max(0, Math.max(...forward.map((bar) => bar.high)) - from.close));
    downs.push(Math.max(0, from.close - Math.min(...forward.map((bar) => bar.low))));
  }
  if (ups.length < MIN_EXCURSION_SAMPLES) return undefined;
  const downMedian = median(downs);
  if (downMedian <= 0) return undefined;
  return median(ups) / downMedian;
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
): TimeframeReading {
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
  const recentDirectionScore = directionalEfficiency(candles.slice(-RECENT_DIRECTION_BARS));
  const touchTolerance = atrUsd * TOUCH_TOLERANCE_ATR;
  const rangeStabilityPercent = measureRangeStability(candles);
  const swingDrift = measureSwingDrift(candles);
  const excursionSymmetryRatio = measureExcursionSymmetry(candles);
  const breakout = readBreakout(candles, swingHighPrice, swingLowPrice);
  // The frame's own ATR normalises the separation, so a cross reads the same
  // way on a $4,000 market and a $90,000 one.
  const ema = readEmaTrend(candles, atrUsd);
  const rsi = readRsi(candles);

  return {
    interval,
    barsObserved: candles.length,
    sufficientData: candles.length >= MIN_MARKET_STRUCTURE_BARS && referencePrice > 0,
    // `Price` is strictly positive; an empty window has no reference price and
    // is already reported as insufficient.
    referencePrice: referencePrice > 0 ? referencePrice : 1,
    directionScore,
    direction: callDirection(directionScore, policy.readings.directionScoreThreshold),
    recentDirectionScore,
    pivotTrend: readPivotTrend(candles, highs, lows),
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
    ...(swingDrift === undefined
      ? {}
      : { swingHighDriftUsd: swingDrift.highDriftUsd, swingLowDriftUsd: swingDrift.lowDriftUsd }),
    ...(excursionSymmetryRatio === undefined ? {} : { excursionSymmetryRatio }),
    ...(swingHighPrice === undefined
      ? {}
      : { swingHighTouches: countTouches(candles, swingHighPrice, "high", touchTolerance) }),
    ...(swingLowPrice === undefined
      ? {}
      : { swingLowTouches: countTouches(candles, swingLowPrice, "low", touchTolerance) }),
    ...(breakout === undefined ? {} : { breakout }),
    ...(ema === undefined ? {} : { ema }),
    ...(rsi === undefined ? {} : { rsi }),
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
function readAlignment(frames: ReadonlyArray<TimeframeReading>): TimeframeAlignment {
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

// ---------------------------------------------------------------------------
// Regime classification
// ---------------------------------------------------------------------------

/** An ATR expansion below this is noise, not trend evidence. */
const REGIME_ATR_EXPANSION_TRENDING = 1.1;

/** Excursion symmetry inside [1/band, band] reads as ranging. */
const REGIME_SYMMETRY_RANGING_BAND = 1.35;

/** Excursion symmetry outside [1/band, band] reads as trending. */
const REGIME_SYMMETRY_TRENDING_BAND = 1.75;

/** Swing-bound drift material at this many ATRs; both bounds under it is a range holding. */
const REGIME_DRIFT_MATERIAL_ATR = 0.5;

/** Consecutive same-direction pivots before structure counts as a trend. */
const REGIME_PIVOT_RUN = 2;

/** One feature's vote: which regime it supports and the measured fact behind it. */
interface RegimeFact {
  readonly side: "trending" | "ranging";
  readonly label: string;
}

/**
 * How many disagreeing pairs are worth naming — plan 33 fix D.
 *
 * The conflicts are a cross product, so they grow as the square of how much
 * the read measured: a four-timeframe read with a handful of facts a side
 * produced eighty-four lines and nearly 9k characters, out of a dozen distinct
 * labels each repeated seven times. Four pairs is enough to see WHAT
 * disagrees; the count line that follows says how much more of the same there
 * was, and `evidence` already carries every fact on a `transition` read.
 */
export const MAX_REGIME_CONFLICTS = 4;

/**
 * The named disagreements, bounded.
 *
 * Pairs are taken one per trending fact before a second pair of any of them,
 * so a short list shows the BREADTH of the disagreement rather than one
 * trending fact argued against four ranging ones.
 */
function describeConflicts(
  trending: ReadonlyArray<RegimeFact>,
  ranging: ReadonlyArray<RegimeFact>,
): ReadonlyArray<string> {
  const total = trending.length * ranging.length;
  if (total === 0) return [];

  const named: Array<string> = [];
  for (let round = 0; round < ranging.length && named.length < MAX_REGIME_CONFLICTS; round += 1) {
    const range = ranging[round];
    if (range === undefined) break;
    for (const trend of trending) {
      if (named.length >= MAX_REGIME_CONFLICTS) break;
      named.push(`${trend.label} vs ${range.label}`);
    }
  }

  if (total <= named.length) return named;
  return [...named, `and ${total - named.length} more disagreeing pairs among the same features`];
}

/** Every regime fact one measured timeframe contributes. */
function readRegimeFacts(frame: TimeframeReading, policy: TradingPolicy): Array<RegimeFact> {
  const facts: Array<RegimeFact> = [];
  const at = frame.interval;
  const threshold = policy.readings.directionScoreThreshold;

  if (frame.direction !== "flat") {
    facts.push({
      side: "trending",
      label: `${at} directionScore ${frame.directionScore.toFixed(2)} is decisive`,
    });
  } else if (Math.abs(frame.directionScore) <= threshold / 2) {
    facts.push({
      side: "ranging",
      label: `${at} directionScore ${frame.directionScore.toFixed(2)} is chop`,
    });
  }

  // The short window turning is trend evidence; a flat short window says
  // nothing on its own — chop is claimed by the full-window score above.
  if (Math.abs(frame.recentDirectionScore) >= threshold) {
    facts.push({
      side: "trending",
      label: `${at} recent ${RECENT_DIRECTION_BARS}-bar directionScore ${frame.recentDirectionScore.toFixed(2)} is decisive`,
    });
  }

  const expansion = frame.atrExpansionRatio;
  if (expansion !== undefined && expansion >= REGIME_ATR_EXPANSION_TRENDING) {
    facts.push({
      side: "trending",
      label: `${at} atrExpansionRatio ${expansion.toFixed(2)} is expanding`,
    });
  }

  const stability = frame.rangeStabilityPercent;
  const stabilityLimit = policy.rangeReversion.stabilityPercent;
  if (stability !== undefined) {
    if (stability <= stabilityLimit) {
      facts.push({
        side: "ranging",
        label: `${at} range height moved ${stability.toFixed(0)}% across the window (stable)`,
      });
    } else if (stability > 2 * stabilityLimit) {
      facts.push({
        side: "trending",
        label: `${at} range height moved ${stability.toFixed(0)}% across the window (not a range)`,
      });
    }
  }

  const symmetry = frame.excursionSymmetryRatio;
  if (symmetry !== undefined && symmetry > 0) {
    const band = symmetry > 1 ? symmetry : 1 / symmetry;
    if (band <= REGIME_SYMMETRY_RANGING_BAND) {
      facts.push({
        side: "ranging",
        label: `${at} excursionSymmetryRatio ${symmetry.toFixed(2)} paid both sides alike`,
      });
    } else if (band >= REGIME_SYMMETRY_TRENDING_BAND) {
      facts.push({
        side: "trending",
        label: `${at} excursionSymmetryRatio ${symmetry.toFixed(2)} paid one side`,
      });
    }
  }

  const pivots = frame.pivotTrend;
  if (
    pivots.consecutiveHigherHighs >= REGIME_PIVOT_RUN &&
    pivots.consecutiveHigherLows >= REGIME_PIVOT_RUN
  ) {
    facts.push({
      side: "trending",
      label: `${at} structure printed ${pivots.consecutiveHigherHighs} higher highs and ${pivots.consecutiveHigherLows} higher lows`,
    });
  }
  if (
    pivots.consecutiveLowerHighs >= REGIME_PIVOT_RUN &&
    pivots.consecutiveLowerLows >= REGIME_PIVOT_RUN
  ) {
    facts.push({
      side: "trending",
      label: `${at} structure printed ${pivots.consecutiveLowerHighs} lower highs and ${pivots.consecutiveLowerLows} lower lows`,
    });
  }

  const highDrift = frame.swingHighDriftUsd;
  const lowDrift = frame.swingLowDriftUsd;
  if (highDrift !== undefined && lowDrift !== undefined && frame.atrUsd > 0) {
    const material = REGIME_DRIFT_MATERIAL_ATR * frame.atrUsd;
    const sameDirection = highDrift * lowDrift > 0;
    if (sameDirection && Math.abs(highDrift) >= material && Math.abs(lowDrift) >= material) {
      const way = highDrift > 0 ? "up" : "down";
      facts.push({
        side: "trending",
        label: `${at} both swing bounds drifted ${way} (${highDrift.toFixed(2)} / ${lowDrift.toFixed(2)} USD)`,
      });
    } else if (Math.abs(highDrift) < material && Math.abs(lowDrift) < material) {
      facts.push({
        side: "ranging",
        label: `${at} swing bounds held their place between window halves`,
      });
    }
  }

  return facts;
}

/**
 * Apply the classify playbook's criteria to the measured timeframes.
 *
 * Each measurable feature on each measured timeframe casts one vote. A side
 * wins only when it has at least two votes and at least twice the other's —
 * anything closer is a transition, because the turns where the features
 * disagree are the turns the next regime is being born, and papering over the
 * disagreement is how the last grind-down was traded as a range. The harness
 * may overrule the verdict, against the named evidence.
 */
export function classifyRegime(
  frames: ReadonlyArray<TimeframeReading>,
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): MarketRegime {
  const facts = frames
    .filter((frame) => frame.sufficientData)
    .flatMap((frame) => readRegimeFacts(frame, policy));
  const trending = facts.filter((fact) => fact.side === "trending");
  const ranging = facts.filter((fact) => fact.side === "ranging");

  const conflicts = describeConflicts(trending, ranging);

  const classification =
    trending.length >= 2 && trending.length >= 2 * ranging.length
      ? ("trending" as const)
      : ranging.length >= 2 && ranging.length >= 2 * trending.length
        ? ("ranging" as const)
        : ("transition" as const);
  const winning =
    classification === "trending" ? trending : classification === "ranging" ? ranging : facts;

  return {
    classification,
    evidence: winning.map((fact) => fact.label),
    conflicts,
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
export function analyseMarketStructure(
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
    regime: classifyRegime(timeframes, policy),
    setups: findCandidateSetups(timeframes, policy),
  };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Deepest a pullback may run, as a percent of the impulse it is undoing,
 * before a continuation entry is chasing a reversal instead.
 */
export const TREND_CONTINUATION_MAX_PULLBACK_PERCENT = 50;

/**
 * A drift resuming after a shallow pullback — the entry the 2026-08-13 grind
 * offered over and over while the breakout branch waited for a close that had
 * already happened bars ago.
 *
 * The evidence is the pivot run in the drift's direction, the recent
 * directional score agreeing with it, and a pullback shallow enough that the
 * leg is being bought (or sold) rather than reversed. The trigger is a candle
 * CLOSING back through the pullback's own extreme — the impulse end price —
 * never a boundary touch: a touch of that level is the pullback finishing,
 * and only the close says the drift resumed.
 */
function readTrendContinuation(
  frame: TimeframeReading,
  policy: TradingPolicy,
): CandidateSetup | null {
  const impulse = frame.lastImpulse;
  const pullbackPercent = frame.pullbackPercentOfImpulse;
  // No impulse or no pullback at all is no signal, not a near-miss: there is
  // no leg to continue and nothing to be near.
  if (impulse === undefined || pullbackPercent === undefined || pullbackPercent <= 0) return null;

  const rejections: Array<SetupRejection> = [];
  if (pullbackPercent > TREND_CONTINUATION_MAX_PULLBACK_PERCENT) {
    rejections.push({
      gate: "pullback_too_deep",
      margin: pullbackPercent - TREND_CONTINUATION_MAX_PULLBACK_PERCENT,
    });
  }

  // The failing levels are the pivots the drift keeps making: higher lows
  // under an up leg, lower highs over a down leg.
  const run =
    impulse.direction === "up"
      ? frame.pivotTrend.consecutiveHigherLows
      : frame.pivotTrend.consecutiveLowerHighs;
  if (run < REGIME_PIVOT_RUN) {
    rejections.push({ gate: "pivot_run", margin: REGIME_PIVOT_RUN - run });
  }

  const recent = frame.recentDirectionScore;
  const recentAgrees = impulse.direction === "up" ? recent > 0 : recent < 0;
  if (!recentAgrees) {
    // The conviction of the drift against the leg — zero is a coin flip
    // away from agreeing.
    rejections.push({ gate: "recent_direction", margin: Math.abs(recent) });
  }

  const threshold = policy.readings.directionScoreThreshold;
  const score = clamp01(
    0.35 * clamp01(run / 4) +
      0.35 * clamp01(Math.abs(recent) / threshold / 2) +
      0.3 * (1 - pullbackPercent / TREND_CONTINUATION_MAX_PULLBACK_PERCENT),
  );
  return {
    kind: "trend_continuation",
    direction: impulse.direction,
    interval: frame.interval,
    score,
    level: impulse.endPrice,
    // The pullback extreme touching the level is the pullback finishing; only
    // a close back through it says the drift resumed.
    closeConfirmed: true,
    rationale:
      `${run} consecutive ${impulse.direction === "up" ? "higher lows" : "lower highs"}, ` +
      `recent ${RECENT_DIRECTION_BARS}-bar directionScore ${recent.toFixed(2)}, ` +
      `pullback ${pullbackPercent.toFixed(0)}% of the ${impulse.sizeUsd.toFixed(2)} USD impulse; ` +
      `a candle closing back through ${impulse.endPrice} resumes the drift` +
      (rejections.length === 0 ? "" : `; near-miss: ${describeRejections(rejections)}`),
    ...(rejections.length === 0 ? {} : { rejectedBy: rejections }),
  };
}

/*
 * `readEmaCross` used to live here — plan 29 step 7.6 deleted it.
 *
 * It took the same `ema` reading the frame already carries, applied three
 * policy thresholds to it, folded the result into a 0-to-1 score, and handed
 * the model a verdict. The model cannot argue with a score; it can only accept
 * or ignore it, and either way the numbers behind it were gone. Two averages
 * crossing is a reading, not a decision: `EmaTrend` now carries the bias, the
 * ATR-normalised separation, and the age of the cross, and the `ema_cross`
 * playbook reads them and reaches its own conclusion against the same cost
 * question every other entry answers.
 *
 * The three thresholds survive in `policy.emaCross` and are quoted in the
 * playbook's prose, where they read as guidance the model can weigh rather
 * than as a gate that already decided.
 */

/**
 * An RSI band extreme that has only just been reached — the other simple
 * indicator strategy, standing alone beside the EMA cross.
 *
 * Distinct from `range_reversion`, which reads a structural range and its
 * boundaries: this one reads one oscillator against fixed bands and needs no
 * range at all. What it borrows from the range playbook is the discipline that
 * an extreme which has HELD for many bars is a trend being ridden, not a market
 * stretched away from its mean.
 */
function readRsiReversion(frame: TimeframeReading, policy: TradingPolicy): CandidateSetup | null {
  const rsi = frame.rsi;
  // A neutral oscillator is no signal — there is no extreme to be near.
  if (rsi === undefined || rsi.condition === "neutral") return null;

  const age = rsi.barsSinceEnteringExtreme ?? 0;
  // Fade the extreme: overbought is a short, oversold is a long.
  const direction = rsi.condition === "overbought" ? ("down" as const) : ("up" as const);

  // A market driving INTO the band is trending, and fading a trend on an
  // oscillator is the losing half of this strategy's reputation. The freshness
  // check cannot see it — a breakout prints an overbought reading on its
  // first bar — so the recent directional score is the veto.
  const recent = frame.recentDirectionScore;
  const threshold = policy.readings.directionScoreThreshold;
  const trendingIntoBand = direction === "down" ? recent >= threshold : recent <= -threshold;

  const rejections: Array<SetupRejection> = [];
  if (age > policy.rsiReversion.maxExtremeAgeBars) {
    rejections.push({ gate: "extreme_age", margin: age - policy.rsiReversion.maxExtremeAgeBars });
  }
  if (trendingIntoBand) {
    // The conviction of the trend into the band, beyond the threshold that
    // already makes it a veto.
    rejections.push({ gate: "trending_into_band", margin: Math.abs(recent) - threshold });
  }

  // The level to arm is the boundary the extreme was made at, so the entry
  // happens where price actually stretched rather than wherever it is now.
  const level =
    (direction === "down" ? frame.swingHighPrice : frame.swingLowPrice) ?? frame.referencePrice;
  const distanceFromBand =
    direction === "down" ? rsi.value - RSI_OVERBOUGHT : RSI_OVERSOLD - rsi.value;

  const score = clamp01(
    0.4 * (1 - age / Math.max(1, policy.rsiReversion.maxExtremeAgeBars)) +
      0.35 * clamp01(distanceFromBand / 15) +
      // The flatter the recent drift, the more of a stretch this is rather
      // than a leg being ridden.
      0.25 * clamp01(1 - Math.abs(recent) / threshold),
  );

  return {
    kind: "rsi_reversion",
    direction,
    interval: frame.interval,
    score,
    level,
    // The band is reached at a price, and waiting a whole bar for a close gives
    // back the part of the snap-back this strategy is paid for — the same call
    // the range boundary makes, for the same reason.
    closeConfirmed: false,
    rationale:
      `RSI(${rsi.period}) at ${rsi.value.toFixed(1)} is ${rsi.condition}, ` +
      `${age} bar(s) into the extreme; fading it ${direction === "down" ? "short" : "long"} at ${level}` +
      (rejections.length === 0 ? "" : `; near-miss: ${describeRejections(rejections)}`),
    ...(rejections.length === 0 ? {} : { rejectedBy: rejections }),
  };
}

/**
 * The structural setup a timeframe supports — breakout, continuation, or range
 * boundary, in that order of precedence.
 *
 * They are mutually exclusive by construction: a confirmed break already IS
 * the continuation taken at the level, and a frame with a live pivot run is not
 * a range holding its bounds. A branch entered but failed reports its
 * near-miss rather than nothing (plan 29 step 3.4); a CLEAN candidate anywhere
 * in the chain still wins over a near-miss. The indicator strategies are NOT
 * part of this chain — they are read separately, so a frame can offer a
 * structural candidate and an indicator candidate at once and the tournament
 * compares them.
 */
function readStructuralSetup(
  frame: TimeframeReading,
  policy: TradingPolicy,
): CandidateSetup | null {
  const edgePercent = policy.rangeReversion.edgePercent;
  const stabilityLimit = policy.rangeReversion.stabilityPercent;
  const minTouches = policy.rangeReversion.minBoundaryTouches;
  const expansion = frame.atrExpansionRatio ?? 1;

  // A break of a swing, confirmed on the close. A wick through the level is
  // deliberately not a setup: it is the failure this measurement exists to
  // separate out.
  const breakout = frame.breakout;
  if (breakout !== undefined && breakout.closedBeyond) {
    const aligned =
      (breakout.direction === "up" && frame.directionScore > 0) ||
      (breakout.direction === "down" && frame.directionScore < 0);
    const touches =
      (breakout.direction === "up" ? frame.swingHighTouches : frame.swingLowTouches) ?? 0;
    const openingRangeTested =
      (frame.swingHighTouches ?? 0) >= policy.openingRange.minBoundaryTouches &&
      (frame.swingLowTouches ?? 0) >= policy.openingRange.minBoundaryTouches;
    const score = clamp01(
      0.4 * clamp01(Math.abs(frame.directionScore) / policy.readings.directionScoreThreshold / 2) +
        0.3 * clamp01(expansion - 1) +
        0.2 * (frame.impulseIsFresh === true ? 1 : 0) +
        0.1 * (aligned ? 1 : 0),
    );
    const rationale =
      `close ${breakout.direction === "up" ? "above" : "below"} ${breakout.level} with ` +
      `directionScore ${frame.directionScore.toFixed(2)}, atrExpansionRatio ${expansion.toFixed(2)}, ` +
      `${touches} prior touches, impulse ${frame.impulseIsFresh === true ? "fresh" : "stale"}`;
    // The armed breakout's own close is allowed to lead the slower direction
    // score (the playbook states that exception explicitly), but contracting
    // ATR is not a breakout entry. It ends the structural chain for the frame,
    // the way the loop's `continue` used to — reported as the near-miss it is.
    if (expansion <= 1) {
      const rejections = [{ gate: "atr_not_expanding", margin: 1 - expansion }];
      return {
        kind: openingRangeTested ? "opening_range_break" : "momentum_breakout",
        direction: breakout.direction,
        interval: frame.interval,
        score,
        level: breakout.level,
        closeConfirmed: true,
        rationale: `${rationale}; near-miss: ${describeRejections(rejections)}`,
        rejectedBy: rejections,
      };
    }
    return {
      kind: openingRangeTested ? "opening_range_break" : "momentum_breakout",
      direction: breakout.direction,
      interval: frame.interval,
      score,
      level: breakout.level,
      closeConfirmed: true,
      rationale,
    };
  }

  // A drift resuming after a shallow pullback. Checked after the breakout —
  // a confirmed break already is the continuation, taken at the level — and
  // before the range branch, because the two claims contradict: a frame with
  // a live pivot run is not a range holding its bounds. A near-miss
  // continuation does not claim the frame, so the range branch still gets its
  // turn.
  const continuation = readTrendContinuation(frame, policy);
  if (continuation !== null && continuation.rejectedBy === undefined) return continuation;

  // A boundary of a range that has held its height and been tested on both
  // sides. Chop is the requirement here, not a disqualification. A frame with
  // no position or stability measurement is no signal, not a near-miss.
  const position = frame.positionInRangePercent;
  const stability = frame.rangeStabilityPercent;
  if (position !== undefined && stability !== undefined) {
    const rejections: Array<SetupRejection> = [];
    if (stability > stabilityLimit) {
      rejections.push({ gate: "range_stability", margin: stability - stabilityLimit });
    }
    if (frame.direction !== "flat") {
      // Conviction beyond the flat band.
      rejections.push({
        gate: "direction_not_flat",
        margin: Math.abs(frame.directionScore) - policy.readings.directionScoreThreshold,
      });
    }
    const highShort = minTouches - (frame.swingHighTouches ?? 0);
    const lowShort = minTouches - (frame.swingLowTouches ?? 0);
    if (highShort > 0 || lowShort > 0) {
      // The worse side of the two.
      rejections.push({ gate: "boundary_touches", margin: Math.max(highShort, lowShort) });
    }
    const distanceFromEdge = Math.min(position, 100 - position);
    if (distanceFromEdge > edgePercent) {
      rejections.push({ gate: "range_edge", margin: distanceFromEdge - edgePercent });
    }

    // The nearer boundary is the one a mid-range near-miss is reaching for:
    // long off the floor side, short off the ceiling side.
    const nearFloor = position <= 50;
    const level = (nearFloor ? frame.swingLowPrice : frame.swingHighPrice) ?? frame.referencePrice;
    const rangeSetup: CandidateSetup = {
      kind: "range_reversion",
      direction: nearFloor ? "up" : "down",
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
        `tested ${frame.swingLowTouches}x low and ${frame.swingHighTouches}x high` +
        (rejections.length === 0 ? "" : `; near-miss: ${describeRejections(rejections)}`),
      ...(rejections.length === 0 ? {} : { rejectedBy: rejections }),
    };
    if (rangeSetup.rejectedBy === undefined) return rangeSetup;
    // A clean continuation outranks a near-miss range; otherwise the first
    // near-miss the chain produced is the context the frame contributes.
    if (continuation !== null) return continuation;
    return rangeSetup;
  }

  return continuation;
}

/**
 * Every setup each timeframe's measurements support: real candidates first,
 * best score first, then the near-misses behind them.
 *
 * Two families, read independently. The structural family (breakout,
 * continuation, range boundary) is mutually exclusive within a frame — see
 * {@link readStructuralSetup}. The indicator family (EMA cross, RSI band) is
 * read alongside it rather than instead of it, because "trade BTC" with no
 * further instruction has to put every strategy on the table before one is
 * picked: a frame that offers no structural setup can still offer a cross, and
 * a frame that offers both should have to defend the choice between them.
 *
 * A timeframe with insufficient data contributes nothing — not even a
 * near-miss (plan 29 step 3.4).
 */
export function findCandidateSetups(
  frames: ReadonlyArray<TimeframeReading>,
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): ReadonlyArray<CandidateSetup> {
  const setups: Array<CandidateSetup> = [];

  for (const frame of frames) {
    if (!frame.sufficientData) continue;

    const structural = readStructuralSetup(frame, policy);
    if (structural !== null) setups.push(structural);

    const rsiReversion = readRsiReversion(frame, policy);
    if (rsiReversion !== null) setups.push(rsiReversion);
  }

  // Real candidates ahead of near-misses, whatever their scores: a near-miss
  // with a high score is context, not a better candidate.
  return [...setups].sort(
    (left, right) =>
      Number(left.rejectedBy !== undefined) - Number(right.rejectedBy !== undefined) ||
      right.score - left.score,
  );
}

// ---------------------------------------------------------------------------
// Strategy tournament (plan 27 E1)
// ---------------------------------------------------------------------------

/**
 * The move each setup kind claims is on offer, read off its own frame.
 *
 * A reversion or ORB is paid out of the range height; a breakout or
 * continuation is paid out of the leg it is riding. Undefined when the frame
 * could not measure the figure, which the row reports as an unknown rather
 * than a zero.
 */
function availableMoveUsd(
  setup: CandidateSetup,
  frame: TimeframeReading | undefined,
  policy: TradingPolicy,
): number | undefined {
  if (frame === undefined) return undefined;

  const swingHeight = (): number | undefined => {
    if (frame.swingHighPrice === undefined || frame.swingLowPrice === undefined) return undefined;
    const height = frame.swingHighPrice - frame.swingLowPrice;
    return height > 0 ? height : undefined;
  };

  if (setup.kind === "range_reversion" || setup.kind === "opening_range_break") {
    return swingHeight();
  }
  if (setup.kind === "rsi_reversion") {
    // A fade off a band is played back toward the middle, not across the whole
    // range — so the move on offer is a stated fraction of the height.
    const height = swingHeight();
    return height === undefined ? undefined : height * policy.rsiReversion.targetSwingFraction;
  }
  return frame.lastImpulse?.sizeUsd;
}

/**
 * Join every scored setup with the cost of taking it — the tournament
 * table the classify turn compares candidates on.
 *
 * `cost` is the break-even price move at the current book, from a fresh cost
 * estimate; pass `null` when none was readable and the rows carry distance
 * and score but no multiple. Rows keep the `setups[]` order (best score
 * first). Pure arithmetic: nothing here decides anything, and nothing compares
 * the multiple against a requirement — cost is context (plan 29 step 3.1).
 */
export function compareCandidates(
  structure: Pick<MarketStructure, "timeframes" | "setups">,
  cost: { readonly breakEvenPriceMoveUsd: number } | null,
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): ReadonlyArray<StrategyCandidate> {
  const frameByInterval = new Map(structure.timeframes.map((frame) => [frame.interval, frame]));

  return structure.setups.map((setup) => {
    const frame = frameByInterval.get(setup.interval);
    const move = availableMoveUsd(setup, frame, policy);
    const breakEven = cost?.breakEvenPriceMoveUsd;
    const multiple =
      move !== undefined && breakEven !== undefined && breakEven > 0 ? move / breakEven : undefined;

    return {
      strategy: setup.kind,
      direction: setup.direction,
      interval: setup.interval,
      score: setup.score,
      level: setup.level,
      closeConfirmed: setup.closeConfirmed,
      distanceToTriggerUsd: frame === undefined ? 0 : Math.abs(setup.level - frame.referencePrice),
      ...(move === undefined ? {} : { availableMoveUsd: move }),
      ...(multiple === undefined ? {} : { costMultiple: multiple }),
      ...(setup.rejectedBy === undefined ? {} : { rejectedBy: setup.rejectedBy }),
      // A near-miss is flagged in the note itself, so the row says what it is
      // even where only the text is read.
      note:
        setup.rejectedBy === undefined
          ? setup.rationale
          : `NEAR-MISS (${describeRejections(setup.rejectedBy)}) — ${setup.rationale}`,
    };
  });
}
