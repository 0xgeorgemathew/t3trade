import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Trading domain tables - spec §18 logical records.
 *
 * Covers the seven records Phase 1 needs. The remaining six from §18
 * (trading_execution_records, trading_orders, trading_fills,
 * trading_position_snapshots, trading_risk_reservations,
 * trading_account_snapshots) arrive with the execution phase.
 *
 * Timestamps are stored as INTEGER epoch milliseconds because the published
 * contracts declare `number`, unlike the upstream projection tables which store
 * ISO strings. Structured sub-records are stored as JSON text columns so the
 * published contract shapes stay the single source of truth.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_accounts (
      account_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      master_wallet_json TEXT NOT NULL,
      execution_wallet_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_accounts_user
    ON trading_accounts (user_id)
  `;

  // version is the mission row's optimistic-locking token. authority_version and
  // strategy_version point at the currently published rows in the two version
  // tables below.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_missions (
      mission_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      trading_account_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      market TEXT NOT NULL,
      strategy_family TEXT NOT NULL,
      harness_json TEXT NOT NULL,
      status TEXT NOT NULL,
      blocked_reason TEXT,
      control_json TEXT NOT NULL,
      authority_version INTEGER NOT NULL,
      strategy_version INTEGER NOT NULL,
      version INTEGER NOT NULL,
      last_harness_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // The one-active-mission invariant, enforced in the database rather than only
  // in the service. revoked and completed are the two permanent terminals from
  // §11.1; every other status still holds mission authority.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_missions_one_active_per_user
    ON trading_missions (user_id)
    WHERE status NOT IN ('revoked', 'completed')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_missions_account
    ON trading_missions (trading_account_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_authority_versions (
      mission_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      authority_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS momentum_strategy_versions (
      mission_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      strategy_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_watches (
      watch_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      strategy_version INTEGER NOT NULL,
      watch_json TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // Supersession on publish reads by (mission, strategy_version); the watch
  // evaluator reads active watches by (mission, status).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_watches_mission_strategy_version
    ON trading_watches (mission_id, strategy_version)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_watches_mission_status
    ON trading_watches (mission_id, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_harness_runs (
      run_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      cause TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `;

  // §11.2 single decision lease: at most one non-terminal run per mission, so a
  // second provider turn can never be started while another is active.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_harness_runs_one_active_per_mission
    ON trading_harness_runs (mission_id)
    WHERE status NOT IN ('completed', 'failed')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_event_inbox (
      event_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      category TEXT NOT NULL,
      deduplication_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;

  // §18.1 deduplication: reconnects and replays drop duplicates before they
  // generate a second wake-up.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_event_inbox_dedupe
    ON trading_event_inbox (mission_id, deduplication_key)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_event_inbox_mission_status
    ON trading_event_inbox (mission_id, status, occurred_at)
  `;
});
