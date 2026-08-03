/**
 * TradingTurnCoordinator - the single gate between an observed event and a
 * started run, spec §12.3, and the wake path that resumes the provider session.
 *
 * It runs the seven pre-run checks in their listed order before acquiring the
 * decision lease, and returns one of three outcomes so a caller can tell
 * whether a run actually started, was queued behind an active one, or was
 * blocked. Only one run may own the mission decision lease at a time; the
 * `idx_trading_harness_runs_one_active_per_mission` unique partial index
 * (migration 035) makes a concurrent second insert a unique violation, which
 * the coordinator catches and reports as `queued_behind_active_run`.
 *
 * On a `started` outcome the coordinator builds the bounded `TradingHarnessWakeup`
 * via `TradingWakeupComposer`, serializes it into the resumed turn's message
 * text, and dispatches `thread.turn.start` via `OrchestrationEngineService`. It
 * does NOT call `ProviderService` directly: dispatch is the only sanctioned way
 * for trading code to resume a session (§6.3), and the persisted `resumeCursor`
 * is what makes the resumed turn continue the same conversation.
 *
 * A forked watcher — subscribed before the turn is dispatched, so an early
 * turn-end cannot slip past it — waits for the first `thread.session-set` where
 * the session leaves `"running"`, releases the lease (marking the run
 * `completed` on a clean end, `failed` on an error), and terminates.
 *
 * @module TradingTurnCoordinator
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import { POC_DEFAULT_TIMEFRAME } from "@t3tools/trading-contracts/strategy";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  HarnessRunOutcome,
  HarnessRunRequest,
  TradingDomainEventSummary,
  TradingHarnessRunCause,
  TradingHarnessWakeup,
} from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWakeupComposer } from "./TradingWakeupComposer.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";

export interface TradingTurnCoordinatorShape {
  /**
   * Run the seven §12.3 pre-run checks and, if they pass, acquire the lease,
   * build the wakeup snapshot, dispatch `thread.turn.start` to resume the bound
   * provider session, and fork a watcher that releases the lease when the turn
   * ends.
   *
   * Returns `started` when this call acquired the lease, `queued_behind_active_run`
   * when another run already owns it, or `blocked{reason}` when a check failed.
   */
  readonly requestRun: (
    input: HarnessRunRequest,
  ) => Effect.Effect<HarnessRunOutcome, PersistenceSqlError>;
}

export class TradingTurnCoordinator extends Context.Service<
  TradingTurnCoordinator,
  TradingTurnCoordinatorShape
>()("t3/trading/TradingTurnCoordinator") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingTurnCoordinator.${operation}`);

/**
 * Parse the JSON-serialized wakeup back from the message text. A round-trip
 * check catches a serialization bug early rather than letting the harness
 * receive malformed JSON.
 */
const decodeWakeupText = Schema.decodeUnknownSync(Schema.fromJsonString(TradingHarnessWakeup));

/**
 * The `mission_created` bootstrap message: the resumed turn's first job is to
 * author a strategy, so it carries just the mission instruction rather than the
 * full snapshot (which requires an active strategy).
 */
const BootstrapWakeup = Schema.Struct({
  kind: Schema.Literal("trading-harness-wakeup"),
  bootstrap: Schema.Literal(true),
  missionId: Schema.String,
  harnessRunId: Schema.String,
  cause: Schema.String,
  instruction: Schema.String,
  /** Matches `TradingHarnessWakeup.defaultTimeframe`, so the very first turn
      authors its strategy on the same candle every later turn wakes on. */
  defaultTimeframe: Schema.String,
});
const encodeBootstrapText = Schema.encodeSync(Schema.fromJsonString(BootstrapWakeup));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const missions = yield* TradingMissionService;
  const strategies = yield* TradingStrategyService;
  const inbox = yield* TradingEventInbox;
  const engine = yield* OrchestrationEngineService;
  const composer = yield* TradingWakeupComposer;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Acquire the lease by inserting a `starting` run. The partial unique index
   * `idx_trading_harness_runs_one_active_per_mission` (status NOT IN
   * 'completed','failed') makes a second concurrent insert a unique violation,
   * which is the single-lease guarantee: exactly one non-terminal run per
   * mission can ever exist.
   *
   * Returns the new run id on success, or `null` when the lease is already held.
   */
  const acquireLease = Effect.fn("TradingTurnCoordinator.acquireLease")(function* (
    missionId: string,
    cause: TradingHarnessRunCause,
  ) {
    const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;

    const inserted = yield* sql<{ readonly run_id: string }>`
      INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
      VALUES (${runId}, ${missionId}, ${cause}, 'starting', ${now}, ${now})
      RETURNING run_id
    `.pipe(
      // A unique-violation means another run already owns the lease: the
      // single-lease invariant held, and this caller is queued, not failed.
      Effect.catchIf(
        (error): boolean => {
          const detail = JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase();
          return detail.includes("unique") || detail.includes("constraint");
        },
        () => Effect.succeed([] as ReadonlyArray<{ readonly run_id: string }>),
      ),
      Effect.mapError(sqlFail("acquireLease")),
    );

    return inserted.length > 0 ? runId : null;
  });

  /**
   * Flip a run to a terminal status, releasing the lease. Idempotent by guard:
   * the `WHERE status NOT IN ('completed','failed')` clause makes a repeat call
   * a no-op, so it cannot corrupt a future run's lease. The `trading_harness_runs`
   * table (migration 035) carries no failure-reason column; the failure detail
   * is logged alongside the transition.
   */
  const completeRun = Effect.fn("TradingTurnCoordinator.completeRun")(function* (
    runId: string,
    status: "completed" | "failed",
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      UPDATE trading_harness_runs
      SET status = ${status}, completed_at = ${now}
      WHERE run_id = ${runId} AND status NOT IN ('completed', 'failed')
    `.pipe(Effect.mapError(sqlFail("completeRun")));
  });

  /**
   * Wait for the turn triggered by this dispatch to end, then release the lease
   * and mark the run's claimed inbox events consumed. The turn-end signal is
   * the first `thread.session-set` domain event where the session leaves
   * `"running"` with no active turn — the canonical turn-end marker the client
   * runtime itself uses (§B.1). A failed turn surfaces as status "error"; those
   * mark the run `failed`.
   *
   * `Stream.take(1)` means the watcher terminates with the turn instead of
   * consuming the domain-event stream for the life of the process.
   */
  const isTurnEndFor =
    (threadId: string) =>
    (event: OrchestrationEvent): boolean => {
      if (event.type !== "thread.session-set") return false;
      if (event.payload.threadId !== threadId) return false;
      const { status, activeTurnId } = event.payload.session;
      return status !== "running" && activeTurnId === null;
    };

  const watchTurnEndAndRelease = (runId: string, missionId: string, threadId: string) =>
    engine.streamDomainEvents.pipe(
      Stream.filter(isTurnEndFor(threadId)),
      Stream.take(1),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "thread.session-set") return;
          const terminal: "completed" | "failed" =
            event.payload.session.status === "error" ? "failed" : "completed";
          yield* completeRun(runId, terminal).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("TradingTurnCoordinator: failed to release lease", {
                runId,
                status: terminal,
                cause: String(cause),
              }),
            ),
          );
          // Close the inbox lifecycle for the events this run claimed.
          yield* inbox.markIncludedConsumed(missionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("TradingTurnCoordinator: failed to mark inbox consumed", {
                missionId,
                cause: String(cause),
              }),
            ),
          );
        }),
      ),
    );

  /**
   * Build the wakeup snapshot and dispatch `thread.turn.start` to resume the
   * bound provider session. This is the only place trading code dispatches a
   * turn — the persisted `resumeCursor` is what continues the conversation.
   *
   * Two shapes:
   * - A watch/timer/user-message cause always has an active strategy (check 7),
   *   so it carries the full bounded `TradingHarnessWakeup` snapshot.
   * - The `mission_created` first run may have no strategy yet (the harness's
   *   first job is to author one); it dispatches a plain bootstrap message
   *   carrying just the mission instruction. Step 7 refines this into the full
   *   thread-derived binding flow.
   */
  const wakeProvider = Effect.fn("TradingTurnCoordinator.wakeProvider")(function* (input: {
    readonly missionId: string;
    readonly harnessRunId: string;
    readonly cause: TradingHarnessRunCause;
    readonly triggeringWatchId?: string;
    readonly userMessage?: string;
    readonly pendingEvents: ReadonlyArray<TradingDomainEventSummary>;
    readonly threadId: string;
  }) {
    const mission = yield* missions.getMission(input.missionId);
    const activeStrategy = yield* strategies.getCurrentStrategy(input.missionId);

    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const messageId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

    let text: string;
    if (activeStrategy._tag === "Some") {
      // Full bounded wakeup for strategy-bearing causes (the watch/timer/resume
      // path the keystone test exercises).
      const occurredAt = yield* Clock.currentTimeMillis;
      const composed = yield* composer.compose({
        mission,
        harnessRunId: input.harnessRunId,
        cause: input.cause,
        occurredAt,
        ...(input.triggeringWatchId !== undefined
          ? { triggeringWatchId: input.triggeringWatchId }
          : {}),
        ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
        pendingEvents: input.pendingEvents,
        activeStrategy: activeStrategy.value,
      });
      // Round-trip check: the serialized text must decode back to a wakeup.
      decodeWakeupText(composed.text);
      text = composed.text;
    } else {
      // mission_created bootstrap: no strategy yet. The resumed turn's first
      // job is to author one.
      text = encodeBootstrapText({
        kind: "trading-harness-wakeup",
        bootstrap: true,
        missionId: input.missionId,
        harnessRunId: input.harnessRunId,
        cause: input.cause,
        instruction: mission.instruction,
        defaultTimeframe: POC_DEFAULT_TIMEFRAME,
      });
    }

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make(input.threadId),
      message: {
        messageId: MessageId.make(messageId),
        role: "user",
        text,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: yield* nowIso,
    });
  });

  const requestRun: TradingTurnCoordinatorShape["requestRun"] = (input) =>
    Effect.gen(function* () {
      // §12.3 check 1: Mission is active.
      const mission = yield* missions
        .getMission(input.missionId)
        .pipe(Effect.catchTag("TradingMissionNotFoundError", () => Effect.succeed(null)));
      if (mission === null) {
        return { status: "blocked", reason: "mission_not_found" } as const;
      }
      if (!isActiveMissionStatus(mission.status)) {
        return { status: "blocked", reason: "mission_not_active" } as const;
      }

      // §12.3 check 2: Provider binding is present. The binding is immutable
      // for an active mission (§10.2); a missing threadId means the mission was
      // created without one (Phase 1 placeholder — Step 7 derives it from the
      // thread's provider session).
      if (mission.harness.threadId === undefined || mission.harness.threadId === "") {
        return { status: "blocked", reason: "provider_binding_missing" } as const;
      }

      // §12.3 check 3: Provider instance is available. Phase 3 has no provider
      // registry gate yet; the binding's `status` field is the availability
      // signal. (Step 7 / the recovery phase refine this against the live
      // ProviderService session state.)
      if (mission.harness.status === "unavailable") {
        return { status: "blocked", reason: "provider_unavailable" } as const;
      }

      // §12.3 check 4: No other run owns the lease. Acquiring the lease is the
      // check — the DB partial unique index enforces at-most-one non-terminal
      // run per mission.
      const runId = yield* acquireLease(input.missionId, input.cause);
      if (runId === null) {
        return { status: "queued_behind_active_run" } as const;
      }

      // §12.3 check 5: Account is available. Phase 3 has no account-status gate
      // (execution lands in PROMPT-04); the account row existing is the check.
      // (Intentionally a no-op seam for now.)

      // §12.3 check 6: The event has not been superseded. Claiming the pending
      // events (flip to included_in_run and return them, one statement) after
      // the lease is acquired means a superseded event cannot drive a run. The
      // claimed set is carried into the wakeup so the harness sees exactly the
      // events that warranted it.
      const pendingEvents = yield* inbox.claimPending(input.missionId);

      // §12.3 check 7: The latest strategy and authority versions are loaded.
      // A `mission_created` first run is the only cause that may proceed without
      // a published strategy (the first turn authors one); any other cause is
      // blocked here so the wakeup's required `activeStrategy` is always present.
      const currentStrategy = yield* strategies.getCurrentStrategy(input.missionId);
      if (currentStrategy._tag === "None" && input.cause !== "mission_created") {
        yield* completeRun(runId, "failed");
        return { status: "blocked", reason: "no_active_strategy" } as const;
      }

      // All checks passed: fork the wake path (watch for the turn ending, build
      // the wakeup, dispatch `thread.turn.start`).
      //
      // The wake is a background effect so `requestRun` returns `started` as soon
      // as the lease is acquired — the caller learns the run started, and the
      // dispatch/resume proceeds asynchronously (matching how `thread.turn.start`
      // itself works: dispatch persists events, a reactor drives the provider).
      // The turn-end watcher is forked BEFORE the dispatch so a turn that ends
      // quickly cannot slip past the hot domain-event stream; the wake fiber
      // then lives exactly as long as the watcher (one turn) and terminates.
      // A wake failure marks the run `failed`, releasing the lease and surfacing
      // the run as terminal in the projection.
      yield* Effect.gen(function* () {
        const watcher = yield* Effect.forkChild(
          watchTurnEndAndRelease(runId, input.missionId, mission.harness.threadId),
        );
        const woke = yield* Effect.exit(
          wakeProvider({
            missionId: input.missionId,
            harnessRunId: runId,
            cause: input.cause,
            ...(input.triggeringWatchId !== undefined
              ? { triggeringWatchId: input.triggeringWatchId }
              : {}),
            ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
            pendingEvents,
            threadId: mission.harness.threadId,
          }),
        );
        if (Exit.isFailure(woke)) {
          yield* Fiber.interrupt(watcher);
          yield* completeRun(runId, "failed").pipe(Effect.catchCause(() => Effect.void));
          yield* Effect.logError("TradingTurnCoordinator: wake dispatch failed", {
            runId,
            cause: String(woke.cause),
          });
          return;
        }
        yield* Fiber.join(watcher);
        // `forkDetach` detaches the wake fiber into a root scope so it lives
        // without requiring the caller to provide a scope. `completeRun`'s
        // guard makes a late or repeated release a no-op.
      }).pipe(Effect.forkDetach);

      return { status: "started", harnessRunId: runId } as const;
    });

  return { requestRun } satisfies TradingTurnCoordinatorShape;
});

export const TradingTurnCoordinatorLive = Layer.effect(TradingTurnCoordinator, make);
