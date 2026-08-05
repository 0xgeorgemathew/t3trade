/**
 * Assemble the self-review for a position that just went flat.
 *
 * A mission that closes a trade goes quiet: the position card empties, the
 * mission walks back to `waiting`, and the next turn starts from a blank
 * account with no memory of what the last one did. The one moment the loop has
 * something to learn from is the moment it learns nothing.
 *
 * This is the read that closes that gap. It runs at exactly one point — the
 * reconcile pass that first observes a held position gone — and it is the only
 * chance to do so: the excursion columns it depends on are cleared by that same
 * pass, and nothing in the fills can reconstruct them afterwards.
 *
 * @module TradingClosedTradeReview
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ClosedTradeReview } from "@t3tools/trading-contracts/history";

/**
 * The snapshot row as it stood before the closing pass overwrote it.
 *
 * Read by the reconciler at the top of every pass, and only interesting on the
 * pass where the position it describes has since disappeared.
 */
export interface PreviousPositionRow {
  readonly size: number;
  readonly observed_at: number;
  readonly entry_price: number | null;
  readonly peak_unrealised_pnl: number | null;
  readonly trough_unrealised_pnl: number | null;
  readonly opened_at: number | null;
}

/** Totals over the fills that belong to the position being reviewed. */
interface TradeFillTotals {
  readonly realized_pnl: number | null;
  readonly fees_paid: number | null;
  readonly fill_count: number;
}

/** The strategy in force at the close, for scoring the thesis against it. */
interface StrategyRow {
  readonly strategy_version: number;
  readonly target_profit_usd: number | null;
}

/**
 * Build the review, or return null when there is nothing to review.
 *
 * `openedAt` is what decides which fills belong to this trade: every fill since
 * the position was first observed non-flat, and none from before it. A row
 * written before migration 046 has no `opened_at`, so it falls back to the last
 * observation — which under-counts the trade rather than absorbing the previous
 * one's fills, and is the safer way to be wrong.
 */
export const buildClosedTradeReview = (input: {
  readonly missionId: string;
  readonly market: string;
  readonly previous: PreviousPositionRow;
  readonly closedAt: number;
}): Effect.Effect<ClosedTradeReview | null, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const { previous } = input;
    if (previous.size === 0) return null;

    const sql = yield* SqlClient.SqlClient;
    const openedAt = previous.opened_at ?? previous.observed_at;
    const direction = previous.size > 0 ? ("long" as const) : ("short" as const);
    // A long is closed by selling. The fills that flattened it are the ones on
    // the opposite side of the position, which is what makes an exit price
    // separable from the entries that preceded it.
    const closingSide = direction === "long" ? "sell" : "buy";

    const totals = yield* sql<TradeFillTotals>`
      SELECT SUM(closed_pnl) AS realized_pnl, SUM(fee_usd) AS fees_paid, COUNT(*) AS fill_count
      FROM trading_fills
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
        AND traded_at >= ${openedAt}
    `;
    const exits = yield* sql<{ readonly avg_price: number | null }>`
      SELECT SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_price
      FROM trading_fills
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
        AND traded_at >= ${openedAt} AND side = ${closingSide}
    `;
    const strategies = yield* sql<StrategyRow>`
      SELECT v.version AS strategy_version,
             json_extract(v.strategy_json, '$.protection.targetProfitUsd') AS target_profit_usd
      FROM momentum_strategy_versions v
      JOIN trading_missions m
        ON m.mission_id = v.mission_id AND m.strategy_version = v.version
      WHERE v.mission_id = ${input.missionId}
    `;

    const realizedPnlUsd = totals[0]?.realized_pnl ?? 0;
    const feesPaidUsd = totals[0]?.fees_paid ?? 0;
    const peak = Math.max(0, previous.peak_unrealised_pnl ?? 0);
    const trough = Math.min(0, previous.trough_unrealised_pnl ?? 0);
    const exitPrice = exits[0]?.avg_price ?? null;
    const strategy = strategies[0];

    return {
      missionId: input.missionId,
      market: input.market,
      direction,
      openedAt,
      closedAt: input.closedAt,
      holdMillis: Math.max(0, input.closedAt - openedAt),
      sizeEth: previous.size,
      ...(previous.entry_price !== null && previous.entry_price > 0
        ? { entryPrice: previous.entry_price }
        : {}),
      ...(exitPrice !== null && exitPrice > 0 ? { exitPrice } : {}),
      realizedPnlUsd,
      feesPaidUsd,
      netPnlUsd: realizedPnlUsd - feesPaidUsd,
      peakUnrealisedPnlUsd: peak,
      worstUnrealisedPnlUsd: trough,
      // Measured against the realised result, not against zero: what the trade
      // showed at its best less what it actually paid out is the number a
      // give-back watch would have saved.
      givebackFromPeakUsd: Math.max(0, peak - realizedPnlUsd),
      fillCount: totals[0]?.fill_count ?? 0,
      ...(strategy === undefined ? {} : { strategyVersion: strategy.strategy_version }),
      ...(strategy?.target_profit_usd == null
        ? {}
        : { targetProfitUsd: strategy.target_profit_usd }),
    } satisfies ClosedTradeReview;
  }).pipe(
    // A review is commentary on a trade that is already over. Failing the whole
    // reconcile because the commentary could not be assembled would be the
    // worst possible trade for it.
    Effect.orElseSucceed(() => null),
  );
