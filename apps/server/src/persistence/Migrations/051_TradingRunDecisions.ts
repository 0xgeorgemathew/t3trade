import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The decision funnel: what each harness run actually decided, and where the
 * ones that decided nothing lost their way.
 *
 * `trading_harness_runs` (migration 035) recorded that a run started and that
 * it ended — nothing about what it concluded. Executions and refusals were
 * durable, but a turn that never reached execution left no trace at all, so
 * "the harness found no edge", "a market read failed", "the tool call was
 * malformed", and "the model never called execute" were one undifferentiated
 * silence. Thresholds cannot be tuned against a silence.
 *
 * These columns are the run's terminal decision plus the observed facts it was
 * derived from. Every one is written by the server from what it saw — none is
 * asserted by the model, and no chain-of-thought is stored: `tools_called_json`
 * is a list of public tool names, `first_tool_error` the first error message a
 * tool already returned to the agent.
 *
 * Same PRAGMA-guarded `ADD COLUMN` shape as 043, 048, and 049.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_harness_runs)`;
  const has = (name: string) => columns.some((column) => column.name === name);

  // The terminal decision and why, from `@t3tools/trading-contracts/decision`.
  if (!has("outcome")) yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN outcome TEXT`;
  if (!has("stand_down_code"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN stand_down_code TEXT`;

  // The dimensions a funnel report breaks down by.
  if (!has("provider")) yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN provider TEXT`;
  if (!has("model")) yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN model TEXT`;
  if (!has("market")) yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN market TEXT`;
  if (!has("playbook")) yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN playbook TEXT`;
  if (!has("strategy_version"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN strategy_version INTEGER`;
  if (!has("authority_version"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN authority_version INTEGER`;

  // The observed facts the outcome is derived from.
  if (!has("tools_called_json"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN tools_called_json TEXT`;
  if (!has("tool_error_count"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN tool_error_count INTEGER NOT NULL DEFAULT 0`;
  if (!has("first_tool_error"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN first_tool_error TEXT`;
  if (!has("published_plan"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN published_plan INTEGER NOT NULL DEFAULT 0`;
  if (!has("execute_attempted"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN execute_attempted INTEGER NOT NULL DEFAULT 0`;
  if (!has("first_preview_refusal"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN first_preview_refusal TEXT`;
  if (!has("exchange_outcome"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN exchange_outcome TEXT`;
  if (!has("latency_ms"))
    yield* sql`ALTER TABLE trading_harness_runs ADD COLUMN latency_ms INTEGER`;

  // The funnel report reads runs per mission newest first; the tool-call hook
  // finds a mission's one open run on every trading tool call.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_harness_runs_mission_started
    ON trading_harness_runs (mission_id, started_at DESC)
  `;
});
