import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreV2,
  type ProjectionStoreV2Error,
} from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layer as providerTurnStartLayer,
  ProviderTurnStartServiceV2,
} from "./ProviderTurnStartService.ts";
import { RunExecutionServiceV2 } from "./RunExecutionService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread:provider-turn-start");
const childThreadId = ThreadId.make("thread:provider-turn-start:child");
const runId = RunId.make("run:provider-turn-start");
const rootNodeId = NodeId.make("node:provider-turn-start:root");
const subagentId = NodeId.make("node:provider-turn-start:subagent");
const attemptId = RunAttemptId.make("attempt:provider-turn-start");
const providerThreadId = ProviderThreadId.make("provider-thread:provider-turn-start");
const childProviderThreadId = ProviderThreadId.make("provider-thread:provider-turn-start:child");
const providerSessionId = ProviderSessionId.make("provider-session:provider-turn-start");
const providerInstanceId = ProviderInstanceId.make("codex");
const messageId = MessageId.make("message:provider-turn-start");
const checkpointScopeId = CheckpointScopeId.make("checkpoint-scope:provider-turn-start");

function makeRootProjection(now: DateTime.Utc): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: threadId,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: "/tmp/provider-turn-start",
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        userMessageId: messageId,
        modelSelection: { instanceId: providerInstanceId },
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        checkpointScopeId,
      },
    ],
    attempts: [
      {
        id: attemptId,
        providerTurnId: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        nativeThreadRef: {
          driver,
          nativeId: "native-root-thread",
          strength: "strong",
        },
        ownerNodeId: rootNodeId,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
      },
    ],
    messages: [
      {
        id: messageId,
        text: "continue the agent",
        attachments: [],
        createdBy: "user",
        creationSource: "user",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    providerSessions: [],
    subagents: [
      {
        id: subagentId,
        status: "idle",
        childThreadId,
        providerThreadId: childProviderThreadId,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("turn-item:provider-turn-start:subagent"),
        type: "subagent",
        subagentId,
        ordinal: 1,
      },
    ],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function makeChildProjection(now: DateTime.Utc): OrchestrationV2ThreadProjection {
  return {
    thread: { id: childThreadId },
    providerThreads: [
      {
        id: childProviderThreadId,
        nativeThreadRef: {
          driver,
          nativeId: "native-child-thread",
          strength: "strong",
        },
        createdAt: now,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

function makeTestLayer(input: {
  readonly rootProjection: OrchestrationV2ThreadProjection;
  readonly childProjection: Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly existingSubagentCounts: Ref.Ref<ReadonlyArray<number>>;
  readonly providerSessionOpens: Ref.Ref<number>;
  readonly runningWrites: Ref.Ref<number>;
}) {
  const session = {
    driver,
    providerSession: { id: providerSessionId },
    resumeThread: ({ providerThread }: { readonly providerThread: unknown }) =>
      Effect.succeed(providerThread),
  } as unknown as ProviderAdapterV2SessionRuntime;

  return providerTurnStartLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffServiceV2)({}),
        Layer.mock(EventSinkV2)({
          writeIfRunCurrent: () =>
            Ref.update(input.runningWrites, (count) => count + 1).pipe(
              Effect.as({ committed: true, storedEvents: [] }),
            ),
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: (requestedThreadId) =>
            requestedThreadId === threadId
              ? Effect.succeed(input.rootProjection)
              : input.childProjection,
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () =>
            Ref.update(input.providerSessionOpens, (count) => count + 1).pipe(Effect.as(session)),
        }),
        Layer.mock(RunExecutionServiceV2)({
          startRootRun: (startInput) =>
            Ref.update(input.existingSubagentCounts, (counts) => [
              ...counts,
              startInput.existingSubagents?.length ?? 0,
            ]),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp/provider-turn-start",
            }),
        }),
      ),
    ),
  );
}

it.effect("fails before provider turn start when child projection rehydration cannot be read", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const existingSubagentCounts = yield* Ref.make<ReadonlyArray<number>>([]);
    const providerSessionOpens = yield* Ref.make(0);
    const runningWrites = yield* Ref.make(0);
    const readError = new ProjectionStoreReadError({
      threadId: childThreadId,
      cause: "temporary database failure",
    });
    const error = yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStartServiceV2;
      return yield* service.start({ threadId, runId }).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          rootProjection: makeRootProjection(now),
          childProjection: Effect.fail(readError),
          existingSubagentCounts,
          providerSessionOpens,
          runningWrites,
        }),
      ),
    );

    assert.equal(error._tag, "ProviderTurnStartError");
    assert.strictEqual(error.cause, readError);
    assert.deepEqual(yield* Ref.get(existingSubagentCounts), []);
    assert.equal(yield* Ref.get(providerSessionOpens), 0);
    assert.equal(yield* Ref.get(runningWrites), 0);
  }),
);

it.effect("skips a missing child projection and still starts the provider turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const existingSubagentCounts = yield* Ref.make<ReadonlyArray<number>>([]);
    const providerSessionOpens = yield* Ref.make(0);
    const runningWrites = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStartServiceV2;
      yield* service.start({ threadId, runId });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          rootProjection: makeRootProjection(now),
          childProjection: Effect.fail(
            new ProjectionStoreThreadNotFoundError({ threadId: childThreadId }),
          ),
          existingSubagentCounts,
          providerSessionOpens,
          runningWrites,
        }),
      ),
    );

    assert.deepEqual(yield* Ref.get(existingSubagentCounts), [0]);
    assert.equal(yield* Ref.get(providerSessionOpens), 1);
    assert.equal(yield* Ref.get(runningWrites), 1);
  }),
);

it.effect("rehydrates an existing child projection before starting the provider turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const existingSubagentCounts = yield* Ref.make<ReadonlyArray<number>>([]);
    const providerSessionOpens = yield* Ref.make(0);
    const runningWrites = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStartServiceV2;
      yield* service.start({ threadId, runId });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          rootProjection: makeRootProjection(now),
          childProjection: Effect.succeed(makeChildProjection(now)),
          existingSubagentCounts,
          providerSessionOpens,
          runningWrites,
        }),
      ),
    );

    assert.deepEqual(yield* Ref.get(existingSubagentCounts), [1]);
    assert.equal(yield* Ref.get(providerSessionOpens), 1);
    assert.equal(yield* Ref.get(runningWrites), 1);
  }),
);
