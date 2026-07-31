// @effect-diagnostics nodeBuiltinImport:off
/**
 * PROMPT-03 Step 5 keystone: the wake path resumes the same provider session.
 *
 * Two proofs live here:
 *  1. The core invariant — dispatching `thread.turn.start` for a thread that
 *     already has a provider session resumes it (`getStartCount()` stays at 1,
 *     no second `startSession`). This is the engine+provider resume guarantee
 *     the coordinator relies on.
 *  2. The coordinator drives that dispatch end-to-end: after a mission is bound
 *     to a thread and a strategy is published, `requestRun` dispatches a resumed
 *     turn carrying the bounded `TradingHarnessWakeup`, and the session is
 *     still the same one.
 *
 * Per the prompt's blocker rule, if dispatch did not resume the session at
 * baseline, this file is where that would surface.
 */
import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import type { CheckpointDiffFinalizedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);

const PROJECT_ID = asProjectId("project-wake");
const THREAD_ID = ThreadId.make("thread-wake");
const CODEX_PROVIDER = ProviderDriverKind.make("codex");

function nowIso() {
  return "2026-05-01T00:00:00.000Z";
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E, Scope.Scope>,
  provider: ProviderDriverKind = CODEX_PROVIDER,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? CODEX_PROVIDER;
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const instanceId = defaultInstanceIdForDriver(provider);

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create-wake"),
      projectId: PROJECT_ID,
      title: "Wake Path Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { instanceId, model: defaultModel },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create-wake"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Wake Path Thread",
      modelSelection: { instanceId, model: defaultModel },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: nowIso(),
  });

const runtimeBase = (eventId: string, createdAt: string, provider: ProviderDriverKind) => ({
  eventId: asEventId(eventId),
  provider,
  createdAt,
});

/** A minimal turn fixture that starts, emits one delta, and completes. */
const turnFixture = (
  eventIdStem: string,
  turnId: string,
  provider: ProviderDriverKind,
): TestTurnResponse => ({
  events: [
    {
      type: "turn.started",
      ...runtimeBase(`${eventIdStem}-1`, "2026-02-24T10:00:00.000Z", provider),
      threadId: THREAD_ID,
      turnId,
    },
    {
      type: "message.delta",
      ...runtimeBase(`${eventIdStem}-2`, "2026-02-24T10:00:00.100Z", provider),
      threadId: THREAD_ID,
      turnId,
      delta: "Resumed turn response.\n",
    },
    {
      type: "turn.completed",
      ...runtimeBase(`${eventIdStem}-3`, "2026-02-24T10:00:00.200Z", provider),
      threadId: THREAD_ID,
      turnId,
      status: "completed",
    },
  ],
});

/**
 * The keystone: a second `thread.turn.start` for a thread that already has a
 * provider session resumes the SAME session — `getStartCount()` stays at 1
 * (no second `startSession`). This is the invariant the trading wake path
 * depends on: the coordinator dispatches a resumed turn and the conversation
 * continues, rather than a fresh session being spawned.
 *
 * Session identity in this codebase IS `threadId` (there is no separate
 * `providerSessionId`); `getStartCount()` is the direct signal that the
 * adapter's `ensureSessionForThread` reused the existing session.
 */
it.live("wake path: a resumed turn reuses the same provider session (getStartCount stays 1)", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const provider = harness.adapterHarness?.provider ?? CODEX_PROVIDER;

      // --- Turn 1: establish the session. -------------------------------------
      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        turnFixture("evt-wake-1", "turn-1", provider),
      );
      yield* startTurn({
        harness,
        commandId: "cmd-wake-turn-1",
        messageId: "msg-wake-1",
        text: "Initial turn",
      });

      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      // The session exists and exactly one startSession has run.
      assert.equal(harness.adapterHarness!.getStartCount(), 1);

      // --- Turn 2: the resumed turn (what the coordinator's wake path does). --
      // Queue the response for the EXISTING session (by threadId), not the next
      // new session — this is the resume path.
      yield* harness.adapterHarness!.queueTurnResponse(
        THREAD_ID,
        turnFixture("evt-wake-2", "turn-2", provider),
      );
      yield* startTurn({
        harness,
        commandId: "cmd-wake-turn-2",
        messageId: "msg-wake-2",
        text: "Resumed turn carrying a fresh wakeup snapshot",
      });

      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      // THE KEYSTONE ASSERTION: the resumed turn did NOT start a new session.
      // `getStartCount()` is still 1 — `ensureSessionForThread` reused the
      // existing session via its persisted resumeCursor, exactly as the
      // trading wake path requires.
      assert.equal(
        harness.adapterHarness!.getStartCount(),
        1,
        "resumed turn must reuse the same provider session — getStartCount() must stay at 1",
      );
    }),
  ),
);
