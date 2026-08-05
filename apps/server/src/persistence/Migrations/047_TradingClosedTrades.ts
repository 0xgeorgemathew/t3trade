import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A durable record of every trade the mission finished.
 *
 * Migration 046 let the reconciler assemble a review at the moment a position
 * went flat, and that review went to the inbox — a message queue, drained and
 * marked consumed. It was written for the closing turn to read once, and it is
 * gone by the time anything wants to ask a question across trades.
 *
 * "Are this mission's targets set too far out?" is exactly that question, and
 * only these rows can answer it: `peak_unrealised_pnl` is the only record of
 * whether a target was ever REACHED, and it exists nowhere else once the
 * position's snapshot row is cleared.
 *
 * Keyed on (mission, closed_at) so a re-run of the same reconcile pass — which
 * stamps the same close time — writes the same row rather than a second one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_closed_trades (
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER NOT NULL,
      hold_millis INTEGER NOT NULL,
      direction TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL,
      exit_price REAL,
      realized_pnl REAL NOT NULL,
      fees_paid REAL NOT NULL,
      net_pnl REAL NOT NULL,
      peak_unrealised_pnl REAL NOT NULL,
      trough_unrealised_pnl REAL NOT NULL,
      giveback_from_peak REAL NOT NULL,
      fill_count INTEGER NOT NULL,
      strategy_version INTEGER,
      target_profit_usd REAL,
      PRIMARY KEY (mission_id, closed_at)
    )
  `;

  // Calibration reads every trade of one mission, newest first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_closed_trades_mission
      ON trading_closed_trades (mission_id, closed_at DESC)
  `;
});
