import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Plan 29 step 4.2's schema: the version machinery is gone (watches bind the
 * mission; the mission points at no plan; the journal is renamed), and the
 * rows it already had survive the rename.
 */
layer("063_TradingPlanRevise", (it) => {
  it.effect("drops the version columns and renames the journal, keeping its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Seed pre-063 shape through 062 only.
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          strategy_family, harness_json, status, blocked_reason, control_json,
          authority_version, strategy_version, version, last_harness_run_id,
          created_at, updated_at
        ) VALUES (
          'm1', 'u1', 'a1', 'Trade ETH', 'ETH', 'momentum', '{}',
          'analysing', NULL, '{}', 1, 2, 3, NULL, 1, 1
        )
      `;
      yield* sql`
        INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
        VALUES ('m1', 1, '{}', 1), ('m1', 2, '{}', 2)
      `;
      yield* sql`
        INSERT INTO trading_watches (
          watch_id, mission_id, strategy_version, watch_json, status, version,
          created_at, updated_at
        ) VALUES (
          'w1', 'm1', 2, '{"type":"position_update","market":"ETH"}', 'active', 1, 1, 1
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 63 });

      // PRAGMA does not take bind parameters; the table names are fixed here.
      const columnNames = (rows: ReadonlyArray<{ readonly name: string }>) =>
        rows.map((row) => row.name);
      const watchColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(trading_watches)`;
      const columns = columnNames(watchColumns);

      // Watches bind the mission, not a plan revision.
      assert.equal(columns.includes("strategy_version"), false);
      const watchRows = yield* sql<{ readonly status: string }>`
        SELECT status FROM trading_watches WHERE watch_id = 'w1'
      `;
      assert.equal(watchRows[0]?.status, "active");

      // The mission points at no plan and names no family.
      const missionColumns = columnNames(
        yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_missions)`,
      );
      assert.equal(missionColumns.includes("strategy_version"), false);
      assert.equal(missionColumns.includes("strategy_family"), false);

      // The journal keeps its rows and PK under the new name.
      const history = yield* sql<{ readonly version: number }>`
        SELECT version FROM trading_plan_history WHERE mission_id = 'm1' ORDER BY version
      `;
      assert.deepEqual(
        history.map((row) => row.version),
        [1, 2],
      );
      const missing = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'momentum_strategy_versions'
      `;
      assert.equal(missing.length, 0);

      // Execution identity no longer encodes a plan revision.
      const execColumns = columnNames(
        yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_execution_records)`,
      );
      const quoteColumns = columnNames(
        yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_entry_quotes)`,
      );
      assert.equal(execColumns.includes("strategy_version"), false);
      assert.equal(quoteColumns.includes("strategy_version"), false);
    }),
  );
});
