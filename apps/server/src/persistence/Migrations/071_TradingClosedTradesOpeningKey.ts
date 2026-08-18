import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Re-key `trading_closed_trades` on the opening, not on when we looked.
 *
 * Migration 047 keyed the table `(mission_id, closed_at)` on the assumption
 * that "a re-run of the same reconcile pass stamps the same close time". It
 * does not: `closed_at` was the local instant a pass happened to observe the
 * position gone, so two passes over one close stamped two keys. A live mission
 * wrote the same trade twice, 67ms apart, and its own scorecard — which later
 * turns calibrate against — counted one trade as two.
 *
 * The opening is the identity that holds. A mission holds one position at a
 * time, `opened_at` is fixed long before the close is reviewed, and it is the
 * same number on every pass. `closed_at` remains, now carrying the exchange's
 * own timestamp for the last closing fill, and is updated in place as later
 * fills of the same close land.
 *
 * SQLite cannot alter a primary key, so the table is rebuilt. The surviving
 * row of each duplicate group is the one with the earliest `closed_at` — the
 * first observation, whose `hold_millis` is the one measured against a close
 * the exchange had actually reported.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE trading_closed_trades_rekeyed (
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
      stop_price_at_entry REAL,
      stop_distance_usd REAL,
      stop_distance_atr_multiple REAL,
      stop_noise_floor_multiple REAL,
      PRIMARY KEY (mission_id, opened_at)
    )
  `;

  // One row per (mission, opening, direction, size): the earliest observation
  // of that close. `MIN(closed_at)` picks the group; the correlated subquery
  // carries the rest of that same row across rather than mixing columns from
  // siblings the way a bare GROUP BY would.
  yield* sql`
    INSERT INTO trading_closed_trades_rekeyed
    SELECT mission_id, market, opened_at, closed_at, hold_millis, direction, size,
           entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
           peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak,
           fill_count, strategy_version, target_profit_usd,
           stop_price_at_entry, stop_distance_usd, stop_distance_atr_multiple,
           stop_noise_floor_multiple
    FROM trading_closed_trades AS t
    WHERE closed_at = (
      SELECT MIN(d.closed_at) FROM trading_closed_trades AS d
      WHERE d.mission_id = t.mission_id AND d.opened_at = t.opened_at
    )
    GROUP BY mission_id, opened_at
  `;

  yield* sql`DROP TABLE trading_closed_trades`;
  yield* sql`ALTER TABLE trading_closed_trades_rekeyed RENAME TO trading_closed_trades`;

  // Calibration reads every trade of one mission, newest first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_closed_trades_mission
      ON trading_closed_trades (mission_id, closed_at DESC)
  `;
});
