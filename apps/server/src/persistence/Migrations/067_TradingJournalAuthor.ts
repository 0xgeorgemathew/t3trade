import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan 29 step 8.4: who wrote a journal note.
 *
 * The journal was built for one author. Step 8.4 gives the panel direct
 * manipulation — dragging a stop or a target publishes a real plan revision —
 * and a revision the operator made is journaled like any other, which
 * immediately raises a question the table cannot answer: whose note is this.
 * It matters in both directions. A human reading the session back needs to
 * know which decisions were theirs, and the model reading its own journal back
 * needs to know which of these notes it did not write, because a note it takes
 * for its own past reasoning is a note it will treat as its own conclusion.
 *
 * Added ahead of the drag handler rather than with it, so the column exists
 * before anything wants to write to it.
 *
 * Every existing row is the model's: nothing but `trading_journal` has ever
 * written this table, and its only caller is the tool. So the default is
 * `model` and the backfill is the default — there is no row whose author is in
 * doubt.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // NOT NULL with a DEFAULT: SQLite rewrites existing rows to the default in
  // one statement, and the column can never be absent afterwards. A nullable
  // column would leave "unknown author" representable, which is a third state
  // nothing means and every reader would have to handle.
  yield* sql`
    ALTER TABLE trading_journal ADD COLUMN author TEXT NOT NULL DEFAULT 'model'
  `;
});
