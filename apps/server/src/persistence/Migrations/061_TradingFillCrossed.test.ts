import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0061 from "./061_TradingFillCrossed.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * Migrate the shared in-memory db and empty `trading_fills`, so each test
 * asserts only over the rows it seeded (the same truncate-per-test shape the
 * reconciler suite uses).
 */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 61 });
  yield* sql`DELETE FROM trading_fills`;
});

const seedFill = (fillId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_fills (
        fill_id, mission_id, order_id, market, side, filled_size,
        avg_fill_price, fee_usd, fee_token, traded_at, observed_at
      ) VALUES (
        ${fillId}, 'mission_1', 100, 'ETH', 'buy', 1,
        3000, 0.5, 'USDC', 1753000000000, 1753000000000
      )
    `;
  });

layer("061_TradingFillCrossed", (it) => {
  it.effect("adds a nullable crossed column to trading_fills", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrated;

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(trading_fills)`;
      const crossed = columns.find((column) => column.name === "crossed");
      assert.ok(crossed !== undefined, "trading_fills has no crossed column");
      assert.equal(crossed.notnull, 0, "crossed must be nullable — old rows have no value");
      assert.equal(crossed.dflt_value, null, "crossed must not default either way");
    }),
  );

  it.effect("leaves a fill written without the flag NULL, not maker or taker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrated;
      // Seeded with no crossed value — the shape of every row written before
      // the flag was carried. The column must not read back as 0 or 1.
      yield* seedFill("fill_old");

      const rows = yield* sql<{ readonly crossed: number | null }>`
        SELECT crossed FROM trading_fills WHERE fill_id = 'fill_old'
      `;
      assert.equal(rows[0]?.crossed, null);
    }),
  );

  it.effect("stores 1 and 0 for flagged fills", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrated;
      yield* seedFill("fill_taker");
      yield* seedFill("fill_maker");
      yield* sql`UPDATE trading_fills SET crossed = 1 WHERE fill_id = 'fill_taker'`;
      yield* sql`UPDATE trading_fills SET crossed = 0 WHERE fill_id = 'fill_maker'`;

      const rows = yield* sql<{ readonly fill_id: string; readonly crossed: number | null }>`
        SELECT fill_id, crossed FROM trading_fills ORDER BY fill_id
      `;
      assert.deepEqual(rows, [
        { fill_id: "fill_maker", crossed: 0 },
        { fill_id: "fill_taker", crossed: 1 },
      ]);
    }),
  );

  it.effect("is a no-op when the migration body runs twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrated;
      yield* seedFill("fill_1");

      // Re-running the migration body directly is the round trip that matters:
      // the migrator itself would skip an already-recorded migration.
      yield* Migration0061;

      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_fills)`;
      yield* Migration0061;
      const after = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_fills)`;
      assert.deepEqual(after, before, "second apply changed the schema");

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM trading_fills WHERE fill_id = 'fill_1'
      `;
      assert.equal(rows[0]?.count, 1, "second apply dropped data");
    }),
  );
});
