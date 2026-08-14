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

import {
  POC_DEFAULT_TIMEFRAME,
  runtimeTimeframe,
  type TradingTimeframe,
} from "@t3tools/trading-contracts/strategy";
import {
  hasReassessmentWithin,
  isDeafWhileHoldingPosition,
  readWatchCoverage,
  watchCoverageFloorMillis,
  watchSanityBackstopMillis,
} from "@t3tools/trading-contracts/watch";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { setSessionProfile } from "../provider/SessionProfile.ts";
import {
  HarnessRunOutcome,
  HarnessRunRequest,
  type TradingPlanState,
  type PersistedWatch,
  TradingDomainEventSummary,
  TradingHarnessRunCause,
} from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { settleRunDecision } from "./TradingRunTelemetry.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWakeupComposer } from "./TradingWakeupComposer.ts";
import { TradingWatchService } from "./TradingWatchService.ts";
import { isActiveMissionStatus, isOperativeMissionStatus } from "./MissionTransitions.ts";

/**
 * A run request, plus whether the caller is waiting on the wake itself.
 *
 * `awaitWake` is runtime plumbing rather than part of the published
 * `HarnessRunRequest` contract: it says only that this caller needs to know
 * whether the wake reached the provider before it decides what to do next.
 * Exactly one caller sets it — the user-message path, which must fall back to
 * an ordinary turn rather than leave the operator's text undelivered.
 */
export interface RequestRunInput extends HarnessRunRequest {
  readonly awaitWake?: boolean;
}

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
    input: RequestRunInput,
  ) => Effect.Effect<HarnessRunOutcome, PersistenceSqlError>;

  /**
   * Route a user's chat message on a mission thread through the wake path.
   *
   * Typing into a bound thread used to take the ordinary turn path: no wakeup
   * snapshot, no decision lease, so the operator's turn could race a
   * watch-fired run and worked from whatever market and account state happened
   * to be left in the harness's context. A message on an operative mission is
   * an event like any other, and gets the same fresh snapshot.
   *
   * Returns `true` when a run started and this call owns the turn — the caller
   * must NOT also dispatch the plain turn. Returns `false` for every other
   * case (no mission, not operative, blocked, or queued behind an active run),
   * so the message still reaches the provider the ordinary way rather than
   * being dropped.
   */
  readonly requestUserMessageRun: (input: {
    readonly threadId: string;
    readonly text: string;
  }) => Effect.Effect<boolean>;
}

export class TradingTurnCoordinator extends Context.Service<
  TradingTurnCoordinator,
  TradingTurnCoordinatorShape
>()("t3/trading/TradingTurnCoordinator") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingTurnCoordinator.${operation}`);

/**
 * The strategy-less wakeup message: the resumed turn's first job is to author a
 * strategy, so it carries just the mission instruction rather than the full
 * snapshot (which requires an active strategy).
 *
 * `mission_created` is the ordinary case, but a mission that ended its first
 * turn without publishing — a stand-down that never became a plan — is woken
 * on this same shape by its staleness floor or by the operator typing.
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
  /** The operator's text, on a `user_message` wake. Without this the message
      that caused the wake never reaches the turn it caused. */
  userMessage: Schema.optional(Schema.String),
  /** Set on any wake after the first: this mission has already taken a turn and
      still has no plan. Standing down is a plan too — publish one. */
  publishOverdue: Schema.optional(Schema.Literal(true)),
  firstTurnContract: Schema.optional(Schema.String),
});
const encodeBootstrapText = Schema.encodeSync(Schema.fromJsonString(BootstrapWakeup));

/**
 * The one thing every strategy-less turn owes: a published plan. A turn that
 * looks at the market and declines to trade has reached a conclusion, and a
 * conclusion the mission does not record leaves it with no thesis to come back
 * to, no armed levels, and nothing for the operator's panel to show.
 */
const FIRST_TURN_CONTRACT =
  "End this turn with trading_publish_plan, whatever you decide. If the costs " +
  "or the market do not justify entering, publish the stand-down: " +
  "targetProfitBasis.insufficientVolatility true, the arithmetic in rationale, " +
  "protection.targetProfitUsd set to the minimum viable target the costs " +
  "demand, and entryPlan.conditions carrying the price levels that would change " +
  "the read. A declined entry is a plan, not a missing one.";

/**
 * Causes that may wake a mission with no published strategy. Each of these
 * originates with the mission or its operator rather than with an armed level,
 * so there is a turn worth running even though there is no thesis to snapshot.
 */
const CAUSES_ALLOWED_WITHOUT_STRATEGY: ReadonlySet<TradingHarnessRunCause> = new Set([
  "mission_created",
  "scheduled_reassessment",
  "user_message",
]);

const PUBLISH_OVERDUE_NOTE =
  "This mission has already taken a turn and still has no published plan. " +
  "Publish one now — including the stand-down shape if the read has not changed.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const missions = yield* TradingMissionService;
  const strategies = yield* TradingStrategyService;
  const inbox = yield* TradingEventInbox;
  const engine = yield* OrchestrationEngineService;
  const composer = yield* TradingWakeupComposer;
  const watches = yield* TradingWatchService;

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

    // Close the run's decision as the lease is released, so every completed run
    // carries exactly one terminal outcome. A telemetry failure must never hold
    // a lease open or fail a settlement: it is logged and dropped.
    yield* settleRunDecision(sql, { runId, completedAt: now }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("TradingTurnCoordinator: could not settle the run decision", {
          runId,
          cause: String(cause),
        }),
      ),
    );
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
  /**
   * The statuses a session writes once its turn is over.
   *
   * `starting` is deliberately absent. It is the first status a resumed
   * session writes, it carries no active turn, and a "not running and no
   * active turn" test therefore matched it — every run released its lease
   * within a second of dispatching, before the harness had said anything.
   * That let a second run start on top of the first and closed the inbox
   * events the first run was still working from.
   */
  const TURN_END_STATUSES: ReadonlySet<string> = new Set([
    "idle",
    "ready",
    "interrupted",
    "stopped",
    "error",
  ]);

  const isTurnEndFor =
    (threadId: string) =>
    (event: OrchestrationEvent): boolean => {
      if (event.type !== "thread.session-set") return false;
      if (event.payload.threadId !== threadId) return false;
      const { status, activeTurnId } = event.payload.session;
      return TURN_END_STATUSES.has(status) && activeTurnId === null;
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

          yield* ensureNotDeaf(missionId);
        }),
      ),
    );

  /**
   * Arm the floor's reassessment, once. `coversByReassessment` has already said
   * nothing is due inside the window, so this cannot stack duplicates.
   *
   * The floor is computed by the caller from the strategy's primary timeframe
   * and whether a position is held (see `watchCoverageFloorMillis`), so the
   * cadence scales with how fast the mission's market prints confirming bars.
   */
  const armStalenessFloor = (input: {
    readonly missionId: string;
    readonly nowMillis: number;
    readonly floorMillis: number;
    readonly detail: Record<string, unknown>;
  }) =>
    Effect.gen(function* () {
      const runAt = input.nowMillis + input.floorMillis;
      const { watch } = yield* watches.registerWatch({
        missionId: input.missionId,
        watch: { type: "scheduled_reassessment", runAt },
        armedReason: "staleness_floor",
      });
      yield* Effect.logInfo("TradingTurnCoordinator: armed a reassessment for a silent mission", {
        missionId: input.missionId,
        watchId: watch.id,
        runAt,
        ...input.detail,
      });
    });

  /**
   * The timeframe the monitoring cadence is scaled off: the mandate's, or `1m`.
   *
   * It used to be the published `timeframes[0]`, which let a plan that named
   * 15m set its own re-wake floor at thirty minutes — the plan chose how often
   * it would be asked to reconsider the plan. See `runtimeTimeframe`; the
   * wakeup composer reads the same rule, so the bars a run is fed and the rate
   * it is woken at cannot disagree.
   */
  const primaryTimeframeFor = (instruction: string): TradingTimeframe =>
    runtimeTimeframe(instruction);

  /**
   * Arm a `pnl_above` watch at the strategy's declared profit target while the
   * mission holds a position, once. A flat position never fires it and leaves
   * it active; the strategy publish supersedes it like any other watch.
   *
   * This is the runtime's half of the wake-and-decide profit target: the
   * strategy names the win worth banking, the runtime wakes the harness when
   * the unrealised PnL reaches it, and the harness decides whether to bank it
   * or republish with a higher target.
   */
  const ensureProfitTargetArmed = (input: {
    readonly missionId: string;
    readonly strategy: TradingPlanState;
    readonly armed: ReadonlyArray<PersistedWatch>;
  }) =>
    Effect.gen(function* () {
      const alreadyArmed = input.armed.some(
        (w) =>
          w.status === "active" &&
          w.watch.type === "pnl_above" &&
          w.watch.valueUsd === input.strategy.protection.targetProfitUsd,
      );
      if (alreadyArmed) return;

      const { watch } = yield* watches.registerWatch({
        missionId: input.missionId,
        watch: {
          type: "pnl_above",
          market: input.strategy.market,
          valueUsd: input.strategy.protection.targetProfitUsd,
        },
        armedReason: "profit_target",
      });
      yield* Effect.logInfo("TradingTurnCoordinator: armed the profit-target watch", {
        missionId: input.missionId,
        watchId: watch.id,
        targetProfitUsd: input.strategy.protection.targetProfitUsd,
      });
    });

  /**
   * Never let a run end holding a position with nothing armed that can wake it.
   *
   * The failure this closes was observed live: a position open, one downside
   * `candle_close` armed, price ran 25 points the profitable way, and the
   * harness was never woken to do anything about it. The mission was not
   * broken — it was deaf, which looks identical from the outside and is much
   * worse, because a deaf mission still holds exposure.
   *
   * Two things happen here, in order:
   *  1. While holding a position with a live strategy, arm a `pnl_above` watch
   *     at the strategy's declared profit target — the win worth banking. This
   *     runs in addition to the coverage logic, before it.
   *  2. The coverage floor: if the run left nothing that can fire on one of the
   *     two sides the mark can move — a price level, a PnL line, or a confirmed
   *     exchange stop — a reassessment is registered at the tight floor so the
   *     mission gets at least one more turn. A mission that *is* covered gets
   *     the slow sanity backstop instead, because it will be woken by a real
   *     event and a three-bar metronome only buys turns that conclude "hold".
   *     Both intervals scale with the strategy's primary timeframe.
   *
   * It never blocks the settlement. The lease is already released by the time
   * this runs, and a mission that could not be given a watch is still better
   * off settled with a logged warning than held open behind a bookkeeping
   * failure.
   */
  const ensureNotDeaf = (missionId: string) =>
    Effect.gen(function* () {
      // A mission that no longer holds authority has nothing to be woken for.
      // Settling a thread revokes its mission while the final turn is still
      // winding down, and arming a fresh watch on the way out is exactly the
      // "settle did not stop everything" the control is supposed to prevent.
      const mission = yield* missions.getMission(missionId);
      if (!isActiveMissionStatus(mission.status)) return;

      const rows = yield* sql<{
        readonly size: number;
        readonly mark_px: number | null;
        readonly protected_size: number | null;
      }>`
        SELECT size, mark_px, protected_size FROM trading_position_snapshots
        WHERE mission_id = ${missionId} AND size != 0
      `.pipe(Effect.mapError(sqlFail("ensureNotDeaf:position")));

      const position = rows[0];
      const now = yield* Clock.currentTimeMillis;
      const armed = yield* strategies.listWatches(missionId);
      const strategyOption = yield* strategies.getCurrentStrategy(missionId);
      const primaryTimeframe = primaryTimeframeFor(mission.instruction);

      // Flat. Timing an entry is the harness's own business, so no level is
      // required on either side — but a mission that has published a thesis and
      // is running its loop must still come back to it. Without this, a thesis
      // whose triggers never come near the market goes silent forever, and a
      // silent mission is indistinguishable from a working one.
      if (position === undefined) {
        if (!isOperativeMissionStatus(mission.status)) return;
        // A mission with no thesis gets the floor too. It used to return here,
        // on the reasoning that there was nothing to come back to — but a turn
        // that looked at the market and declined to enter has plenty to come
        // back to, and skipping the floor left it dormant until the operator
        // typed. The floor runs on the default timeframe in that case, and the
        // wake it arms takes the bootstrap path (check 7) asking for the
        // publish the turn owes.
        const flatFloor = watchCoverageFloorMillis({
          timeframe: primaryTimeframe,
          holdingPosition: false,
        });
        if (hasReassessmentWithin({ watches: armed, nowMillis: now, floorMillis: flatFloor }))
          return;

        yield* armStalenessFloor({
          missionId,
          nowMillis: now,
          floorMillis: flatFloor,
          detail: {
            missionStatus: mission.status,
            flat: true,
            primaryTimeframe,
            hasStrategy: strategyOption._tag === "Some",
          },
        });
        return;
      }

      // Holding a position with a live strategy: arm the profit target. The
      // strategy is the source of the target, so a mission with no published
      // thesis skips this and falls through to the coverage floor alone.
      if (strategyOption._tag === "Some") {
        yield* ensureProfitTargetArmed({
          missionId,
          strategy: strategyOption.value,
          armed,
        });
      }

      const markPrice = position.mark_px;
      const holdingFloor = watchCoverageFloorMillis({
        timeframe: primaryTimeframe,
        holdingPosition: true,
      });

      // With no mark there is no "each side of" anything to measure. Treat that
      // as uncovered rather than as covered: an unreadable mark is not evidence
      // the mission can hear.
      const coverage =
        markPrice === null
          ? { coversUpside: false, coversDownside: false, coversByReassessment: false }
          : readWatchCoverage({
              watches: armed,
              markPrice,
              nowMillis: now,
              floorMillis: holdingFloor,
              positionSize: position.size,
              protectedSize: position.protected_size ?? 0,
            });

      if (isDeafWhileHoldingPosition(coverage)) {
        yield* armStalenessFloor({
          missionId,
          nowMillis: now,
          floorMillis: holdingFloor,
          detail: { positionSize: position.size, coverage, primaryTimeframe },
        });
        return;
      }

      // Covered on both sides. The mission will be woken by a real event, so the
      // only thing left to schedule is the slow look at whether the thesis still
      // holds — not the three-bar metronome the deaf case needs.
      const sanityFloor = watchSanityBackstopMillis(primaryTimeframe);
      if (hasReassessmentWithin({ watches: armed, nowMillis: now, floorMillis: sanityFloor }))
        return;

      yield* armStalenessFloor({
        missionId,
        nowMillis: now,
        floorMillis: sanityFloor,
        detail: { positionSize: position.size, coverage, primaryTimeframe, sanityBackstop: true },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("TradingTurnCoordinator: could not check watch coverage", {
          missionId,
          cause: String(cause),
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
      // The composer validates the struct against the schema before rendering
      // and returns it; the rendered text is a compact form, not JSON, so the
      // round-trip here is the struct the composer already decoded.
      text = composed.text;
    } else {
      // No strategy yet. Ordinarily this is the `mission_created` bootstrap and
      // the resumed turn's first job is to author one — but a mission that
      // finished a turn without publishing is woken on this same shape by its
      // staleness floor or by the operator, and is told the publish is overdue.
      const publishOverdue = input.cause !== "mission_created";
      text = encodeBootstrapText({
        kind: "trading-harness-wakeup",
        bootstrap: true,
        missionId: input.missionId,
        harnessRunId: input.harnessRunId,
        cause: input.cause,
        instruction: mission.instruction,
        defaultTimeframe: POC_DEFAULT_TIMEFRAME,
        ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
        ...(publishOverdue ? { publishOverdue: true as const } : {}),
        firstTurnContract: publishOverdue
          ? `${PUBLISH_OVERDUE_NOTE} ${FIRST_TURN_CONTRACT}`
          : FIRST_TURN_CONTRACT,
      });
    }

    // Every wake goes through here, so this is the one place that sees a live
    // mission on every path. The profile registry is in-memory and the reactor
    // only binds it where a mission is created, so setting it again here is what
    // keeps a post-restart wake locked to the `mcp__t3-trade__*` toolset. It is
    // idempotent — re-setting an already-bound thread is a no-op.
    yield* Effect.sync(() =>
      setSessionProfile({ threadId: ThreadId.make(input.threadId), kind: "trading" }),
    );

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

  /**
   * Put the mission back in a state where something can still wake it, after a
   * wake failed.
   *
   * A failed wake is not a neutral event: the watch that fired was flipped
   * `triggered` before the run was ever requested (single-fire guard), so the
   * condition has been spent and nothing re-arms it. Left alone the mission is
   * deaf — still holding exposure, still looking healthy from the outside —
   * until the next staleness floor, whose wake fails the same way.
   *
   * Two repairs, both bounded. `ensureNotDeaf` is the ordinary end-of-turn arm
   * and re-registers the reassessment/profit-target coverage. Re-registering
   * the triggering watch gives back the specific level the harness was waiting
   * on. Neither retries the wake: the trim ladder makes a repeat size failure
   * unlikely, and an unbounded retry loop against a genuinely broken provider
   * is worse than the staleness floor already is.
   */
  const recoverFromFailedWake = (input: {
    readonly missionId: string;
    readonly triggeringWatchId?: string;
  }) =>
    Effect.gen(function* () {
      yield* ensureNotDeaf(input.missionId);
      if (input.triggeringWatchId === undefined) return;

      const spent = yield* watches.getWatch(input.triggeringWatchId);
      // Only a watch the failed wake actually consumed is worth replacing; one
      // still active (or already superseded by a publish) needs nothing.
      if (spent === null || spent.status !== "triggered") return;

      const { watch } = yield* watches.registerWatch({
        missionId: input.missionId,
        watch: spent.watch,
        armedReason: "wake_retry",
      });
      yield* Effect.logWarning("TradingTurnCoordinator: re-armed a watch a failed wake consumed", {
        missionId: input.missionId,
        consumedWatchId: spent.id,
        watchId: watch.id,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("TradingTurnCoordinator: could not recover from a failed wake", {
          missionId: input.missionId,
          cause: String(cause),
        }),
      ),
    );

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
      // A cause that can only have come from the mission itself may proceed
      // without a published strategy and takes the bootstrap wakeup: the first
      // run authors a plan, and a scheduled reassessment or an operator message
      // on a mission that never published one asks it to finish that job. A
      // watch-fired cause still requires a strategy — nothing could have armed
      // the watch without one — so the wakeup's `activeStrategy` is present
      // wherever it is required.
      const currentStrategy = yield* strategies.getCurrentStrategy(input.missionId);
      if (currentStrategy._tag === "None" && !CAUSES_ALLOWED_WITHOUT_STRATEGY.has(input.cause)) {
        yield* completeRun(runId, "failed");
        return { status: "blocked", reason: "no_active_strategy" } as const;
      }

      // All checks passed: watch for the turn ending, build the wakeup, and
      // dispatch `thread.turn.start`.
      //
      // The turn-end watcher is forked BEFORE the dispatch so a turn that ends
      // quickly cannot slip past the hot domain-event stream, and detached so
      // it outlives whichever fiber dispatched — it terminates itself on the
      // first turn-end (`Stream.take(1)`). A wake failure interrupts it, marks
      // the run `failed` (releasing the lease), and re-arms the mission.
      const dispatchWake = Effect.gen(function* () {
        const watcher = yield* Effect.forkDetach(
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
        if (Exit.isSuccess(woke)) return true;

        yield* Fiber.interrupt(watcher);
        // `completeRun`'s guard makes a late or repeated release a no-op.
        yield* completeRun(runId, "failed").pipe(Effect.catchCause(() => Effect.void));
        yield* Effect.logError("TradingTurnCoordinator: wake dispatch failed", {
          runId,
          cause: String(woke.cause),
        });
        yield* recoverFromFailedWake({
          missionId: input.missionId,
          ...(input.triggeringWatchId !== undefined
            ? { triggeringWatchId: input.triggeringWatchId }
            : {}),
        });
        return false;
      });

      // A user's message is the one cause with something waiting on the answer.
      // `ws.ts` only falls through to the ordinary dispatch when this returns a
      // non-`started` outcome, so a forked wake that fails afterwards drops the
      // message entirely — the client keeps saying "Working" for a turn that
      // never happened. Compose and dispatch inline for that cause, and report
      // the failure as a blocked run so the plain turn still carries the text.
      if (input.awaitWake === true) {
        const dispatched = yield* dispatchWake;
        if (dispatched) return { status: "started", harnessRunId: runId } as const;
        return { status: "blocked", reason: "wake_failed" } as const;
      }

      // Every other cause returns `started` as soon as the lease is acquired —
      // nothing user-visible is waiting on the dispatch, and it proceeds
      // asynchronously the way `thread.turn.start` itself does.
      yield* Effect.forkDetach(dispatchWake);

      return { status: "started", harnessRunId: runId } as const;
    });

  const requestUserMessageRun: TradingTurnCoordinatorShape["requestUserMessageRun"] = (input) =>
    Effect.gen(function* () {
      const bound = yield* missions.findMissionByThreadId(input.threadId);
      if (bound._tag === "None") return false;

      const mission = bound.value;
      // A paused, blocked, or agent-unavailable mission is not taking events;
      // the message goes to the provider the ordinary way.
      if (!isOperativeMissionStatus(mission.status)) return false;

      const outcome = yield* requestRun({
        missionId: mission.id,
        cause: "user_message",
        userMessage: input.text,
        // Wait for the wake: returning `true` before the dispatch composed is
        // what let a compose failure swallow the operator's message.
        awaitWake: true,
      });
      if (outcome.status === "started") return true;

      yield* Effect.logInfo("TradingTurnCoordinator: user message took the ordinary turn path", {
        missionId: mission.id,
        outcome: outcome.status,
        ...(outcome.status === "blocked" ? { reason: outcome.reason } : {}),
      });
      return false;
    }).pipe(
      // A routing failure must never swallow the operator's message: fall back
      // to the ordinary turn.
      Effect.catchCause((cause) =>
        Effect.logWarning("TradingTurnCoordinator: could not route a user message", {
          threadId: input.threadId,
          cause: String(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  return { requestRun, requestUserMessageRun } satisfies TradingTurnCoordinatorShape;
});

export const TradingTurnCoordinatorLive = Layer.effect(TradingTurnCoordinator, make);
