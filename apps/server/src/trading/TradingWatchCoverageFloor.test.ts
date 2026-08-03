/**
 * The coverage floor at run settlement.
 *
 * A mission may not end a run holding a position with nothing armed that can
 * wake it. The failure this closes was observed live: a long open, one downside
 * `candle_close` armed, a `position_update` that correctly never fired because
 * the size never changed, price 25 points in favour, and a harness that was
 * never woken to take any of it.
 *
 * The turn coordinator is what notices, because run settlement is the only
 * moment that knows a turn has finished deciding. These tests drive a real run
 * to its end — a one-event domain stream is the turn-end signal — and assert
 * what the mission is left holding.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { WATCH_COVERAGE_FLOOR_MILLIS } from "@t3tools/trading-contracts/watch";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";
import { TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinator, TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";
import { TradingWakeupComposer } from "./TradingWakeupComposer.ts";
import { TradingWatchService, TradingWatchServiceLive } from "./TradingWatchService.ts";

const MISSION = "mission_floor";
const THREAD = "thread_floor";

/**
 * The turn-end signal, as a one-element stream. The coordinator's release
 * watcher takes the first `thread.session-set` where the session leaves
 * "running" with no active turn, so a static stream settles the run
 * deterministically instead of on a timer.
 */
const turnEnded = {
  type: "thread.session-set",
  eventId: EventId.make("event_1"),
  sequence: 1,
  occurredAt: new Date(0).toISOString(),
  payload: {
    threadId: ThreadId.make(THREAD),
    session: { status: "idle", activeTurnId: null },
  },
} as unknown as OrchestrationEvent;

const stubEngine = Layer.succeed(OrchestrationEngineService, {
  dispatch: () => Effect.succeed({ sequence: 0 }),
  readEvents: () => Stream.empty,
  streamDomainEvents: Stream.make(turnEnded),
  latestSequence: Effect.succeed(0),
});

/** Unused: the run under test takes the `mission_created` bootstrap branch. */
const stubComposer = Layer.succeed(TradingWakeupComposer, {
  compose: () => Effect.die("the bootstrap branch does not compose a wakeup"),
});

const layer = it.layer(
  TradingTurnCoordinatorLive.pipe(
    Layer.provideMerge(TradingMissionServiceLive),
    Layer.provideMerge(TradingStrategyServiceLive),
    Layer.provideMerge(TradingWatchServiceLive),
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(stubComposer),
    Layer.provideMerge(stubEngine),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: THREAD,
  status: "available",
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_harness_runs`;
  yield* sql`DELETE FROM trading_event_inbox`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM trading_position_snapshots`;

  const missions = yield* TradingMissionService;
  yield* missions.createMission({
    missionId: MISSION,
    userId: "local",
    tradingAccountId: "acct_1",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 100,
    harness,
  });
});

/** Put the mission in the state that matters: holding a position, at a mark. */
const holdPosition = (size: number, markPx: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_position_snapshots
        (mission_id, market, size, entry_price, unrealised_pnl, margin_used,
         protected_size, mark_px, observed_at)
      VALUES (${MISSION}, 'ETH', ${size}, ${markPx}, 0, 50, ${Math.abs(size)}, ${markPx}, 1000)
    `;
  });

/**
 * Run a turn to completion. `mission_created` is the one cause allowed to run
 * without a published strategy, which is what lets these tests exercise
 * settlement without also standing up a wakeup composer.
 */
const runOneTurn = Effect.gen(function* () {
  const coordinator = yield* TradingTurnCoordinator;
  const outcome = yield* coordinator.requestRun({ missionId: MISSION, cause: "mission_created" });
  assert.equal(outcome.status, "started");

  // The settlement path is forked. Yield until the run row goes terminal —
  // `Effect.yieldNow` rather than a sleep, because these tests run on the test
  // clock and a sleep would never come back.
  const sql = yield* SqlClient.SqlClient;
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM trading_harness_runs
      WHERE mission_id = ${MISSION} AND status IN ('completed', 'failed')
    `;
    if ((rows[0]?.count ?? 0) > 0) break;
    yield* Effect.yieldNow;
  }
  // The coverage check runs after the release; give it its own turns.
  for (let attempt = 0; attempt < 500; attempt++) yield* Effect.yieldNow;
});

const activeWatches = Effect.gen(function* () {
  const strategies = yield* TradingStrategyService;
  const all = yield* strategies.listWatches(MISSION);
  return all.filter((w) => w.status === "active");
});

layer("run settlement: the armed-coverage floor", (it) => {
  it.effect("arms a reassessment when a position is left with nothing that can fire", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* holdPosition(0.05, 1_850);
      yield* runOneTurn;

      const watches = yield* activeWatches;
      assert.equal(watches.length, 1);
      const watch = watches[0]!.watch;
      assert.equal(watch.type, "scheduled_reassessment");
      if (watch.type !== "scheduled_reassessment") return;
      // Due inside the floor — the whole point is that it is soon.
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      assert.isAtMost(watch.runAt, now + WATCH_COVERAGE_FLOOR_MILLIS + 1_000);
    }),
  );

  it.effect("does not arm anything when levels are already armed on both sides", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* holdPosition(0.05, 1_850);

      const watches = yield* TradingWatchService;
      yield* watches.registerWatch({
        missionId: MISSION,
        watch: {
          type: "price_cross",
          market: "ETH",
          priceSource: "mark",
          direction: "above",
          price: 1_870,
        },
      });
      yield* watches.registerWatch({
        missionId: MISSION,
        watch: {
          type: "price_cross",
          market: "ETH",
          priceSource: "mark",
          direction: "below",
          price: 1_830,
        },
      });

      yield* runOneTurn;

      const active = yield* activeWatches;
      assert.equal(active.length, 2);
      assert.isFalse(active.some((w) => w.watch.type === "scheduled_reassessment"));
    }),
  );

  it.effect("arms a reassessment when only the downside is covered", () =>
    // The observed session exactly: a downside candle_close and a
    // position_update that can never fire for a mark that only moves.
    Effect.gen(function* () {
      yield* seed;
      yield* holdPosition(0.05, 1_850);

      const watches = yield* TradingWatchService;
      yield* watches.registerWatch({
        missionId: MISSION,
        watch: {
          type: "candle_close",
          market: "ETH",
          interval: "1m",
          direction: "below",
          price: 1_830,
        },
      });
      yield* watches.registerWatch({
        missionId: MISSION,
        watch: { type: "position_update", market: "ETH" },
      });

      yield* runOneTurn;

      const active = yield* activeWatches;
      assert.isTrue(active.some((w) => w.watch.type === "scheduled_reassessment"));
    }),
  );

  it.effect("leaves a flat mission alone", () =>
    // A flat mission's next move is an entry, and timing an entry is the
    // harness's own business. The floor only applies to open exposure.
    Effect.gen(function* () {
      yield* seed;
      yield* runOneTurn;

      const active = yield* activeWatches;
      assert.deepEqual(active, []);
    }),
  );
});
