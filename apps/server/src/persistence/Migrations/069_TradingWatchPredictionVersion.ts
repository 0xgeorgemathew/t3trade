import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `prediction_version` on `trading_watches`: which prediction a watch belongs
 * to.
 *
 * The runtime arms two watches from a published plan's projection — the
 * horizon and the invalidation level — and a revised plan has to retire the
 * ones armed for the read it just replaced. Without a version on the row, the
 * only way to find them would be by armed reason, which cannot tell the pair
 * armed a moment ago from the pair armed for the plan before it: a revision
 * would sweep the watches it had just written.
 *
 * The column holds the plan's `strategy_version`. Null on every existing row
 * and on every watch the harness arms itself, which is exactly right — those
 * belong to no prediction and no revision may sweep them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_watches)`;

  if (!columns.some((column) => column.name === "prediction_version")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN prediction_version INTEGER`;
  }
});
