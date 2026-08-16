/**
 * The coverage floor at run settlement.
 *
 * A mission may not end a run holding a position with nothing armed that can
 * wake it. The failure this closes was observed live: a long open, one downside
 * `candle_close` armed, a `position_update` that correctly never fired because
 * the size never changed, price 25 points in favour, and a harness that was
 * never woken to take any of it.
 *
 * The same floor applies to a flat mission that has published a thesis: a
 * strategy whose triggers never come near the market would otherwise leave the
 * mission silent forever, which reads exactly like a mission that is working.
 *
 * The turn coordinator is what notices, because run settlement is the only
 * moment that knows a turn has finished deciding. These tests drive a real run
 * to its end — the test offers the turn-end event itself — and assert what the
 * mission is left holding.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  watchCoverageFloorMillis,
  watchSanityBackstopMillis,
} from "@t3tools/trading-contracts/watch";

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
 * The turn-end signal. The coordinator's release watcher takes the first
 * `thread.session-set` where the session leaves "running" with no active turn.
 */
const turnEnded = {
  type: "thread.session-set",
  eventId: EventId.make("event_1"),
  sequence: 1,
  occurredAt: "1970-01-01T00:00:00.000Z",
  payload: {
    threadId: ThreadId.make(THREAD),
    session: { status: "idle", activeTurnId: null },
  },
} as unknown as OrchestrationEvent;

/**
 * The turn-end event is offered by the test rather than replayed from a static
 * stream, so a case can set the mission up — publish a strategy, arm a watch —
 * between the run starting and the run settling. Settlement is the moment the
 * floor is applied, and the floor reads whatever is true then.
 */
let turnEndQueue: Queue.Queue<OrchestrationEvent> | null = null;

/**
 * How many turns the coordinator has dispatched. The wake path is forked, so
 * this is what a test waits on before changing the mission underneath it.
 */
let dispatchCount = 0;

const stubEngine = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<OrchestrationEvent>();
    turnEndQueue = queue;
    return {
      dispatch: () =>
        Effect.sync(() => {
          dispatchCount += 1;
          return { sequence: 0 };
        }),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromQueue(queue),
      latestSequence: Effect.succeed(0),
    };
  }),
);

/** Never called: every run under test takes the `mission_created` bootstrap branch. */
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
  yield* sql`DELETE FROM trading_plan_history`;

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
 * Start a turn. `mission_created` is the one cause allowed to run without a
 * published strategy, which is what lets these tests exercise settlement
 * without also standing up a wakeup composer.
 */
const startTurn = Effect.gen(function* () {
  const before = dispatchCount;
  const coordinator = yield* TradingTurnCoordinator;
  const outcome = yield* coordinator.requestRun({ missionId: MISSION, cause: "mission_created" });
  assert.equal(outcome.status, "started");

  // The wake is forked and reads the mission as it is when it runs. Wait for
  // its dispatch, so a case that publishes a strategy next does not change the
  // wakeup's shape out from under it.
  for (let attempt = 0; attempt < 500 && dispatchCount === before; attempt++) {
    yield* Effect.yieldNow;
  }
  assert.isAbove(dispatchCount, before);
});

/** End the turn and wait for the forked settlement — the floor runs there. */
const endTurn = Effect.gen(function* () {
  yield* Queue.offer(turnEndQueue!, turnEnded);

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

const runOneTurn = Effect.gen(function* () {
  yield* startTurn;
  yield* endTurn;
});

/** Publish a strategy, so the mission has a live thesis to come back to. */
const publishStrategy = Effect.gen(function* () {
  const strategies = yield* TradingStrategyService;
  const published = yield* strategies.publishMomentumStrategy({
    missionId: MISSION,
    expectedMissionVersion: 1,
    strategy: {
      market: "ETH",
      intent: "long",
      entry: { triggers: [], urgency: "now" },
      stop: { method: "fixed" },
      target: { profitUsd: 10 },
      invalidation: [],
      reassess: { afterMinutes: 90 },
      because: "wait for the level",
    },
  });
  assert.equal(published.outcome, "accepted");
});

/**
 * Publish a plan whose reassess window is about to lapse, so the floor it arms
 * is the plan's own expiry rather than the coverage cadence (plan 29 step
 * 4.6). `afterMinutes` is fractional on purpose: 0.05 min = 3 s.
 */
const publishShortWindowStrategy = Effect.gen(function* () {
  const strategies = yield* TradingStrategyService;
  const missions = yield* TradingMissionService;
  const published = yield* strategies.publishMomentumStrategy({
    missionId: MISSION,
    expectedMissionVersion: yield* missions.getMissionVersion(MISSION),
    strategy: {
      market: "ETH",
      intent: "long",
      entry: { triggers: [], urgency: "now" },
      stop: { method: "fixed" },
      target: { profitUsd: 10 },
      invalidation: [],
      reassess: { afterMinutes: 0.05 },
      because: "this plan expires almost immediately",
    },
  });
  assert.equal(published.outcome, "accepted");
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
      // Due inside the scaled floor — the whole point is that it is soon. No
      // strategy is published here, so the primary timeframe is the 1m default
      // and holding a position scales the floor to 3 bars (3 minutes).
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const holdingFloor1m = watchCoverageFloorMillis({
        timeframe: "1m",
        holdingPosition: true,
      });
      assert.isAtMost(watch.runAt, now + holdingFloor1m + 1_000);
    }),
  );

  it.effect("arms only the slow sanity backstop when both sides are already covered", () =>
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

      // Both price levels survive, plus one reassessment — but far out: a
      // covered position gets a thesis-drift check, not a 3-bar metronome.
      const active = yield* activeWatches;
      assert.equal(active.length, 3);
      const reassessment = active.find((w) => w.watch.type === "scheduled_reassessment");
      assert.isDefined(reassessment);
      if (reassessment?.watch.type !== "scheduled_reassessment") return;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const tight = watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: true });
      assert.isAbove(reassessment.watch.runAt, now + tight);
      assert.isAtMost(reassessment.watch.runAt, now + watchSanityBackstopMillis("1m") + 1_000);
    }),
  );

  it.effect("treats a PnL target over a confirmed stop as covered on both sides", () =>
    // The observed mission's shape: a short with a target `pnl_above` armed and
    // a reduce-only stop resting. Both directions are heard, so the only thing
    // the floor should add is the slow thesis-drift check.
    Effect.gen(function* () {
      yield* seed;
      yield* holdPosition(-0.05, 1_850);

      const watches = yield* TradingWatchService;
      yield* watches.registerWatch({
        missionId: MISSION,
        watch: { type: "pnl_above", market: "ETH", valueUsd: 5 },
      });

      yield* runOneTurn;

      const active = yield* activeWatches;
      const reassessments = active.filter((w) => w.watch.type === "scheduled_reassessment");
      assert.equal(reassessments.length, 1);
      const scheduled = reassessments[0]!.watch;
      if (scheduled.type !== "scheduled_reassessment") return;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      assert.isAbove(
        scheduled.runAt,
        now + watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: true }),
      );
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

  it.effect("arms a reassessment for a flat mission that published nothing", () =>
    // The stand-down case. A turn that read the market and declined to enter
    // has reached a conclusion, and this used to be treated as "nothing to come
    // back to": no watch, no schedule, dormant until the operator typed. The
    // floor runs on the default timeframe, because no strategy named one.
    Effect.gen(function* () {
      yield* seed;
      yield* runOneTurn;

      const active = yield* activeWatches;
      assert.equal(active.length, 1);
      const watch = active[0]!.watch;
      assert.equal(watch.type, "scheduled_reassessment");
      assert.equal(active[0]!.armedReason, "staleness_floor");
      if (watch.type !== "scheduled_reassessment") return;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const flatFloor = watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: false });
      assert.isAtMost(watch.runAt, now + flatFloor + 1_000);
    }),
  );

  // Plan 29 step 4.6: a plan's own `reassess.afterMinutes` caps the floor. A
  // plan that expires in seconds must get its reassessment within seconds,
  // not at the flat floor's ten-minute cadence.
  it.effect("arms no later than the plan's own expiry", () =>
    Effect.gen(function* () {
      yield* seed;
      // Publish inside the turn, so the plan's clock starts when the turn is
      // living it and the floor that arms at settlement measures from there.
      yield* startTurn;
      yield* publishShortWindowStrategy;
      yield* endTurn;

      const active = yield* activeWatches;
      const watch = active.find((w) => w.watch.type === "scheduled_reassessment");
      assert.ok(watch !== undefined, "expected a scheduled reassessment");
      if (watch?.watch.type !== "scheduled_reassessment") return;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      // The plan's 3 s window has likely already lapsed by the time the floor
      // arms; either way the wake is due within the window plus slack, far
      // inside the 10-minute flat floor.
      const flatFloor = watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: false });
      assert.isAtMost(watch.watch.runAt, now + 3_000 + 2_000);
      assert.isBelow(watch.watch.runAt - now, flatFloor);
    }),
  );

  it.effect("arms the profit-target pnl_above watch once while holding a position", () =>
    // The strategy names the win worth banking; the runtime arms a `pnl_above`
    // watch at it while the mission holds a position. This runs in addition to
    // the coverage floor, so a position left with no levels still gets both the
    // target watch and a staleness reassessment.
    Effect.gen(function* () {
      yield* seed;
      yield* holdPosition(0.05, 1_850);
      yield* startTurn;
      yield* publishStrategy;
      yield* endTurn;

      const active = yield* activeWatches;
      const target = active.find((w) => w.watch.type === "pnl_above");
      assert.isOk(target);
      if (target?.watch.type !== "pnl_above") return;
      assert.equal(target.watch.valueUsd, 10);
      assert.equal(target.armedReason, "profit_target");
      // Exactly one pnl_above watch is armed, never a duplicate.
      assert.equal(active.filter((w) => w.watch.type === "pnl_above").length, 1);
    }),
  );

  it.effect("does not arm the profit-target watch while flat", () =>
    // A flat position never fires pnl_above and the runtime does not arm it
    // before there is exposure to bank a profit on.
    Effect.gen(function* () {
      yield* seed;
      yield* startTurn;
      yield* publishStrategy;
      yield* endTurn;

      const active = yield* activeWatches;
      assert.isFalse(active.some((w) => w.watch.type === "pnl_above"));
    }),
  );

  it.effect("arms a reassessment for a flat mission holding a live thesis", () =>
    // The silent-mission case: a published thesis whose triggers never come
    // near the market. Nothing crosses, nothing fires, and without the floor
    // the mission never speaks again.
    Effect.gen(function* () {
      yield* seed;
      yield* startTurn;
      yield* publishStrategy;
      yield* endTurn;

      const active = yield* activeWatches;
      assert.equal(active.length, 1);
      assert.equal(active[0]!.watch.type, "scheduled_reassessment");
      // Tagged, so the wake it produces can say why it happened.
      assert.equal(active[0]!.armedReason, "staleness_floor");
    }),
  );

  it.effect("does not stack a second reassessment when one is already due", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* startTurn;
      yield* publishStrategy;

      const watches = yield* TradingWatchService;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* watches.registerWatch({
        missionId: MISSION,
        watch: { type: "scheduled_reassessment", runAt: now + 60_000 },
      });

      yield* endTurn;

      const active = yield* activeWatches;
      assert.equal(active.length, 1);
      assert.equal(active[0]!.armedReason, undefined);
    }),
  );

  it.effect("leaves a paused mission alone", () =>
    // A paused mission has been told to stop reassessing. Waking it would ask
    // the harness to do the one thing the user just took away.
    Effect.gen(function* () {
      yield* seed;
      yield* startTurn;
      yield* publishStrategy;

      const missions = yield* TradingMissionService;
      const version = yield* missions.getMissionVersion(MISSION);
      yield* missions.transition({ missionId: MISSION, to: "paused", expectedVersion: version });

      yield* endTurn;

      const active = yield* activeWatches;
      assert.deepEqual(active, []);
    }),
  );
});
