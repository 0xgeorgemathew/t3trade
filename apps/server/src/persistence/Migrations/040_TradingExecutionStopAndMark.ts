import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Additive PROMPT-04 columns needed by the stop-aware budget reader (Task 2)
 * and the mark-price position view (Task 8).
 *
 * - `trading_execution_records.stop_price` / `planned_loss_at_stop_usd`: the
 *   intent's stop is currently dropped at persist time, which is what left the
 *   budget reader without a stop to thread into `openPositionRisk`.
 * - `trading_position_snapshots.mark_px`: the contract's `markPrice` field is
 *   otherwise never populated.
 *
 * Same PRAGMA-guarded `ADD COLUMN` shape as 039.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const executionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_execution_records)`;
  if (!executionCols.some((column) => column.name === "stop_price")) {
    yield* sql`ALTER TABLE trading_execution_records ADD COLUMN stop_price REAL`;
  }
  if (!executionCols.some((column) => column.name === "planned_loss_at_stop_usd")) {
    yield* sql`ALTER TABLE trading_execution_records ADD COLUMN planned_loss_at_stop_usd REAL`;
  }

  const positionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_position_snapshots)`;
  if (!positionCols.some((column) => column.name === "mark_px")) {
    yield* sql`ALTER TABLE trading_position_snapshots ADD COLUMN mark_px REAL`;
  }
});
