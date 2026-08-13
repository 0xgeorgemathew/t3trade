import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Level event history + prior structure read — plan 27 B1/B2, the ledger seam.
 *
 * `trading_level_events` is the append-only record of what each price level
 * has already done to a mission: armed / touched / wick_rejected /
 * closed_through from the watch seams, entered_at / stopped_out_at from the
 * fill reconciler. Rows carry the raw level; grouping into "the same level"
 * happens at read time with an ATR-scaled tolerance, so the tolerance can
 * follow the market instead of being frozen into the rows.
 *
 * `trading_structure_reads` keeps the latest market-structure read per
 * mission, market, and timeframe (upsert, one row each), so the next wake can
 * be shown what the previous read believed — the memory a boundary-redraw or
 * regime-flip check needs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_level_events (
      event_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      level REAL NOT NULL,
      kind TEXT NOT NULL,
      price REAL NOT NULL,
      occurred_at INTEGER NOT NULL
    )
  `;

  // The wakeup composer reads a mission's events newest-first per market.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_level_events_mission
    ON trading_level_events (mission_id, market, occurred_at DESC)
  `;

  // Plan 27 C1: the entry-quote row snapshots the setup evidence and regime
  // read in force when the entry was priced. Measurement only — nothing gates
  // on these; null means the entry was quoted with no scored setup behind it.
  yield* sql`ALTER TABLE trading_entry_quotes ADD COLUMN setup_kind_at_entry TEXT`;
  yield* sql`ALTER TABLE trading_entry_quotes ADD COLUMN setup_score_at_entry REAL`;
  yield* sql`ALTER TABLE trading_entry_quotes ADD COLUMN regime_at_entry TEXT`;

  // Plan 27 G1/G2: the ATR the server measured when the entry was quoted.
  // With the quote's stop_price and bid/ask it is what stop-distance and
  // noise-floor multiples are computed from at close time.
  yield* sql`ALTER TABLE trading_entry_quotes ADD COLUMN atr_usd_at_entry REAL`;

  // Plan 27 G1: where the stop sat when the entry was quoted, denormalised
  // onto the closed trade so calibration reads one table. Null on trades with
  // no readable entry quote behind them.
  yield* sql`ALTER TABLE trading_closed_trades ADD COLUMN stop_price_at_entry REAL`;
  yield* sql`ALTER TABLE trading_closed_trades ADD COLUMN stop_distance_usd REAL`;
  yield* sql`ALTER TABLE trading_closed_trades ADD COLUMN stop_distance_atr_multiple REAL`;
  yield* sql`ALTER TABLE trading_closed_trades ADD COLUMN stop_noise_floor_multiple REAL`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_structure_reads (
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      interval TEXT NOT NULL,
      classification TEXT NOT NULL,
      swing_high REAL,
      swing_low REAL,
      measured_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, market, interval)
    )
  `;
});
