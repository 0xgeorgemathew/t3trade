/**
 * What the mission already did - its own completed trades, read back to it.
 *
 * Fills, fees, and realised results were persisted from the first day and were
 * readable only by the workspace UI. The harness could not see its own trade
 * history at all: every turn reasoned from the position in front of it, so the
 * same mistake was available to be made again immediately, and "score the thesis
 * against the outcome" was an instruction with nothing behind it.
 *
 * Two shapes live here. `TradingTradeHistory` is the read: what was traded, at
 * what price, for what result, under which strategy version. `ClosedTradeReview`
 * is the push: the one summary the runtime assembles when a position goes flat,
 * so the closing turn arrives already knowing how the trade actually went rather
 * than having to reconstruct it.
 *
 * @module TradingHistory
 */
import { Schema } from "effect";
import { ExchangeMarket, Price, TradingId, UnixMillis } from "./primitives.ts";

/** Default number of completed orders `trading_look` returns. */
export const TRADE_HISTORY_DEFAULT_LIMIT = 20;

/** Hard cap on that count, so one tool response stays bounded. */
export const TRADE_HISTORY_MAX_LIMIT = 100;

/**
 * One completed order — the sum of its own partial fills.
 *
 * Hyperliquid reports a market order as however many slices it took to cross
 * the book, and a history of slices is not a history of decisions. Each entry
 * here is the order the mission actually placed: size summed, price
 * size-weighted, fee and realised PnL totalled.
 */
export const TradingTradeHistoryEntry = Schema.Struct({
  orderId: Schema.Number,
  cloid: Schema.optional(Schema.String),
  market: ExchangeMarket,
  side: Schema.Literals(["buy", "sell"]),
  filledSize: Schema.Number,
  /** Size-weighted average across the order's partials. */
  avgFillPrice: Price,
  notionalUsd: Schema.Number,
  feeUsd: Schema.Number,
  /**
   * Realised PnL the exchange attributed to this order, gross of the fee
   * beside it. Zero on an order that only opened or added to a position.
   */
  closedPnlUsd: Schema.Number,
  /** `closedPnlUsd` less `feeUsd` — what the order was actually worth. */
  netPnlUsd: Schema.Number,
  /** First and last partial, so a slow fill is visible as one. */
  firstFillAt: UnixMillis,
  lastFillAt: UnixMillis,
  fillCount: Schema.Number,
  /**
   * The strategy version that was current when this order filled, and the
   * target it was published with.
   *
   * This is what makes the history a record of decisions rather than of trades:
   * a losing order under a thesis the mission has since abandoned reads very
   * differently from a losing order under the one it is still running.
   */
  strategyVersion: Schema.optional(Schema.Number),
  targetProfitUsd: Schema.optional(Schema.Number),
});
export type TradingTradeHistoryEntry = typeof TradingTradeHistoryEntry.Type;

/** Round trips the fee-share reading is computed over — the "last 3 scalps". */
export const FEE_SHARE_SAMPLE = 3;

/**
 * Fee share of gross, in percent, above which the size is wrong for the range.
 *
 * Past this line the trades are working and the fees are taking the result:
 * the move being captured is too small for the size being traded, and the
 * answer is a wider target, a cheaper fee tier, or standing down — not another
 * scalp at the same size.
 */
export const FEE_SHARE_ALARM_PERCENT = 50;

/**
 * One completed round trip — flat to flat.
 *
 * Orders are what the mission placed; a round trip is what it *did*. The entry
 * and exit prices, the hold, and the net result only exist at this granularity,
 * and they are the figures a scalp is actually judged on. A trip is opened by
 * the first order that takes the mission off flat and closed by the order that
 * returns it there; anything in between that adds to or trims the position
 * belongs to the same trip.
 */
export const TradingRoundTrip = Schema.Struct({
  market: ExchangeMarket,
  direction: Schema.Literals(["long", "short"]),
  /** Size the trip opened at, in base units. */
  sizeEth: Schema.Number,
  /** Size-weighted average across the orders that built the position. */
  entryAvgPrice: Price,
  /** Size-weighted average across the orders that closed it. */
  exitAvgPrice: Price,
  /** Realised PnL the exchange attributed to the closing orders, before fees. */
  grossPnlUsd: Schema.Number,
  /** Every fee the trip paid — entry side and exit side both. */
  feesPaidUsd: Schema.Number,
  /** `grossPnlUsd` less `feesPaidUsd`. The result. */
  netPnlUsd: Schema.Number,
  openedAt: UnixMillis,
  closedAt: UnixMillis,
  holdMillis: Schema.Number,
  /** Orders the trip took, entry side and exit side together. */
  orderCount: Schema.Number,
  /** The version and target in force when the trip closed. */
  strategyVersion: Schema.optional(Schema.Number),
  targetProfitUsd: Schema.optional(Schema.Number),
});
export type TradingRoundTrip = typeof TradingRoundTrip.Type;

/** Totals across every fill the mission has ever recorded, not just the page. */
export const TradingTradeHistorySummary = Schema.Struct({
  realizedPnlUsd: Schema.Number,
  feesPaidUsd: Schema.Number,
  /** Realised less fees — the only figure that says whether this worked. */
  netPnlUsd: Schema.Number,
  orderCount: Schema.Number,
  fillCount: Schema.Number,
  /** Orders that closed exposure at a gain, and at a loss, net of their fee. */
  winningOrders: Schema.Number,
  losingOrders: Schema.Number,
  /** Completed flat-to-flat trips. A position still open is not counted. */
  roundTripCount: Schema.Number,
  /**
   * Fees as a percent of the gross the trades produced, across every completed
   * round trip, using the MAGNITUDE of each trip's gross — a losing trip still
   * moved price and still paid to do it.
   *
   * Zero when nothing has been traded, which reads the same as "no cost
   * problem" and is the honest answer when there is no evidence either way.
   */
  feeShareOfGrossPercent: Schema.Number,
  /**
   * The same reading over the last `FEE_SHARE_SAMPLE` trips only.
   *
   * This is the one to act on: a mission that scalped well for an hour and is
   * now donating fees has a lifetime figure that still looks fine. Above
   * `FEE_SHARE_ALARM_PERCENT` the range is too small for the size being traded.
   */
  recentFeeShareOfGrossPercent: Schema.Number,
  firstFillAt: Schema.optional(UnixMillis),
  lastFillAt: Schema.optional(UnixMillis),
});
export type TradingTradeHistorySummary = typeof TradingTradeHistorySummary.Type;

export const TradingTradeHistory = Schema.Struct({
  missionId: TradingId,
  /** Newest first, capped by the request's `limit`. */
  orders: Schema.Array(TradingTradeHistoryEntry),
  /**
   * Completed flat-to-flat trips, newest first, over the same orders.
   *
   * The orders say what was placed; these say what each trade was worth. A
   * position that is still open has no trip here — it has no result yet.
   */
  roundTrips: Schema.Array(TradingRoundTrip),
  summary: TradingTradeHistorySummary,
});
export type TradingTradeHistory = typeof TradingTradeHistory.Type;

const weightedAverage = (
  parts: ReadonlyArray<{ readonly size: number; readonly price: number }>,
): number => {
  const size = parts.reduce((sum, part) => sum + part.size, 0);
  if (size <= 0) return 0;
  return parts.reduce((sum, part) => sum + part.size * part.price, 0) / size;
};

/** An order's signed contribution to the position, in base units. */
const signedSize = (order: TradingTradeHistoryEntry): number =>
  order.side === "buy" ? order.filledSize : -order.filledSize;

/**
 * Pair the mission's orders into the round trips they actually made.
 *
 * The exchange never reports a "trade" — it reports fills, and a scalp is two
 * or more orders apart. Walking the orders oldest-first and tracking the
 * running net position recovers the trip: it opens when the position leaves
 * flat, and it closes when the position returns there.
 *
 * A trip is therefore cut at flat and nowhere else. One order that reverses
 * straight THROUGH flat — sell 2 against a 1 long — does not close anything,
 * because the position never touched zero; that order and the ones that unwind
 * its residual all belong to the same trip, whose `direction` is the side it
 * opened on. Splitting such an order would mean apportioning its size, fee, and
 * realised PnL between two trips on an assumption the exchange never reported,
 * so the pairing declines to invent one. The execution path closes with a
 * reduce-only order before it re-enters, so this is the odd case, not the
 * normal one — but when it happens the trip reads as one longer trade rather
 * than two clean ones, and its `orderCount` is the tell.
 *
 * A trailing group that never returns to flat is the position still open, and
 * is left out — it has no result to report yet.
 */
export function buildRoundTrips(
  orders: ReadonlyArray<TradingTradeHistoryEntry>,
): ReadonlyArray<TradingRoundTrip> {
  const oldestFirst = [...orders].sort((a, b) => a.firstFillAt - b.firstFillAt);
  const trips: Array<TradingRoundTrip> = [];

  let open: Array<TradingTradeHistoryEntry> = [];
  let position = 0;

  for (const order of oldestFirst) {
    open.push(order);
    position += signedSize(order);
    // Floating-point fill sizes never land exactly on zero; a residue smaller
    // than any tradeable size is flat.
    if (Math.abs(position) > 1e-9) continue;

    const first = open[0];
    if (first !== undefined) trips.push(toRoundTrip(open, first));
    open = [];
    position = 0;
  }

  // Built oldest-first by the walk; published newest-first like `orders`.
  return trips.toReversed();
}

const toRoundTrip = (
  group: ReadonlyArray<TradingTradeHistoryEntry>,
  first: TradingTradeHistoryEntry,
): TradingRoundTrip => {
  const long = first.side === "buy";
  const entries = group.filter((order) => (order.side === "buy") === long);
  const exits = group.filter((order) => (order.side === "buy") !== long);
  const last = group[group.length - 1] ?? first;

  const entryAvgPrice = weightedAverage(
    entries.map((order) => ({ size: order.filledSize, price: order.avgFillPrice })),
  );
  const exitAvgPrice = weightedAverage(
    exits.map((order) => ({ size: order.filledSize, price: order.avgFillPrice })),
  );
  const grossPnlUsd = group.reduce((sum, order) => sum + order.closedPnlUsd, 0);
  const feesPaidUsd = group.reduce((sum, order) => sum + order.feeUsd, 0);

  return {
    market: first.market,
    direction: long ? "long" : "short",
    sizeEth: entries.reduce((sum, order) => sum + order.filledSize, 0),
    // `Price` is strictly positive; a group with no priced side cannot happen
    // through the pairing above, but the schema is not told that.
    entryAvgPrice: entryAvgPrice > 0 ? entryAvgPrice : 1,
    exitAvgPrice: exitAvgPrice > 0 ? exitAvgPrice : 1,
    grossPnlUsd,
    feesPaidUsd,
    netPnlUsd: grossPnlUsd - feesPaidUsd,
    openedAt: first.firstFillAt,
    closedAt: last.lastFillAt,
    holdMillis: last.lastFillAt - first.firstFillAt,
    orderCount: group.length,
    // The trip is scored against the thesis it was closed under, which is the
    // one whose target it was being held for.
    ...(last.strategyVersion === undefined ? {} : { strategyVersion: last.strategyVersion }),
    ...(last.targetProfitUsd === undefined ? {} : { targetProfitUsd: last.targetProfitUsd }),
  };
};

/**
 * Fees as a percent of the gross those trips produced.
 *
 * Gross is taken as a magnitude: a losing trip still paid to be wrong, and
 * netting it against a winner would hide exactly the case this number exists to
 * catch — a string of trades whose results cancel while the fees accumulate.
 */
export function feeShareOfGross(trips: ReadonlyArray<TradingRoundTrip>): number {
  const gross = trips.reduce((sum, trip) => sum + Math.abs(trip.grossPnlUsd), 0);
  if (gross <= 0) return 0;
  return (trips.reduce((sum, trip) => sum + trip.feesPaidUsd, 0) / gross) * 100;
}

// ---------------------------------------------------------------------------
// The closing-turn self-review
// ---------------------------------------------------------------------------

/**
 * How a position that just went flat actually went.
 *
 * `peakUnrealisedPnlUsd` and `worstUnrealisedPnlUsd` are the maximum favourable
 * and adverse excursion — the best and worst this trade was ever worth while it
 * was open. Neither is derivable after the fact from fills, and the exchange
 * reports neither, so the reconciler records both while the position is live.
 * They are the difference between "that was a bad entry" and "that was a good
 * entry I gave back", which is the one distinction a self-review exists to draw.
 */
export const ClosedTradeReview = Schema.Struct({
  missionId: TradingId,
  market: ExchangeMarket,
  direction: Schema.Literals(["long", "short"]),
  openedAt: UnixMillis,
  closedAt: UnixMillis,
  holdMillis: Schema.Number,
  /** Size the position reached, in base units, at its last observation. */
  sizeEth: Schema.Number,
  entryPrice: Schema.optional(Price),
  /** Size-weighted average of the fills that closed the position. */
  exitPrice: Schema.optional(Price),
  realizedPnlUsd: Schema.Number,
  feesPaidUsd: Schema.Number,
  netPnlUsd: Schema.Number,
  /** Maximum favourable excursion, in USD of unrealised PnL. */
  peakUnrealisedPnlUsd: Schema.Number,
  /** Maximum adverse excursion. Zero or negative by construction. */
  worstUnrealisedPnlUsd: Schema.Number,
  /** How much of the best it ever showed was left on the table. */
  givebackFromPeakUsd: Schema.Number,
  fillCount: Schema.Number,
  /** The strategy version in force when the position closed, and its target. */
  strategyVersion: Schema.optional(Schema.Number),
  targetProfitUsd: Schema.optional(Schema.Number),
  /**
   * Where the stop sat when the entry was quoted — plan 27 G1, measurement
   * only. All four are read off the entry quote at close time and absent when
   * the trade has no readable quote behind it (a manual entry, or one from
   * before the columns existed).
   */
  stopPriceAtEntry: Schema.optional(Price),
  /** |entry − stop|, in USD of price. */
  stopDistanceUsd: Schema.optional(Schema.Number),
  /** That distance in ATRs measured at quote time. */
  stopDistanceAtrMultiple: Schema.optional(Schema.Number),
  /**
   * That distance over the noise floor at quote time —
   * `max(2x half-spread, 0.35x ATR)`. Under 1 the stop sat inside the
   * market's own noise, which is the stop this measurement exists to count.
   */
  stopNoiseFloorMultiple: Schema.optional(Schema.Number),
});
export type ClosedTradeReview = typeof ClosedTradeReview.Type;

const usd = (value: number): string => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

/**
 * The review as the one line the harness reads on its closing wake.
 *
 * The wake carries this as an inbox event summary, which is prose, so the
 * arithmetic has to survive the trip as prose. It states the result net of
 * fees first, because a gross win that the fees took is the failure mode the
 * whole cost model exists to surface, and it always names the excursions —
 * a trade banked at a third of what it showed is a lesson the realised figure
 * alone hides completely.
 */
export function describeClosedTrade(review: ClosedTradeReview): string {
  const minutes = Math.round(review.holdMillis / 60_000);
  const prices =
    review.entryPrice === undefined || review.exitPrice === undefined
      ? ""
      : ` entry ${review.entryPrice} → exit ${review.exitPrice.toFixed(2)},`;
  const target =
    review.targetProfitUsd === undefined
      ? ""
      : ` Published target was ${usd(review.targetProfitUsd)}.`;
  const stop =
    review.stopDistanceAtrMultiple === undefined || review.stopNoiseFloorMultiple === undefined
      ? ""
      : ` The stop sat ${review.stopDistanceAtrMultiple.toFixed(2)} ATR from entry` +
        `${review.stopNoiseFloorMultiple < 1 ? ` — INSIDE the noise floor (${review.stopNoiseFloorMultiple.toFixed(2)}x)` : ` (${review.stopNoiseFloorMultiple.toFixed(1)}x the noise floor)`}.`;
  return (
    `trade_closed: ${review.direction} ${Math.abs(review.sizeEth)} ${review.market} held ${minutes}m,` +
    `${prices} realised ${usd(review.realizedPnlUsd)} less ${usd(review.feesPaidUsd)} of fees = ` +
    `NET ${usd(review.netPnlUsd)}. It was worth ${usd(review.peakUnrealisedPnlUsd)} at its best and ` +
    `${usd(review.worstUnrealisedPnlUsd)} at its worst, so ${usd(review.givebackFromPeakUsd)} of the peak ` +
    `was given back.${target}${stop} Review this before re-entering: did the thesis hold, was the target the ` +
    `right rung, and did the stop or the give-back do its job? Open your reply with two or three plain ` +
    `sentences a non-trader could follow — what happened, and what you will do next.`
  );
}
