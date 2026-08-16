import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan 29 step 4.2: revise, don't version.
 *
 * The plan document stopped carrying a version when step 4.1 reshaped it; this
 * removes the version machinery that was left holding it up:
 *
 * - `trading_watches.strategy_version` and its index: watches bind their
 *   mission, not a plan revision. Supersede-on-publish is gone — publishing
 *   revises the plan in place and watches survive.
 * - `trading_missions.strategy_version` / `strategy_family`: the mission no
 *   longer points at a plan row or names a family. The publish path's
 *   optimistic lock re-keyed onto the mission's own generic `version` column
 *   (the one `transition` and `updateHarnessBinding` already bump).
 * - `momentum_strategy_versions` → `trading_plan_history`: rows and PK kept —
 *   it is the journal of what the mission has believed, and nothing gates on
 *   it. Current-plan reads are latest-by-version per mission.
 * - `trading_execution_records.strategy_version` /
 *   `trading_entry_quotes.strategy_version`: the execution path no longer
 *   knows or cares which plan revision an order was decided under (the
 *   cloid hash drops the field too, so new cloids are derived from
 *   mission + sequence + action alone).
 * - `projection_trading_missions.strategy_family` / `strategy_version`:
 *   mirrors of the dropped mission columns.
 * - `trading_harness_runs.strategy_version`: a telemetry annotation nothing
 *   reads; the mission pointer it was stamped from is gone.
 *
 * `trading_closed_trades.strategy_version` (migration 047) is deliberately
 * KEPT: the closed-trade review reads the plan in force at close time from
 * `trading_plan_history` and stamps it, so calibration's per-version grouping
 * keeps its input without any mission pointer.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Watches: drop the version binding and the index that existed for
  // supersede-on-publish reads.
  yield* sql`DROP INDEX IF EXISTS idx_trading_watches_mission_strategy_version`;
  yield* sql`ALTER TABLE trading_watches DROP COLUMN strategy_version`;

  // Missions: no plan pointer, no family.
  yield* sql`ALTER TABLE trading_missions DROP COLUMN strategy_version`;
  yield* sql`ALTER TABLE trading_missions DROP COLUMN strategy_family`;

  // The journal keeps its rows and its PK under a position-shaped name.
  yield* sql`ALTER TABLE momentum_strategy_versions RENAME TO trading_plan_history`;

  // Execution decoupling: order identity no longer encodes a plan revision.
  yield* sql`ALTER TABLE trading_execution_records DROP COLUMN strategy_version`;
  yield* sql`ALTER TABLE trading_entry_quotes DROP COLUMN strategy_version`;

  // Read-model mirrors of the dropped mission columns.
  yield* sql`ALTER TABLE projection_trading_missions DROP COLUMN strategy_family`;
  yield* sql`ALTER TABLE projection_trading_missions DROP COLUMN strategy_version`;

  // Telemetry annotation with no reader and, now, no source.
  yield* sql`ALTER TABLE trading_harness_runs DROP COLUMN strategy_version`;
});
