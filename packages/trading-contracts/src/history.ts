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

/** Default number of completed orders `trading_get_trade_history` returns. */
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
  firstFillAt: Schema.optional(UnixMillis),
  lastFillAt: Schema.optional(UnixMillis),
});
export type TradingTradeHistorySummary = typeof TradingTradeHistorySummary.Type;

export const TradingTradeHistory = Schema.Struct({
  missionId: TradingId,
  /** Newest first, capped by the request's `limit`. */
  orders: Schema.Array(TradingTradeHistoryEntry),
  summary: TradingTradeHistorySummary,
});
export type TradingTradeHistory = typeof TradingTradeHistory.Type;

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
  return (
    `trade_closed: ${review.direction} ${Math.abs(review.sizeEth)} ${review.market} held ${minutes}m,` +
    `${prices} realised ${usd(review.realizedPnlUsd)} less ${usd(review.feesPaidUsd)} of fees = ` +
    `NET ${usd(review.netPnlUsd)}. It was worth ${usd(review.peakUnrealisedPnlUsd)} at its best and ` +
    `${usd(review.worstUnrealisedPnlUsd)} at its worst, so ${usd(review.givebackFromPeakUsd)} of the peak ` +
    `was given back.${target} Review this before re-entering: did the thesis hold, was the target the ` +
    `right rung, and did the stop or the give-back do its job?`
  );
}
