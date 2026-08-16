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

import type { OrderBook } from "./market.ts";
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
 * Everything the book and the tape say, as readings.
 *
 * Every field is optional and independently derived: one unreadable input never
 * costs another field's answer.
 */
export const MarketMicrostructure = Schema.Struct({
  bookImbalance: Schema.optional(BookImbalance),
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
 * Everything the book alone can say, from one order book read.
 *
 * Kept as one entry point so the `trading_look` path and the wake path build
 * the same reading from the same input — they read the same market half
 * through `TradingWakeupComposer.observe`, and this is what that half calls.
 */
export const readMicrostructure = (input: {
  readonly orderBook: OrderBook | null;
}): MarketMicrostructure | null => {
  const bookImbalance = input.orderBook === null ? null : readBookImbalance(input.orderBook);
  if (bookImbalance === null) return null;
  return { bookImbalance };
};
