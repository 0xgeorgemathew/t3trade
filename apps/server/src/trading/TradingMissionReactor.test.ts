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
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
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
import { TradingProtectionService } from "./TradingProtectionService.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { FALLBACK_MISSION_CAPITAL_USD } from "./MissionCapital.ts";
import { TradingLayerLive } from "./runtimeLayer.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid";

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
  // The reactor resolves a mission's harness driver kind by provider instance
  // id. No test here configures provider instances, so an empty registry is
  // the honest stand-in: the lookup finds nothing and the binding falls back.
  Layer.provideMerge(makeProviderRegistryLayer()),
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

/**
 * The same create, with no capital stated — the path that resolves the mandate
 * from the account. Absent rather than zero: the two are different requests.
 */
const createMissionWithoutCapital = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.create",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    tradingAccountId: "acct-trading-reactor",
    instruction: "Trade ETH momentum",
    createdAt: NOW,
  });
  yield* settle;
});

/** The master-wallet identity account reads resolve through (§10.6). */
const MASTER_ADDRESS = "0x000000000000000000000000000000000000beef";

/**
 * Provision the account row the mission names, so `getMasterWalletAddress`
 * resolves and the account read is actually reached. The wallet JSON shape is
 * the published `TradingMasterWallet` contract (§10.1).
 */
const seedTradingAccount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const masterWalletJson =
    '{"privyWalletId":"wallet-trading-reactor",' +
    `"address":"${MASTER_ADDRESS}",` +
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
  yield* sql`DELETE FROM trading_fills`;

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
 * The auto-mission shortcut (`AutoMissionConfig`): a new thread gets a mission
 * without anyone visiting Settings.
 *
 * The env is set inside the test rather than around the layer because
 * `AutoMissionConfigLive` reads `process.env` on every resolve, not at build
 * time — and because `started` creates its own thread, which must be drained
 * before the shortcut is armed or it would claim the slot first.
 *
 * The explicit knob rather than an armed signer: these tests are about which
 * threads the shortcut claims, and the test server has no signer to arm.
 * `T3_TRADES_AUTO_MISSION_WORKSPACE` narrows it to the lab project so the
 * suite's own thread (at `process.cwd()`) stays outside it.
 */
const LAB_ROOT = "/tmp/t3-trading-reactor-lab";
const LAB_PROJECT_ID = ProjectId.make("project-trading-reactor-lab");

const AUTO_MISSION_ENV = ["T3_TRADES_AUTO_MISSION", "T3_TRADES_AUTO_MISSION_WORKSPACE"] as const;

const withAutoMissionArmed = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = AUTO_MISSION_ENV.map((name) => [name, process.env[name]] as const);
      process.env.T3_TRADES_AUTO_MISSION = "1";
      process.env.T3_TRADES_AUTO_MISSION_WORKSPACE = LAB_ROOT;
      return previous;
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
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

/**
 * Create the mission without starting its first run.
 *
 * `createMission` goes through the reactor, which starts the first harness run,
 * which queues a turn start — and upstream refuses to settle a thread inside
 * the queued-turn grace window. That refusal is correct (settling would hide
 * just-requested work) and it is not what these tests are about, so the mission
 * is written straight to the domain and announced, the way `blockMission` does.
 */
const createQuietMission = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.createMission({
    missionId: MISSION_ID,
    userId: "local",
    tradingAccountId: "acct-trading-reactor",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    harness: {
      provider: "claude",
      providerInstanceId: "claude",
      threadId: THREAD_ID,
      status: "available",
    },
  });
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.status-set",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    status: "analysing",
    createdAt: NOW,
  });
  yield* settle;
});

/** One reconciled fill: the proof the mission has a realised result to report. */
const recordFill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO trading_fills (
      fill_id, mission_id, execution_id, cloid, order_id, market, side,
      filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at,
      closed_pnl
    ) VALUES (
      'fill-settle', ${MISSION_ID}, 'exec-settle', '0xcloid-settle', 1, 'ETH', 'buy',
      0.5, 3000, 1.5, 'USDC', 1000, 1000, 12.5
    )
  `;
});

/** Settle a thread the way the sidebar's Settle does, then drain the reactor. */
const settleThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.settle",
      commandId: yield* commandId,
      threadId,
    });
    yield* settle;
  });

it.layer(TestLayer)("settling a mission-bound thread", (it) => {
  // Settle is the way out of a mission. A thread the user has finished with
  // must not keep an authority that wakes, trades, and holds the one active
  // slot the next thread needs.
  it.effect("revokes the mission bound to the settled thread", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createQuietMission;

      yield* settleThread(THREAD_ID);

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "revoked");
    }).pipe(Effect.scoped),
  );

  // §11.1 has two permanent terminals and only one of them was reachable, so
  // `completed` sat in the contract, the transition table, and the UI's
  // completion summary while nothing ever set it. A fill is the difference: a
  // mission that traded and came back flat finished, and says so.
  it.effect("completes a flat mission that actually traded", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createQuietMission;
      yield* recordFill;

      yield* settleThread(THREAD_ID);

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "completed");
    }).pipe(Effect.scoped),
  );

  // A blocked mission's authority was withdrawn by a deterministic safety
  // condition. It traded, but it did not finish — reporting that as a completed
  // objective is the more expensive of the two lies.
  it.effect("still revokes a mission that traded and then blocked", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createQuietMission;
      yield* recordFill;
      yield* blockMission;

      yield* settleThread(THREAD_ID);

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "revoked");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a mission alone when some other thread is settled", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createQuietMission;

      const otherThread = ThreadId.make("thread-trading-reactor-unbound");
      const engine = yield* OrchestrationEngineService;
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId,
          threadId: otherThread,
          projectId: PROJECT_ID,
          title: "Unbound thread",
          modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        })
        .pipe(Effect.ignore);
      yield* settle;

      yield* settleThread(otherThread);

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.notEqual(projected.value.status, "revoked");
    }).pipe(Effect.scoped),
  );

  // `findMissionByThreadId` returns only a still-authoritative mission, so the
  // second settle has nothing to act on. Settle is a bulk action in the sidebar
  // and must stay a silent no-op the second time.
  it.effect("is a no-op when the mission is already revoked", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createQuietMission;

      yield* settleThread(THREAD_ID);
      yield* settleThread(THREAD_ID);

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "revoked");
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
      // The mandate is the testnet authority defaults over the allocated capital.
      assert.equal(projected.value.authorityVersion, 1);
      assert.equal(projected.value.authority.allocatedCapitalUsd, 1_000);
      assert.equal(projected.value.authority.maximumGrossNotionalUsd, 8_000);
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
      requestUserMessageRun: () => Effect.succeed(false),
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
      // The reactor resolves a mission's harness driver kind by provider instance
      // id. No test here configures provider instances, so an empty registry is
      // the honest stand-in: the lookup finds nothing and the binding falls back.
      Layer.provideMerge(makeProviderRegistryLayer()),
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
          return {
            position: null,
            openOrders: [],
            canonicalOrders: [],
            fills: [],
            observedAt: 0,
            externalChanges: [],
          };
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
      // The reactor resolves a mission's harness driver kind by provider instance
      // id. No test here configures provider instances, so an empty registry is
      // the honest stand-in: the lookup finds nothing and the binding falls back.
      Layer.provideMerge(makeProviderRegistryLayer()),
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

/**
 * The mandate's size comes from the account, not from a constant.
 *
 * A create request that states no capital is the ordinary case — the form's
 * capital field left empty, or `T3_TRADES_AUTO_MISSION_CAPITAL_USD` unset. The
 * reactor resolves it from the live account value at creation time, and the
 * whole §10.4 envelope scales from what it resolved: a $1,000 account yields a
 * $350 cumulative loss budget rather than the $17.50 a hardcoded $50 produced.
 */
it.live("sizes a mission with no stated capital from the live account value", () =>
  Effect.gen(function* () {
    const stubGateway = Layer.succeed(HyperliquidGateway, {
      resolveMarket: () => Effect.die("not used"),
      getMarketSnapshot: () => Effect.die("not used"),
      getMarketHistory: () => Effect.die("not used"),
      getOrderBook: () => Effect.die("not used"),
      getAccountSnapshot: () =>
        Effect.succeed({
          address: MASTER_ADDRESS,
          accountValue: 1_000,
          marginUsed: 0,
          withdrawable: 1_000,
          positions: [],
          freshness: { observedAt: 0, source: "info_api", staleness: "fresh" },
        } as never),
      getPosition: () => Effect.die("not used"),
      getOpenOrders: () => Effect.die("not used"),
      getTakerFeeRateBps: () => Effect.die("not used"),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubGateway),
      Layer.provideMerge(TradingLayerLive),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      // The reactor resolves a mission's harness driver kind by provider instance
      // id. No test here configures provider instances, so an empty registry is
      // the honest stand-in: the lookup finds nothing and the binding falls back.
      Layer.provideMerge(makeProviderRegistryLayer()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-capital-" })),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createMissionWithoutCapital;

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.authority.allocatedCapitalUsd, 1_000);
      // The §10.4 envelope the resolved capital scales: 8x gross, 35% budget.
      assert.equal(projected.value.authority.maximumGrossNotionalUsd, 8_000);
      assert.equal(projected.value.authority.maximumCumulativeLossUsd, 350);
      assert.equal(projected.value.authority.maximumPlannedRiskPerPositionUsd, 70);
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);

/**
 * An unreadable account is a warning, not a refusal.
 *
 * Here the mission names a trading account that was never provisioned, so the
 * master address — and with it the account read — fails outright. The mission
 * must still be created, on the documented fallback mandate: a dead info
 * endpoint is not a reason to stop a testnet lab from starting, and the
 * operator's cue is the warning plus a mandate visibly smaller than expected.
 */
it.live("still creates the mission when the account cannot be read", () =>
  Effect.gen(function* () {
    yield* started;
    // No trading_accounts row seeded: getMasterWalletAddress fails.
    yield* createMissionWithoutCapital;

    const projected = yield* projectedMission;
    assert.ok(Option.isSome(projected));
    assert.equal(projected.value.authority.allocatedCapitalUsd, FALLBACK_MISSION_CAPITAL_USD);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

/**
 * §17: a stop pulled by hand in the exchange UI leaves the position naked, and
 * nothing outside an execution ever compared the confirmed protected size to
 * the position again. The watchdog is that comparison. It runs on the same 5s
 * pass that settles a flat position, so this test waits for a real tick.
 */
it.live(
  "re-places protection when the reconciled position outgrows its confirmed stop",
  () =>
    Effect.gen(function* () {
      const runs: Array<HarnessRunRequest> = [];
      const stubCoordinator = Layer.succeed(TradingTurnCoordinator, {
        requestRun: (input) =>
          Effect.sync(() => {
            runs.push(input);
            return { status: "started", harnessRunId: `run_${runs.length}` } as const;
          }),
        requestUserMessageRun: () => Effect.succeed(false),
      });

      const protectionCalls: Array<{ readonly stopPrice: number }> = [];
      const stubProtection = Layer.succeed(TradingProtectionService, {
        reconcileProtection: (input: { readonly stopPrice: number }) =>
          Effect.sync(() => {
            protectionCalls.push({ stopPrice: input.stopPrice });
            return {
              status: "protected" as const,
              positionSize: 0.5,
              protectedSize: 0.5,
              replacedCloids: [],
            };
          }),
        replaceProtection: () => Effect.die("not used"),
        cancelEntriesWithProtection: () => Effect.die("not used"),
      } as unknown as TradingProtectionService["Service"]);

      const StubbedLayer = TradingMissionReactorLive.pipe(
        Layer.provide(stubCoordinator),
        Layer.provide(stubProtection),
        Layer.provideMerge(TradingLayerLive),
        Layer.provideMerge(OrchestrationEngineLive),
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provideMerge(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        // The reactor resolves a mission's harness driver kind by provider instance
        // id. No test here configures provider instances, so an empty registry is
        // the honest stand-in: the lookup finds nothing and the binding falls back.
        Layer.provideMerge(makeProviderRegistryLayer()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-protection-" }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        yield* started;
        yield* seedTradingAccount;
        yield* createMission;

        // Walk the mission to `position_open`, the only status the watchdog acts in.
        const missions = yield* TradingMissionService;
        for (const to of ["waiting", "executing", "position_open"] as const) {
          const expectedVersion = yield* missions.getMissionVersion(MISSION_ID);
          yield* missions.transition({ missionId: MISSION_ID, to, expectedVersion });
        }

        // Half an ETH open with nothing confirmed protecting it, and an approved
        // stop price on the record that opened it.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl,
          margin_used, protected_size, observed_at
        ) VALUES (${MISSION_ID}, 'ETH', 0.5, 3000, 0, 100, 0, 1000)
      `;
        yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, strategy_version, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at,
          stop_price
        ) VALUES (
          'exec-protect', ${MISSION_ID}, 1, 1, 'open',
          '0xcloid', 'idem-protect', 'ETH', 'buy', 0.5, 3001, 'ioc',
          0, ${MASTER_ADDRESS}, 'filled', '[]', 1000, 1000, 2900
        )
      `;

        // The watchdog rides the 5s settle pass.
        for (let attempt = 0; attempt < 800 && protectionCalls.length === 0; attempt++) {
          yield* Effect.sleep("10 millis");
        }

        assert.equal(protectionCalls.length > 0, true, "the watchdog must re-place the stop");
        assert.equal(protectionCalls[0]?.stopPrice, 2900);

        // And the harness is told its stop was pulled out from under it.
        const woken = runs.filter((run) => run.cause === "order_updated");
        assert.equal(woken.length > 0, true, "the harness must be woken");

        const events = yield* sql<{ readonly summary: string }>`
        SELECT summary FROM trading_event_inbox
        WHERE mission_id = ${MISSION_ID} AND deduplication_key LIKE 'protection_lost:%'
      `;
        assert.equal(events.length > 0, true, "the loss must be recorded where the harness reads");
      }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
    }),
  { timeout: 30_000 },
);
