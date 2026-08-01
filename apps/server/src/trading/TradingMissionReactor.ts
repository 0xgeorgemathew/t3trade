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
import { TradingExecutionGuard } from "./TradingExecutionGuard.ts";
import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingFillReconciler } from "./TradingFillReconciler.ts";
import { InterimSignerConfig } from "./InterimSignerConfig.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type TradingRequestEvent = Extract<
  OrchestrationEvent,
  | { type: "trading.mission-create-requested" }
  | { type: "trading.mission-control-requested" }
  | { type: "trading.mission-watch-fired" }
  | { type: "trading.execution-requested" }
>;

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-watch-fired",
  "trading.execution-requested",
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
  /** Start the event stream. The server-startup reconcile runs at layer build. */
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
  const guard = yield* TradingExecutionGuard;
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;
  const budgetReader = yield* TradingBudgetReader;
  const gateway = yield* HyperliquidGateway;
  const signerConfig = yield* InterimSignerConfig;

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

    const mission = yield* missions.getMission(missionId);
    const isBlocked =
      mission.status === "blocked" && mission.blockedReason === "cumulative_loss_limit";
    if (targetStatus === "analysing") {
      // §16.4 applies the exhaustion gate to resume only; pause and revoke
      // remain available while blocked so the user can recover safely.
      yield* guard.guardResume(missionId, isBlocked);
      yield* Effect.gen(function* () {
        const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
        yield* reconciler.reconcile(
          { missionId, masterAddress, market: mission.market },
          "before_resuming_paused_mission",
        );
      }).pipe(Effect.catch(() => Effect.void));
    }

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

  /**
   * The §17.2 write side. A harness raised `trading.execution.requested`; the
   * reactor answers it by running preview → guard → submit → reconcile, then
   * blocking the mission if the post-submit budget is exhausted. A refused
   * preview or a failed submit is a normal outcome (the surrounding
   * `catchCause` logs it); the mission's persisted records are the source of
   * truth, not the request.
   */
  const processExecutionRequested = Effect.fn("TradingMissionReactor.execution")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.execution-requested" }>,
  ) {
    const { missionId, threadId, intent, expectedAuthorityVersion, activeHarnessRunId } =
      event.payload;

    const mission = yield* missions.getMission(missionId);
    // §10.6: account/position reads use the master-wallet address; the signer
    // address is recorded on the execution record only.
    const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);

    // §18.2 trigger #3: reconcile canonical state before execution so preview
    // and the budget gate see reconciled truth, not a stale local cache.
    yield* reconciler.reconcile(
      { missionId, masterAddress, market: intent.market },
      "before_execution",
    );

    // Assemble the §16.3 preview context from reconciled state.
    // Load the master wallet's taker fee rate once; fall back to the authority's
    // default when the read fails or is stale. Both the budget reader and the
    // preview consume the same rate so Eq 3/4 agree.
    const fallbackFeeBps = mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide;
    const stopSlippageReserveBps = mission.authority.riskPolicy.stopSlippageReserveBps;
    const feeRate = yield* gateway.getTakerFeeRateBps(masterAddress).pipe(
      Effect.map((r) => r.feeBps),
      Effect.orElseSucceed(() => fallbackFeeBps),
    );
    const budgetInput = yield* budgetReader.read({
      missionId,
      maximumCumulativeLossUsd: mission.authority.maximumCumulativeLossUsd,
      takerFeeRateBps: feeRate,
    });
    const orderBook = yield* gateway.getOrderBook(intent.market);
    const budget = evaluateLossBudget(budgetInput);
    const sql = yield* SqlClient.SqlClient;
    const pendingRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM trading_execution_records
      WHERE mission_id = ${missionId}
        AND status NOT IN ('filled', 'rejected', 'cancelled', 'failed')
    `;
    // The interim signer IS the approved execution wallet for the POC (Privy
    // replaces it in PROMPT-06). Resolve its address so preview item 8 can
    // confirm a wallet is approved before a nonce is spent. If the signer is
    // not armed or misconfigured, preview rejects on item 8 — no nonce spent.
    const signerOuter = yield* Effect.option(signerConfig.resolve);
    const signerInner = signerOuter._tag === "Some" ? signerOuter.value : null;
    const approvedExecutionWalletAddress =
      signerInner !== null && signerInner._tag === "Some" ? signerInner.value.address : null;

    // §16.4: block position-increasing actions under exhaustion before the
    // submit sequence spends a nonce. Cancel/reduce/close pass through.
    yield* guard.guardAction(intent.actionType, budget);

    const executionInput = {
      intent,
      masterAddress,
      previewContext: {
        mission,
        currentStrategyVersion: mission.strategyVersion,
        currentAuthorityVersion: mission.authorityVersion,
        expectedAuthorityVersion,
        activeHarnessRunId,
        approvedExecutionWalletAddress,
        bbo: orderBook.bestBidOffer,
        accountObservedAt: budgetInput.observedAt,
        hasPendingExecution: (pendingRows[0]?.count ?? 0) > 0,
        budget: budgetInput,
        takerFeeRateBps: feeRate,
        stopSlippageReserveBps,
        nowMs: budgetInput.observedAt,
      },
      allowedSlippageBps: 50,
    };
    if (intent.actionType === "close" || (intent.actionType === "reduce" && intent.reduceOnly)) {
      yield* guard.reduceOnlyClose(executionInput);
    } else {
      yield* execution.submitOrder(executionInput);
    }

    // §18.2 trigger #4: converge local state to canonical exchange state after
    // the submit landed. Local records are hints until this confirms them.
    yield* reconciler.reconcile(
      { missionId, masterAddress, market: intent.market },
      "after_submission",
    );

    // §16.4: re-evaluate the budget after the reconciled submit. If the
    // cumulative-loss ceiling is now exhausted, block the mission so a later
    // resume must be revalidated. Reduce-only protection stays live
    // (`isPermittedUnderExhaustion` permits cancel/reduce/close).
    const postBudgetInput = yield* budgetReader.read({
      missionId,
      maximumCumulativeLossUsd: mission.authority.maximumCumulativeLossUsd,
      takerFeeRateBps: feeRate,
    });
    const postBudget = evaluateLossBudget(postBudgetInput);
    if (postBudget.exhausted) {
      const expectedVersion = yield* missions.getMissionVersion(missionId);
      // A version conflict means another transition beat us; the mission state
      // the projection holds is still authoritative, so log and continue.
      yield* guard.blockForExhaustion(missionId, expectedVersion).pipe(
        Effect.catch(() =>
          Effect.logWarning("trading execution: could not block exhausted mission", {
            missionId,
          }),
        ),
      );
      yield* announceStatus({ missionId, threadId, status: "blocked" });
    }
  });

  /**
   * Run one event. Every failure short of an interrupt is logged and swallowed
   * so a single refused request cannot crash the queue: the mission's
   * persisted state is the source of truth, not the request. Interrupts
   * propagate so a scope shutdown tears the queue down.
   */
  const runEvent = (event: TradingRequestEvent) =>
    Effect.gen(function* () {
      if (event.type === "trading.mission-create-requested") {
        yield* processCreateRequested(event);
      } else if (event.type === "trading.mission-control-requested") {
        yield* processControlRequested(event);
      } else if (event.type === "trading.mission-watch-fired") {
        yield* processWatchFired(event);
      } else {
        yield* processExecutionRequested(event);
      }
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // A refused control or execution is a normal outcome, not a crash: the
        // projection keeps the state the domain still holds.
        return Effect.logWarning("trading mission reactor could not apply a requested intent", {
          eventType: event.type,
          missionId: event.payload.missionId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const process = (event: TradingRequestEvent) => runEvent(event);

  const worker = yield* makeDrainableWorker(process);

  // §18.2 trigger #1: converge every active mission to canonical exchange state
  // at layer build, so local tables reflect truth before any request runs. Forked
  // here (not in `start`) so its read/SQL requirements resolve from the services
  // this layer already captured, keeping `start`'s context narrow (Scope only).
  yield* Effect.gen(function* () {
    // Poll until an active mission exists, then start following it. The original
    // build-time check only followed a mission that already existed at layer
    // build; a mission created later never got a fill/reconnect subscription.
    // The poll is cheap (one indexed read every 5s) and stops once a mission is
    // found — `follow` then owns its own lifetime under this scope.
    const fillReconciler = yield* TradingFillReconciler;
    let started = false;
    while (!started) {
      const active = yield* missions
        .findActiveMission(LOCAL_TRADING_USER_ID)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (active._tag === "None") {
        yield* Effect.sleep("5 seconds");
        continue;
      }
      const mission = active.value;
      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      yield* reconciler
        .reconcile(
          { missionId: mission.id, masterAddress, market: mission.market },
          "server_startup",
        )
        .pipe(Effect.catch(() => Effect.void));
      yield* fillReconciler
        .follow({ missionId: mission.id, masterAddress, market: mission.market })
        .pipe(Effect.forkScoped);
      started = true;
    }
  }).pipe(Effect.forkScoped);

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
