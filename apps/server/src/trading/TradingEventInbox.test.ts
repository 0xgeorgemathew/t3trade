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
  yield* runMigrations({ toMigrationInclusive: 63 });
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
        deduplicationKey: "candle_close:watch_1:1000",
        occurredAt: 1_000,
      });

      assert.strictEqual(inserted, true);
      assert.strictEqual(yield* inbox.isPending("mission_1", "candle_close:watch_1:1000"), true);

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      const [event] = claimed;
      assert.equal(event?.deduplicationKey, "candle_close:watch_1:1000");
      assert.equal(event?.category, "market");
      // The summary persisted with the event is what the wakeup reads back.
      assert.equal(event?.summary, "5m candle closed above 3000");
    }),
  );

  it.effect("collapses a duplicate deduplication key and reports it was not inserted", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      const first = yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:watch_1:2000",
        occurredAt: 2_000,
      });
      const replay = yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:watch_1:2000",
        occurredAt: 9_999,
      });

      assert.strictEqual(first, true);
      // A replay with the same dedup key is ignored — no second wake-up.
      assert.strictEqual(replay, false);

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      const [event] = claimed;
      // The original occurrence is kept, not the replay's 9999.
      assert.equal(event?.occurredAt, 2_000);
    }),
  );

  it.effect("keeps distinct deduplication keys and claims oldest first", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:watch_1:100",
        occurredAt: 100,
      });
      yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "price_cross:watch_2",
        occurredAt: 200,
      });
      yield* inbox.persist({
        ...baseEvent,
        deduplicationKey: "candle_close:watch_1:100",
        occurredAt: 300,
      });

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 2);
      const [first, second] = claimed;
      // Oldest first.
      assert.equal(first?.deduplicationKey, "candle_close:watch_1:100");
      assert.equal(second?.deduplicationKey, "price_cross:watch_2");
    }),
  );

  it.effect("moves pending → included_in_run → consumed", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;
      const sql = yield* SqlClient.SqlClient;

      const statusOf = (key: string) =>
        Effect.map(
          sql<{ readonly status: string }>`
            SELECT status FROM trading_event_inbox WHERE deduplication_key = ${key}
          `,
          (rows) => rows[0]?.status,
        );

      yield* inbox.persist({ ...baseEvent, deduplicationKey: "timer:1", occurredAt: 1 });
      assert.strictEqual(yield* inbox.isPending("mission_1", "timer:1"), true);

      // A run starts: pending events are claimed atomically.
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(yield* statusOf("timer:1"), "included_in_run");
      assert.strictEqual(yield* inbox.isPending("mission_1", "timer:1"), false);

      // A new event lands as pending for the next run while the first is in-flight.
      yield* inbox.persist({ ...baseEvent, deduplicationKey: "timer:2", occurredAt: 2 });

      // The run completes: included_in_run → consumed; the new event is untouched.
      yield* inbox.markIncludedConsumed("mission_1");
      assert.equal(yield* statusOf("timer:1"), "consumed");
      assert.equal(yield* statusOf("timer:2"), "pending");
    }),
  );

  it.effect("finds an event by deduplication key whatever status it reached", () =>
    Effect.gen(function* () {
      yield* migrated;
      const inbox = yield* TradingEventInbox;

      assert.equal(yield* inbox.findSummary("mission_1", "execution_refused:0"), null);

      yield* inbox.persist({
        ...baseEvent,
        category: "system",
        deduplicationKey: "execution_refused:0",
        summary: "execution 0 refused: mission_active",
        occurredAt: 5_000,
      });

      // Claimed, not pending — the run reporting the refusal is the same run
      // that claimed it, so `isPending` would already read false by then.
      yield* inbox.claimPending("mission_1");
      assert.strictEqual(yield* inbox.isPending("mission_1", "execution_refused:0"), false);

      const found = yield* inbox.findSummary("mission_1", "execution_refused:0");
      assert.equal(found?.summary, "execution 0 refused: mission_active");
      assert.equal(found?.category, "system");
    }),
  );
});
