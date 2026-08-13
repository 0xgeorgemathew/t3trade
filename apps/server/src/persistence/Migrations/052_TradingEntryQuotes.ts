import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Executable entry quotes — the server's half of an order, held between the
 * turn that asked for it and the call that executes it.
 *
 * A row is everything `trading_execute` needs and the harness used to have to
 * supply: the strategy and authority versions, the harness run that owned the
 * decision lease, the mission's next execution sequence, and a priced, sized,
 * precision-correct entry with its stop. `consumed_execution_sequence` is what
 * makes a repeated execute idempotent — the second call reuses the sequence, so
 * it reuses the cloid, so the exchange sees one order.
 *
 * Quotes expire. Nothing prunes them: they are the record of what the server
 * offered and at what price, which is the other half of every refusal the
 * funnel counts.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_entry_quotes (
      quote_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      harness_run_id TEXT NOT NULL,
      strategy_version INTEGER NOT NULL,
      authority_version INTEGER NOT NULL,
      execution_sequence INTEGER NOT NULL,

      market TEXT NOT NULL,
      side TEXT NOT NULL,
      action_type TEXT NOT NULL,
      order_preference TEXT NOT NULL,

      size REAL NOT NULL,
      requested_size REAL NOT NULL,
      constrained_by TEXT NOT NULL,
      limit_price REAL NOT NULL,
      stop_price REAL NOT NULL,
      planned_loss_usd REAL NOT NULL,
      reserved_risk_usd REAL NOT NULL,
      notional_usd REAL NOT NULL,
      best_bid REAL NOT NULL,
      best_ask REAL NOT NULL,
      round_trip_cost_usd REAL NOT NULL,

      quoted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    )
  `;

  // The quote path reads a mission's newest quote to derive the next sequence.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_entry_quotes_mission_quoted
    ON trading_entry_quotes (mission_id, quoted_at DESC)
  `;
});
