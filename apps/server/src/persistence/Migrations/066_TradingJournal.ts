import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan 29 step 6.4: the mission journal.
 *
 * Append-only by construction — there is no `updated_at` and nothing writes
 * this table except an insert. The plan document is the model's intent and is
 * replaced on every revision; this is its memory, and memory that gets
 * overwritten is not memory.
 *
 * Nothing prunes it. A session's notes are the same size class as its plan
 * history, and the read that rides a turn is bounded by the reader, not by the
 * table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_journal (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;

  // Every reader wants one mission's notes, newest first: the tool's read-back
  // and the projection's timeline join.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_journal_mission_created
    ON trading_journal (mission_id, created_at DESC)
  `;
});
