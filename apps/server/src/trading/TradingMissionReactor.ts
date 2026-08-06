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
import { PENDING_EXECUTION_STATUSES } from "@t3tools/trading-contracts/execution";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";
import {
  checkStopReplacement,
  isPositionIncreasing,
  PROTECTION_SIZE_EPSILON,
} from "@t3tools/trading-contracts/protection";
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
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { setSessionProfile, clearSessionProfile } from "../provider/SessionProfile.ts";
import type { PersistedWatch, TradingHarnessRunCause } from "./Schemas.ts";
import { executionRefusedKey, executionSettledKey } from "./ExecutionRefusal.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { TradingWatchService } from "./TradingWatchService.ts";
import { TradingExecutionGuard } from "./TradingExecutionGuard.ts";
import {
  HyperliquidExecutionService,
  TradingExecutionError,
} from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingProtectionService } from "./TradingProtectionService.ts";
import { TradingEmergencyCloseService } from "./TradingEmergencyCloseService.ts";
import { TradingControlService } from "./TradingControlService.ts";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingFillReconciler } from "./TradingFillReconciler.ts";
import { InterimSignerConfig } from "./InterimSignerConfig.ts";
import { IocSlippageConfig } from "./IocSlippageConfig.ts";
import { AutoMissionConfig } from "./AutoMissionConfig.ts";
import { resolveMissionCapitalUsd } from "./MissionCapital.ts";
import { ALL_MISSION_STATUSES, isActiveMissionStatus } from "./MissionTransitions.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type TradingRequestEvent = Extract<
  OrchestrationEvent,
  | { type: "trading.mission-create-requested" }
  | { type: "trading.mission-control-requested" }
  | { type: "trading.mission-risk-control-requested" }
  | { type: "trading.mission-watch-fired" }
  | { type: "trading.execution-requested" }
  // Not a trading intent: settling a thread is what ends its mission. Starting
  // one is the first message's job — see `TradingAutoMission`.
  | { type: "thread.settled" }
>;

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-risk-control-requested",
  "trading.mission-watch-fired",
  "trading.execution-requested",
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

/**
 * Warn with the reason, keep the stack for whoever asks for it.
 *
 * A `Cause.pretty` rendering at warn level is a dozen lines of fiber trace
 * wrapped around one sentence, repeated for every failure the reactor
 * swallows — it buries the mission log it is supposed to explain. The sentence
 * goes to warn; the full cause goes to debug, where reading it is a deliberate
 * act.
 */
const warnWithCause = (
  message: string,
  fields: Record<string, unknown>,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logWarning(message, { ...fields, reason: describeRefusal(cause) }).pipe(
    Effect.andThen(Effect.logDebug(message, { ...fields, cause: Cause.pretty(cause) })),
  );

/**
 * The predicate a watch fired on, in one line, for the log.
 *
 * Reads the predicate back rather than interpreting it: "ETH mark crosses above
 * 3100" is what the operator armed, and it is the only thing that explains why
 * the mission woke when it did.
 */
const describeWatchPredicate = (watch: PersistedWatch["watch"]): string => {
  switch (watch.type) {
    case "price_cross":
      return `${watch.market} ${watch.priceSource} crosses ${watch.direction} ${watch.price}`;
    case "candle_close":
      return `${watch.market} ${watch.interval} candle closes ${watch.direction} ${watch.price}`;
    case "order_update":
      return `order ${watch.cloid} updated`;
    case "position_update":
      return `${watch.market} position updated`;
    case "scheduled_reassessment":
      return `scheduled reassessment due at ${watch.runAt}`;
    case "pnl_above":
      return `${watch.market} unrealised PnL reaches $${watch.valueUsd}`;
    case "pnl_below":
      return `${watch.market} unrealised PnL falls to $${watch.valueUsd}`;
    case "pnl_giveback":
      return `${watch.market} unrealised PnL gives back $${watch.drawdownUsd} from its peak`;
  }
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
  const providerRegistry = yield* ProviderRegistry;
  const emergency = yield* TradingEmergencyCloseService;
  const controls = yield* TradingControlService;
  const autoMission = yield* AutoMissionConfig;
  const iocSlippage = yield* IocSlippageConfig;

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
   *
   * `reason` names what drove the step. It is logged rather than persisted: the
   * §11.1 loop is legible from the outside only if each move says which of the
   * handlers below made it, and a mission that silently stops moving is the
   * failure this log is for.
   */
  const advance = Effect.fn("TradingMissionReactor.advance")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly from: ReadonlyArray<TradingMissionStatus>;
    readonly to: TradingMissionStatus;
    readonly reason: string;
  }) {
    const mission = yield* missions.getMission(input.missionId);
    if (!input.from.includes(mission.status)) {
      yield* Effect.logDebug("trading mission transition skipped", {
        missionId: input.missionId,
        status: mission.status,
        to: input.to,
        reason: input.reason,
      });
      return false;
    }

    const expectedVersion = yield* missions.getMissionVersion(input.missionId);
    const updated = yield* missions.transition({
      missionId: input.missionId,
      to: input.to,
      expectedVersion,
    });
    yield* Effect.logInfo("trading mission advanced", {
      missionId: input.missionId,
      from: mission.status,
      to: updated.status,
      reason: input.reason,
    });
    yield* announceStatus({
      missionId: input.missionId,
      threadId: input.threadId,
      status: updated.status,
    });
    // A terminal transition releases the thread from its mission. Drop the
    // trading profile so the adapter stops locking the next session on this
    // thread to the trading tools. `blocked` still holds the thread, so it is
    // deliberately not terminal here.
    if (updated.status === "revoked" || updated.status === "completed") {
      yield* Effect.sync(() => clearSessionProfile(input.threadId));
      // Every permanent terminal ends the same way, including an incumbent
      // revoked by a new thread taking the slot.
      yield* deleteWhenTerminalAndFlat(input.missionId);
    }
    return true;
  });

  /**
   * A mission that has reached a permanent terminal status is finished, and a
   * finished mission is deleted rather than kept.
   *
   * Every settled mission used to live forever, which is the wall of dead rows
   * on the Trading Settings page and the reason a stuck mission could still be
   * found by a projection read weeks later. Deleting is safe only once the
   * position is gone: a row removed while exposure is open would strand real
   * money with no record of who opened it. When the close could not flatten
   * (exchange unreachable), the revoked row stays and the flat sweep below
   * finishes the job when the position finally clears.
   */
  const deleteWhenTerminalAndFlat = Effect.fn("TradingMissionReactor.deleteTerminalMission")(
    function* (missionId: TradingMissionId) {
      if (yield* holdsPosition(missionId)) {
        // Debug, not warning: the deferred-deletion sweep re-checks every few
        // seconds, and the settle path warns once on its own behalf.
        yield* Effect.logDebug("mission deletion deferred: position not flat", { missionId });
        return false;
      }
      yield* missions.deleteMission(missionId);
      yield* Effect.logInfo("deleted a terminal mission", { missionId });
      return true;
    },
  );

  /**
   * The driver kind that runs one configured provider instance, or null when
   * the registry does not know the instance (an id from settings this build has
   * no driver for). A null falls through to `toTradingProvider`'s default.
   */
  const driverKindForInstance = (instanceId: string) =>
    providerRegistry.getProviders.pipe(
      Effect.map(
        (providers) =>
          providers.find((snapshot) => snapshot.instanceId === instanceId)?.driver ?? null,
      ),
    );

  /**
   * Derive the harness binding from the thread the mission is bound to.
   *
   * The provider and instance come from the thread's session (the live provider
   * session the mission's turns will resume). The session usually does not
   * exist yet at mission-create time — the first turn establishes it — so the
   * instance id comes from the thread's model selection, and the driver kind is
   * looked up from the provider registry by that instance id.
   *
   * That lookup is not a nicety. The binding is identity-frozen for an active
   * mission (§10.2), so a provider guessed wrong here can never be corrected,
   * and the workspace reads `harness.provider` as the driver the composer's
   * model picker is locked to (`missionHarnessProvider` in `ChatView`).
   * Defaulting to "codex" bound every OpenCode and Claude mission to a driver
   * that was not the one running the thread, which locked the picker to the
   * wrong provider and left the mission unable to take a follow-up message
   * after its first turn.
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
    const providerInstanceId = session?.providerInstanceId ?? shell.value.modelSelection.instanceId;
    const driverKind = session?.providerName ?? (yield* driverKindForInstance(providerInstanceId));
    return {
      provider: toTradingProvider(driverKind),
      providerInstanceId,
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

    // No stated capital means "size the mandate from the account". Resolved
    // here rather than in `TradingMissionService` because this is where the
    // exchange gateway already is; the service stays SQL-only. See
    // `MissionCapital` for the precedence and why an unreadable account warns
    // instead of blocking.
    const capital = yield* resolveMissionCapitalUsd({
      explicitUsd: allocatedCapitalUsd,
      readAccountValueUsd: missions.getMasterWalletAddress(tradingAccountId).pipe(
        Effect.flatMap((address) => gateway.getAccountSnapshot(address)),
        Effect.map((snapshot) => snapshot.accountValue),
      ),
    });

    yield* missions.createMission({
      missionId,
      userId: LOCAL_TRADING_USER_ID,
      tradingAccountId,
      instruction,
      allocatedCapitalUsd: capital.allocatedCapitalUsd,
      harness,
    });
    // Bind the trading profile to the thread so the provider adapter (the
    // Claude path) locks subsequent sessions to the `mcp__t3-trade__*` tools
    // only. Set here, at mission creation, is what marks this thread as a
    // trading thread for every session it opens while the mission is live.
    yield* Effect.sync(() => setSessionProfile({ threadId, kind: "trading" }));

    // The first line of a mission's story. The mandate scales from this number,
    // so where the number came from belongs next to it.
    yield* Effect.logInfo("trading mission created", {
      missionId,
      threadId,
      tradingAccountId,
      allocatedCapitalUsd: capital.allocatedCapitalUsd,
      capitalSource: capital.source,
      provider: harness.provider,
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
        return warnWithCause(
          "TradingMissionReactor: first run did not start",
          { missionId },
          cause,
        ).pipe(Effect.as(false));
      }),
    );

    // §11.1 `initializing → analysing`: the first run is what the mission was
    // initializing for. A mission whose first run never started stays in
    // `initializing`, which is the accurate description of it.
    if (started) {
      yield* advance({
        missionId,
        threadId,
        from: ["initializing"],
        to: "analysing",
        reason: "first_run_started",
      });
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
   * Whether this mission ever traded.
   *
   * A fill is the whole difference between the two permanent terminals. A
   * mission that opened a thread, published nothing, and was settled has no
   * result to report and is simply `revoked`; one that entered, traded, and came
   * back flat has a realised result, and calling that `revoked` too made
   * `completed` unreachable — the UI's completion summary and the binding
   * query's terminal set were both written against a status nothing ever set.
   */
  const hasRealizedResult = Effect.fn("TradingMissionReactor.hasRealizedResult")(function* (
    missionId: TradingMissionId,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ fill_count: number }>`
      SELECT COUNT(*) AS fill_count FROM trading_fills WHERE mission_id = ${missionId}
    `;
    return (rows[0]?.fill_count ?? 0) > 0;
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
        const status = outcome.status as TradingMissionStatus;
        yield* announceStatus({ missionId, threadId, status });
        if (status === "revoked" || status === "completed") {
          yield* Effect.sync(() => clearSessionProfile(threadId));
          // `closeAndRevoke` flattens before it revokes, so this normally
          // deletes here. When the exchange was unreachable the position is
          // still open, and `deleteFlatTerminalMissions` finishes it later.
          const deleted = yield* deleteWhenTerminalAndFlat(missionId);
          if (!deleted) {
            yield* Effect.logWarning("settle deferred mission deletion: position not flat", {
              missionId,
              threadId,
            });
          }
        }
      }
      return;
    }

    // §11.1's two permanent terminals say different things, and only one of
    // them was ever reachable. A flat mission that traded and hit no
    // deterministic block ended cleanly: that is `completed`. A blocked one did
    // not — its authority was withdrawn by a safety condition, and reporting
    // that as a completed objective would be the more expensive lie.
    const traded = yield* hasRealizedResult(missionId);
    const terminal: TradingMissionStatus =
      traded && mission.status !== "blocked" ? "completed" : "revoked";

    yield* Effect.logInfo("settle ended a flat mission", {
      missionId,
      threadId,
      terminal,
      traded,
      status: mission.status,
    });
    yield* advance({
      missionId,
      threadId,
      from: ALL_MISSION_STATUSES.filter(isActiveMissionStatus),
      to: terminal,
      reason: "thread_settled",
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

    yield* Effect.logInfo("trading watch fired", {
      missionId,
      watchId,
      watchType: watch?.watch.type,
      cause,
      armedReason: watch?.armedReason,
      summary: watch === null ? undefined : describeWatchPredicate(watch.watch),
    });

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
            attempt: attempt + 1,
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
        attempts: QUEUE_RETRY_LIMIT,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        warnWithCause(
          "TradingMissionReactor: watch-fired run request failed",
          { missionId, watchId },
          cause,
        ),
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
   * Withdraw one resting order the harness placed (`actionType: "cancel"`).
   *
   * The order is named by `targetCloid` and looked up against this mission's
   * own rows — the harness may only cancel what its mission owns, and the
   * lookup is what enforces that rather than trusting the cloid it was handed.
   *
   * A position-increasing parent goes through §17.3's protect-then-cancel
   * ordering, because cancelling a partially filled parent takes its linked
   * TP/SL children with it and would strip the filled slice of its only stop.
   * Anything else — a resting order with no recorded stop — is cancelled
   * plainly.
   */
  const cancelRestingOrder = Effect.fn("TradingMissionReactor.cancelRestingOrder")(
    function* (input: {
      readonly missionId: TradingMissionId;
      readonly intent: TradingOrderIntent;
      readonly masterAddress: string;
    }) {
      const { missionId, intent, masterAddress } = input;
      const targetCloid = intent.targetCloid;
      if (targetCloid === undefined) {
        return yield* new TradingExecutionError({
          stage: "intent_invalid",
          detail:
            "a cancel names the order it withdraws: supply targetCloid, the client order id " +
            "read from trading_get_open_orders",
        });
      }

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly action_type: string;
        readonly stop_price: number | null;
      }>`
      SELECT e.action_type, e.stop_price
      FROM trading_orders o
      JOIN trading_execution_records e ON e.cloid = o.cloid
      WHERE o.mission_id = ${missionId} AND o.cloid = ${targetCloid}
    `;
      const order = rows[0];
      if (order === undefined) {
        return yield* new TradingExecutionError({
          stage: "intent_invalid",
          detail: `no resting order ${targetCloid} belongs to this mission`,
        });
      }

      if (isPositionIncreasing(order.action_type) && order.stop_price !== null) {
        const outcome = yield* protection.cancelEntriesWithProtection({
          missionId,
          strategyVersion: intent.strategyVersion,
          executionSequence: intent.executionSequence,
          masterAddress,
          market: intent.market,
          stopPrice: order.stop_price,
          cloids: [targetCloid],
        });
        if (outcome.status === "escalate") {
          return yield* new TradingExecutionError({
            stage: "intent_invalid",
            detail:
              `order ${targetCloid} was left resting: the already-filled size could not be ` +
              `protected first (${outcome.escalationReason ?? "protection unconfirmed"})`,
          });
        }
        return `order ${targetCloid} cancelled; the filled size keeps its stop`;
      }

      yield* execution.submitCancel({ market: intent.market, cloid: targetCloid });
      return `order ${targetCloid} cancelled`;
    },
  );

  /**
   * Move the stop on an open position (`actionType: "modify_stop"`).
   *
   * The whole reason this exists: protection is placed once at entry, so
   * trailing a stop or pulling it to break-even had no path at all. The new
   * price is checked against a fresh mid before anything is submitted — an
   * unreachable stop would otherwise fail to confirm, and a failure to confirm
   * escalates to a close, which is a violent answer to a typo'd number.
   */
  const modifyStop = Effect.fn("TradingMissionReactor.modifyStop")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly intent: TradingOrderIntent;
    readonly masterAddress: string;
    readonly bbo: {
      readonly bidPrice?: number | undefined;
      readonly askPrice?: number | undefined;
    };
  }) {
    const { missionId, threadId, intent, masterAddress, bbo } = input;
    const stop = intent.stop;
    if (stop === undefined) {
      return yield* new TradingExecutionError({
        stage: "intent_invalid",
        detail: "modify_stop carries the new protection: supply stop.stopPrice",
      });
    }

    // A one-sided book gives no usable mid, and this check is the only thing
    // standing between a typo'd stop and an escalation to a forced close.
    // Refuse rather than pick a side.
    const { bidPrice, askPrice } = bbo;
    if (bidPrice === undefined || askPrice === undefined) {
      return yield* new TradingExecutionError({
        stage: "intent_invalid",
        detail: "no two-sided book to price the new stop against; retry when the book is quoted",
      });
    }
    const midPrice = (bidPrice + askPrice) / 2;

    // The position this protects, as the `before_execution` reconcile left it.
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly size: number }>`
      SELECT size FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND market = ${intent.market}
    `;
    const positionSize = rows[0]?.size ?? 0;
    if (positionSize === 0) {
      return yield* new TradingExecutionError({
        stage: "intent_invalid",
        detail: "modify_stop needs an open position; this mission is flat",
      });
    }

    const defect = checkStopReplacement({
      positionSize,
      referencePrice: midPrice,
      stopPrice: stop.stopPrice,
    });
    if (defect !== null) {
      return yield* new TradingExecutionError({
        stage: "intent_invalid",
        detail:
          `${defect}: stop ${stop.stopPrice} against mid ${midPrice} for a ` +
          `${positionSize > 0 ? "long" : "short"} of ${positionSize}`,
      });
    }

    const outcome = yield* protection.replaceProtection({
      missionId,
      strategyVersion: intent.strategyVersion,
      executionSequence: intent.executionSequence,
      masterAddress,
      market: intent.market,
      stopPrice: stop.stopPrice,
    });

    if (outcome.status !== "escalate") {
      yield* Effect.logInfo("trading stop replaced", {
        missionId,
        status: outcome.status,
        stopPrice: stop.stopPrice,
        protectedSize: outcome.protectedSize,
        replacedCloids: outcome.replacedCloids,
      });
      return (
        `stop moved to ${stop.stopPrice}; ${outcome.protectedSize} of the position is ` +
        `confirmed protected`
      );
    }

    yield* Effect.logError("trading stop replacement left the position uncovered; escalating", {
      missionId,
      reason: outcome.escalationReason,
    });
    yield* emergency.emergencyClose({
      missionId,
      masterAddress,
      market: intent.market,
      reason: outcome.escalationReason ?? "stop replacement could not be confirmed",
    });
    yield* announceStatus({ missionId, threadId, status: "blocked" });
    // The stop move did not happen and the position was closed out from under
    // it. Failing here is what puts that on the tool's own answer instead of
    // leaving the harness to read "succeeded" for a mission that is now flat
    // and blocked.
    return yield* new TradingExecutionError({
      stage: "intent_invalid",
      detail:
        `the new stop could not be confirmed (${outcome.escalationReason ?? "unconfirmed"}); ` +
        `the position was closed under §17.5 and the mission is blocked`,
    });
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
   * Record what a deterministic action did, where the harness can read it.
   *
   * `cancel` and `modify_stop` write no execution record — they place no order
   * of their own — so `TradingExecutionOutcome` had nothing to find and sat out
   * its full twenty-second deadline before answering "still in flight" for an
   * action that had already succeeded. This is that answer.
   */
  const recordExecutionSettled = Effect.fn("TradingMissionReactor.recordExecutionSettled")(
    function* (executionSequence: number, missionId: TradingMissionId, summary: string) {
      const occurredAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* inbox.persist({
        missionId,
        category: "system",
        deduplicationKey: executionSettledKey(executionSequence),
        payload: { executionSequence, summary },
        occurredAt,
        summary,
      });
    },
  );

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
    yield* advance({
      missionId,
      threadId,
      from: ["waiting", "position_open"],
      to: "executing",
      reason: `execution_requested:${intent.actionType}`,
    });

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
    // Preview item 16 exists to stop two submit sequences racing one nonce and
    // idempotency window, and that is all it should stop. "In flight" is
    // therefore the mid-submission statuses only: a record the exchange has
    // already acknowledged is resting on the book, which is visible, manageable
    // state — the harness must be able to reduce, close, cancel, or move a stop
    // while an entry rests. Counting `accepted` here is what made one filled
    // entry permanently lock the mission out of every subsequent write.
    const pendingRows = yield* sql<{
      readonly cloid: string;
      readonly action_type: string;
      readonly status: string;
      readonly updated_at: number;
    }>`
      SELECT cloid, action_type, status, updated_at FROM trading_execution_records
      WHERE mission_id = ${missionId}
        AND ${sql.in("status", PENDING_EXECUTION_STATUSES)}
      ORDER BY updated_at ASC
      LIMIT 1
    `;
    const blocking = pendingRows[0];
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
        pendingExecution:
          blocking === undefined
            ? null
            : {
                cloid: blocking.cloid,
                actionType: blocking.action_type,
                status: blocking.status,
                ageMillis: Math.max(0, budgetInput.observedAt - blocking.updated_at),
              },
        budget: budgetInput,
        takerFeeRateBps: feeRate,
        stopSlippageReserveBps,
        nowMs: budgetInput.observedAt,
      },
      allowedSlippageBps: (yield* iocSlippage.resolve).entryBps,
    };
    // Which of the five write paths this intent is. `reduce` and `close` never
    // reach `submitOrder`: both go through the guard, which forces reduce-only
    // on the wire and sizes the exit against the canonical position. That is
    // what stops a `reduce` with `reduceOnly: false` from crossing through flat
    // into an unprotected reversal `allowDirectionReversal: false` forbids.
    if (intent.actionType === "close") {
      yield* guard.reduceOnlyClose(executionInput);
    } else if (intent.actionType === "reduce") {
      yield* guard.reduceOnlySized(executionInput);
    } else if (intent.actionType === "cancel") {
      const summary = yield* cancelRestingOrder({ missionId, intent, masterAddress });
      yield* recordExecutionSettled(intent.executionSequence, missionId, summary);
    } else if (intent.actionType === "modify_stop") {
      const summary = yield* modifyStop({
        missionId,
        threadId,
        intent,
        masterAddress,
        bbo: orderBook.bestBidOffer,
      });
      yield* recordExecutionSettled(intent.executionSequence, missionId, summary);
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
      reason: "execution_settled",
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
                warnWithCause(
                  "trading execution: mission did not leave executing",
                  { missionId: event.payload.missionId },
                  cause,
                ),
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
        return warnWithCause(
          "trading mission reactor could not apply a requested intent",
          {
            eventType: event.type,
            // The two thread-lifecycle events carry no mission on the payload.
            missionId: "missionId" in event.payload ? event.payload.missionId : undefined,
          },
          cause,
        );
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
        return warnWithCause("trading could not follow the active mission", {}, cause);
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
      reason: "position_went_flat",
    });
  });

  /**
   * Notice a stop that is no longer there, and put it back.
   *
   * Protection is placed and confirmed at entry, on a `modify_stop`, and on a
   * cancel-with-protection — all of them executions. Outside an execution
   * nothing ever compared the confirmed protected size to the position again,
   * so a stop cancelled by hand in the exchange UI left the position naked for
   * as long as it stayed open, with every local read still reporting the
   * protected size the last execution confirmed.
   *
   * The comparison is against the reconciled snapshot the fill reconciler keeps
   * current, so this costs no exchange round-trip on the common path where
   * nothing is wrong. When it is wrong, `reconcileProtection` is the same
   * routine every other protection repair runs, and the same §17.5 escalation
   * applies when it cannot confirm a replacement.
   */
  const guardProtection = Effect.fn("TradingMissionReactor.guardProtection")(function* () {
    const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);
    if (Option.isNone(active)) return;
    const mission = active.value;
    // Only while the mission is simply holding a position. An execution in
    // progress owns protection for the duration and reconciles it itself.
    if (mission.status !== "position_open") return;

    const missionId = TradingMissionId.make(mission.id);
    const threadId = mission.harness.threadId as ThreadId;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly size: number; readonly protected_size: number }>`
      SELECT size, protected_size FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND market = ${mission.market}
    `;
    const snapshot = rows[0];
    if (snapshot === undefined) return;

    const exposed = Math.abs(snapshot.size);
    if (exposed === 0) return;
    if (snapshot.protected_size >= exposed - PROTECTION_SIZE_EPSILON) return;

    // The price the last approved stop was set at. Without one there is nothing
    // to re-place — a position that never had a stop is not this loop's problem.
    const stops = yield* sql<{ readonly stop_price: number }>`
      SELECT stop_price FROM trading_execution_records
      WHERE mission_id = ${missionId} AND stop_price IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    const stopPrice = stops[0]?.stop_price;
    if (stopPrice === undefined) return;

    const occurredAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const summary =
      `protection_lost: ${exposed} of ${mission.market} is open with only ` +
      `${snapshot.protected_size} confirmed protected; re-placing the stop at ${stopPrice}`;
    yield* inbox
      .persist({
        missionId,
        category: "exchange",
        deduplicationKey: `protection_lost:${occurredAt}`,
        payload: { size: snapshot.size, protectedSize: snapshot.protected_size, stopPrice },
        occurredAt,
        summary,
      })
      .pipe(Effect.ignore);
    yield* Effect.logWarning("trading protection watchdog found an uncovered position", {
      missionId,
      size: snapshot.size,
      protectedSize: snapshot.protected_size,
    });

    const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
    const outcome = yield* protection.reconcileProtection({
      missionId,
      strategyVersion: mission.strategyVersion,
      // Not a harness execution, so there is no sequence to borrow. Epoch
      // seconds keeps each watchdog placement's cloid distinct from the last
      // one's and from every harness sequence, which are small counters.
      executionSequence: Math.floor(occurredAt / 1000),
      masterAddress,
      market: mission.market,
      stopPrice,
    });

    if (outcome.status === "escalate") {
      yield* Effect.logError("trading protection watchdog could not re-place the stop; §17.5", {
        missionId,
        reason: outcome.escalationReason,
      });
      yield* emergency.emergencyClose({
        missionId,
        masterAddress,
        market: mission.market,
        reason: outcome.escalationReason ?? "protection was removed and could not be re-placed",
      });
      yield* announceStatus({ missionId, threadId, status: "blocked" });
    }

    // Either way the harness is told: its stop was pulled out from under it.
    yield* coordinator.requestRun({ missionId, cause: "order_updated" }).pipe(Effect.ignore);
  });

  /**
   * Finish the deletions a settle could not.
   *
   * A mission revoked while the exchange was unreachable keeps its row and its
   * position banner until the position is actually gone. The reconciler is what
   * eventually notices, and this is the pass that acts on it — otherwise the
   * only terminal missions that ever got deleted would be the ones that settled
   * cleanly, which is exactly the case that needed no help.
   */
  const deleteFlatTerminalMissions = Effect.fn("TradingMissionReactor.deleteFlatTerminal")(
    function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly mission_id: string }>`
        SELECT mission_id FROM trading_missions WHERE status IN ('revoked', 'completed')
      `;
      for (const row of rows) {
        yield* deleteWhenTerminalAndFlat(TradingMissionId.make(row.mission_id));
      }
    },
  );

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("5 seconds");
      yield* settleFlatPosition().pipe(Effect.catchCause(() => Effect.void));
      yield* deleteFlatTerminalMissions().pipe(Effect.catchCause(() => Effect.void));
      yield* guardProtection().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : warnWithCause("trading protection watchdog pass failed", {}, cause),
        ),
      );
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
