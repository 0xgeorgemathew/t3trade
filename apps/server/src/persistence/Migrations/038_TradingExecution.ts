import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The six execution records spec §18 defers from migration 035.
 *
 * These tables hold the persisted execution record (the idempotency anchor),
 * the orders/fills/positions the reconciler converges against Hyperliquid,
 * the risk reservations that gate signing, and the canonical account snapshot
 * cache. The mission tables in 035 remain authoritative for mission state;
 * these are the execution-domain records PROMPT-04 adds.
 *
 * Timestamps are INTEGER epoch millis, matching 035's trading tables (the
 * projection table in 036 is the TEXT-ISO exception). JSON columns carry the
 * published spec contracts verbatim.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // §18 trading_execution_records — persisted BEFORE signing (§15.5, §17.2
  // step 2). The cloid + idempotency_key make retries idempotent: the
  // exchange dedupes on cloid, the local write dedupes on idempotency_key.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_execution_records (
      execution_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      strategy_version INTEGER NOT NULL,
      execution_sequence INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      cloid TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      limit_price REAL NOT NULL,
      time_in_force TEXT NOT NULL,
      reduce_only INTEGER NOT NULL,
      signer_address TEXT NOT NULL,
      status TEXT NOT NULL,
      order_results_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_execution_records_mission
    ON trading_execution_records (mission_id, execution_sequence)
  `;
  // A retry must reuse the same cloid; look it up by cloid to detect reuse.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_execution_records_cloid
    ON trading_execution_records (cloid)
  `;

  // §18 trading_orders — reconciled open orders keyed by cloid.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_orders (
      mission_id TEXT NOT NULL,
      cloid TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      limit_price REAL NOT NULL,
      remaining_size REAL NOT NULL,
      reduce_only INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, cloid)
    )
  `;

  // §18 trading_fills — reconciled fills from the master address's userFills.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_fills (
      fill_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      execution_id TEXT,
      cloid TEXT,
      order_id INTEGER NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      filled_size REAL NOT NULL,
      avg_fill_price REAL NOT NULL,
      fee_usd REAL NOT NULL,
      fee_token TEXT NOT NULL,
      traded_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_fills_mission
    ON trading_fills (mission_id, traded_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_fills_cloid
    ON trading_fills (cloid)
  `;

  // §18 trading_position_snapshots — the reconciled position per mission.
  // One row per (mission, market); the POC trades ETH only.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_position_snapshots (
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL,
      unrealised_pnl REAL NOT NULL,
      margin_used REAL NOT NULL,
      protected_size REAL NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, market)
    )
  `;

  // §18 trading_risk_reservations — the reservation ledger against the
  // cumulative-loss budget. `reserved` while in flight; `released` once the
  // fill settles into open-position risk or the execution is rejected.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_risk_reservations (
      reservation_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      cloid TEXT NOT NULL,
      action_type TEXT NOT NULL,
      reserved_risk_usd REAL NOT NULL,
      status TEXT NOT NULL,
      reserved_at INTEGER NOT NULL,
      released_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_risk_reservations_mission
    ON trading_risk_reservations (mission_id, status)
  `;

  // §18 trading_account_snapshots — the canonical account snapshot cache,
  // reconciled from the master address's clearinghouse state.
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_account_snapshots (
      mission_id TEXT NOT NULL,
      master_address TEXT NOT NULL,
      account_value REAL NOT NULL,
      margin_used REAL NOT NULL,
      withdrawable REAL NOT NULL,
      positions_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id)
    )
  `;
});
