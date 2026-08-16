import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Plan 29 step 8.4's schema: a note now says who wrote it.
 *
 * The claim worth testing is the backfill, not the DDL. Every note written
 * before this column existed is the model's — nothing but `trading_journal`
 * has ever written the table and its only caller is the tool — so the rows
 * that predate the column have to come out as `model`, not as null and not as
 * a value a reader has to guess at.
 */
layer("067_TradingJournalAuthor", (it) => {
  it.effect("reads every note written before the column as the model's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });

      yield* sql`
        INSERT INTO trading_journal (id, mission_id, note, created_at)
        VALUES ('n1', 'm1', '3200 chopped me twice', 100)
      `;

      yield* runMigrations({ toMigrationInclusive: 67 });

      const rows = yield* sql<{ readonly id: string; readonly author: string }>`
        SELECT id, author FROM trading_journal ORDER BY created_at
      `;
      assert.deepStrictEqual([...rows], [{ id: "n1", author: "model" }]);
    }),
  );

  it.effect("takes an explicit author on a new note and leaves the default alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });

      yield* sql`
        INSERT INTO trading_journal (id, mission_id, note, created_at, author)
        VALUES ('n3', 'm2', 'dragged the stop up under the swing', 100, 'user')
      `;
      // The column has a default, so a writer that does not name an author
      // still gets the historical one rather than a null.
      yield* sql`
        INSERT INTO trading_journal (id, mission_id, note, created_at)
        VALUES ('n4', 'm2', 'holding through the retest', 200)
      `;

      // Scoped to its own mission: the suite shares one in-memory database, so
      // the row the backfill test wrote is still here.
      const rows = yield* sql<{ readonly id: string; readonly author: string }>`
        SELECT id, author FROM trading_journal WHERE mission_id = 'm2' ORDER BY created_at
      `;
      assert.deepStrictEqual(
        [...rows],
        [
          { id: "n3", author: "user" },
          { id: "n4", author: "model" },
        ],
      );
    }),
  );
});
