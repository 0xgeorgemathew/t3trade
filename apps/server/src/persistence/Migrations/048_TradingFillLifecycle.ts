import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Where each fill sat in the position's life, and the leverage it ran at.
 *
 * A fill row said "sell 0.67 ETH" and nothing more, and that is not enough to
 * say what happened: a sell opens a short and closes a long, and the running
 * position that tells the two apart is not in the row. The exchange labels it
 * for us — `dir` is "Open Long", "Close Long", "Long > Short" — so `direction`
 * records that label verbatim rather than trying to recover it later from a
 * receipt list that is capped at the last three orders.
 *
 * `leverage` is the exchange's own setting for the market, not a measurement,
 * which is why it is the one position-snapshot column NOT cleared when the
 * mission goes flat: the receipts outlive the position, and the leverage the
 * next entry will run at is the one the last entry ran at.
 *
 * Same PRAGMA-guarded `ADD COLUMN` shape as 039, 040 and 045.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fillCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_fills)`;
  if (!fillCols.some((column) => column.name === "direction")) {
    yield* sql`ALTER TABLE trading_fills ADD COLUMN direction TEXT`;
  }

  const positionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_position_snapshots)`;
  if (!positionCols.some((column) => column.name === "leverage")) {
    yield* sql`ALTER TABLE trading_position_snapshots ADD COLUMN leverage REAL`;
  }
});
