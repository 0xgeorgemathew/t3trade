import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0041 from "./041_TradingInboxSummaryRepair.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

// One database per block: `it.layer` builds its layer once, and a test that
// leaves the schema half-migrated would otherwise be the next test's starting
// point.
const freshDatabase = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const inboxColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('trading_event_inbox')
  `;
  return rows.map((row) => row.name);
});

freshDatabase()("041_TradingInboxSummaryRepair on a pre-037 database", (it) => {
  it.effect("adds the summary column that database never received", () =>
    Effect.gen(function* () {
      // Migrate to 036 and stop: that is the shape of a database created while
      // the file now at 038 still occupied id 37. Recording id 37 makes the
      // runner skip 037_TradingInboxSummary forever.
      yield* runMigrations({ toMigrationInclusive: 36 });
      assert.ok(!(yield* inboxColumns).includes("summary"));

      yield* Migration0041;

      assert.ok((yield* inboxColumns).includes("summary"));
    }),
  );
});

freshDatabase()("041_TradingInboxSummaryRepair on a current database", (it) => {
  it.effect("leaves a database that already ran 037 alone", () =>
    Effect.gen(function* () {
      // ALTER TABLE ADD COLUMN is not idempotent in SQLite, so a fresh database
      // — which runs 037 normally — must not attempt the add a second time.
      yield* runMigrations();
      const before = yield* inboxColumns;

      yield* Migration0041;

      assert.deepEqual(yield* inboxColumns, before);
    }),
  );
});
