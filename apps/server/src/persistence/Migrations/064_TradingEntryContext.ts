import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan 29 step 6.2: the entry's evidence, separated from the quote token.
 *
 * `trading_entry_quotes` was doing two unrelated jobs. One was the two-step —
 * a short-lived token the harness handed back to execute — and that job is
 * being retired. The other was the record of what the server saw at the moment
 * it committed to an entry: the book it priced against, the stop it accepted,
 * and the plan-27 C1 setup snapshot. Four readers depend on the second job
 * (the wakeup composer's `enteredWithoutScoredSetup`, the run telemetry's
 * entry-governance and session-economics reads, and the closed-trade review),
 * and none of them cares that a token ever existed.
 *
 * This is the second job with its own table. One row per entry the server
 * committed to, keyed by the mission-local execution sequence that already
 * identifies every order — so a reader joins on the sequence or on time, and
 * an entry that never became a quote (step 6.2's one-call `enter`) records
 * exactly the same evidence as one that did.
 *
 * Nothing prunes it: it is the other half of every trade the record explains.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_entry_context (
      mission_id TEXT NOT NULL,
      execution_sequence INTEGER NOT NULL,

      market TEXT NOT NULL,
      side TEXT NOT NULL,
      action_type TEXT NOT NULL,

      entry_price REAL NOT NULL,
      best_bid REAL NOT NULL,
      best_ask REAL NOT NULL,
      stop_price REAL NOT NULL,
      size REAL NOT NULL,
      notional_usd REAL NOT NULL,
      constrained_by TEXT NOT NULL,

      setup_kind TEXT,
      setup_score REAL,
      regime TEXT,
      atr_usd REAL,

      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, execution_sequence)
    )
  `;

  // Every reader joins a trade to the entry that opened it by time, newest
  // first — the same join the quote rows carried.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_entry_context_mission_recorded
    ON trading_entry_context (mission_id, recorded_at DESC)
  `;

  // The quotes that became orders are exactly the entries the server
  // committed to, so the existing record carries over whole. Quotes that were
  // never consumed described an entry that never happened and are not
  // evidence about a trade; they stay behind with the table being retired.
  yield* sql`
    INSERT OR IGNORE INTO trading_entry_context (
      mission_id, execution_sequence, market, side, action_type,
      entry_price, best_bid, best_ask, stop_price, size, notional_usd,
      constrained_by, setup_kind, setup_score, regime, atr_usd, recorded_at
    )
    SELECT
      mission_id, execution_sequence, market, side, action_type,
      CASE WHEN side = 'buy' THEN best_ask ELSE best_bid END,
      best_bid, best_ask, stop_price, size, notional_usd,
      constrained_by, setup_kind_at_entry, setup_score_at_entry,
      regime_at_entry, atr_usd_at_entry, consumed_at
    FROM trading_entry_quotes
    WHERE consumed_at IS NOT NULL
  `;
});
