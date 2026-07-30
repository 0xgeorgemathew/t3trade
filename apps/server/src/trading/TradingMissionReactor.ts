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
 * @module TradingMissionReactor
 */
import type { OrchestrationEvent, ThreadId, TradingMissionId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import type { TradingMissionStatus } from "@t3tools/trading-contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { TradingMissionService } from "./TradingMissionService.ts";

type TradingRequestEvent = Extract<
  OrchestrationEvent,
  { type: "trading.mission-create-requested" | "trading.mission-control-requested" }
>;

const REQUESTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "trading.mission-create-requested",
  "trading.mission-control-requested",
]);

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

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const missions = yield* TradingMissionService;
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

  const processCreateRequested = Effect.fn("TradingMissionReactor.create")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.mission-create-requested" }>,
  ) {
    const { missionId, threadId, tradingAccountId, instruction, allocatedCapitalUsd } =
      event.payload;

    yield* missions.createMission({
      missionId,
      userId: LOCAL_TRADING_USER_ID,
      tradingAccountId,
      instruction,
      allocatedCapitalUsd,
      harness: {
        provider: "claude",
        providerInstanceId: "claude",
        threadId,
        status: "available",
      },
    });

    yield* announceStatus({ missionId, threadId, status: "initializing" });
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
        REQUESTED_EVENT_TYPES.has(event.type)
          ? worker.enqueue(event as TradingRequestEvent)
          : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies TradingMissionReactorShape;
});

export const TradingMissionReactorLive = Layer.effect(TradingMissionReactor, make);
