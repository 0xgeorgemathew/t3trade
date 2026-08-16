/**
 * The previous observation's market sample — plan 29 steps 7.3 and 7.4.
 *
 * What is worth pinning: one row per mission and market, overwritten rather
 * than accumulated; the optional halves survive a round trip as absent rather
 * than as zero; and neither side can fail an observation — a read against a
 * table that is not there returns nothing, and a write against it is a no-op.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { readMarketSample, writeMarketSample } from "./TradingMarketSample.ts";

const layer = it.layer(
  Layer.mergeAll(NodeSqliteClient.layerMemory()).pipe(Layer.provideMerge(NodeServices.layer)),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 68 });
  yield* sql`DELETE FROM trading_market_samples`;
});

const base = { missionId: "m1", market: "ETH" } as const;

layer("TradingMarketSample", (it) => {
  it.effect("round-trips a full sample", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sample = {
        markPrice: 4_000,
        spreadBps: 1.5,
        nearDepthUsd: 82_000,
        openInterest: 12_345,
        observedAt: 1_700_000_000_000,
      };
      yield* writeMarketSample({ ...base, sample });
      assert.deepStrictEqual(yield* readMarketSample(base), sample);
    }),
  );

  it.effect("keeps one row per mission and market, not a series", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* writeMarketSample({
        ...base,
        sample: { markPrice: 4_000, nearDepthUsd: 10, observedAt: 1 },
      });
      yield* writeMarketSample({
        ...base,
        sample: { markPrice: 4_100, nearDepthUsd: 20, observedAt: 2 },
      });

      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_market_samples
      `;
      assert.strictEqual(rows[0]?.n, 1);
      // Every delta this phase reports spans exactly one gap: the newest wins.
      assert.strictEqual((yield* readMarketSample(base))?.markPrice, 4_100);
    }),
  );

  it.effect("keeps two markets apart", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* writeMarketSample({ ...base, sample: { markPrice: 4_000, observedAt: 1 } });
      yield* writeMarketSample({
        missionId: "m1",
        market: "BTC",
        sample: { markPrice: 90_000, observedAt: 1 },
      });
      assert.strictEqual((yield* readMarketSample(base))?.markPrice, 4_000);
      assert.strictEqual(
        (yield* readMarketSample({ missionId: "m1", market: "BTC" }))?.markPrice,
        90_000,
      );
    }),
  );

  it.effect("reports an absent measurement as absent, never as zero", () =>
    Effect.gen(function* () {
      yield* migrated;
      // A book that could not be read leaves no spread and no depth behind. A
      // zero would read as "the book emptied", which is a different fact.
      yield* writeMarketSample({
        ...base,
        sample: { markPrice: 4_000, observedAt: 1 },
      });
      const read = yield* readMarketSample(base);
      assert.isUndefined(read?.spreadBps);
      assert.isUndefined(read?.nearDepthUsd);
      assert.isUndefined(read?.openInterest);
    }),
  );

  it.effect("costs the deltas and nothing else when the table is not there", () =>
    // An un-migrated database of its own: both sides must be survivable,
    // because an observation that failed over bookkeeping is a mission that
    // went deaf while still holding exposure.
    Effect.gen(function* () {
      yield* writeMarketSample({ ...base, sample: { markPrice: 4_000, observedAt: 1 } });
      assert.isNull(yield* readMarketSample(base));
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory().pipe(Layer.provide(NodeServices.layer)))),
  );

  it.effect("reports nothing for a mission that has never observed", () =>
    Effect.gen(function* () {
      yield* migrated;
      assert.isNull(yield* readMarketSample({ missionId: "never", market: "ETH" }));
    }),
  );
});
