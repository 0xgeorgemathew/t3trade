import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The sequence of stop moves on a position — plan 24 §5.
 *
 * `replaceProtection` logs each move and keeps only the latest price, so the
 * two questions the policy has to answer before it allows another one — how
 * many have there been on this position, and how long ago was the last — had no
 * durable answer. This is that answer, and it is also the history §4.1's stop
 * step-line draws from: current state alone cannot show a stop that walked up
 * behind a winner.
 *
 * Scoped per position by comparing `adjusted_at` against the position
 * snapshot's `opened_at` (migration 046), so a new position starts with a fresh
 * budget without anything having to clear the table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_stop_adjustments (
      adjustment_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      previous_stop_price REAL NOT NULL,
      new_stop_price REAL NOT NULL,
      justification TEXT NOT NULL,
      adjusted_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_stop_adjustments_mission
    ON trading_stop_adjustments (mission_id, market, adjusted_at)
  `;
});
