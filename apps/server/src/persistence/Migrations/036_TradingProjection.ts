import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The mission read model the workspace UI renders.
 *
 * This is a projection, not a second source of truth: migration 035's
 * `trading_missions` remains authoritative, and the trading projector rebuilds
 * this table from the event stream like every other `projection_*` table.
 *
 * Timestamps are TEXT ISO strings here, matching the other projection tables,
 * while 035 stores INTEGER epoch millis. The trading projector is the single
 * place that converts between them. The JSON payload columns are the deliberate
 * exception: they carry the published spec contracts (`TradingAuthority`,
 * `TradingPlanState`, `PersistedWatch`) verbatim, so a reader sees exactly
 * the shape the harness published.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_trading_missions (
      mission_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      trading_account_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      market TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      status TEXT NOT NULL,
      blocked_reason TEXT,
      authority_json TEXT NOT NULL,
      authority_version INTEGER NOT NULL,
      strategy_json TEXT,
      strategy_version INTEGER NOT NULL,
      watches_json TEXT NOT NULL,
      control_json TEXT NOT NULL,
      harness_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The workspace shell reads a mission by the thread it is bound to (§10.2),
  // which is how a chat thread finds "its" mission.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_trading_missions_thread
    ON projection_trading_missions (thread_id)
  `;
});
