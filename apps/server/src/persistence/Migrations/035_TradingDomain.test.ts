import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0035 from "./035_TradingDomain.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const TRADING_TABLES = [
  "trading_accounts",
  "trading_missions",
  "trading_authority_versions",
  "momentum_strategy_versions",
  "trading_watches",
  "trading_harness_runs",
  "trading_event_inbox",
] as const;

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%trading%'
    UNION
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%momentum%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

const schemaFingerprint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly type: string; readonly name: string; readonly sql: string }>`
    SELECT type, name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE name LIKE '%trading%' OR name LIKE '%momentum%'
    ORDER BY type, name
  `;
  return rows.map((row) => `${row.type}:${row.name}:${row.sql}`);
});

layer("035_TradingDomain", (it) => {
  it.effect("creates every Phase 1 trading table on a fresh database", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 35 });

      const names = yield* tableNames;
      for (const table of TRADING_TABLES) {
        assert.ok(names.includes(table), `missing table ${table}`);
      }
    }),
  );

  it.effect("puts optimistic-version columns on missions, watches, authority, and strategy", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      const columnsOf = (table: string) =>
        sql<{ readonly name: string; readonly notnull: number }>`
          SELECT name, "notnull" FROM pragma_table_info(${table})
        `;

      for (const table of [
        "trading_missions",
        "trading_watches",
        "trading_authority_versions",
        "momentum_strategy_versions",
      ]) {
        const columns = yield* columnsOf(table);
        const version = columns.find((column) => column.name === "version");
        assert.ok(version !== undefined, `${table} has no version column`);
        assert.equal(version.notnull, 1, `${table}.version must be NOT NULL`);
      }
    }),
  );

  it.effect("enforces one active mission per user", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      const insert = (missionId: string, status: string) => sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          strategy_family, harness_json, status, control_json,
          authority_version, strategy_version, version, created_at, updated_at
        ) VALUES (
          ${missionId}, 'user_1', 'acct_1', 'Trade ETH momentum', 'ETH',
          'momentum', '{}', ${status}, '{}', 1, 0, 1, 1753000000000, 1753000000000
        )
      `;

      yield* insert("mission_1", "waiting");

      const second = yield* Effect.result(insert("mission_2", "analysing"));
      assert.equal(second._tag, "Failure", "a second active mission must be rejected");

      // A terminal mission frees the slot.
      yield* sql`UPDATE trading_missions SET status = 'completed' WHERE mission_id = 'mission_1'`;
      yield* insert("mission_3", "analysing");

      const active = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM trading_missions
        WHERE status NOT IN ('revoked', 'completed')
      `;
      assert.equal(active[0]?.count, 1);
    }),
  );

  it.effect("enforces a single harness-run decision lease per mission", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      const insert = (runId: string, status: string) => sql`
        INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, created_at)
        VALUES (${runId}, 'mission_1', 'mission_created', ${status}, 1753000000000)
      `;

      yield* insert("run_1", "running");
      const second = yield* Effect.result(insert("run_2", "queued"));
      assert.equal(second._tag, "Failure", "a second live run must be rejected");

      yield* sql`UPDATE trading_harness_runs SET status = 'completed' WHERE run_id = 'run_1'`;
      yield* insert("run_3", "queued");
    }),
  );

  it.effect("deduplicates inbox events by mission and deduplication key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      const insert = (eventId: string) => sql`
        INSERT INTO trading_event_inbox (
          event_id, mission_id, category, deduplication_key, payload_json,
          status, occurred_at, created_at
        ) VALUES (
          ${eventId}, 'mission_1', 'market', 'candle_close:5m:1753000000000', '{}',
          'pending', 1753000000000, 1753000000000
        )
      `;

      yield* insert("event_1");
      const duplicate = yield* Effect.result(insert("event_2"));
      assert.equal(duplicate._tag, "Failure", "a replayed event must be rejected");
    }),
  );

  it.effect("is a no-op when applied twice and preserves existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      const before = yield* schemaFingerprint;

      yield* sql`
        INSERT INTO trading_accounts (
          account_id, user_id, environment, master_wallet_json,
          execution_wallet_json, status, created_at, updated_at
        ) VALUES (
          'acct_1', 'user_1', 'hyperliquid_testnet', '{}', '{}', 'ready',
          1753000000000, 1753000000000
        )
      `;

      // Re-running the migration body directly is the round trip that matters:
      // the migrator itself would skip an already-recorded migration.
      yield* Migration0035;

      const after = yield* schemaFingerprint;
      assert.deepStrictEqual(after, before, "second apply changed the schema");

      const accounts = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM trading_accounts
      `;
      assert.equal(accounts[0]?.count, 1, "second apply dropped data");
    }),
  );

  it.effect("records migration 035 exactly once when the migrator runs twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations WHERE migration_id = 35
      `;
      assert.equal(rows[0]?.count, 1);
    }),
  );
});
