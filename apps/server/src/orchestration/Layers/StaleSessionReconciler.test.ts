import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { assert, describe, it } from "vite-plus/test";

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

const makeRuntime = () => {
  const layer = OrchestrationEngineLive.pipe(
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
  return ManagedRuntime.make(layer);
};

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
  it("stops a session left running by the previous process", async () => {
    const runtime = makeRuntime();
    try {
      await runtime.runPromise(seedRunningThread);
      await runtime.runPromise(reconcileStaleSessions);

      const snapshot = await runtime.runPromise(
        Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getSnapshot()),
      );
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);

      assert.equal(thread?.session?.status, "stopped");
      assert.equal(thread?.session?.activeTurnId, null);
      // The turn has to close too: the workspace counts "Working for …" from a
      // turn that has no completedAt.
      const turns = await runtime.runPromise(
        Effect.flatMap(ProjectionTurnRepository, (repository) =>
          repository.listByThreadId({ threadId: THREAD_ID }),
        ),
      );
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.state, "interrupted");
      assert.notEqual(turns[0]?.completedAt ?? null, null);
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves a settled session alone", async () => {
    const runtime = makeRuntime();
    try {
      await runtime.runPromise(seedRunningThread);
      await runtime.runPromise(reconcileStaleSessions);
      const before = await runtime.runPromise(
        Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getSnapshot()),
      );
      await runtime.runPromise(reconcileStaleSessions);
      const after = await runtime.runPromise(
        Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getSnapshot()),
      );

      const updatedAt = (snapshot: typeof before) =>
        snapshot.threads.find((entry) => entry.id === THREAD_ID)?.session?.updatedAt;
      assert.equal(updatedAt(after), updatedAt(before));
    } finally {
      await runtime.dispose();
    }
  });
});
