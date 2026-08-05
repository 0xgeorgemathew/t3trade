import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The durable high-water mark of a position's unrealised PnL.
 *
 * The exchange reports what a position is worth now and never what it was worth
 * at its best, so nothing in T3 could answer "how much of this winner have we
 * given back?" — and without that answer, holding past a profit target is a bet
 * with no floor under it. `pnl_giveback` watches fire off this column.
 *
 * It lives on the position snapshot rather than in memory because the drawdown
 * a restart most needs to know about is the one that happened while the server
 * was down. Reset to NULL when the mission goes flat, so a new position starts
 * its own high-water mark rather than inheriting the last one's.
 *
 * Same PRAGMA-guarded `ADD COLUMN` shape as 039 and 040.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const positionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_position_snapshots)`;
  if (!positionCols.some((column) => column.name === "peak_unrealised_pnl")) {
    yield* sql`ALTER TABLE trading_position_snapshots ADD COLUMN peak_unrealised_pnl REAL`;
  }
});
