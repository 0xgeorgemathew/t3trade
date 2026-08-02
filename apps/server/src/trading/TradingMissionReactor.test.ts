/**
 * The request → domain → projection loop.
 *
 * These tests exercise the ordering the whole design rests on: a `*-requested`
 * event is applied by the reactor through `TradingMissionService`, and only the
 * resulting `trading.mission.status-set` reaches the projection. A control the
 * domain refuses must leave the projection showing the status still in force.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TradingMissionId,
} from "@t3tools/contracts";
import { POC_DEFAULT_INSTRUCTION } from "@t3tools/trading-contracts/strategy";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { HarnessRunRequest } from "./Schemas.ts";
import { TradingMissionProjection } from "./TradingMissionProjection.ts";
import { TradingMissionReactor, TradingMissionReactorLive } from "./TradingMissionReactor.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import {
  HyperliquidReconciler,
  type ReconcileInput,
  type ReconciliationTrigger,
} from "./HyperliquidReconciler.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { TradingLayerLive } from "./runtimeLayer.ts";

const THREAD_ID = ThreadId.make("thread-trading-reactor");
const MISSION_ID = TradingMissionId.make("mission-trading-reactor");

// The reactor now runs the §17.2 write side (preview → submit → reconcile) and
// the §18.2 startup reconcile, so its `make` depends on the execution services
// (guard, execution, reconciler, budget reader, signer). Provide the full
// trading layer rather than just the core mission layer.
const TestLayer = TradingMissionReactorLive.pipe(
  Layer.provideMerge(TradingLayerLive),
  Layer.provideMerge(OrchestrationEngineLive),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-reactor-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const commandId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
  Effect.map(CommandId.make),
);

const NOW = "2026-07-30T00:00:00.000Z";

/**
 * The engine projects each dispatch synchronously, but the reactor is a queue:
 * a request has to drain before the status-set it raises exists at all, and
 * that dispatch can enqueue nothing further, so one drain is enough.
 */
const settle = TradingMissionReactor.pipe(Effect.flatMap((reactor) => reactor.drain));

const createMission = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.create",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    tradingAccountId: "acct-trading-reactor",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    createdAt: NOW,
  });
  yield* settle;
});

const control = (
  type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type,
      commandId: yield* commandId,
      threadId: THREAD_ID,
      missionId: MISSION_ID,
      createdAt: NOW,
    });
    yield* settle;
  });

const projectedMission = TradingMissionProjection.pipe(
  Effect.flatMap((projection) => projection.getByThreadId(THREAD_ID)),
  Effect.orDie,
);

/**
 * Move the test mission straight into the §16.4 blocked state, the way the
 * reactor's own `blockForExhaustion` does after a post-submit budget exhausts.
 * `initializing → blocked` is a legal §11.1 exit, so the service accepts it
 * directly; the reactor only reaches `blocked` through execution, which these
 * control-matrix tests do not drive. The matching `status-set` announcement is
 * dispatched afterwards so the projection reflects the blocked status, exactly
 * as the reactor's execution path does (TradingMissionReactor L438).
 */
const blockMission = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.transition({
    missionId: MISSION_ID,
    to: "blocked",
    expectedVersion: yield* missions.getMissionVersion(MISSION_ID),
    blockedReason: "cumulative_loss_limit",
  });
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.status-set",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    status: "blocked",
    blockedReason: "cumulative_loss_limit",
    createdAt: NOW,
  });
  yield* settle;
});

const PROJECT_ID = ProjectId.make("project-trading-reactor");

/**
 * A mission is bound to a real thread (§10.2), so the thread has to exist
 * before a mission command naming it can be decided.
 */
const started = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM projection_trading_missions`;

  const reactor = yield* TradingMissionReactor;
  yield* reactor.start();

  const engine = yield* OrchestrationEngineService;
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "sonnet",
  };
  yield* engine
    .dispatch({
      type: "project.create",
      commandId: yield* commandId,
      projectId: PROJECT_ID,
      title: "Trading",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      createdAt: NOW,
    })
    .pipe(Effect.ignore);
  yield* engine
    .dispatch({
      type: "thread.create",
      commandId: yield* commandId,
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Mission thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    })
    .pipe(Effect.ignore);
});

/**
 * The auto-mission shortcut (`AutoMissionConfig`): a thread opened in a
 * configured lab workspace gets a mission without anyone visiting Settings.
 *
 * The env is set inside the test rather than around the layer because
 * `AutoMissionConfigLive` reads `process.env` on every resolve, not at build
 * time — and because `started` creates its own thread, which must be drained
 * before the shortcut is armed or it would claim the slot first.
 */
const LAB_ROOT = "/tmp/t3-trading-reactor-lab";
const LAB_PROJECT_ID = ProjectId.make("project-trading-reactor-lab");

const withAutoMissionArmed = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.T3_TRADES_AUTO_MISSION_WORKSPACE;
      process.env.T3_TRADES_AUTO_MISSION_WORKSPACE = LAB_ROOT;
      return previous;
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3_TRADES_AUTO_MISSION_WORKSPACE;
        else process.env.T3_TRADES_AUTO_MISSION_WORKSPACE = previous;
      }),
  );

/** Open a thread in the lab project, creating the project on first use. */
const openLabThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const modelSelection = {
      instanceId: ProviderInstanceId.make("claude"),
      model: "sonnet",
    };
    yield* engine
      .dispatch({
        type: "project.create",
        commandId: yield* commandId,
        projectId: LAB_PROJECT_ID,
        title: "Lab",
        workspaceRoot: LAB_ROOT,
        defaultModelSelection: modelSelection,
        createdAt: NOW,
      })
      .pipe(Effect.ignore);
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: yield* commandId,
        threadId,
        projectId: LAB_PROJECT_ID,
        title: "Lab thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      })
      .pipe(Effect.ignore);
    // Two drains: the first runs the thread.created handler, whose dispatched
    // mission.create enqueues the create-requested event the second drains.
    yield* settle;
    yield* settle;
  });

it.layer(TestLayer)("auto-mission shortcut", (it) => {
  it.effect("gives a thread opened in the lab workspace a mission of its own", () =>
    Effect.gen(function* () {
      yield* started;
      yield* settle;

      const labThread = ThreadId.make("thread-trading-reactor-lab");
      yield* withAutoMissionArmed(openLabThread(labThread));

      const projection = yield* TradingMissionProjection;
      const mission = yield* projection.getByThreadId(labThread).pipe(Effect.orDie);
      assert.ok(Option.isSome(mission), "the lab thread should have been given a mission");
      assert.equal(mission.value.instruction, POC_DEFAULT_INSTRUCTION);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a thread outside the lab workspace alone", () =>
    Effect.gen(function* () {
      yield* started;
      yield* settle;

      // `started`'s thread lives at process.cwd(), not LAB_ROOT.
      yield* withAutoMissionArmed(settle);

      const projected = yield* projectedMission;
      assert.ok(Option.isNone(projected), "a thread outside the lab must not get a mission");
    }).pipe(Effect.scoped),
  );

  // The safety rule. One active mission per user (§10.1) means claiming the slot
  // retires the incumbent — and revoking a mission that still holds exposure
  // would strand a live position behind a mission with no authority to manage
  // it. A position-holding incumbent keeps the slot; the new thread gets nothing.
  it.effect("refuses to take the slot from a mission that still holds a position", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* settle;

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl,
          margin_used, protected_size, observed_at
        ) VALUES (${MISSION_ID}, 'ETH', 0.03, 1882.7, 0, 20, 0.03, 0)
      `;

      const labThread = ThreadId.make("thread-trading-reactor-lab-blocked");
      yield* withAutoMissionArmed(openLabThread(labThread));

      const projection = yield* TradingMissionProjection;
      const claimed = yield* projection.getByThreadId(labThread).pipe(Effect.orDie);
      assert.ok(Option.isNone(claimed), "the lab thread must not get a mission");

      const incumbent = yield* projectedMission;
      assert.ok(Option.isSome(incumbent));
      assert.notEqual(incumbent.value.status, "revoked", "the incumbent must keep its authority");
    }).pipe(Effect.scoped),
  );
});

it.layer(TestLayer)("trading mission reactor", (it) => {
  it.effect("projects a mission only after the domain accepts it", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected), "expected a projected mission row");
      assert.equal(projected.value.id, MISSION_ID);
      assert.equal(projected.value.threadId, THREAD_ID);
      // §11.1 `initializing → analysing`: the create handler starts the first
      // run and then advances, so a mission whose first run started is
      // analysing by the time it is projected.
      assert.equal(projected.value.status, "analysing");
      assert.equal(projected.value.strategyVersion, 0);
      assert.equal(projected.value.strategy, null);
      // The mandate is the POC authority defaults over the allocated capital.
      assert.equal(projected.value.authorityVersion, 1);
      assert.equal(projected.value.authority.allocatedCapitalUsd, 1_000);
      assert.equal(projected.value.authority.maximumGrossNotionalUsd, 3_000);
      // Migration 035 stores epoch millis; the read model is ISO.
      assert.match(projected.value.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    }),
  );

  it.effect("applies a legal control and reflects it in the projection", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      // The create handler already advanced the mission to analysing, which is
      // where pause is legal from.
      yield* control("trading.mission.pause");

      const paused = yield* projectedMission;
      assert.ok(Option.isSome(paused));
      assert.equal(paused.value.status, "paused");

      yield* control("trading.mission.resume");

      const resumed = yield* projectedMission;
      assert.ok(Option.isSome(resumed));
      assert.equal(resumed.value.status, "analysing");
    }),
  );

  it.effect("leaves the projection alone when §11.1 refuses the control", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      // revoked is a permanent terminal (§11.1): no control is legal from it,
      // so the pause below must be refused.
      const missions = yield* TradingMissionService;
      yield* missions.transition({
        missionId: MISSION_ID,
        to: "revoked",
        expectedVersion: yield* missions.getMissionVersion(MISSION_ID),
      });

      yield* control("trading.mission.pause");

      const stillRevoked = yield* missions.getMission(MISSION_ID);
      assert.equal(stillRevoked.status, "revoked", "the domain must refuse the control");
    }),
  );

  // ── §16.4 blocked-mission control matrix ────────────────────────────────────
  //
  // The bug B4 fixed was `guardResume` running before the control's target
  // status was read, which rejected pause and revoke too. The matrix below
  // pins the correct behaviour: while a mission is blocked under
  // `cumulative_loss_limit`, revocation and pause remain available (the user
  // must be able to recover safely), but resume is rejected and leaves the
  // mission blocked. A later case reconciles before resuming a merely-paused
  // mission.

  it.effect("§16.4: permits revocation while a mission is blocked", () =>
    // §16.4 item 4: revocation is explicitly permitted while blocked, so the
    // user can wind the mission down without first clearing the block.
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* blockMission;

      yield* control("trading.mission.revoke");

      const revoked = yield* projectedMission;
      assert.ok(Option.isSome(revoked), "expected a projected mission row");
      assert.equal(revoked.value.status, "revoked");
    }),
  );

  it.effect("§16.4: permits pause while a mission is blocked", () =>
    // Pause is a control, not a resume, so the exhaustion gate does not apply;
    // the blocked mission transitions to paused and the projection reflects it.
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* blockMission;

      yield* control("trading.mission.pause");

      const paused = yield* projectedMission;
      assert.ok(Option.isSome(paused));
      assert.equal(paused.value.status, "paused");
    }),
  );

  it.effect("§16.4: rejects resume while blocked and leaves the mission blocked", () =>
    // The reactor's guardResume must reject a resume dispatched on a blocked
    // mission (TradingExhaustionError / resume_blocked). The rejection is
    // caught and logged by the reactor's runEvent guard (a refused control is
    // a normal outcome, not a crash), so dispatch resolves; the proof that the
    // guard fired is the projection still reading blocked — transition was
    // never reached. This is the regression net for bug B4: had guardResume run
    // before the control type was read, pause/revoke would have been rejected
    // too; here resume alone is refused.
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* blockMission;

      yield* control("trading.mission.resume");

      // The mission must NOT have transitioned back to analysing.
      const stillBlocked = yield* projectedMission;
      assert.ok(Option.isSome(stillBlocked));
      assert.equal(
        stillBlocked.value.status,
        "blocked",
        "resume must not transition a blocked mission",
      );
      assert.equal(
        stillBlocked.value.blockedReason,
        "cumulative_loss_limit",
        "the block reason must survive a refused resume",
      );
    }),
  );
});

/**
 * The wake loop seam: a `trading.mission-watch-fired` domain event must reach
 * `TradingTurnCoordinator.requestRun` with the watch as the triggering cause.
 * Uses a recording stub coordinator so the test observes exactly what the
 * reactor asked for without driving a real provider turn.
 */
it.live("asks the coordinator for a run when a watch fires", () =>
  Effect.gen(function* () {
    const calls: Array<HarnessRunRequest> = [];
    const stubCoordinator = Layer.succeed(TradingTurnCoordinator, {
      requestRun: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { status: "started", harnessRunId: `run_${calls.length}` } as const;
        }),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubCoordinator),
      Layer.provideMerge(TradingLayerLive),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-watchfired-" }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* createMission;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.cause, "mission_created");

      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "trading.mission.watch-fired",
        commandId: yield* commandId,
        threadId: THREAD_ID,
        missionId: MISSION_ID,
        watchId: "watch_1",
        deduplicationKey: "candle_close:watch_1:1000",
        createdAt: NOW,
      });
      yield* settle;

      // The retry loop is forked; poll briefly for the recorded request.
      for (let attempt = 0; attempt < 300 && calls.length < 2; attempt++) {
        yield* Effect.sleep("10 millis");
      }
      assert.equal(calls.length, 2, "the fired watch must request a run");
      assert.equal(calls[1]?.cause, "market_watch_triggered");
      assert.equal(calls[1]?.triggeringWatchId, "watch_1");
      assert.equal(calls[1]?.missionId, MISSION_ID);
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);

/**
 * §16.4 ordering: a resume of a merely-*paused* (not blocked) mission must run
 * the `before_resuming_paused_mission` reconcile BEFORE the transition, so the
 * budget gate and the resumed turn see reconciled truth rather than a stale
 * local cache. The reactor wraps the reconcile in a catch (a reconcile failure
 * is logged, not fatal), so to observe the trigger the mission's trading
 * account must resolve a master address — otherwise the reconcile is never
 * reached and the trigger never fires.
 *
 * A recording stub reconciler captures the trigger; the live layer is otherwise
 * intact so the real reactor ordering (guard → reconcile → transition →
 * announce) is what runs.
 */
it.live("reconciles before resuming a paused mission", () =>
  Effect.gen(function* () {
    const triggers: Array<ReconciliationTrigger> = [];
    const stubReconciler = Layer.succeed(HyperliquidReconciler, {
      reconcile: (input: ReconcileInput, trigger: ReconciliationTrigger) =>
        Effect.sync(() => {
          triggers.push(trigger);
          assert.equal(input.missionId, MISSION_ID);
          return { position: null, openOrders: [], canonicalOrders: [], fills: [], observedAt: 0 };
        }),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubReconciler),
      Layer.provideMerge(TradingLayerLive),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-resumereconcile-" }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* createMission;

      // Seed the trading account so getMasterWalletAddress resolves and the
      // reactor actually reaches reconciler.reconcile. The wallet JSON shape is
      // the published TradingMasterWallet contract (§10.1).
      const sql = yield* SqlClient.SqlClient;
      const masterWalletJson =
        '{"privyWalletId":"wallet-trading-reactor",' +
        '"address":"0x000000000000000000000000000000000000beef",' +
        '"ownership":"user"}';
      yield* sql`
        INSERT INTO trading_accounts (
          account_id, user_id, environment, master_wallet_json,
          execution_wallet_json, status, created_at, updated_at
        ) VALUES (
          'acct-trading-reactor', 'local', 'hyperliquid_testnet', ${masterWalletJson},
          ${masterWalletJson}, 'ready', 0, 0
        )
      `;

      // Creation already put the mission in the active loop; pause is the
      // state resume targets.
      yield* control("trading.mission.pause");

      const paused = yield* projectedMission;
      assert.ok(Option.isSome(paused));
      assert.equal(paused.value.status, "paused");

      yield* control("trading.mission.resume");

      // The reconcile must have fired with the §18.2 trigger, and only then did
      // the mission resume — so the projection now reads analysing.
      assert.isTrue(
        triggers.includes("before_resuming_paused_mission"),
        "resume must reconcile before the transition",
      );
      const resumed = yield* projectedMission;
      assert.ok(Option.isSome(resumed));
      assert.equal(resumed.value.status, "analysing");
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);
