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
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { CommandId, TradingMissionId } from "@t3tools/contracts";
import type { TradingMissionStatus, TradingProvider } from "@t3tools/trading-contracts";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";
import { isPositionIncreasing } from "@t3tools/trading-contracts/protection";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PersistedWatch, TradingHarnessRunCause } from "./Schemas.ts";
import { executionRefusedKey } from "./ExecutionRefusal.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { TradingWatchService } from "./TradingWatchService.ts";
import { TradingExecutionGuard } from "./TradingExecutionGuard.ts";
import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingProtectionService } from "./TradingProtectionService.ts";
import { TradingEmergencyCloseService } from "./TradingEmergencyCloseService.ts";
import { TradingControlService } from "./TradingControlService.ts";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingFillReconciler } from "./TradingFillReconciler.ts";
import { InterimSignerConfig } from "./InterimSignerConfig.ts";
import { AutoMissionConfig } from "./AutoMissionConfig.ts";
import { ALL_MISSION_STATUSES, isActiveMissionStatus } from "./MissionTransitions.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type TradingRequestEvent = Extract<
  OrchestrationEvent,
  | { type: "trading.mission-create-requested" }
  | { type: "trading.mission-control-requested" }
  | { type: "trading.mission-risk-control-requested" }
  | { type: "trading.mission-watch-fired" }
  | { type: "trading.execution-requested" }
  // Not trading intents: a thread's own lifecycle is what opens and closes a
  // mission on a lab server. Created gives the thread a mission, settled takes
  // it away. See `AutoMissionConfig`.
  | { type: "thread.created" }
  | { type: "thread.settled" }
>;

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-risk-control-requested",
  "trading.mission-watch-fired",
  "trading.execution-requested",
  "thread.created",
  "thread.settled",
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

/**
 * A one-line reason a harness can act on, from a refusal's cause.
 *
 * The full `Cause.pretty` rendering is a stack trace with the reason buried in
 * its first line; that first line is the part the harness needs and the part
 * that fits an inbox summary. The whole rendering is kept on the event payload.
 */
const describeRefusal = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.split("\n")[0] ?? "unknown";
};

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
  const protection = yield* TradingProtectionService;
  const emergency = yield* TradingEmergencyCloseService;
  const controls = yield* TradingControlService;
  const autoMission = yield* AutoMissionConfig;

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
   * Move a mission one step along the §11.1 loop and announce where it landed.
   *
   * §11.1 publishes the loop, but until now nothing drove it: creation
   * announced `initializing` and the only other writers were the user's own
   * pause/resume/revoke controls. A mission therefore sat in `initializing`
   * forever, and §16.3 item 1 (`mission_active`, which admits only `executing`
   * and `position_open`) refused every entry the harness ever requested. The
   * four callers below are the deterministic points the loop turns on.
   *
   * `from` is the status this step is valid out of. Anything else means another
   * transition — a user pause, a revoke, an exhaustion block — got there first,
   * and that status is the authoritative one; the step is skipped rather than
   * forced. The returned boolean says whether the move happened.
   */
  const advance = Effect.fn("TradingMissionReactor.advance")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly from: ReadonlyArray<TradingMissionStatus>;
    readonly to: TradingMissionStatus;
  }) {
    const mission = yield* missions.getMission(input.missionId);
    if (!input.from.includes(mission.status)) return false;

    const expectedVersion = yield* missions.getMissionVersion(input.missionId);
    const updated = yield* missions.transition({
      missionId: input.missionId,
      to: input.to,
      expectedVersion,
    });
    yield* announceStatus({
      missionId: input.missionId,
      threadId: input.threadId,
      status: updated.status,
    });
    return true;
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
    const started = yield* coordinator.requestRun({ missionId, cause: "mission_created" }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        // A failure to start the first run is logged, not fatal — the
        // mission exists and a later watch or manual action can start it.
        return Effect.logWarning("TradingMissionReactor: first run did not start", {
          missionId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false));
      }),
    );

    // §11.1 `initializing → analysing`: the first run is what the mission was
    // initializing for. A mission whose first run never started stays in
    // `initializing`, which is the accurate description of it.
    if (started) {
      yield* advance({ missionId, threadId, from: ["initializing"], to: "analysing" });
    }
  });

  /** Whether a mission still holds exchange exposure, per the reconciled snapshots. */
  const holdsPosition = Effect.fn("TradingMissionReactor.holdsPosition")(function* (
    missionId: TradingMissionId,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ open_count: number }>`
      SELECT COUNT(*) AS open_count
      FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND size != 0
    `;
    return (rows[0]?.open_count ?? 0) > 0;
  });

  /**
   * Give a newly opened thread a mission of its own.
   *
   * Off unless the shortcut is enabled (see `AutoMissionConfig`: an armed
   * interim signer, or the explicit knob), and narrowed to one workspace root
   * when the config names one.
   *
   * One active mission per user is a domain invariant (§10.1), so claiming the
   * slot means retiring whoever holds it. That is safe only while the incumbent
   * is flat: revoking a mission that holds a position would strand real exposure
   * behind a mission with no authority left to manage it. A position-holding
   * incumbent therefore keeps the slot, and the new thread simply gets no
   * mission — close it from the workspace panel and open another thread.
   */
  const processThreadCreated = Effect.fn("TradingMissionReactor.autoMission")(function* (
    event: Extract<TradingRequestEvent, { type: "thread.created" }>,
  ) {
    const settings = yield* autoMission.resolve;
    if (Option.isNone(settings)) return;

    const scopedRoot = settings.value.workspaceRoot;
    if (scopedRoot !== null) {
      const project = yield* snapshotQuery.getProjectShellById(event.payload.projectId);
      if (Option.isNone(project)) return;
      if (project.value.workspaceRoot !== scopedRoot) return;
    }

    const threadId = event.payload.threadId;
    const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);

    if (Option.isSome(active)) {
      const previous = active.value;
      // The bootstrap thread can be projected twice on a cold start; a mission
      // already bound to this thread is the outcome we wanted, not a conflict.
      if (previous.harness.threadId === threadId) return;

      // The domain mission carries plain strings; the command surface is
      // branded. Same values, re-tagged at the boundary.
      const incumbentMissionId = TradingMissionId.make(previous.id);

      if (yield* holdsPosition(incumbentMissionId)) {
        yield* Effect.logWarning("auto-mission: incumbent holds a position, slot not taken", {
          threadId,
          incumbentMissionId,
        });
        return;
      }

      yield* advance({
        missionId: incumbentMissionId,
        threadId: previous.harness.threadId as ThreadId,
        from: ALL_MISSION_STATUSES.filter(isActiveMissionStatus),
        to: "revoked",
      });
    }

    // Dispatched as the same command the Settings form sends, so the mission is
    // created on the genuine path: decider, reactor, first harness turn.
    yield* orchestrationEngine.dispatch({
      type: "trading.mission.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
      threadId,
      missionId: TradingMissionId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
      tradingAccountId: settings.value.tradingAccountId,
      instruction: settings.value.instruction,
      allocatedCapitalUsd: settings.value.allocatedCapitalUsd,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Settling a thread ends its mission.
   *
   * Settle is the sidebar's "I am done with this thread", and a thread bound to
   * a mission cannot be done while the mission still holds authority to trade
   * on its behalf — it would keep waking, keep placing orders, and keep holding
   * the one active-mission slot the next thread needs.
   *
   * Exposure decides how it ends. A flat mission is simply revoked. A mission
   * that still holds a position goes through §17.5's close-and-revoke, which
   * cancels resting entries and flattens the position before dropping the
   * authority — the same thing the workspace's destructive button does, and the
   * only ordering that does not leave a position nobody is authorized to manage.
   *
   * `findMissionByThreadId` returns only a still-authoritative mission, so a
   * settle on an already-revoked thread is a no-op rather than an error.
   */
  const processThreadSettled = Effect.fn("TradingMissionReactor.threadSettled")(function* (
    event: Extract<TradingRequestEvent, { type: "thread.settled" }>,
  ) {
    const threadId = event.payload.threadId;
    const found = yield* missions.findMissionByThreadId(threadId);
    if (Option.isNone(found)) return;

    const mission = found.value;
    const missionId = TradingMissionId.make(mission.id);

    if (yield* holdsPosition(missionId)) {
      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      const outcome = yield* controls.closeAndRevoke({
        missionId,
        masterAddress,
        market: mission.market,
      });
      yield* Effect.logInfo("settle closed and revoked a mission holding a position", {
        missionId,
        threadId,
        summary: outcome.summary,
      });
      if (outcome.status !== undefined) {
        yield* announceStatus({
          missionId,
          threadId,
          status: outcome.status as TradingMissionStatus,
        });
      }
      return;
    }

    yield* advance({
      missionId,
      threadId,
      from: ALL_MISSION_STATUSES.filter(isActiveMissionStatus),
      to: "revoked",
    });
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
   * §17.2 steps 6–9 for one acknowledged increase.
   *
   * Reconciles protection against canonical state and, when the bounded window
   * closes with the position still uncovered, hands off to §17.5's emergency
   * close rather than waiting for a later harness turn. §17.5 is explicit that
   * the deterministic path must converge on its own.
   *
   * A reduce-only action skips this: it removes exposure rather than adding
   * any, and demanding fresh protection for it would place a stop against a
   * position that is on its way to flat.
   */
  const protectIncrease = Effect.fn("TradingMissionReactor.protectIncrease")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly intent: TradingOrderIntent;
    readonly masterAddress: string;
  }) {
    const { missionId, threadId, intent, masterAddress } = input;
    const stop = intent.stop;
    if (!isPositionIncreasing(intent.actionType) || stop === undefined) return;

    const outcome = yield* protection.reconcileProtection({
      missionId,
      strategyVersion: intent.strategyVersion,
      executionSequence: intent.executionSequence,
      masterAddress,
      market: intent.market,
      stopPrice: stop.stopPrice,
    });

    if (outcome.status !== "escalate") {
      yield* Effect.logInfo("trading protection reconciled", {
        missionId,
        status: outcome.status,
        positionSize: outcome.positionSize,
        protectedSize: outcome.protectedSize,
      });
      return;
    }

    yield* Effect.logError("trading protection could not be confirmed; escalating to §17.5", {
      missionId,
      reason: outcome.escalationReason,
    });
    yield* emergency.emergencyClose({
      missionId,
      masterAddress,
      market: intent.market,
      reason: outcome.escalationReason ?? "protection could not be confirmed",
    });
    yield* announceStatus({ missionId, threadId, status: "blocked" });
  });

  /**
   * A workspace button pressed one of §14.7's exchange-touching controls.
   *
   * The whole point of these is that they do not need a harness turn, so this
   * handler resolves the mission's canonical identity and calls the control
   * service directly. Nothing here consults the harness binding, the decision
   * lease, or the strategy version.
   */
  const processRiskControlRequested = Effect.fn("TradingMissionReactor.riskControl")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.mission-risk-control-requested" }>,
  ) {
    const { missionId, threadId, control, reductionPercent } = event.payload;

    const mission = yield* missions.getMission(missionId);
    const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
    const target = { missionId, masterAddress, market: mission.market };

    const outcome = yield* control === "cancel_entries"
      ? controls.cancelEntries(target)
      : control === "reduce_position"
        ? controls.reducePosition({ ...target, percent: reductionPercent ?? 100 })
        : control === "close_position"
          ? controls.closePosition(target)
          : controls.closeAndRevoke(target);

    yield* Effect.logInfo("trading deterministic control applied", {
      missionId,
      control,
      summary: outcome.summary,
    });

    if (outcome.status !== undefined) {
      yield* announceStatus({
        missionId,
        threadId,
        status: outcome.status as TradingMissionStatus,
      });
    }
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

    // §11.1 `waiting → executing` / `position_open → executing`: requesting an
    // entry is what puts the mission into execution. §16.3 item 1 admits an
    // intent only from those two statuses, so this move is the thing that makes
    // an entry reachable at all — and it happens before preview so preview
    // reads the status this request just established. `runEvent` settles the
    // mission out of `executing` afterwards, on every path.
    yield* advance({ missionId, threadId, from: ["waiting", "position_open"], to: "executing" });

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

    // §17.2 steps 6–9: the acknowledged increase is not done until protection
    // is confirmed for the ACTUAL canonical position. The grouped normalTpsl
    // child that went out with the entry proves nothing (§17.1) — it may be
    // untriggered, rejected, or sized to a fill that did not fully happen.
    //
    // This runs for increases only. A reduce or close removes exposure; the
    // reconcile above already reflects whatever protection remains.
    yield* protectIncrease({ missionId, threadId, intent, masterAddress });

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
      yield* guard.blockForExhaustion(missionId, expectedVersion, masterAddress).pipe(
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
   * Leave `executing` for whatever the exchange actually holds.
   *
   * §11.1 gives `executing` two exits: `position_open` and `waiting`. Which one
   * applies is not a property of the request — a preview refusal, an unfilled
   * IOC and a full fill all end the same request differently — so it is read
   * from the reconciled position rather than inferred. Runs on every exit path
   * of an execution, successful or not, because a mission stranded in
   * `executing` would refuse its own next entry only after refusing to leave.
   *
   * The snapshot is what the `after_submission` reconcile just wrote (§18): the
   * canonical position, already converged, with no second exchange round-trip.
   * A request that failed before reaching that reconcile leaves the previous
   * snapshot in place, which is still what the mission holds.
   */
  const settleAfterExecution = Effect.fn("TradingMissionReactor.settleAfterExecution")(function* (
    event: Extract<TradingRequestEvent, { type: "trading.execution-requested" }>,
  ) {
    const { missionId, threadId, intent } = event.payload;
    const mission = yield* missions.getMission(missionId);
    if (mission.status !== "executing") return;

    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly size: number }>`
      SELECT size FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND market = ${intent.market}
    `;
    const size = rows[0]?.size ?? 0;

    yield* advance({
      missionId,
      threadId,
      from: ["executing"],
      to: size === 0 ? "waiting" : "position_open",
    });
  });

  /**
   * Record why an execution request was refused, where the harness can read it.
   *
   * A refusal used to exist only as a server log line, so `trading_request_entry`
   * had nothing to report and the harness carried on as though it had entered.
   * Writing it to the mission inbox puts the reason on both paths that reach the
   * harness: `TradingExecutionOutcome` reads it back for the tool's own return,
   * and the next wakeup carries it as a pending event.
   */
  const recordExecutionRefused = Effect.fn("TradingMissionReactor.recordExecutionRefused")(
    function* (
      event: Extract<TradingRequestEvent, { type: "trading.execution-requested" }>,
      cause: Cause.Cause<unknown>,
    ) {
      const { missionId, intent } = event.payload;
      const occurredAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* inbox.persist({
        missionId,
        category: "system",
        deduplicationKey: executionRefusedKey(intent.executionSequence),
        payload: { executionSequence: intent.executionSequence, cause: Cause.pretty(cause) },
        occurredAt,
        summary: `execution ${intent.executionSequence} refused: ${describeRefusal(cause)}`,
      });
    },
  );

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
      } else if (event.type === "trading.mission-risk-control-requested") {
        yield* processRiskControlRequested(event);
      } else if (event.type === "trading.mission-watch-fired") {
        yield* processWatchFired(event);
      } else if (event.type === "thread.created") {
        yield* processThreadCreated(event);
      } else if (event.type === "thread.settled") {
        yield* processThreadSettled(event);
      } else {
        yield* processExecutionRequested(event).pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : recordExecutionRefused(event, cause).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.ensuring(
            settleAfterExecution(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("trading execution: mission did not leave executing", {
                  missionId: event.payload.missionId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
        );
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
          // The two thread-lifecycle events carry no mission on the payload.
          missionId: "missionId" in event.payload ? event.payload.missionId : undefined,
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
  /**
   * The mission `follow` is currently subscribed for, with the scope that owns
   * its fibers. Held outside the loop so the layer's own teardown can close it.
   */
  let followed: { readonly missionId: string; readonly scope: Scope.Scope } | null = null;

  const stopFollowing = Effect.suspend(() => {
    if (followed === null) return Effect.void;
    const closing = Scope.close(followed.scope, Exit.void);
    followed = null;
    return closing.pipe(Effect.ignore);
  });

  yield* Effect.gen(function* () {
    // Follow whichever mission is active *right now*, not whichever was active
    // first. Two earlier shapes of this loop both went wrong: the build-time
    // check never picked up a mission created later, and the poll that replaced
    // it stopped at the first mission it found and stayed there. A mission that
    // succeeds a revoked one then inherited none of §18.2 — no `after_fill`, no
    // reconnect convergence, no periodic backstop — so its position card kept
    // the mark it was opened at and no fill ever woke the harness. Meanwhile the
    // revoked mission went on polling the exchange forever.
    //
    // Each `follow` gets its own scope so switching missions can close the old
    // subscriptions; the reconcile before it converges the new mission's tables
    // before anything reads them.
    const fillReconciler = yield* TradingFillReconciler;

    // One pass: retarget `follow` if the active mission changed. Failures here
    // are logged and retried on the next tick — a transient read error must not
    // leave the server permanently unsubscribed.
    const syncFollowedMission = Effect.gen(function* () {
      const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);
      const activeId = Option.isSome(active) ? active.value.id : null;

      if (followed !== null && followed.missionId !== activeId) {
        yield* stopFollowing;
      }
      if (Option.isNone(active) || followed !== null) return;

      const mission = active.value;
      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      const input = { missionId: mission.id, masterAddress, market: mission.market };
      yield* reconciler.reconcile(input, "server_startup").pipe(Effect.catch(() => Effect.void));
      const scope = yield* Scope.make("sequential");
      yield* fillReconciler.follow(input).pipe(Scope.provide(scope), Effect.forkScoped);
      followed = { missionId: mission.id, scope };
      yield* Effect.logInfo("trading following mission", { missionId: mission.id });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("trading could not follow the active mission", {
          cause: Cause.pretty(cause),
        });
      }),
    );

    while (true) {
      yield* syncFollowedMission;
      yield* Effect.sleep("5 seconds");
    }
  }).pipe(Effect.ensuring(stopFollowing), Effect.forkScoped);

  /**
   * Follow a position the mission no longer holds back to `waiting`.
   *
   * §11.1 leaves `position_open` on two paths the reactor drives: the next
   * execution request, and a user control. A stop-out drives neither — the
   * exchange flattens the position, §18's `after_fill` converges the snapshot,
   * and the mission goes on reporting `position_open` to every
   * `trading_get_mission` until the harness happens to ask for another entry. A
   * harness that reads its own status as the answer to "am I in a trade" is then
   * wrong for as long as it waits, which is precisely when it should be looking
   * for the next entry.
   *
   * Reads the reconciled snapshot only, so this costs no exchange round-trip,
   * and `advance` declines to move a mission that has since left
   * `position_open` — an execution in progress owns the status until it settles.
   */
  const settleFlatPosition = Effect.fn("TradingMissionReactor.settleFlatPosition")(function* () {
    const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);
    if (Option.isNone(active)) return;
    const mission = active.value;
    if (mission.status !== "position_open") return;

    const missionId = TradingMissionId.make(mission.id);
    if (yield* holdsPosition(missionId)) return;

    yield* advance({
      missionId,
      threadId: mission.harness.threadId as ThreadId,
      from: ["position_open"],
      to: "waiting",
    });
  });

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("5 seconds");
      yield* settleFlatPosition().pipe(Effect.catchCause(() => Effect.void));
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
