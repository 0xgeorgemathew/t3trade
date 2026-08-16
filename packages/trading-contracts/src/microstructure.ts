/**
 * Market microstructure — what the book and the tape say, plan 29 phase 7.
 *
 * Everything in this module rides `trading_look` AND every wake, on every turn,
 * for the life of a mission. That is the budget it is written against: each
 * reading is a handful of numbers folded onto one rendered line, and every one
 * of them is optional, because the reads they come from are best-effort. A
 * reading that cannot be taken costs its own field and nothing else.
 *
 * These are readings, never verdicts. Nothing here scores a setup, gates an
 * entry, or says what to do — the model reads the numbers and decides.
 *
 * @module TradingMicrostructure
 */
import { Schema } from "effect";

import type { MarketCandle, OrderBook } from "./market.ts";
import { Price, UsdAmount } from "./primitives.ts";
import { realizedVolatilityPercent } from "./volatility.ts";

/**
 * How many levels a side the imbalance is measured over.
 *
 * Hyperliquid serves at most 20 levels a side. Ten is the compromise the depth
 * question actually wants: deep enough that a single refreshing top-of-book
 * order does not swing the number, shallow enough that resting size five
 * percent away — which will never be touched inside the holding period — does
 * not drown out the size that will be.
 */
export const BOOK_IMBALANCE_LEVELS = 10;

/**
 * Resting bid depth against resting ask depth, near the touch.
 *
 * The highest-value single addition to the observation, because its predictive
 * horizon matches the intended holding period: book imbalance says something
 * about the next minutes, which is exactly the window a mission trades in.
 * Longer-horizon readings say nothing about that window, and tick-by-tick ones
 * are gone before a turn can act.
 *
 * `imbalance` is the number to read: `(bid - ask) / (bid + ask)` over the
 * measured levels, so `+1` is an all-bid book, `-1` all-ask, and `0` balanced.
 * The two USD depths are beside it because a lopsided ratio across a thin book
 * and a lopsided ratio across a deep one are different facts.
 */
export const BookImbalance = Schema.Struct({
  /** Notional resting on the bid over `levels`, in USD. */
  bidDepthUsd: UsdAmount,
  /** Notional resting on the ask over `levels`, in USD. */
  askDepthUsd: UsdAmount,
  /** `(bid - ask) / (bid + ask)`. Positive is bid-heavy. */
  imbalance: Schema.Number,
  /** How many levels a side were actually summed — a thin book serves fewer. */
  levels: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type BookImbalance = typeof BookImbalance.Type;

/**
 * How many bars of the primary timeframe the aggressor estimate reads.
 *
 * Fifteen, for the same reason the book is measured near the touch: it is the
 * window the mission is about to trade in. A longer one averages the flow that
 * is about to matter together with flow that has already been absorbed.
 */
export const AGGRESSOR_FLOW_BARS = 15;

/**
 * Which side of the book recent volume has been crossing into.
 *
 * `buyShare` is the share of the window's volume estimated to have lifted the
 * ask; `1 - buyShare` hit the bid. Above 0.5 is buyers paying up, below is
 * sellers hitting out, and 0.5 is a two-sided tape.
 *
 * ESTIMATED, not counted — and the name of the derivation is on the value so
 * nothing downstream can mistake one for the other. Hyperliquid's REST surface
 * serves no trade tape; the true aggressor split needs the WebSocket `trades`
 * channel and a running accumulator, which is a subscription this observation
 * does not hold. So each bar is split by where it closed inside its own range —
 * a bar closing on its high bought all the way up, one closing on its low sold
 * all the way down — and the splits are weighted by that bar's volume.
 *
 * `volume` rides beside it because a lopsided share across a dead tape says
 * nothing: two trades can put `buyShare` at 1.0.
 */
export const AggressorFlow = Schema.Struct({
  /** Estimated share of window volume crossing into the ask. 0..1. */
  buyShare: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  /** Total volume over the window, in base units. */
  volume: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Bars actually read — a short history serves fewer. */
  bars: Schema.Number.check(Schema.isGreaterThan(0)),
  /** How `buyShare` was arrived at. One value today; it is here so it can change. */
  basis: Schema.Literal("bar_close_location"),
});
export type AggressorFlow = typeof AggressorFlow.Type;

/**
 * How far from the mid "near the touch" reaches, in basis points.
 *
 * Ten. Size resting further out than that will not be taken inside a holding
 * period, so counting it would let a wall a full percent away hide the fact
 * that the first ten bps of the book just emptied.
 */
export const NEAR_TOUCH_BPS = 10;

/**
 * The previous observation's market sample, for the readings that are deltas.
 *
 * Depth thinning and open interest moving are facts about change, and the
 * exchange serves no history for either — so the runtime keeps the last sample
 * and the next observation compares against it.
 */
/**
 * The shortest gap a delta reading is measured over.
 *
 * `observe` runs on every wake AND on every `trading_look`, so a model that
 * looks twice in a turn puts two samples seconds apart. Over three seconds,
 * open interest — which the exchange republishes on its own slow cadence —
 * has almost always not moved at all, while the mark has moved a little. That
 * pair reads exactly like the squeeze the positioning reading exists to name:
 * price going somewhere on no new money. The reading would be manufactured by
 * the act of looking.
 *
 * Thirty seconds, against a 1m primary timeframe: short enough that a genuine
 * wake-to-wake delta always clears it, long enough that a second look inside
 * one turn does not. Below it the current levels are still reported; only the
 * change is withheld, because "too soon to say" and "unchanged" are different
 * facts.
 */
export const MARKET_SAMPLE_MIN_SPAN_MILLIS = 30_000;

export const MarketSample = Schema.Struct({
  markPrice: Schema.Number,
  spreadBps: Schema.optional(Schema.Number),
  nearDepthUsd: Schema.optional(Schema.Number),
  openInterest: Schema.optional(Schema.Number),
  observedAt: Schema.Number,
});
export type MarketSample = typeof MarketSample.Type;

/**
 * What it currently costs to cross, and how much is standing near the touch.
 *
 * A thinning book is the reading that matters here, and it is a reading about
 * change: depth falling while the spread widens means slippage is about to
 * rise and the stops resting below are about to be reachable. So the current
 * values carry their movement since the previous observation beside them, with
 * the age of that comparison stated — a mission that has not looked in an hour
 * is told its "change" spans an hour, rather than reading it as a minute's.
 *
 * The two change fields are absent on a mission's first observation, and on
 * any observation whose predecessor could not be read. There is no zero to
 * report: "unchanged" and "nothing to compare against" are different facts.
 */
export const LiquidityReading = Schema.Struct({
  /** Ask minus bid over the mid, in basis points. */
  spreadBps: Schema.Number,
  /** Notional resting within `NEAR_TOUCH_BPS` of the mid, both sides, in USD. */
  nearDepthUsd: UsdAmount,
  /** Change in `spreadBps` since the previous observation. Positive is wider. */
  spreadBpsChange: Schema.optional(Schema.Number),
  /** Percent change in `nearDepthUsd` since then. Negative is thinning. */
  depthChangePercent: Schema.optional(Schema.Number),
  /** Seconds the comparison spans. Absent with the comparison itself. */
  sinceSeconds: Schema.optional(Schema.Number),
});
export type LiquidityReading = typeof LiquidityReading.Type;

/**
 * How open interest has moved against price.
 *
 * The two together say what the move is made of, and neither says it alone.
 * Open interest rising with price is new money taking the side price is going;
 * open interest falling while price rises is the other side covering, which is
 * a squeeze and ends when the shorts run out. The same pair inverted reads the
 * same way down. The model reads the two numbers and draws the conclusion —
 * nothing here classifies the move, because a classifier would be a verdict
 * and would be wrong at exactly the edges that matter.
 *
 * Both are percent changes since the previous observation over the same span,
 * so they are comparable to each other. The whole reading is absent when there
 * is no predecessor to measure against; open interest as a level is already on
 * the market snapshot and is not repeated here.
 */
export const PositioningReading = Schema.Struct({
  /** Percent change in open interest since the previous observation. */
  openInterestChangePercent: Schema.Number,
  /** Percent change in the mark over the same span. */
  priceChangePercent: Schema.Number,
  /** Seconds the two changes span. */
  sinceSeconds: Schema.Number,
});
export type PositioningReading = typeof PositioningReading.Type;

/**
 * The short window the vol ratio measures against the long one.
 *
 * Twenty bars — the horizon a trade is actually held over on the runtime
 * timeframe. The ratio is only meaningful if the numerator is the volatility
 * the position will experience, not an average over an hour of it.
 */
export const VOL_RATIO_SHORT_BARS = 20;

/**
 * Realized volatility over the last twenty bars against the whole window.
 *
 * The single number worth reading before deciding whether to trade at all. The
 * cost of a round trip is fixed and known; what has to clear it is the move,
 * and the move available over a holding period is what volatility measures.
 * Above 1 the market is moving faster than it has been and the same stop
 * distance buys less time; below 1 it is compressing, and a target set off the
 * window's own history will not be reached inside the hold.
 *
 * It is a ratio and not a verdict: nothing here says "do not trade". It says
 * how the next twenty bars are likely to differ from the last hundred and
 * twenty, and the plan's own arithmetic against `costContext` decides the rest.
 */
export const VolatilityRatio = Schema.Struct({
  /** Short-window realized vol over long-window realized vol. */
  ratio: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Realized volatility per bar over the short window, as a percent. */
  shortPercent: Schema.Number,
  /** The same over the whole window. */
  longPercent: Schema.Number,
  shortBars: Schema.Number.check(Schema.isGreaterThan(0)),
  longBars: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type VolatilityRatio = typeof VolatilityRatio.Type;

/**
 * Where the mark sits against the window's volume-weighted average price.
 *
 * VWAP is where the volume actually traded, which makes it the level both
 * sides treat as fair. Distance from it in basis points says how stretched the
 * current price is from that agreement — and, read beside the cost line, how
 * much of a reversion to it a round trip would eat.
 */
export const VwapReading = Schema.Struct({
  priceUsd: Price,
  /** Mark less VWAP over VWAP, in basis points. Positive is above. */
  distanceBps: Schema.Number,
  bars: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type VwapReading = typeof VwapReading.Type;

/**
 * Everything the book and the tape say, as readings.
 *
 * Every field is optional and independently derived: one unreadable input never
 * costs another field's answer.
 */
export const MarketMicrostructure = Schema.Struct({
  bookImbalance: Schema.optional(BookImbalance),
  aggressorFlow: Schema.optional(AggressorFlow),
  liquidity: Schema.optional(LiquidityReading),
  positioning: Schema.optional(PositioningReading),
  volatilityRatio: Schema.optional(VolatilityRatio),
  vwap: Schema.optional(VwapReading),
});
export type MarketMicrostructure = typeof MarketMicrostructure.Type;

/** Notional resting across the first `levels` entries of one side. */
const depthUsd = (
  side: OrderBook["bids"],
  levels: number,
): { readonly usd: number; readonly counted: number } => {
  const taken = side.slice(0, levels);
  let usd = 0;
  for (const level of taken) usd += level.price * level.size;
  return { usd, counted: taken.length };
};

/**
 * Measure bid-vs-ask depth near the touch.
 *
 * Returns `null` when the book has no usable side — a one-sided or empty book
 * has no ratio to report, and reporting `±1` for it would read as conviction
 * where there is only an absent quote.
 */
export const readBookImbalance = (
  book: OrderBook,
  levels: number = BOOK_IMBALANCE_LEVELS,
): BookImbalance | null => {
  const bid = depthUsd(book.bids, levels);
  const ask = depthUsd(book.asks, levels);
  const total = bid.usd + ask.usd;
  if (bid.counted === 0 || ask.counted === 0 || total <= 0) return null;
  return {
    bidDepthUsd: bid.usd,
    askDepthUsd: ask.usd,
    imbalance: (bid.usd - ask.usd) / total,
    levels: Math.min(bid.counted, ask.counted),
  };
};

/**
 * Estimate which side recent volume has been crossing into.
 *
 * Returns `null` when the window carries no volume to split — a tape with
 * nothing on it has no direction, and reporting 0.5 for it would read as
 * balance rather than absence. Bars with no range contribute their volume at
 * the midpoint: a bar that opened and closed at one price bought and sold in
 * equal measure as far as this estimate can tell.
 */
export const readAggressorFlow = (
  candles: ReadonlyArray<MarketCandle>,
  bars: number = AGGRESSOR_FLOW_BARS,
): AggressorFlow | null => {
  const window = candles.slice(-bars);
  let volume = 0;
  let buyVolume = 0;
  for (const candle of window) {
    if (candle.volume <= 0) continue;
    const range = candle.high - candle.low;
    const closeLocation = range > 0 ? (candle.close - candle.low) / range : 0.5;
    volume += candle.volume;
    buyVolume += candle.volume * closeLocation;
  }
  if (volume <= 0) return null;
  return {
    buyShare: buyVolume / volume,
    volume,
    bars: window.length,
    basis: "bar_close_location",
  };
};

/** Notional resting within `bps` of `mid`, across both sides. */
const nearTouchDepthUsd = (book: OrderBook, mid: number, bps: number): number => {
  const window = (mid * bps) / 10_000;
  let usd = 0;
  for (const level of book.bids) {
    if (level.price >= mid - window) usd += level.price * level.size;
  }
  for (const level of book.asks) {
    if (level.price <= mid + window) usd += level.price * level.size;
  }
  return usd;
};

/**
 * Measure what crossing costs and how much is standing near the touch, and say
 * how both have moved since the previous observation.
 *
 * Returns `null` when the book has no two-sided top — with no bid or no ask
 * there is no spread, and a one-sided book's "depth" is not the number this
 * reading claims to be.
 */
export const readLiquidity = (input: {
  readonly orderBook: OrderBook;
  readonly observedAt: number;
  readonly previous: MarketSample | null;
}): LiquidityReading | null => {
  const bid = input.orderBook.bestBidOffer.bidPrice;
  const ask = input.orderBook.bestBidOffer.askPrice;
  if (bid === undefined || ask === undefined || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10_000;
  const nearDepthUsd = nearTouchDepthUsd(input.orderBook, mid, NEAR_TOUCH_BPS);

  const previous = input.previous;
  // A comparison needs a predecessor that measured the same two things and
  // measured them earlier. Anything else reports the current values alone.
  if (
    previous === null ||
    previous.spreadBps === undefined ||
    previous.nearDepthUsd === undefined ||
    previous.nearDepthUsd <= 0 ||
    input.observedAt - previous.observedAt < MARKET_SAMPLE_MIN_SPAN_MILLIS
  ) {
    return { spreadBps, nearDepthUsd };
  }
  return {
    spreadBps,
    nearDepthUsd,
    spreadBpsChange: spreadBps - previous.spreadBps,
    depthChangePercent: ((nearDepthUsd - previous.nearDepthUsd) / previous.nearDepthUsd) * 100,
    sinceSeconds: Math.round((input.observedAt - previous.observedAt) / 1_000),
  };
};

/**
 * Measure open interest and price over the same span.
 *
 * Returns `null` unless the predecessor carried a usable open interest and a
 * usable mark and was taken at least {@link MARKET_SAMPLE_MIN_SPAN_MILLIS}
 * earlier — a change needs two readings of the same two things far enough
 * apart to be a change, and there is no partial answer worth reporting.
 */
export const readPositioning = (input: {
  readonly markPrice: number;
  readonly openInterest: number | undefined;
  readonly observedAt: number;
  readonly previous: MarketSample | null;
}): PositioningReading | null => {
  const previous = input.previous;
  const openInterest = input.openInterest;
  if (
    previous === null ||
    openInterest === undefined ||
    previous.openInterest === undefined ||
    previous.openInterest <= 0 ||
    previous.markPrice <= 0 ||
    input.observedAt - previous.observedAt < MARKET_SAMPLE_MIN_SPAN_MILLIS
  ) {
    return null;
  }
  return {
    openInterestChangePercent:
      ((openInterest - previous.openInterest) / previous.openInterest) * 100,
    priceChangePercent: ((input.markPrice - previous.markPrice) / previous.markPrice) * 100,
    sinceSeconds: Math.round((input.observedAt - previous.observedAt) / 1_000),
  };
};

/**
 * Measure realized volatility over a short window against the whole one.
 *
 * Returns `null` when either window is too short to have a standard deviation,
 * or when the long window's is zero — a ratio against zero is not a large
 * number, it is an absent measurement, and reporting it as `Infinity` would be
 * a reading the model would act on.
 */
export const readVolatilityRatio = (
  candles: ReadonlyArray<MarketCandle>,
  shortBars: number = VOL_RATIO_SHORT_BARS,
): VolatilityRatio | null => {
  // Three closes is the floor: two returns, which is the least a standard
  // deviation is defined over.
  if (candles.length < 3 || shortBars < 3 || candles.length <= shortBars) return null;
  const shortWindow = candles.slice(-shortBars);
  const longPercent = realizedVolatilityPercent(candles);
  const shortPercent = realizedVolatilityPercent(shortWindow);
  if (longPercent <= 0) return null;
  return {
    ratio: shortPercent / longPercent,
    shortPercent,
    longPercent,
    shortBars: shortWindow.length,
    longBars: candles.length,
  };
};

/**
 * Volume-weighted average price over the window, and how far the mark is off it.
 *
 * Each bar contributes its typical price — the mean of high, low and close —
 * weighted by its volume. Returns `null` for a window with no volume: an
 * unweighted average of prices is not a VWAP, and returning one under that name
 * would be worse than returning nothing.
 */
export const readVwap = (
  candles: ReadonlyArray<MarketCandle>,
  markPrice: number,
): VwapReading | null => {
  let volume = 0;
  let weighted = 0;
  let bars = 0;
  for (const candle of candles) {
    if (candle.volume <= 0) continue;
    volume += candle.volume;
    weighted += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    bars += 1;
  }
  if (volume <= 0 || bars === 0) return null;
  const priceUsd = weighted / volume;
  if (priceUsd <= 0) return null;
  return {
    priceUsd,
    distanceBps: ((markPrice - priceUsd) / priceUsd) * 10_000,
    bars,
  };
};

/**
 * Every reading, from the inputs one observation already holds.
 *
 * Kept as one entry point so the `trading_look` path and the wake path build
 * the same readings from the same inputs — they read the same market half
 * through `TradingWakeupComposer.observe`, and this is what that half calls.
 */
export const readMicrostructure = (input: {
  readonly orderBook: OrderBook | null;
  /** The primary-timeframe lookback window the other readings measure over. */
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly observedAt: number;
  /** The mark and open interest this observation read, for the delta readings. */
  readonly markPrice: number;
  readonly openInterest: number | undefined;
  /** The previous observation's sample, when one was kept. Deltas need it. */
  readonly previousSample: MarketSample | null;
}): MarketMicrostructure | null => {
  const book = input.orderBook;
  const bookImbalance = book === null ? null : readBookImbalance(book);
  const aggressorFlow = readAggressorFlow(input.candles);
  const liquidity =
    book === null
      ? null
      : readLiquidity({
          orderBook: book,
          observedAt: input.observedAt,
          previous: input.previousSample,
        });
  const volatilityRatio = readVolatilityRatio(input.candles);
  const vwap = readVwap(input.candles, input.markPrice);
  const positioning = readPositioning({
    markPrice: input.markPrice,
    openInterest: input.openInterest,
    observedAt: input.observedAt,
    previous: input.previousSample,
  });
  if (
    bookImbalance === null &&
    aggressorFlow === null &&
    liquidity === null &&
    positioning === null &&
    volatilityRatio === null &&
    vwap === null
  ) {
    return null;
  }
  return {
    ...(bookImbalance === null ? {} : { bookImbalance }),
    ...(aggressorFlow === null ? {} : { aggressorFlow }),
    ...(liquidity === null ? {} : { liquidity }),
    ...(positioning === null ? {} : { positioning }),
    ...(volatilityRatio === null ? {} : { volatilityRatio }),
    ...(vwap === null ? {} : { vwap }),
  };
};

/** What this observation should leave behind for the next one to compare against. */
export const sampleFromObservation = (input: {
  readonly markPrice: number;
  readonly observedAt: number;
  readonly microstructure: MarketMicrostructure | null;
  readonly openInterest: number | undefined;
}): MarketSample => ({
  markPrice: input.markPrice,
  ...(input.microstructure?.liquidity === undefined
    ? {}
    : {
        spreadBps: input.microstructure.liquidity.spreadBps,
        nearDepthUsd: input.microstructure.liquidity.nearDepthUsd,
      }),
  ...(input.openInterest === undefined ? {} : { openInterest: input.openInterest }),
  observedAt: input.observedAt,
});
