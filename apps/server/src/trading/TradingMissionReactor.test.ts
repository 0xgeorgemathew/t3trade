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
import { TradingMissionProjection } from "./TradingMissionProjection.ts";
import { TradingMissionReactor, TradingMissionReactorLive } from "./TradingMissionReactor.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingLayerLive } from "./runtimeLayer.ts";

const THREAD_ID = ThreadId.make("thread-trading-reactor");
const MISSION_ID = TradingMissionId.make("mission-trading-reactor");

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

const control = (type: "trading.mission.pause" | "trading.mission.resume") =>
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

it.layer(TestLayer)("trading mission reactor", (it) => {
  it.effect("projects a mission only after the domain accepts it", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected), "expected a projected mission row");
      assert.equal(projected.value.id, MISSION_ID);
      assert.equal(projected.value.threadId, THREAD_ID);
      assert.equal(projected.value.status, "initializing");
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

      // initializing's only loop edge is to analysing, so get there first.
      const missions = yield* TradingMissionService;
      yield* missions.transition({
        missionId: MISSION_ID,
        to: "analysing",
        expectedVersion: yield* missions.getMissionVersion(MISSION_ID),
      });

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
});
