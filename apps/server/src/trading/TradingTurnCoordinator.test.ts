import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinator, TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";
import { TradingWakeupComposer } from "./TradingWakeupComposer.ts";
import { TradingWatchService, TradingWatchServiceLive } from "./TradingWatchService.ts";

/**
 * A no-op `OrchestrationEngineService` for the coordinator's unit tests. These
 * tests verify the seven pre-run checks and the single-lease invariant, not the
 * wake path (which is forked as a background effect and covered by the keystone
 * integration test). Dispatch succeeds with a stub sequence; the domain-events
 * stream is empty so the release watcher never fires — the tests that need a
 * released lease set the row to `completed` directly.
 */
const dispatchedTexts: Array<string> = [];
const stubEngine = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command: { readonly message?: { readonly text: string } }) =>
    Effect.sync(() => {
      if (command.message !== undefined) dispatchedTexts.push(command.message.text);
      return { sequence: 0 };
    }),
  readEvents: () => Stream.empty,
  streamDomainEvents: Stream.empty,
  latestSequence: Effect.succeed(0),
} as never);

/**
 * The bootstrap wakeup the coordinator dispatches for a mission with no
 * strategy: plain JSON, so a test can read the contract the turn was given.
 */
const awaitBootstrapWake = (cause: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const found = dispatchedTexts
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .find((wake) => wake["bootstrap"] === true && wake["cause"] === cause);
      if (found !== undefined) return found;
      yield* Effect.yieldNow;
    }
    throw new Error(`no bootstrap wake dispatched for cause ${cause}`);
  });

/**
 * A recording wakeup composer. The unit tests do not exercise the wake path
 * itself — the empty text fails the coordinator's round-trip check, which marks
 * the run failed — but what the coordinator asked to be composed is exactly
 * what a user-message run has to get right.
 */
const composed: Array<{ readonly cause: string; readonly userMessage?: string | undefined }> = [];
/** Flipped by the tests that pin what a failed wake must leave behind. */
let composeFails = false;
const stubComposer = Layer.succeed(TradingWakeupComposer, {
  compose: (input) =>
    Effect.suspend(() => {
      composed.push({ cause: input.cause, userMessage: input.userMessage });
      return composeFails
        ? Effect.fail({ _tag: "ComposeWakeupError" as const, reason: "test_forced_failure" })
        : Effect.succeed({ wakeup: {} as never, text: "" });
    }),
});

const layer = it.layer(
  TradingTurnCoordinatorLive.pipe(
    Layer.provideMerge(TradingMissionServiceLive),
    Layer.provideMerge(TradingStrategyServiceLive),
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(TradingWatchServiceLive),
    Layer.provideMerge(stubComposer),
    Layer.provideMerge(stubEngine),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 63 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_harness_runs`;
  yield* sql`DELETE FROM trading_event_inbox`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM trading_plan_history`;
  composeFails = false;
  dispatchedTexts.length = 0;
});

/** Create a mission and leave it without a strategy — the stand-down shape. */
const seedMissionWithoutStrategy = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.createMission({
    missionId: "mission_1",
    userId: "local",
    tradingAccountId: "acct_1",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    harness,
  });
});

/** Create a mission with a published strategy so a run can start against it. */
const seedMission = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.createMission({
    missionId: "mission_1",
    userId: "local",
    tradingAccountId: "acct_1",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    harness,
  });
  const strategies = yield* TradingStrategyService;
  const published = yield* strategies.publishMomentumStrategy({
    missionId: "mission_1",
    expectedMissionVersion: 1,
    strategy: {
      market: "ETH",
      intent: "long",
      entry: { triggers: [], urgency: "now" },
      stop: { method: "fixed" },
      target: { profitUsd: 10 },
      invalidation: [],
      reassess: { afterMinutes: 90 },
      because: "wait for breakout",
    },
  });
  if (published.outcome !== "accepted") throw new Error("seed publish rejected");
});

layer("TradingTurnCoordinator", (it) => {
  it.effect("starts a run when no lease is held", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });

      assert.equal(outcome.status, "started");
    }),
  );

  it.effect("queues a second simultaneous request behind the active run (single lease)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const coordinator = yield* TradingTurnCoordinator;

      // Fire two requests; the partial unique index guarantees at most one
      // non-terminal run, so exactly one starts and the other queues.
      const [first, second] = yield* Effect.all(
        [
          coordinator.requestRun({ missionId: "mission_1", cause: "market_watch_triggered" }),
          coordinator.requestRun({ missionId: "mission_1", cause: "scheduled_reassessment" }),
        ],
        { concurrency: "unbounded" },
      );

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, ["queued_behind_active_run", "started"]);

      // Exactly one non-terminal run row exists in the table.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_harness_runs
        WHERE mission_id = 'mission_1' AND status NOT IN ('completed', 'failed')
      `;
      assert.equal(rows[0]?.c, 1);
    }),
  );

  it.effect("blocks a watch-fired run for a mission with no published strategy", () =>
    // Nothing could have armed the watch without a strategy, so a watch cause
    // arriving here is stale — unlike a schedule or an operator message, which
    // are the mission asking to finish the job of publishing one.
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMissionWithoutStrategy;

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });

      assert.equal(outcome.status, "blocked");
      if (outcome.status === "blocked") {
        assert.equal(outcome.reason, "no_active_strategy");
      }
    }),
  );

  it.effect("allows the mission_created cause without a published strategy", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMissionWithoutStrategy;

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "mission_created",
      });

      assert.equal(outcome.status, "started");

      // The first turn is asked for a plan but not accused of owing one.
      const wake = yield* awaitBootstrapWake("mission_created");
      assert.isUndefined(wake["publishOverdue"]);
      assert.isString(wake["firstTurnContract"]);
    }),
  );

  it.effect("wakes a strategy-less mission on its staleness floor, publish overdue", () =>
    // The stand-down mission. Its first turn declined to enter and published
    // nothing, so the coverage floor armed a reassessment. That wake used to be
    // bounced here as `no_active_strategy`, which left the mission dormant and
    // burned a failed run per floor.
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMissionWithoutStrategy;

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "scheduled_reassessment",
      });

      assert.equal(outcome.status, "started");

      const wake = yield* awaitBootstrapWake("scheduled_reassessment");
      assert.equal(wake["publishOverdue"], true);
      assert.include(String(wake["firstTurnContract"]), "trading_publish_plan");
    }),
  );

  it.effect("carries the operator's text into a strategy-less mission's wake", () =>
    // The bootstrap branch used to drop `userMessage` outright — reachable only
    // now that this cause gets here at all. A message that wakes a turn and
    // then vanishes from it is worse than no wake.
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMissionWithoutStrategy;

      const coordinator = yield* TradingTurnCoordinator;
      const routed = yield* coordinator.requestUserMessageRun({
        threadId: "thread_1",
        text: "why did you not take that trade?",
      });
      assert.isTrue(routed);

      const wake = yield* awaitBootstrapWake("user_message");
      assert.equal(wake["userMessage"], "why did you not take that trade?");
      assert.equal(wake["publishOverdue"], true);
    }),
  );

  it.effect("routes a user message on a bound thread through the wake path", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      composed.length = 0;

      const coordinator = yield* TradingTurnCoordinator;
      const routed = yield* coordinator.requestUserMessageRun({
        threadId: "thread_1",
        text: "take half off here",
      });
      assert.isTrue(routed);

      const sql = yield* SqlClient.SqlClient;
      const runs = yield* sql<{ readonly cause: string }>`
        SELECT cause FROM trading_harness_runs WHERE mission_id = 'mission_1'
      `;
      assert.equal(runs[0]?.cause, "user_message");

      // The wake is forked; give it its turns, then check what it composed.
      // Earlier cases' forked wakes land here too, so look for this one.
      for (let attempt = 0; attempt < 500; attempt++) {
        if (composed.some((entry) => entry.cause === "user_message")) break;
        yield* Effect.yieldNow;
      }
      const userWake = composed.filter((entry) => entry.cause === "user_message");
      assert.deepEqual(userWake, [{ cause: "user_message", userMessage: "take half off here" }]);
    }),
  );

  it.effect("leaves a message on an unbound thread to the ordinary turn path", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const coordinator = yield* TradingTurnCoordinator;
      const routed = yield* coordinator.requestUserMessageRun({
        threadId: "thread_with_no_mission",
        text: "hello",
      });
      assert.isFalse(routed);
    }),
  );

  it.effect("leaves a message on a paused mission to the ordinary turn path", () =>
    // A paused mission is not taking events. The message still has to reach the
    // provider, so the ordinary turn carries it.
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const missions = yield* TradingMissionService;
      const version = yield* missions.getMissionVersion("mission_1");
      yield* missions.transition({
        missionId: "mission_1",
        to: "paused",
        expectedVersion: version,
      });

      const coordinator = yield* TradingTurnCoordinator;
      const routed = yield* coordinator.requestUserMessageRun({
        threadId: "thread_1",
        text: "close it",
      });
      assert.isFalse(routed);
    }),
  );

  it.effect("leaves a message queued behind an active run to the ordinary turn path", () =>
    // Never swallow the operator's message: if the lease is held, the message
    // goes the ordinary way rather than nowhere.
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const coordinator = yield* TradingTurnCoordinator;
      const first = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });
      assert.equal(first.status, "started");

      const routed = yield* coordinator.requestUserMessageRun({
        threadId: "thread_1",
        text: "are you there",
      });
      assert.isFalse(routed);
    }),
  );

  // The observed failure: a watch fired, the wake failed on size, the run was
  // marked failed — and nothing re-armed anything. The mission was permanently
  // deaf while still looking healthy from the outside.
  it.effect("re-arms the mission after a failed wake instead of leaving it deaf", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const sql = yield* SqlClient.SqlClient;
      const watches = yield* TradingWatchService;

      const { watch } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: {
          type: "candle_close",
          market: "ETH",
          interval: "1m",
          direction: "below",
          price: 1_907.6,
        },
      });
      // The evaluator flips a watch `triggered` before it asks for a run: the
      // condition is already spent by the time the wake can fail.
      yield* sql`UPDATE trading_watches SET status = 'triggered' WHERE watch_id = ${watch.id}`;

      composeFails = true;
      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
        triggeringWatchId: watch.id,
      });
      assert.equal(outcome.status, "started");

      const runStatus = sql<{ readonly status: string }>`
        SELECT status FROM trading_harness_runs WHERE mission_id = 'mission_1'
      `.pipe(Effect.map((rows) => rows[0]?.status));
      const activeWatches = sql<{ readonly armed_reason: string | null }>`
        SELECT armed_reason FROM trading_watches
        WHERE mission_id = 'mission_1' AND status = 'active'
      `;

      // The wake is forked; let it run through both repairs.
      for (let attempt = 0; attempt < 500; attempt++) {
        if ((yield* activeWatches).length >= 2) break;
        yield* Effect.yieldNow;
      }

      assert.equal(yield* runStatus, "failed");
      // Releasing the lease also closes the run's decision: a run that ended
      // without publishing anything is the funnel's `no_decision`, not a blank.
      const decision = yield* sql<{
        readonly outcome: string | null;
        readonly stand_down_code: string | null;
        readonly provider: string | null;
      }>`
        SELECT outcome, stand_down_code, provider FROM trading_harness_runs
        WHERE mission_id = 'mission_1'
      `;
      assert.equal(decision[0]?.outcome, "no_decision");
      assert.equal(decision[0]?.stand_down_code, "not_published");
      assert.equal(decision[0]?.provider, "claude");
      const reasons = (yield* activeWatches).map((row) => row.armed_reason).sort();
      // The spent level is armed again, and the floor's reassessment is there
      // as the backstop if the level never comes back.
      assert.deepEqual(reasons, ["staleness_floor", "wake_retry"]);
    }),
  );

  // The other half of the same failure: `ws.ts` only falls through to the plain
  // dispatch when this returns false, so a wake that fails after the fact turns
  // the operator's message into no turn at all.
  it.effect("hands a user message back to the ordinary turn path when the wake fails", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      composeFails = true;

      const coordinator = yield* TradingTurnCoordinator;
      const routed = yield* coordinator.requestUserMessageRun({
        threadId: "thread_1",
        text: "Hi",
      });
      assert.isFalse(routed);

      // And the lease is released, so the fallback turn is not queued behind a
      // run that will never end.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_harness_runs
        WHERE mission_id = 'mission_1' AND status NOT IN ('completed', 'failed')
      `;
      assert.equal(rows[0]?.c, 0);
    }),
  );

  it.effect("allows a second run after the first completes (lease released)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const coordinator = yield* TradingTurnCoordinator;

      const first = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });
      assert.equal(first.status, "started");

      // Mark the first run completed — the lease is released.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE trading_harness_runs SET status = 'completed' WHERE mission_id = 'mission_1'`;

      const second = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "scheduled_reassessment",
      });
      assert.equal(second.status, "started");
    }),
  );
});

/**
 * The turn-end release path: a `thread.session-set` event where the session
 * leaves "running" with no active turn must release the lease (run →
 * `completed`) and close the inbox lifecycle (`included_in_run` → `consumed`,
 * keyed by MISSION id). Runs standalone with a queue-backed engine stream so
 * the test can emit the turn-end event itself.
 */
const turnEndEvent = (threadId: string): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("evt-turn-end"),
  aggregateKind: "thread",
  aggregateId: ThreadId.make(threadId),
  occurredAt: "2026-07-30T00:00:01.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.session-set",
  payload: {
    threadId: ThreadId.make(threadId),
    session: {
      threadId: ThreadId.make(threadId),
      status: "ready",
      providerName: "claude",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-07-30T00:00:01.000Z",
    },
  },
});

/** The first status a resumed session writes: no active turn, turn not begun. */
const sessionStartingEvent = (threadId: string): OrchestrationEvent => ({
  sequence: 1,
  eventId: EventId.make("evt-session-starting"),
  aggregateKind: "thread",
  aggregateId: ThreadId.make(threadId),
  occurredAt: "2026-07-30T00:00:00.500Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.session-set",
  payload: {
    threadId: ThreadId.make(threadId),
    session: {
      threadId: ThreadId.make(threadId),
      status: "starting",
      providerName: "claude",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-07-30T00:00:00.500Z",
    },
  },
});

/** Poll a read until `done`, sleeping between attempts (the watcher is a fiber). */
const awaitCondition = <A, E>(read: Effect.Effect<A, E>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    const last = yield* read;
    return yield* Effect.die(`awaitCondition: condition not reached (last=${String(last)})`);
  });

it.live("releases the lease and consumes claimed inbox events when the turn ends", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<OrchestrationEvent>();
    const queueEngine = Layer.succeed(OrchestrationEngineService, {
      dispatch: () => Effect.succeed({ sequence: 0 }),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromQueue(queue),
      latestSequence: Effect.succeed(0),
    });
    const testLayer = TradingTurnCoordinatorLive.pipe(
      Layer.provideMerge(TradingMissionServiceLive),
      Layer.provideMerge(TradingStrategyServiceLive),
      Layer.provideMerge(TradingEventInboxLive),
      Layer.provideMerge(TradingWatchServiceLive),
      Layer.provideMerge(stubComposer),
      Layer.provideMerge(queueEngine),
      Layer.provideMerge(NodeSqliteClient.layerMemory()),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 63 });
      const missions = yield* TradingMissionService;
      yield* missions.createMission({
        missionId: "mission_1",
        userId: "local",
        tradingAccountId: "acct_1",
        instruction: "Trade ETH momentum",
        allocatedCapitalUsd: 1_000,
        harness,
      });

      // A pending event the run will claim on start.
      const inbox = yield* TradingEventInbox;
      yield* inbox.persist({
        missionId: "mission_1",
        category: "market",
        deduplicationKey: "candle_close:watch_1:1000",
        payload: {},
        occurredAt: 1_000,
        summary: "5m candle closed 3100 (above 3000)",
      });

      // mission_created is the strategy-less bootstrap cause, so the forked
      // wake succeeds against the stub composer and the watcher stays up.
      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "mission_created",
      });
      assert.equal(outcome.status, "started");

      const sql = yield* SqlClient.SqlClient;
      const runStatus = sql<{ readonly status: string }>`
        SELECT status FROM trading_harness_runs WHERE mission_id = 'mission_1'
      `.pipe(Effect.map((rows) => rows[0]?.status));
      const inboxStatus = sql<{ readonly status: string }>`
        SELECT status FROM trading_event_inbox WHERE mission_id = 'mission_1'
      `.pipe(Effect.map((rows) => rows[0]?.status));

      // The run claimed the pending event and holds the lease.
      yield* awaitCondition(inboxStatus, (status) => status === "included_in_run");
      assert.equal(yield* runStatus, "starting");

      // The resumed session announces itself as "starting" — no active turn,
      // but the turn has not happened yet. Releasing here would hand the
      // lease to a second run while this one was still being woken.
      yield* Queue.offer(queue, sessionStartingEvent("thread_1"));
      yield* Effect.sleep("50 millis");
      assert.equal(yield* runStatus, "starting");
      assert.equal(yield* inboxStatus, "included_in_run");

      // The turn ends: the watcher releases the lease and closes the inbox.
      yield* Queue.offer(queue, turnEndEvent("thread_1"));
      yield* awaitCondition(runStatus, (status) => status === "completed");
      yield* awaitCondition(inboxStatus, (status) => status === "consumed");
    }).pipe(Effect.provide(testLayer));
  }),
);
