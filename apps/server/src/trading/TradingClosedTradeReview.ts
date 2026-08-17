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
import { stopNoiseFloorUsd } from "@t3tools/trading-contracts/stop-adjustment";

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
  /** Base units filled on the side that OPENED the trade — its peak exposure. */
  readonly opened_size: number | null;
}

/**
 * How far before the first observation a fill can trade and still belong to
 * this trade — plan 34 step 3.
 *
 * `opened_at` is when the reconciler first SAW the position, not when it was
 * opened: the entry's fills trade a few hundred milliseconds earlier, and a
 * window starting at the observation excluded every one of them. The mission
 * this was found on reported half its real fee load to its own scorecard —
 * which is what the standing-rules fee-share gate reads.
 *
 * The same minute of slack the entry-context join below already uses, and for
 * the same reason. It is wide enough to be wrong only if a mission opened a
 * new position within a minute of closing the last one, which the one-position
 * mandate does not allow.
 */
const FILL_WINDOW_SLACK_MILLIS = 60_000;

/** The strategy in force at the close, for scoring the thesis against it. */
interface StrategyRow {
  readonly strategy_version: number;
  readonly target_profit_usd: number | null;
}

/** The entry that opened the trade — where its stop sat, and against what market. */
interface EntryContextRow {
  readonly stop_price: number;
  readonly atr_usd: number | null;
  readonly best_bid: number;
  readonly best_ask: number;
}

/**
 * Stop distance at entry in USD, ATRs, and noise-floor multiples — plan 27 G1.
 *
 * All read off the entry record: the stop the entry was approved with, the ATR
 * the server measured then, and the spread it was priced against. Empty when
 * any leg is missing; a partial measurement would grade the stop against a
 * floor that was never computed.
 */
const measureStopAtEntry = (
  entry: EntryContextRow | undefined,
  entryPrice: number | null,
): Partial<
  Pick<
    ClosedTradeReview,
    "stopPriceAtEntry" | "stopDistanceUsd" | "stopDistanceAtrMultiple" | "stopNoiseFloorMultiple"
  >
> => {
  if (entry === undefined || entryPrice === null || entryPrice <= 0) return {};
  if (!(entry.stop_price > 0)) return {};
  const distance = Math.abs(entryPrice - entry.stop_price);
  const atr = entry.atr_usd;
  const floor = stopNoiseFloorUsd({
    halfSpreadUsd: Math.max(0, (entry.best_ask - entry.best_bid) / 2),
    atrUsd: atr ?? 0,
  });
  return {
    stopPriceAtEntry: entry.stop_price,
    stopDistanceUsd: distance,
    ...(atr !== null && atr > 0 ? { stopDistanceAtrMultiple: distance / atr } : {}),
    ...(floor > 0 ? { stopNoiseFloorMultiple: distance / floor } : {}),
  };
};

/**
 * Build the review, or return null when there is nothing to review.
 *
 * `openedAt` is what decides which fills belong to this trade: every fill from
 * a minute before the position was first observed non-flat — see
 * {@link FILL_WINDOW_SLACK_MILLIS} — and none from before that. A row written
 * before migration 046 has no `opened_at`, so it falls back to the last
 * observation.
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
    const openingSide = direction === "long" ? "buy" : "sell";
    const fillsFrom = openedAt - FILL_WINDOW_SLACK_MILLIS;

    const totals = yield* sql<TradeFillTotals>`
      SELECT SUM(closed_pnl) AS realized_pnl, SUM(fee_usd) AS fees_paid, COUNT(*) AS fill_count,
             SUM(CASE WHEN side = ${openingSide} THEN filled_size ELSE 0 END) AS opened_size
      FROM trading_fills
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
        AND traded_at >= ${fillsFrom}
    `;
    const exits = yield* sql<{ readonly avg_price: number | null }>`
      SELECT SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_price
      FROM trading_fills
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
        AND traded_at >= ${fillsFrom} AND side = ${closingSide}
    `;
    // The entry that opened this trade: the newest open entry the server
    // committed to at or shortly before the position was first observed. Same
    // join the entry governance read uses; a minute of slack covers the gap
    // between the entry and the snapshot pass that observed the fill.
    const entries = yield* sql<EntryContextRow>`
      SELECT stop_price, atr_usd, best_bid, best_ask
      FROM trading_entry_context
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
        AND action_type = 'open'
        AND recorded_at <= ${openedAt + 60_000}
      ORDER BY recorded_at DESC
      LIMIT 1
    `;
    // The plan in force when the position closed — the newest history row the
    // close did not outlive. The mission row no longer points at a plan (plan
    // 29 step 4.2), so "in force" is read from the journal, not a pointer. The
    // json path is the position-centric document's (`target.profitUsd`).
    const strategies = yield* sql<StrategyRow>`
      SELECT version AS strategy_version,
             json_extract(strategy_json, '$.target.profitUsd') AS target_profit_usd
      FROM trading_plan_history
      WHERE mission_id = ${input.missionId}
        AND created_at <= ${input.closedAt}
      ORDER BY version DESC
      LIMIT 1
    `;

    const realizedPnlUsd = totals[0]?.realized_pnl ?? 0;
    const feesPaidUsd = totals[0]?.fees_paid ?? 0;
    const peak = Math.max(0, previous.peak_unrealised_pnl ?? 0);
    const trough = Math.min(0, previous.trough_unrealised_pnl ?? 0);
    const exitPrice = exits[0]?.avg_price ?? null;
    const openedSize = Math.abs(totals[0]?.opened_size ?? 0);
    const strategy = strategies[0];

    return {
      missionId: input.missionId,
      market: input.market,
      direction,
      openedAt,
      closedAt: input.closedAt,
      holdMillis: Math.max(0, input.closedAt - openedAt),
      // The exposure the trade actually carried, not the chunk that happened
      // to be left when it went flat: a position closed in three rungs was
      // reviewed at the size of the last one.
      sizeEth: openedSize > 0 ? (direction === "long" ? openedSize : -openedSize) : previous.size,
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
      ...measureStopAtEntry(entries[0], previous.entry_price),
    } satisfies ClosedTradeReview;
  }).pipe(
    // A review is commentary on a trade that is already over. Failing the whole
    // reconcile because the commentary could not be assembled would be the
    // worst possible trade for it.
    Effect.orElseSucceed(() => null),
  );

/**
 * Keep the review after the turn that reads it.
 *
 * The inbox is a queue: the closing turn drains its copy and it is gone. The
 * questions worth asking across trades — was the target ever reached, is this
 * mission's habit of setting them wrong — need the record to outlive the
 * message, and `peakUnrealisedPnlUsd` exists nowhere else once the position
 * snapshot is cleared.
 *
 * Keyed on (mission, closedAt), so a re-run of the same reconcile pass rewrites
 * its row instead of counting the trade twice.
 */
export const persistClosedTradeReview = (
  review: ClosedTradeReview,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_closed_trades (
        mission_id, market, opened_at, closed_at, hold_millis, direction, size,
        entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
        peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak,
        fill_count, strategy_version, target_profit_usd,
        stop_price_at_entry, stop_distance_usd, stop_distance_atr_multiple,
        stop_noise_floor_multiple
      ) VALUES (
        ${review.missionId}, ${review.market}, ${review.openedAt}, ${review.closedAt},
        ${review.holdMillis}, ${review.direction}, ${review.sizeEth},
        ${review.entryPrice ?? null}, ${review.exitPrice ?? null},
        ${review.realizedPnlUsd}, ${review.feesPaidUsd}, ${review.netPnlUsd},
        ${review.peakUnrealisedPnlUsd}, ${review.worstUnrealisedPnlUsd},
        ${review.givebackFromPeakUsd}, ${review.fillCount},
        ${review.strategyVersion ?? null}, ${review.targetProfitUsd ?? null},
        ${review.stopPriceAtEntry ?? null}, ${review.stopDistanceUsd ?? null},
        ${review.stopDistanceAtrMultiple ?? null}, ${review.stopNoiseFloorMultiple ?? null}
      )
      ON CONFLICT(mission_id, closed_at) DO UPDATE SET
        realized_pnl = ${review.realizedPnlUsd}, fees_paid = ${review.feesPaidUsd},
        net_pnl = ${review.netPnlUsd}, fill_count = ${review.fillCount}
    `;
  }).pipe(Effect.ignore);
