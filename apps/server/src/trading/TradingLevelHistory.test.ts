/**
 * Level memory — plan 27 B1/B2.
 *
 * What is worth pinning: events written at nearly-equal prices group into one
 * level under the ATR tolerance; the wakeup read is bounded and
 * nearest-to-the-mark first; writes are idempotent under replay; and the
 * structure-read echo returns the newest row for the preferred interval.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  LEVEL_HISTORY_WAKEUP_LEVELS,
  readLevelHistory,
  readPreviousStructureRead,
  recordLevelEvent,
  recordStructureRead,
} from "./TradingLevelHistory.ts";

const layer = it.layer(
  Layer.mergeAll(NodeSqliteClient.layerMemory()).pipe(Layer.provideMerge(NodeServices.layer)),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 64 });
  yield* sql`DELETE FROM trading_level_events`;
  yield* sql`DELETE FROM trading_structure_reads`;
});

layer("TradingLevelHistory", (it) => {
  it.effect("groups near-equal levels under the tolerance and counts their events", () =>
    Effect.gen(function* () {
      yield* migrated;
      const base = { missionId: "m1", market: "ETH" } as const;
      yield* recordLevelEvent({
        ...base,
        level: 1_899.7,
        kind: "armed",
        price: 1_899.7,
        occurredAt: 1_000,
      });
      yield* recordLevelEvent({
        ...base,
        level: 1_900.2,
        kind: "wick_rejected",
        price: 1_899.9,
        occurredAt: 2_000,
      });
      yield* recordLevelEvent({
        ...base,
        level: 1_900.0,
        kind: "closed_through",
        price: 1_898.5,
        occurredAt: 3_000,
      });
      // A separate level, well outside the tolerance.
      yield* recordLevelEvent({
        ...base,
        level: 1_950,
        kind: "armed",
        price: 1_950,
        occurredAt: 4_000,
      });

      const history = yield* readLevelHistory({
        missionId: "m1",
        market: "ETH",
        markPrice: 1_901,
        toleranceUsd: 1,
      });

      assert.equal(history.length, 2);
      // Nearest to the mark first: the 1,900 cluster.
      const near = history[0]!;
      assert.closeTo(near.level, 1_900, 0.5);
      assert.equal(near.armed, 1);
      assert.equal(near.wickRejected, 1);
      assert.equal(near.closedThrough, 1);
      assert.equal(near.lastEventKind, "closed_through");
      assert.equal(near.lastEventAt, 3_000);
    }),
  );

  it.effect("records a replayed event once and bounds the wakeup read", () =>
    Effect.gen(function* () {
      yield* migrated;
      const event = {
        missionId: "m1",
        market: "ETH",
        level: 2_000,
        kind: "stopped_out_at",
        price: 2_000,
        occurredAt: 5_000,
      } as const;
      yield* recordLevelEvent(event);
      yield* recordLevelEvent(event);

      for (let index = 0; index < 10; index++) {
        yield* recordLevelEvent({
          missionId: "m1",
          market: "ETH",
          level: 2_100 + index * 50,
          kind: "armed",
          price: 2_100 + index * 50,
          occurredAt: 6_000 + index,
        });
      }

      const history = yield* readLevelHistory({
        missionId: "m1",
        market: "ETH",
        markPrice: 2_000,
        toleranceUsd: 1,
      });

      assert.equal(history.length, LEVEL_HISTORY_WAKEUP_LEVELS);
      assert.equal(history[0]?.stopOuts, 1);
    }),
  );

  it.effect("echoes the newest structure read, preferring the asked-for interval", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* recordStructureRead({
        missionId: "m1",
        market: "ETH",
        interval: "1m",
        classification: "ranging",
        swingHigh: 2_010,
        swingLow: 1_990,
        measuredAt: 1_000,
      });
      yield* recordStructureRead({
        missionId: "m1",
        market: "ETH",
        interval: "15m",
        classification: "transition",
        swingHigh: 2_050,
        swingLow: 1_950,
        measuredAt: 2_000,
      });
      // A newer read on the same interval replaces the row.
      yield* recordStructureRead({
        missionId: "m1",
        market: "ETH",
        interval: "1m",
        classification: "transition",
        swingHigh: 2_005,
        swingLow: 1_985,
        measuredAt: 3_000,
      });

      const preferred = yield* readPreviousStructureRead({
        missionId: "m1",
        market: "ETH",
        preferredInterval: "1m",
      });
      assert.equal(preferred?.interval, "1m");
      assert.equal(preferred?.classification, "transition");
      assert.equal(preferred?.swing_high, 2_005);

      const fallback = yield* readPreviousStructureRead({
        missionId: "m1",
        market: "ETH",
        preferredInterval: "5m",
      });
      // No 5m row exists; the newest row on any interval is older memory
      // worth more than none.
      assert.equal(fallback?.interval, "1m");
    }),
  );

  it.effect("returns nothing for a mission with no recorded history", () =>
    Effect.gen(function* () {
      yield* migrated;
      const history = yield* readLevelHistory({
        missionId: "empty",
        market: "ETH",
        markPrice: 2_000,
        toleranceUsd: 1,
      });
      assert.deepEqual(history, []);
      const echo = yield* readPreviousStructureRead({
        missionId: "empty",
        market: "ETH",
        preferredInterval: "1m",
      });
      assert.equal(echo, null);
    }),
  );
});
