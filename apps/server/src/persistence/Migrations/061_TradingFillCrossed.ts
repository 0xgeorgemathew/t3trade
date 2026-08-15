import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The exchange's own maker/taker label on each fill — plan 29 step 2.7.
 *
 * `crossed` is what the `userFills` wire already carried and nothing read:
 * true means the fill crossed the spread (a taker that paid it), false means
 * it rested and was hit (a maker). That flag is the only way to measure maker
 * fill rate after the fact — order type does not decide it, because a GTC
 * priced through the book crosses and pays taker too.
 *
 * Nullable 0/1, not defaulting either way: NULL is the honest value for rows
 * written before the flag was carried, and those sessions must read
 * "no maker flag recorded" rather than count as maker or taker.
 *
 * Same PRAGMA-guarded `ADD COLUMN` shape as 039, 040, 045 and 048.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fillCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_fills)`;
  if (!fillCols.some((column) => column.name === "crossed")) {
    yield* sql`ALTER TABLE trading_fills ADD COLUMN crossed INTEGER`;
  }
});
