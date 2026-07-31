import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";

const layer = it.layer(
  TradingEventInboxLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** Shared in-memory database; each test migrates then truncates the inbox. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 35 });
  yield* sql`DELETE FROM trading_event_inbox`;
});

const baseEvent = {
  missionId: "mission_1",
  category: "market" as const,
  payload: { watchId: "watch_1", close: 3_100 },
  summary: "5m candle closed above 3000",
};

layer("TradingEventInbox", (it) => {
  it.effect("persists a new event and reports it was inserted", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      const inserted = yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:5m:1000",
        occurredAt: 1_000,
      });

      assert.strictEqual(inserted, true);

      const pending = yield* inbox.collectPending("mission_1");
      assert.equal(pending.length, 1);
      const [event] = pending;
      assert.equal(event?.deduplicationKey, "candle_close:5m:1000");
      assert.equal(event?.category, "market");
    }),
  );

  it.effect("collapses a duplicate deduplication key and reports it was not inserted", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      const first = yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:5m:2000",
        occurredAt: 2_000,
      });
      const replay = yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:5m:2000",
        occurredAt: 9_999,
      });

      assert.strictEqual(first, true);
      // A replay with the same dedup key is ignored — no second wake-up.
      assert.strictEqual(replay, false);

      const pending = yield* inbox.collectPending("mission_1");
      assert.equal(pending.length, 1);
      const [event] = pending;
      // The original occurrence is kept, not the replay's 9999.
      assert.equal(event?.occurredAt, 2_000);
    }),
  );

  it.effect("keeps distinct deduplication keys", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:5m:100",
        occurredAt: 100,
      });
      yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "price_cross:ETH:above:3000",
        occurredAt: 200,
      });
      yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:5m:100",
        occurredAt: 300,
      });

      const pending = yield* inbox.collectPending("mission_1");
      assert.equal(pending.length, 2);
      const [first, second] = pending;
      // Oldest first.
      assert.equal(first?.deduplicationKey, "candle_close:5m:100");
      assert.equal(second?.deduplicationKey, "price_cross:ETH:above:3000");
    }),
  );

  it.effect("moves pending → included_in_run → consumed", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      yield* inbox.persist({ ...baseEvent, deduplicationKey: "timer:1", occurredAt: 1 });

      // Before a run starts, the event is pending.
      assert.equal((yield* inbox.collectPending("mission_1")).length, 1);

      // A run starts: pending events become included_in_run and leave the queue.
      yield* inbox.markPendingIncludedInRun("mission_1");
      assert.equal((yield* inbox.collectPending("mission_1")).length, 0);

      // A new event lands as pending for the next run while the first is in-flight.
      yield* inbox.persist({ ...baseEvent, deduplicationKey: "timer:2", occurredAt: 2 });
      assert.equal((yield* inbox.collectPending("mission_1")).length, 1);

      // The run completes: included_in_run → consumed.
      yield* inbox.markIncludedConsumed("mission_1");
      // The new event is still pending, unaffected by the prior run's completion.
      assert.equal((yield* inbox.collectPending("mission_1")).length, 1);
    }),
  );
});
