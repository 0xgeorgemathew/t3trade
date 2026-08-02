import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Re-applies migration 037 to databases that were created before it existed.
 *
 * 037 was inserted underneath an id that had already been applied: the file now
 * at 038 was originally 037, so any database migrated before the renumbering
 * has id 37 recorded and skips `037_TradingInboxSummary` forever. Those
 * databases keep a `trading_event_inbox` with no `summary` column, and every
 * `claimPending` fails with `no such column: summary` — which stops a mission's
 * first harness run and strands it in `initializing`.
 *
 * A fresh database runs 037 normally and reaches here with the column already
 * present, so the add is conditional rather than unconditional.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('trading_event_inbox')
  `;
  if (columns.some((column) => column.name === "summary")) return;

  yield* sql`
    ALTER TABLE trading_event_inbox ADD COLUMN summary TEXT NOT NULL DEFAULT ''
  `;
});
