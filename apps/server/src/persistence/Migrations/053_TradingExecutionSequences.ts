import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One durable, atomic execution-sequence lane per mission.
 *
 * A sequence becomes a client-order id and a receipt key, so it must be unique
 * even for actions such as cancel that do not create an execution record. The
 * old MAX(sequence)+1 reads in the quote and exit services could race and could
 * also reuse a cancel's sequence. This counter reserves every sequence before
 * an action is dispatched; gaps are harmless, reuse is not.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_execution_sequences (
      mission_id TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0)
    )
  `;

  yield* sql`
    INSERT INTO trading_execution_sequences (mission_id, next_sequence)
    SELECT mission_id, MAX(execution_sequence) + 1
    FROM (
      SELECT mission_id, execution_sequence FROM trading_execution_records
      UNION ALL
      SELECT mission_id, execution_sequence FROM trading_entry_quotes
    )
    GROUP BY mission_id
    ON CONFLICT(mission_id) DO UPDATE SET
      next_sequence = MAX(trading_execution_sequences.next_sequence, excluded.next_sequence)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_execution_records_mission_sequence
    ON trading_execution_records (mission_id, execution_sequence)
  `;

  // Builds before this migration could race two still-live quotes onto the
  // same sequence. There is no safe winner: choosing one would let a caller
  // holding the other token believe it still owns that sequence. Expire every
  // member of such a group so both callers receive the normal re-quote path.
  // Consumed historical quotes remain as audit records and are deliberately
  // outside the active-token uniqueness constraint.
  yield* sql`
    UPDATE trading_entry_quotes
    SET expires_at = 0
    WHERE consumed_at IS NULL
      AND (mission_id, execution_sequence) IN (
        SELECT mission_id, execution_sequence
        FROM trading_entry_quotes
        WHERE consumed_at IS NULL AND expires_at > 0
        GROUP BY mission_id, execution_sequence
        HAVING COUNT(*) > 1
      )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_entry_quotes_mission_sequence
    ON trading_entry_quotes (mission_id, execution_sequence)
    WHERE consumed_at IS NULL AND expires_at > 0
  `;
});
