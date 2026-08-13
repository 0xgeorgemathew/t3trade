import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ServerConfig } from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { reconcileStaleSessions } from "./StaleSessionReconciler.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";

const THREAD_ID = ThreadId.make("thread-stale");
const TURN_ID = TurnId.make("turn-stale");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

/** Provided per test, not shared: both tests seed the same thread id, so each
    needs its own in-memory database. */
const testLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

/** A thread mid-turn: session running, turn open, nothing completed. */
const seedRunningThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: ProjectId.make("project-stale"),
    title: "Stale",
    workspaceRoot: process.cwd(),
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
    },
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread"),
    threadId: THREAD_ID,
    projectId: ProjectId.make("project-stale"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("cmd-session-running"),
    threadId: THREAD_ID,
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      runtimeMode: "full-access",
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: CREATED_AT,
    },
    createdAt: CREATED_AT,
  });
});

describe("reconcileStaleSessions", () => {
  it.effect("stops a session left running by the previous process", () =>
    Effect.gen(function* () {
      yield* seedRunningThread;
      yield* reconcileStaleSessions;

      const query = yield* ProjectionSnapshotQuery;
      const snapshot = yield* query.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);

      assert.equal(thread?.session?.status, "stopped");
      assert.equal(thread?.session?.activeTurnId, null);
      // The turn has to close too: the workspace counts "Working for …" from a
      // turn that has no completedAt.
      const repository = yield* ProjectionTurnRepository;
      const turns = yield* repository.listByThreadId({ threadId: THREAD_ID });
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.state, "interrupted");
      assert.notEqual(turns[0]?.completedAt ?? null, null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves a settled session alone", () =>
    Effect.gen(function* () {
      yield* seedRunningThread;
      yield* reconcileStaleSessions;

      const query = yield* ProjectionSnapshotQuery;
      const before = yield* query.getSnapshot();
      yield* reconcileStaleSessions;
      const after = yield* query.getSnapshot();

      const updatedAt = (snapshot: typeof before) =>
        snapshot.threads.find((entry) => entry.id === THREAD_ID)?.session?.updatedAt;
      assert.equal(updatedAt(after), updatedAt(before));
    }).pipe(Effect.provide(testLayer)),
  );
});
