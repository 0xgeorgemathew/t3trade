import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Plan 29 step 6.2: the quote table goes and the sequence counter stays. The
 * second half is the one worth a test — the counter is not part of the
 * two-step, it is what derives every cloid, and dropping it with the table it
 * happened to sit beside would break the exit path, the stop adjustment, and
 * both lanes of the working-order loop.
 */
layer("065_TradingEntryQuotesRetired", (it) => {
  it.effect("drops the quote table and keeps the execution-sequence counter", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('trading_entry_quotes', 'trading_execution_sequences', 'trading_entry_context')
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        ["trading_entry_context", "trading_execution_sequences"],
      );
    }),
  );
});
