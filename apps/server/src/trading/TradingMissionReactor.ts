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
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";
import {
  plannedLossAtStopUsd,
  stopDecisionWakePnlUsd,
  stopProximityWatchLevel,
} from "@t3tools/trading-contracts/stop-adjustment";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import { runtimeTimeframe, TradingTimeframe } from "@t3tools/trading-contracts/strategy";
import { PENDING_EXECUTION_STATUSES } from "@t3tools/trading-contracts/execution";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";
import {
  checkStopReplacement,
  isPositionIncreasing,
  PROTECTION_SIZE_EPSILON,
} from "@t3tools/trading-contracts/protection";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Schema } from "effect";
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
import {
  executionRefusedKey,
  executionSettledKey,
  workingOrderOutcomeKey,
} from "./ExecutionRefusal.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingExecutionReceipts } from "./TradingExecutionReceipts.ts";
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
import { TradingWorkingOrderService } from "./TradingWorkingOrderService.ts";
import { TradingEmergencyCloseService } from "./TradingEmergencyCloseService.ts";
import { TradingControlService } from "./TradingControlService.ts";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingFillReconciler } from "./TradingFillReconciler.ts";
import { InterimSignerConfig } from "./InterimSignerConfig.ts";
import { IocSlippageConfig } from "./IocSlippageConfig.ts";
import { resolveMissionCapitalUsd } from "./MissionCapital.ts";
import { ALL_MISSION_STATUSES, isActiveMissionStatus } from "./MissionTransitions.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordExchangeOutcome, recordExecutionRefusal } from "./TradingRunTelemetry.ts";

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

/**
 * The timeframe the mission's cadences measure on: the mandate's interval, or
 * `1m` — the same `runtimeTimeframe` rule the wakeup composer and the coverage
 * floor use.
 *
 * This used to read the plan's published `timeframes[0]`; the plan no longer
 * names timeframes (plan 29 step 4.1), so the mission's own instruction is the
 * source. Anything unreadable — no mission row, a NULL instruction — falls
 * back to the POC default, which is the same thing the coverage floor does: a
 * mission between strategies still gets a cadence. Reading the row rather
 * than taking a `TradingMissionService` dependency keeps the reactor's layer
 * exactly as wide as it was.
 */
const primaryTimeframeFromMission = (missionId: TradingMissionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly instruction: string | null }>`
      SELECT instruction FROM trading_missions WHERE mission_id = ${missionId}
    `;
    return runtimeTimeframe(rows[0]?.instruction ?? "");
  });

/**
 * The active plan's target, read as numbers rather than through the strategy
 * decoder — a reconciliation that refused to act because a historical prose
 * field stopped decoding would leave a take-profit resting against a plan that
 * had withdrawn it.
 *
 * Null when the mission has published nothing or stood aside
 * (`intent: "stand_aside"` — the stand-down of the old schema, and the same
 * skip it performed); the price rung is null when the plan published neither a
 * take-profit price nor a target. Hoisted to module scope so the stand-aside
 * skip is testable without the whole reactor layer.
 */
export const moduleReadPlanTarget = (missionId: TradingMissionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly take_profit_price: number | null;
      readonly target_profit_usd: number | null;
      readonly stand_aside: number | null;
    }>`
      SELECT
        json_extract(s.strategy_json, '$.target.price') AS take_profit_price,
        json_extract(s.strategy_json, '$.target.profitUsd') AS target_profit_usd,
        json_extract(s.strategy_json, '$.intent') = 'stand_aside' AS stand_aside
      FROM trading_plan_history s
      WHERE s.mission_id = ${missionId}
      ORDER BY s.version DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined || row.stand_aside === 1) return null;
    return {
      takeProfitPrice: row.take_profit_price,
      targetProfitUsd: row.target_profit_usd,
    };
  });

/**
 * The current plan's publication facts for the working-order backstop: when it
 * was published and whether it stood aside. Read as numbers and a flag rather
 * than through the plan decoder — the same posture as `moduleReadPlanTarget`.
 * Null when the mission has published nothing.
 */
export const moduleReadPlanPublication = (missionId: TradingMissionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly published_at: number;
      readonly stand_aside: number;
    }>`
      SELECT created_at AS published_at,
             json_extract(strategy_json, '$.intent') = 'stand_aside' AS stand_aside
      FROM trading_plan_history
      WHERE mission_id = ${missionId}
      ORDER BY version DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return { publishedAt: row.published_at, standAside: row.stand_aside === 1 };
  });

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
  const receipts = yield* TradingExecutionReceipts;
  const crypto = yield* Crypto.Crypto;
  const guard = yield* TradingExecutionGuard;
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;
  const budgetReader = yield* TradingBudgetReader;
  const gateway = yield* HyperliquidGateway;
  const signerConfig = yield* InterimSignerConfig;
  const protection = yield* TradingProtectionService;
  const workingOrders = yield* TradingWorkingOrderService;
  const providerRegistry = yield* ProviderRegistry;
  const emergency = yield* TradingEmergencyCloseService;
  const controls = yield* TradingControlService;
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
    }
    return true;
  });

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
    const { missionId, threadId, tradingAccountId, instruction, allocatedCapitalUsd, market } =
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
      ...(market === undefined ? {} : { market }),
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
          yield* retireWorkingOrdersQuietly({
            missionId,
            tradingAccountId: mission.tradingAccountId,
            market: mission.market,
            reason: "the thread was settled",
          });
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
    // Whatever resting entry the mission left behind goes with it — a flat
    // settle skips the close-and-revoke path that cancels entries for a
    // position, and a patient entry must not outlive its mission.
    yield* retireWorkingOrdersQuietly({
      missionId,
      tradingAccountId: mission.tradingAccountId,
      market: mission.market,
      reason: "the thread was settled",
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

    // A user's Revoke ends the mission the same way a settle does: the thread
    // is released, and the row stays as the mission's permanent record.
    if (updated.status === "revoked" || updated.status === "completed") {
      yield* Effect.sync(() => clearSessionProfile(threadId));
      yield* retireWorkingOrdersQuietly({
        missionId,
        tradingAccountId: mission.tradingAccountId,
        market: mission.market,
        reason: `the mission was ${updated.status}`,
      });
    }
  });

  /**
   * Arm — or re-level — the stop-proximity watch (plan 24 §5.4) and the
   * stop-decision wake (plan 27 G4).
   *
   * The stop is the point where the exchange takes the decision. This is the
   * wake one ATR before that, so the decision is still the harness's: tighten
   * into strength, hold, or exit deliberately. It is armed from the two places
   * a confirmed stop comes into existence — the entry that placed it and every
   * replacement that moved it — so the level always follows the stop actually
   * resting rather than one that was true a move ago.
   *
   * Re-arming goes through `replacesWatchId`, so there is never more than one
   * of these on a mission and the old level is cancelled in the same
   * transaction that writes the new one.
   *
   * Best-effort by design: this runs after the protection it describes is
   * already confirmed, and a mission with a live stop and no proximity watch is
   * protected, just less forewarned. It never fails the execution that armed it.
   */
  const armStopProximityWatch = Effect.fn("TradingMissionReactor.armStopProximityWatch")(
    function* (input: {
      readonly missionId: TradingMissionId;
      readonly market: TradingMarket;
      readonly stopPrice: number;
    }) {
      const { missionId, market, stopPrice } = input;
      const sql = yield* SqlClient.SqlClient;

      const positions = yield* sql<{
        readonly size: number;
        readonly mark_px: number | null;
        readonly entry_price: number | null;
      }>`
        SELECT size, mark_px, entry_price FROM trading_position_snapshots
        WHERE mission_id = ${missionId} AND market = ${market} AND size != 0
      `;
      const position = positions[0];
      if (position === undefined || position.mark_px === null) return;

      // The mission's runtime timeframe drives the ATR, the same one every
      // other cadence in the mission is measured on (see
      // `primaryTimeframeFromMission`).
      const timeframe = yield* primaryTimeframeFromMission(missionId);

      const history = yield* gateway.getMarketHistory({
        market,
        interval: timeframe,
        maxBars: VOLATILITY_LOOKBACK_BARS,
      });
      const volatility = measureVolatility({
        market,
        interval: timeframe,
        candles: history.candles,
        measuredAt: history.freshness.observedAt,
      });

      // Plan 27 G4: the decision wake at ~70% of the way to the stop, as
      // unrealised PnL. The price-anchored proximity watch below goes silent
      // when the stop sits under one ATR away; this one always has a level
      // while the stop can still lose. One per mission, following the stop
      // that actually rests.
      const existingDecision = yield* sql<{ readonly watch_id: string }>`
        SELECT watch_id FROM trading_watches
        WHERE mission_id = ${missionId} AND status = 'active' AND armed_reason = 'stop_decision'
        ORDER BY created_at DESC
      `;
      const replacesDecision = existingDecision[0]?.watch_id;
      const wakePnlUsd =
        position.entry_price === null
          ? null
          : stopDecisionWakePnlUsd(
              plannedLossAtStopUsd({
                positionSize: position.size,
                entryPrice: position.entry_price,
                stopPrice,
              }),
            );
      if (wakePnlUsd === null) {
        // A stop at or past breakeven cannot lose; a wake about losing to it
        // has nothing to ask.
        if (replacesDecision !== undefined) {
          yield* watches.cancelWatch({ missionId, watchId: replacesDecision });
        }
      } else {
        const decision = yield* watches.registerWatch({
          missionId,
          watch: { type: "pnl_below", market, valueUsd: wakePnlUsd },
          armedReason: "stop_decision",
          replacesWatchId: replacesDecision,
        });
        yield* Effect.logInfo("trading armed the stop-decision wake", {
          missionId,
          watchId: decision.watch.id,
          stopPrice,
          valueUsd: wakePnlUsd,
          replaces: replacesDecision,
        });
      }

      const level = stopProximityWatchLevel({
        positionSize: position.size,
        stopPrice,
        markPrice: position.mark_px,
        atrUsd: volatility.atrUsd,
      });

      // No usable ATR, or the level is already through the mark. A watch that
      // was true before it was written is an immediate wake, not coverage.
      const existing = yield* sql<{ readonly watch_id: string }>`
        SELECT watch_id FROM trading_watches
        WHERE mission_id = ${missionId} AND status = 'active' AND armed_reason = 'stop_proximity'
        ORDER BY created_at DESC
      `;
      const replaces = existing[0]?.watch_id;

      if (level === null) {
        if (replaces !== undefined) yield* watches.cancelWatch({ missionId, watchId: replaces });
        return;
      }

      const { watch } = yield* watches.registerWatch({
        missionId,
        watch: {
          type: "price_cross",
          market,
          priceSource: "mark",
          direction: level.direction,
          price: level.price,
        },
        armedReason: "stop_proximity",
        replacesWatchId: replaces,
      });
      yield* Effect.logInfo("trading armed the stop-proximity watch", {
        missionId,
        watchId: watch.id,
        stopPrice,
        price: level.price,
        direction: level.direction,
        atrUsd: volatility.atrUsd,
        replaces,
      });
    },
  );

  /** Never let arming a wake break the execution that confirmed the stop. */
  const armStopProximityWatchQuietly = (input: {
    readonly missionId: TradingMissionId;
    readonly market: TradingMarket;
    readonly stopPrice: number;
  }) =>
    armStopProximityWatch(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("trading could not arm the stop-proximity watch", {
          missionId: input.missionId,
          cause: String(cause),
        }),
      ),
    );

  // --- plan 29 step 2.5: keep a resting reduce-only take-profit on the book --

  /**
   * The active plan's target — see the module-scope `moduleReadPlanTarget` for
   * what it reads and why it is not decoded through the strategy schema.
   */
  const readPlanTarget = moduleReadPlanTarget;

  /**
   * The cloids of reduce-only orders the HARNESS itself rested — a `patient`
   * exit (plan 29 step 2.3) and nothing else, since every other exit crosses
   * and never rests. They are handed to the take-profit reconcile as orders
   * it must leave alone: a patient exit and a take-profit are the same shape
   * on the book, and only the record says which one the model asked for.
   */
  const readHarnessRestingExitCloids = (input: {
    readonly missionId: TradingMissionId;
    readonly market: TradingMarket;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly cloid: string }>`
        SELECT cloid FROM trading_execution_records
        WHERE mission_id = ${input.missionId}
          AND market = ${input.market}
          AND reduce_only = 1
          AND time_in_force = 'alo'
          AND status IN ('submitted', 'accepted')
      `;
      return rows.map((row) => row.cloid);
    }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  /**
   * Converge the resting take-profit to the plan: the protection service
   * reads canonical state and places, replaces, or withdraws the reduce-only
   * ALO at the plan's derived target price. Failures log and wait for the
   * next pass — the stop keeps the downside, so nothing here escalates.
   */
  const reconcileTakeProtectionFor = Effect.fn("TradingMissionReactor.reconcileTakeProtectionFor")(
    function* (input: {
      readonly missionId: TradingMissionId;
      readonly market: TradingMarket;
      readonly masterAddress: string;
      /** Varies the placement cloid across passes; watchdog passes use epoch seconds. */
      readonly executionSequence: number;
    }) {
      const target = yield* readPlanTarget(input.missionId);
      const preserveCloids = yield* readHarnessRestingExitCloids({
        missionId: input.missionId,
        market: input.market,
      });
      const outcome = yield* protection.reconcileTakeProtection({
        missionId: input.missionId,
        executionSequence: input.executionSequence,
        masterAddress: input.masterAddress,
        market: input.market,
        target,
        preserveCloids,
      });
      yield* Effect.logInfo("trading take-profit reconciled", {
        missionId: input.missionId,
        status: outcome.status,
        targetPrice: outcome.targetPrice,
        positionSize: outcome.positionSize,
        cancelledCloids: outcome.cancelledCloids,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
      return outcome;
    },
  );

  /** Never let the take-profit break the flow it is attached to. */
  const reconcileTakeProtectionQuietly = (input: {
    readonly missionId: TradingMissionId;
    readonly market: TradingMarket;
    readonly masterAddress: string;
    readonly executionSequence: number;
  }) =>
    reconcileTakeProtectionFor(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("trading could not reconcile the take-profit", {
          missionId: input.missionId,
          reason: describeRefusal(cause),
        }),
      ),
    );

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
      // The stop that now rests is the one the proximity wake is measured from.
      yield* armStopProximityWatchQuietly({
        missionId,
        market: intent.market,
        stopPrice: stop.stopPrice,
      });
      // The entry that opened the position also banks its profit target: the
      // plan's take-profit goes from published to resting here (plan 29 step
      // 2.5). Quietly — a take-profit that cannot rest never fails the
      // execution that just confirmed the stop.
      yield* reconcileTakeProtectionQuietly({
        missionId,
        market: intent.market,
        masterAddress,
        executionSequence: intent.executionSequence,
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
            "read from trading_look",
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
      // The level follows the stop: every move re-levels the proximity wake.
      yield* armStopProximityWatchQuietly({
        missionId,
        market: intent.market,
        stopPrice: stop.stopPrice,
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
      const status = outcome.status as TradingMissionStatus;
      yield* announceStatus({ missionId, threadId, status });
      if (status === "revoked" || status === "completed") {
        yield* retireWorkingOrdersQuietly({
          missionId,
          tradingAccountId: mission.tradingAccountId,
          market: mission.market,
          reason: `the ${control} control ended the mission`,
        });
      }
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
    const activeRunRows = yield* sql<{ readonly run_id: string }>`
      SELECT run_id FROM trading_harness_runs
      WHERE mission_id = ${missionId} AND status NOT IN ('completed', 'failed')
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const currentHarnessRunId = activeRunRows[0]?.run_id ?? null;
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
        currentAuthorityVersion: mission.authorityVersion,
        expectedAuthorityVersion,
        activeHarnessRunId: currentHarnessRunId,
        requestingHarnessRunId: activeHarnessRunId,
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
    let exchangeStatus = "succeeded";
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
      const record = yield* execution.submitOrder(executionInput);
      exchangeStatus = record.status;
    }

    // An order reached the exchange. The funnel counts that separately from a
    // published plan: it is the only outcome that ends in exposure.
    yield* recordExchangeOutcome(yield* SqlClient.SqlClient, {
      missionId,
      action: intent.actionType,
      status: exchangeStatus,
    }).pipe(Effect.catchCause(() => Effect.void));

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
   * A refusal used to exist only as a server log line, so the entry tool
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

      // The same refusal on the decision funnel: a run that tried to trade and
      // was stopped by a gate is a different outcome from one that never tried.
      const sql = yield* SqlClient.SqlClient;
      yield* recordExecutionRefusal(sql, {
        missionId,
        reason: describeRefusal(cause),
      }).pipe(Effect.catchCause(() => Effect.void));
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
              // Last, and only last: the tool waiting on this request wakes the
              // moment the latch opens and immediately reads the durable
              // record. Signalling any earlier — before the refusal above is
              // written, before the mission has left `executing` — wakes it to
              // read state that is not there yet, and it reports an execution
              // that has finished as still in flight.
              Effect.andThen(
                receipts.settle({
                  missionId: event.payload.missionId,
                  executionSequence: event.payload.intent.executionSequence,
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
   * `trading_look` until the harness happens to ask for another entry. A
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

    const wentFlat = yield* advance({
      missionId,
      threadId: mission.harness.threadId as ThreadId,
      from: ["position_open"],
      to: "waiting",
      reason: "position_went_flat",
    });
    if (!wentFlat) return;

    // The position that just left can leave a resting take-profit behind (a
    // stop-out takes the position without taking the profit order). The
    // exchange usually retires reduce-only orders with the position; this is
    // the belt. The stop path is deliberately not touched here — withdrawing
    // stops is not this loop's invariant to own.
    const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
    const occurredAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    yield* reconcileTakeProtectionQuietly({
      missionId,
      market: mission.market,
      masterAddress,
      // No harness execution to borrow a sequence from; epoch seconds keep
      // this pass's cloid distinct, the same trick the stop watchdog uses.
      executionSequence: Math.floor(occurredAt / 1000),
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
   * Keep the resting take-profit converged to the plan (plan 29 step 2.5).
   *
   * Runs on the same five-second cadence as the protection watchdog and for
   * the same reason: the plan can change (a publish that moved the target) or
   * the book can change (an order cancelled by hand) between harness turns,
   * and nothing else watches the profit side. Only while simply holding — an
   * execution in progress reconciles the take-profit itself.
   */
  const guardTakeProfit = Effect.fn("TradingMissionReactor.guardTakeProfit")(function* () {
    const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);
    if (Option.isNone(active)) return;
    const mission = active.value;
    if (mission.status !== "position_open") return;

    const missionId = TradingMissionId.make(mission.id);
    const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
    const occurredAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    yield* reconcileTakeProtectionFor({
      missionId,
      market: mission.market,
      masterAddress,
      // Not a harness execution, so there is no sequence to borrow; epoch
      // seconds keep each pass's cloid distinct — the same trick the stop
      // watchdog uses.
      executionSequence: Math.floor(occurredAt / 1000),
    });
  });

  /**
   * Own the resting patient entry (plan 29 step 2.4).
   *
   * Runs on the same five-second cadence as the other guards and for the same
   * reason: between harness turns nothing else watches a post-only entry, and
   * an unowned one either goes stale at a price the market left or fills at
   * the worst moment. The service decides (re-price / cross / abandon / do
   * nothing); this pass supplies the mission's facts and tells the model what
   * a terminal outcome did.
   */
  const guardWorkingOrder = Effect.fn("TradingMissionReactor.guardWorkingOrder")(function* () {
    const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);
    if (Option.isNone(active)) return;
    const mission = active.value;

    const missionId = TradingMissionId.make(mission.id);
    const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
    const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

    const outcome = yield* workingOrders.reconcile({
      missionId,
      masterAddress,
      market: mission.market,
      missionStatus: mission.status,
      plan: yield* moduleReadPlanPublication(missionId),
      nowMs,
      allowedSlippageBps: (yield* iocSlippage.resolve).entryBps,
    });

    yield* Effect.logDebug("trading working order pass", {
      missionId,
      status: outcome.status,
      cloid: outcome.cloid,
      waitMillis: outcome.waitMillis,
      repriceCount: outcome.repriceCount,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
    if (outcome.status !== "crossed" && outcome.status !== "abandoned") return;

    // Terminal outcomes are the model's business: one plain line, pending in
    // the inbox, and a wake to let it re-decide. Keyed by the record's cloid
    // so the reconciler's settle grace cannot queue the same line twice.
    yield* inbox
      .persist({
        missionId,
        category: "exchange",
        deduplicationKey: workingOrderOutcomeKey(outcome.status, outcome.cloid ?? "unknown"),
        payload: { status: outcome.status, cloid: outcome.cloid },
        occurredAt: nowMs,
        summary: outcome.summary ?? `patient entry ${outcome.status}`,
      })
      .pipe(Effect.ignore);

    // A cross opened a position outside any turn, so the post-fill steps the
    // wake's own execution path runs are this pass's to run: confirm the stop
    // against canonical state (§17.5 escalates if it cannot — the grouped
    // stop child went out with the entry, but §17.1 says a submission proves
    // nothing), then arm the proximity wake and the take-profit. The mission
    // then walks the same two legal edges an execution walks, so the
    // position_open guards start watching what the cross opened.
    if (outcome.status === "crossed" && outcome.placedIntent !== undefined) {
      yield* protectIncrease({
        missionId,
        threadId: mission.harness.threadId as ThreadId,
        intent: outcome.placedIntent,
        masterAddress,
      });
      const wentExecuting = yield* advance({
        missionId,
        threadId: mission.harness.threadId as ThreadId,
        from: ["waiting", "analysing"],
        to: "executing",
        reason: "working_order_crossed",
      });
      if (wentExecuting) {
        yield* advance({
          missionId,
          threadId: mission.harness.threadId as ThreadId,
          from: ["executing"],
          to: "position_open",
          reason: "working_order_crossed",
        });
      }
    }

    yield* coordinator.requestRun({ missionId, cause: "order_updated" }).pipe(Effect.ignore);
  });

  /**
   * Withdraw a mission's resting working entries when its authority ends.
   *
   * The exhaustion block and the emergency close cancel increasing orders on
   * their own; a flat settle and a plain revoke did not — a patient entry was
   * left working a dead mission's market, which is exactly the unowned order
   * the working loop exists to prevent. The line is still written to the
   * inbox for the record; a terminal mission claims no further runs.
   */
  const retireWorkingOrdersQuietly = (input: {
    readonly missionId: TradingMissionId;
    readonly tradingAccountId: string;
    readonly market: TradingMarket;
    readonly reason: string;
  }) =>
    Effect.gen(function* () {
      const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const masterAddress = yield* missions.getMasterWalletAddress(input.tradingAccountId);
      const outcome = yield* workingOrders.abandon({
        missionId: input.missionId,
        masterAddress,
        market: input.market,
        nowMs,
      });
      if (!outcome.found) return;
      yield* inbox
        .persist({
          missionId: input.missionId,
          category: "exchange",
          deduplicationKey: workingOrderOutcomeKey("abandoned", outcome.cloid ?? "unknown"),
          payload: { cloid: outcome.cloid, reason: input.reason },
          occurredAt: nowMs,
          summary: `patient entry withdrawn: ${input.reason}`,
        })
        .pipe(Effect.ignore);
      yield* Effect.logInfo("trading withdrew a working entry on mission end", {
        missionId: input.missionId,
        cancelledCloids: outcome.cancelledCloids,
        reason: input.reason,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        warnWithCause(
          "trading could not withdraw a working entry on mission end",
          { missionId: input.missionId },
          cause,
        ),
      ),
    );

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("5 seconds");
      yield* settleFlatPosition().pipe(Effect.catchCause(() => Effect.void));
      yield* guardProtection().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : warnWithCause("trading protection watchdog pass failed", {}, cause),
        ),
      );
      yield* guardTakeProfit().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : warnWithCause("trading take-profit watchdog pass failed", {}, cause),
        ),
      );
      yield* guardWorkingOrder().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : warnWithCause("trading working-order watchdog pass failed", {}, cause),
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
