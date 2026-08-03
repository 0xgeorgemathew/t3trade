import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Two additive columns on `trading_watches`.
 *
 * `armed_reason` records who armed a watch. The runtime arms a reassessment of
 * its own accord when a mission would otherwise go silent, and a harness woken
 * by one needs to know that nothing crossed — the wake itself is the signal that
 * its thesis has gone stale.
 *
 * `baseline_signature` is the durable baseline for the two differential watch
 * types (`position_update`, `order_update`). It used to live in a per-process
 * Map, so a restart forgot it and the first real change after the restart was
 * swallowed as "the first observation".
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_watches)`;

  if (!columns.some((column) => column.name === "armed_reason")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN armed_reason TEXT`;
  }
  if (!columns.some((column) => column.name === "baseline_signature")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN baseline_signature TEXT`;
  }
});
