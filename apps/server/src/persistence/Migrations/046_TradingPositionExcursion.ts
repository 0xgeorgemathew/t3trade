import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The other two things a closed trade cannot be reconstructed from its fills.
 *
 * Migration 045 recorded the high-water mark so a give-back watch had something
 * to fire against. A closing self-review needs the mirror and the clock as well:
 *
 *  - `trough_unrealised_pnl` — the maximum ADVERSE excursion. Without it a trade
 *    that was down forty dollars before it came back to close at five reads,
 *    afterwards, exactly like one that went straight to five. Those are not the
 *    same trade and only one of them is repeatable.
 *  - `opened_at` — when the position was first observed non-flat. The fills
 *    carry timestamps, but which fills belong to THIS position is the question,
 *    and the answer is "the ones since it opened".
 *
 * Both are cleared when the mission goes flat, alongside the peak, so each
 * position measures only itself. Same PRAGMA-guarded `ADD COLUMN` shape as 045.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_position_snapshots)`;
  const has = (name: string): boolean => columns.some((column) => column.name === name);

  if (!has("trough_unrealised_pnl")) {
    yield* sql`ALTER TABLE trading_position_snapshots ADD COLUMN trough_unrealised_pnl REAL`;
  }
  if (!has("opened_at")) {
    yield* sql`ALTER TABLE trading_position_snapshots ADD COLUMN opened_at INTEGER`;
  }
});
