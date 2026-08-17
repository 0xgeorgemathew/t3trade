import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `trading_protection_orders`: the orders the SERVER rests on a position.
 *
 * The take-profit reconcile places a reduce-only ALO at the plan's target and
 * replaces it whenever the target moves. Those orders existed nowhere on this
 * side of the wire — no execution record, no event, no row — so when one
 * filled, the position simply shrank between two wakes and the model had to
 * guess what had happened to it. On the mission this was found on it guessed
 * wrong, and attributed the server's own take-profit to a give-back trigger.
 *
 * A deliberately separate table rather than `trading_execution_records`: that
 * table is read by the budget, the exhaustion guard, the stand-down cancel
 * sweep and preview item 16, all of which classify by `action_type` and would
 * have to be taught about a reduce-only order none of them placed. This one is
 * a ledger and nothing reads it as permission.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_protection_orders (
      cloid TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      -- What the server rested it for. Only 'take_profit' today.
      kind TEXT NOT NULL,
      size REAL NOT NULL,
      limit_price REAL NOT NULL,
      placed_at INTEGER NOT NULL,
      -- Set when a later pass replaced or withdrew this order.
      retired_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_protection_orders_mission
    ON trading_protection_orders (mission_id, placed_at)
  `;
});
