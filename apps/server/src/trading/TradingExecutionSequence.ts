import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Atomically reserve the next mission-local execution sequence.
 *
 * The statement also observes manually/backfilled execution and entry rows, so
 * importing old data cannot move the counter behind an already-used sequence.
 * SQLite serializes the upsert itself; two callers cannot receive the same
 * RETURNING value.
 *
 * The entry-context half of that floor covers the gap the execution records
 * leave: a sequence is allocated before an order is submitted, and a
 * submission refused at preview writes no record at all. The entry the server
 * committed to is written either way, so an imported mission cannot hand out a
 * sequence a cloid was already derived from.
 */
export const allocateExecutionSequence = Effect.fn("trading.allocateExecutionSequence")(function* (
  sql: SqlClient.SqlClient,
  missionId: string,
) {
  const rows = yield* sql<{ readonly execution_sequence: number }>`
      INSERT INTO trading_execution_sequences (mission_id, next_sequence)
      VALUES (
        ${missionId},
        (
          SELECT COALESCE(MAX(execution_sequence), -1) + 2
          FROM (
            SELECT execution_sequence FROM trading_execution_records WHERE mission_id = ${missionId}
            UNION ALL
            SELECT execution_sequence FROM trading_entry_context WHERE mission_id = ${missionId}
          )
        )
      )
      ON CONFLICT(mission_id) DO UPDATE SET
        next_sequence = MAX(
          trading_execution_sequences.next_sequence + 1,
          excluded.next_sequence
        )
      RETURNING next_sequence - 1 AS execution_sequence
    `;
  const sequence = rows[0]?.execution_sequence;
  if (sequence === undefined) {
    return yield* Effect.die(new Error(`could not allocate execution sequence for ${missionId}`));
  }
  return sequence;
});
