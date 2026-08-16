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
import { UsdAmount } from "./primitives.ts";

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
 * Everything the book and the tape say, as readings.
 *
 * Every field is optional and independently derived: one unreadable input never
 * costs another field's answer.
 */
export const MarketMicrostructure = Schema.Struct({
  bookImbalance: Schema.optional(BookImbalance),
  aggressorFlow: Schema.optional(AggressorFlow),
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
}): MarketMicrostructure | null => {
  const bookImbalance = input.orderBook === null ? null : readBookImbalance(input.orderBook);
  const aggressorFlow = readAggressorFlow(input.candles);
  if (bookImbalance === null && aggressorFlow === null) return null;
  return {
    ...(bookImbalance === null ? {} : { bookImbalance }),
    ...(aggressorFlow === null ? {} : { aggressorFlow }),
  };
};
