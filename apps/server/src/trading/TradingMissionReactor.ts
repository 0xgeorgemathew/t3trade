/**
 * Applies requested trading intents to the domain, then reports what happened.
 *
 * The decider turns a client's control into a `*-requested` event, which is a
 * question, not an answer. This reactor is what answers it: it runs the write
 * through `TradingMissionService` — where §11.1 and the one-active-mission
 * invariant are enforced — and only then dispatches the internal
 * `trading.mission.status-set` command whose event the projector reads.
 *
 * That ordering is the whole point. The UI never sees a status the domain
 * refused, and mission state still reaches clients over T3's ordered WS push
 * path rather than a side channel.
 *
 * The reactor also closes the PROMPT-03 wake loop: a `trading.mission-watch-fired`
 * domain event (announced by the WatchEvaluator) is turned into a
 * `TradingTurnCoordinator.requestRun`, resuming the bound provider session.
 *
 * @module TradingMissionReactor
 */
import type { OrchestrationEvent, ThreadId, TradingMissionId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import type { TradingMissionStatus, TradingProvider } from "@t3tools/trading-contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PersistedWatch, TradingHarnessRunCause } from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

type TradingRequestEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "trading.mission-create-requested"
      | "trading.mission-control-requested"
      | "trading.mission-watch-fired";
  }
>;

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-watch-fired",
]);

/**
 * How long a fired watch keeps retrying behind an active run before giving up.
 * The inbox event stays pending either way, so the next run still sees it; the
 * retry is what turns "queued behind the active run" into an actual follow-up
 * resume once the lease is released.
 */
const QUEUE_RETRY_DELAY = "5 seconds";
const QUEUE_RETRY_LIMIT = 60;

/**
 * The owner every mission on this installation belongs to.
 *
 * §10.1 scopes the one-active-mission invariant to a user, and upstream T3 is a
 * single-user local server with no user identity on the wire. Pinning one owner
 * here keeps that invariant meaningful — one active mission per installation —
 * without inventing an identity contract the spec has not published.
 */
export const LOCAL_TRADING_USER_ID = "local";

export interface TradingMissionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when the queue is idle. For tests, in place of a sleep. */
  readonly drain: Effect.Effect<void>;
}

export class TradingMissionReactor extends Context.Service<
  TradingMissionReactor,
  TradingMissionReactorShape
>()("t3/trading/TradingMissionReactor") {}

/**
 * Map a thread's provider driver kind to the trading provider literal.
 *
 * The session's `providerName` is a `ProviderDriverKind` slug (e.g. "codex",
 * "claude", "claudeAgent", "opencode"). The trading domain only knows three
 * providers (§10.2): codex, claude, opencode. A claudeAgent session maps to
 * "claude" (it is the claude driver); anything unrecognized falls back to
 * "codex" so the mission is still bound and can be corrected on the first run.
 */
const toTradingProvider = (driverKind: string | null | undefined): TradingProvider => {
  if (driverKind === "claude" || driverKind === "claudeAgent") return "claude";
  if (driverKind === "opencode") return "opencode";
  return "codex";
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const missions = yield* TradingMissionService;
  const coordinator = yield* TradingTurnCoordinator;
  const watches = yield* TradingWatchService;
  const inbox = yield* TradingEventInbox;
  const crypto = yield* Crypto.Crypto;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const announceStatus = Effect.fn("TradingMissionReactor.announceStatus")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly status: TradingMissionStatus;
  }) {
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* orchestrationEngine.dispatch({
      type: "trading.mission.status-set",
      commandId: CommandId.make(commandId),
      threadId: input.threadId,
      missionId: input.missionId,
      status: input.status,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Derive the harness binding from the thread the mission is bound to.
   *
   * The provider and instance come from the thread's session (the live provider
   * session the mission's turns will resume). The session may not exist yet at
   * mission-create time (the first turn establishes it); in that case the
   * model selection's instance id is the fallback, and the provider defaults to
   * "codex" until a session materialises. The binding is identity-frozen for an
   * active mission (§10.2), so this is the one place it is resolved.
   */
  const resolveHarnessBinding = Effect.fn("TradingMissionReactor.resolveHarnessBinding")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* snapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(shell)) {
      // The thread was archived or never projected; bind with a minimal
      // placeholder so the mission exists and can be corrected. The
      // coordinator's provider-binding check will block runs until a real
      // binding lands.
      return {
        provider: "codex" as TradingProvider,
        providerInstanceId: "unbound",
        threadId,
        status: "available" as const,
      };
    }
    const session = shell.value.session;
    return {
      provider: toTradingProvider(session?.providerName ?? null),
      providerInstanceId: session?.providerInstanceId ?? shell.value.modelSelection.instanceId,
      threadId,
      status: "available" as const,
    };
  });

  const processCreateRequested = Effect.fn("TradingMissionReactor.create")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.mission-create-requested" }>,
  ) {
    const { missionId, threadId, tradingAccountId, instruction, allocatedCapitalUsd } =
      event.payload;

    const harness = yield* resolveHarnessBinding(threadId);

    yield* missions.createMission({
      missionId,
      userId: LOCAL_TRADING_USER_ID,
      tradingAccountId,
      instruction,
      allocatedCapitalUsd,
      harness,
    });

    yield* announceStatus({ missionId, threadId, status: "initializing" });

    // Start the first run on the thread's actual provider. The mission_created
    // cause is the only one allowed to proceed without a published strategy
    // (coordinator check 7); the resumed turn's first job is to author one.
    // The coordinator forks the wake path internally (a daemon fiber), so this
    // returns once the lease is acquired, not when the turn completes.
    yield* coordinator.requestRun({ missionId, cause: "mission_created" }).pipe(
      Effect.catchCause((cause) => {
        // A failure to start the first run is logged, not fatal — the
        // mission exists and a later watch or manual action can start it.
        return Effect.logWarning("TradingMissionReactor: first run did not start", {
          missionId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  /** Map the fired watch's type to the §11.2 run cause it wakes the harness with. */
  const causeForWatch = (watch: PersistedWatch | null): TradingHarnessRunCause => {
    switch (watch?.watch.type) {
      case "scheduled_reassessment":
        return "scheduled_reassessment";
      case "order_update":
        return "order_updated";
      case "position_update":
        return "position_updated";
      default:
        return "market_watch_triggered";
    }
  };

  /**
   * A fired watch wakes the harness: ask the coordinator to start a run for it.
   *
   * This is the seam that closes the PROMPT-03 loop — the evaluator observed
   * and announced the firing; this handler turns it into a resumed provider
   * turn. When another run holds the lease the request is retried on a slow
   * cadence ("queue behind the active run", §12.3) and stops as soon as the
   * inbox event is no longer pending — that means a run has claimed it, so the
   * firing has been delivered and a follow-up resume would be redundant.
   *
   * The retry loop is forked so a long-running active run does not stall the
   * reactor's event queue behind it.
   */
  const processWatchFired = Effect.fn("TradingMissionReactor.watchFired")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.mission-watch-fired" }>,
  ) {
    const { missionId, watchId, deduplicationKey } = event.payload;
    const watch = yield* watches.getWatch(watchId);
    const cause = causeForWatch(watch);

    yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < QUEUE_RETRY_LIMIT; attempt++) {
        const outcome = yield* coordinator.requestRun({
          missionId,
          cause,
          triggeringWatchId: watchId,
        });
        if (outcome.status === "started") return;
        if (outcome.status === "blocked") {
          yield* Effect.logWarning("TradingMissionReactor: fired watch could not start a run", {
            missionId,
            watchId,
            reason: outcome.reason,
          });
          return;
        }
        yield* Effect.sleep(QUEUE_RETRY_DELAY);
        const stillPending = yield* inbox.isPending(missionId, deduplicationKey);
        if (!stillPending) return;
      }
      yield* Effect.logWarning("TradingMissionReactor: fired watch stayed queued; giving up", {
        missionId,
        watchId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("TradingMissionReactor: watch-fired run request failed", {
          missionId,
          watchId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkDetach,
    );
  });

  const processControlRequested = Effect.fn("TradingMissionReactor.control")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.mission-control-requested" }>,
  ) {
    const { missionId, threadId, targetStatus } = event.payload;
    const expectedVersion = yield* missions.getMissionVersion(missionId);

    // TradingMissionService.transition runs validateTransition and the row's
    // optimistic version check; an illegal control fails here and never
    // reaches the projection.
    const updated = yield* missions.transition({
      missionId,
      to: targetStatus,
      expectedVersion,
    });

    yield* announceStatus({ missionId, threadId, status: updated.status });
  });

  const process = (event: TradingRequestEvent) =>
    (event.type === "trading.mission-create-requested"
      ? processCreateRequested(event)
      : event.type === "trading.mission-watch-fired"
        ? processWatchFired(event)
        : processControlRequested(event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // A refused control is a normal outcome, not a crash: the projection
        // keeps the status the domain still holds.
        return Effect.logWarning("trading mission reactor could not apply a requested intent", {
          eventType: event.type,
          missionId: event.payload.missionId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(process);

  const start: TradingMissionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        HANDLED_EVENT_TYPES.has(event.type)
          ? worker.enqueue(event as TradingRequestEvent)
          : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies TradingMissionReactorShape;
});

export const TradingMissionReactorLive = Layer.effect(TradingMissionReactor, make);
