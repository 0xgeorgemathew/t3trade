/**
 * Trading tool handlers.
 *
 * Each handler does three things and nothing else: check the capability,
 * resolve the mission the calling thread is bound to, and delegate to the
 * trading services. All mission and strategy rules live in those services.
 *
 * @module TradingToolkitHandlers
 */
import {
  TradingToolRejectedError,
  type TradingGetMissionResult,
} from "@t3tools/trading-contracts/tools";
import type { TradingOrderIntent, TradingOrderResult } from "@t3tools/trading-contracts/execution";
import type { TradingTimeframe, TradingUrgency } from "@t3tools/trading-contracts/strategy";
import { readExitRequest } from "@t3tools/trading-contracts/exit";
import type { StopAdjustmentJustification } from "@t3tools/trading-contracts/stop-adjustment";
import { classifyFailure } from "@t3tools/trading-contracts/recovery";
import {
  findMirroredLevel,
  isWatchRefusal,
  resolveWatchHandle,
  toMarketWatch,
  toWatchRow,
  watchHandle,
} from "@t3tools/trading-contracts/watch";
import {
  isJournalRefusal,
  readJournalNote,
  TRADING_JOURNAL_READ_LIMIT,
  TRADING_JOURNAL_TURN_READ_LIMIT,
  type TradingJournalEntry,
} from "@t3tools/trading-contracts/journal";
import {
  resolveLookScopes,
  TRADING_LOOK_BOOK_LEVELS,
  TRADING_LOOK_FLAT_BAR_CAP,
  echoedBarsForLook,
  type TradingLookInput,
  type TradingLookScope,
  type TradingObservation,
} from "@t3tools/trading-contracts/observation";
import { DEFAULT_TRADING_MARKET, type TradingMarket } from "@t3tools/trading-contracts/primitives";
import { CommandId, ThreadId, TradingMissionId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

import type { PersistedWatch, TradingMission } from "../../../trading/Schemas.ts";
import type { TradingPlanState } from "../../../trading/Schemas.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingExitService } from "../../../trading/TradingExitService.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingEntryService } from "../../../trading/TradingEntryService.ts";
import { TradingStopAdjustmentService } from "../../../trading/TradingStopAdjustmentService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { publishPlanWithAftermath } from "../../../trading/TradingPlanPublication.ts";
import { TradingWatchService } from "../../../trading/TradingWatchService.ts";
import { TradingJournalService } from "../../../trading/TradingJournalService.ts";
import { TradingWakeupComposer } from "../../../trading/TradingWakeupComposer.ts";
import { allocateExecutionSequence } from "../../../trading/TradingExecutionSequence.ts";
import { recordStructureRead } from "../../../trading/TradingLevelHistory.ts";
import { recordExecutionRefusal } from "../../../trading/TradingRunTelemetry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import {
  analyseMarketStructure,
  compareCandidates,
  digestMarketStructure,
  MARKET_STRUCTURE_LOOKBACK_BARS,
  MARKET_STRUCTURE_TIMEFRAMES,
} from "@t3tools/trading-contracts/market-structure";
import { toCandleSeries } from "@t3tools/trading-contracts/market";
import type {
  AgentMarketSnapshot,
  MarketCandle,
  MarketCandleSeries,
  MarketHistory,
  OrderBook,
} from "@t3tools/trading-contracts/market";
import { readMicrostructure } from "@t3tools/trading-contracts/microstructure";
import {
  computeIndicator,
  INDICATOR_MAX_REQUESTS,
  type IndicatorRequest,
} from "@t3tools/trading-contracts/indicators";
import {
  roundMarketStructure,
  roundMicrostructure,
  roundObservedVolatility,
} from "@t3tools/trading-contracts/precision";
import { PLAYBOOKS } from "@t3tools/trading-contracts/playbook";
import { readMissionMode } from "@t3tools/trading-contracts/mode";
import { readAccountMarginCapacityUsd } from "../../../trading/AccountMarginCapacity.ts";
import { TradingCostEstimator } from "../../../trading/TradingCostEstimator.ts";
import { TradingCalibrationService } from "../../../trading/TradingCalibrationService.ts";
import { TradingTradeHistoryService } from "../../../trading/TradingTradeHistoryService.ts";
import { TradingToolkit } from "./tools.ts";

interface BoundCall {
  readonly threadId: string;
  readonly mission: TradingMission;
}

/**
 * Refuse a tool call, and say so in the log.
 *
 * A rejection here is invisible everywhere except the agent's own transcript:
 * the server log showed a mission sitting still with no explanation, and the
 * operator had no way to tell "the agent stopped calling tools" from "every
 * call it made was refused". One line per refusal closes that gap.
 */
const rejectCall = (input: {
  readonly reason:
    | "capability_not_granted"
    | "thread_not_bound_to_mission"
    | "mission_not_bound_to_thread";
  readonly threadId: string;
  readonly missionId: string | undefined;
}) =>
  Effect.logInfo("trading tool call rejected", input).pipe(
    Effect.andThen(new TradingToolRejectedError(input)),
  );

/**
 * Resolve the mission a trading tool call is authorized to act on.
 *
 * Capability is granted per session; authorization is resolved per call. §10.2
 * freezes one active mission onto one provider thread, so the thread carried by
 * the credential — not an argument the harness supplies — decides which mission
 * is reachable. A `missionId` argument is checked against that binding rather
 * than trusted; an omitted `missionId` resolves to the bound mission.
 */
const resolveBoundCall = Effect.fn("TradingToolkit.resolveBoundCall")(function* (
  missionId: string | undefined,
): Effect.fn.Return<
  BoundCall,
  TradingToolRejectedError,
  McpInvocationContext.McpInvocationContext | TradingMissionService
> {
  const scope = yield* McpInvocationContext.requireCapability("trading", (denial) => denial).pipe(
    Effect.catch((denial) =>
      rejectCall({
        reason: "capability_not_granted",
        threadId: denial.threadId,
        missionId,
      }),
    ),
  );

  const missions = yield* TradingMissionService;
  const bound = yield* missions.findMissionByThreadId(scope.threadId).pipe(Effect.orDie);

  if (Option.isNone(bound)) {
    return yield* rejectCall({
      reason: "thread_not_bound_to_mission",
      threadId: scope.threadId,
      missionId,
    });
  }

  // Omitting `missionId` resolves to the bound mission. Naming a different one
  // is still a mismatch the harness has to be told about explicitly.
  if (missionId !== undefined && bound.value.id !== missionId) {
    return yield* rejectCall({
      reason: "mission_not_bound_to_thread",
      threadId: scope.threadId,
      missionId,
    });
  }

  return { threadId: scope.threadId, mission: bound.value };
});

/**
 * The same gate, for the reads that do not need a live mission.
 *
 * Market data is not mission state: resolving a market, reading a snapshot,
 * candles, or the book is the same answer whoever asks. Routing those through
 * `resolveBoundCall` meant that the moment a mission went terminal every tool on
 * the thread failed, including the ones that would have explained why — the
 * agent could not even read the price it had just been trading. The capability
 * is still required; only the binding is optional, and `null` is what a write
 * tool would still refuse on.
 */
const resolveReadCall = Effect.fn("TradingToolkit.resolveReadCall")(function* (
  missionId: string | undefined,
): Effect.fn.Return<
  { readonly threadId: string; readonly mission: TradingMission | null },
  TradingToolRejectedError,
  McpInvocationContext.McpInvocationContext | TradingMissionService
> {
  const scope = yield* McpInvocationContext.requireCapability("trading", (denial) => denial).pipe(
    Effect.catch((denial) =>
      rejectCall({
        reason: "capability_not_granted",
        threadId: denial.threadId,
        missionId,
      }),
    ),
  );

  const missions = yield* TradingMissionService;
  const bound = yield* missions.findMissionByThreadId(scope.threadId).pipe(Effect.orDie);
  return { threadId: scope.threadId, mission: Option.isNone(bound) ? null : bound.value };
});

/**
 * What `trading_look` answers when the thread has no live mission: the
 * last one it held and, if the slot has moved on, who holds it now.
 */
const readUnboundMission = Effect.fn("TradingToolkit.readUnboundMission")(function* (
  threadId: string,
) {
  const missions = yield* TradingMissionService;
  const last = yield* missions.findLastMissionByThreadId(threadId).pipe(Effect.orDie);
  if (Option.isNone(last)) return { bound: false as const };

  const active = yield* missions.findActiveMission(last.value.userId).pipe(Effect.orDie);
  return {
    bound: false as const,
    lastMission: last.value,
    ...(Option.isSome(active) && active.value.id !== last.value.id
      ? { activeMissionId: active.value.id }
      : {}),
  };
});

/**
 * The mission half of a look.
 *
 * `withRetrospect` is the `retrospect` scope: the plan history, the notes, and
 * the target calibration are what the mission has BELIEVED, and a run reacting
 * to a fired level does not need its own back-catalogue to answer what just
 * happened. It used to ride on `mission`, which meant a model scoping
 * correctly still paid for it.
 *
 * Everything else here is live state and is always read — a scoped look that
 * hid the armed watches or the pending executions would be a cheaper read that
 * is also a blind one.
 */
const readMission = Effect.fn("TradingToolkit.readMission")(function* (
  mission: TradingMission,
  withRetrospect: boolean,
) {
  const strategies = yield* TradingStrategyService;
  const strategy = yield* strategies.getCurrentStrategy(mission.id).pipe(Effect.orDie);
  // Bounded (plan 29 step 6.3): every live watch, plus a capped tail of
  // settled ones. The settled tail is retrospect — a watch that fired arrived
  // as the wake's own `triggeringWatch`, and no turn of the mission this was
  // measured on ever referred back to a retired one, while they were 46% of
  // the registry a hot-path read carried (plan 35 phase 2).
  const allWatches = yield* strategies.listWatchesForRead(mission.id).pipe(Effect.orDie);
  const watches = withRetrospect
    ? allWatches
    : allWatches.filter((watch) => watch.status === "active");
  const missions = yield* TradingMissionService;
  // The same set preview item 16 refuses against, so a harness told
  // `no_conflicting_execution_pending` can read what is holding the lock.
  const pendingExecutions = yield* missions.listPendingExecutions(mission.id).pipe(Effect.orDie);
  // What the mission has believed, not only what it believes now. A harness
  // that has republished three times cannot otherwise see the targets it set
  // before this one.
  const strategyHistory = withRetrospect
    ? yield* strategies.listStrategyVersions(mission.id).pipe(Effect.orDie)
    : null;

  // What the mission has told itself, across the revisions that replaced the
  // plan it was written beside (plan 29 step 6.4). Short — the working set, not
  // the session; `trading_journal` reads the longer tail deliberately.
  const journals = yield* TradingJournalService;
  const journal = withRetrospect
    ? yield* journals
        .list({ missionId: mission.id, limit: TRADING_JOURNAL_TURN_READ_LIMIT })
        .pipe(Effect.orDie)
    : null;

  // The optimistic-lock version a publish must quote (`expectedMissionVersion`)
  // — the mission contract itself no longer carries a version number.
  const missionVersion = yield* missions.getMissionVersion(mission.id).pipe(Effect.orDie);

  // The retired calibration tool's read, off the hot path (plan 29 step 6.5).
  // Omitted entirely until there is a closed trade to grade — a mission that
  // has not traded should not be handed an empty verdict every turn.
  const calibration = withRetrospect
    ? yield* (yield* TradingCalibrationService).read({ missionId: mission.id }).pipe(Effect.orDie)
    : null;

  // Plan 29 step 9.1. Derived from the mandate on every read, never stored: a
  // column would be a second copy of a fact `mission.instruction` already
  // states, and the instruction is what the model reads. The two cannot
  // disagree if there is only one of them.
  const mode = readMissionMode(mission.instruction);

  return {
    bound: true,
    mission: withRetrospect ? mission : withMandatePointer(mission),
    mode,
    ...(Option.isNone(strategy) ? {} : { strategy: strategy.value }),
    missionVersion,
    // Plan 33 fix B: the rows the model reads, not the rows the table stores.
    watches: watches.map((watch) => {
      const row = toWatchRow(watch);
      return { ...row, id: watchHandle(row.id) };
    }),
    pendingExecutions,
    ...(strategyHistory === null ? {} : { strategyHistory }),
    ...(journal === null ? {} : { journal }),
    ...(calibration === null || calibration.tradeCount === 0
      ? {}
      : { targetCalibration: calibration }),
  } satisfies TradingGetMissionResult;
});

// The position's high-water mark used to be attached here. Since step 6.1 the
// look reads the market half through `TradingWakeupComposer.observe`, which
// attaches `peakUnrealisedPnl` and `drawdownFromPeakUsd` itself — so a look and
// a wake report the same peak by construction rather than by two copies of the
// same arithmetic agreeing.

/**
 * How much of the mandate a scoped look carries — plan 34 step 1.3.
 *
 * Enough to recognise which mandate it is, and not the thousand characters of
 * it. The mandate does not change for a mission's life, so re-reading it on
 * every wake-turn buys nothing; the full text is one scope away.
 */
const MANDATE_PREVIEW_CHARS = 120;

/**
 * The mission row with its mandate cut to a pointer.
 *
 * The `retrospect` scope — and so any unscoped assessment look — still carries
 * the whole instruction. A run reacting to a level that fired does not: it
 * already knows what it is doing, and the mandate was 1,050 characters of
 * every look it took.
 */
const withMandatePointer = (mission: TradingMission): TradingMission =>
  mission.instruction.length <= MANDATE_PREVIEW_CHARS
    ? mission
    : {
        ...mission,
        instruction: `${mission.instruction.slice(0, MANDATE_PREVIEW_CHARS)}… (mandate abridged — read it in full with scope "retrospect")`,
      };

const announceWatchRegistered = Effect.fn("TradingToolkit.announceWatchRegistered")(
  function* (input: {
    readonly threadId: string;
    readonly missionId: string;
    readonly watch: PersistedWatch;
  }) {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    yield* engine
      .dispatch({
        type: "trading.mission.watch-registered",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(input.threadId),
        missionId: TradingMissionId.make(input.missionId),
        watch: input.watch,
        createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not announce a registered watch to the orchestration engine", {
            missionId: input.missionId,
            watchId: input.watch.id,
            cause,
          }),
        ),
      );
  },
);

const announceWatchCancelled = Effect.fn("TradingToolkit.announceWatchCancelled")(
  function* (input: {
    readonly threadId: string;
    readonly missionId: string;
    readonly watchId: string;
  }) {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    yield* engine
      .dispatch({
        type: "trading.mission.watch-cancelled",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(input.threadId),
        missionId: TradingMissionId.make(input.missionId),
        watchId: input.watchId,
        createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not announce a cancelled watch to the orchestration engine", {
            missionId: input.missionId,
            watchId: input.watchId,
            cause,
          }),
        ),
      );
  },
);

/**
 * Put an accepted stop move on the WS push path.
 *
 * Only accepted ones: a refusal is agent feedback about a stop that never
 * moved, and announcing it would draw a step on the chart for something that
 * did not happen.
 */
const announceStopAdjusted = Effect.fn("TradingToolkit.announceStopAdjusted")(function* (input: {
  readonly threadId: string;
  readonly missionId: string;
  readonly market: string;
  readonly previousStopPrice: number;
  readonly newStopPrice: number;
  readonly justification: string;
}) {
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

  yield* engine
    .dispatch({
      type: "trading.mission.stop-adjusted",
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make(input.threadId),
      missionId: TradingMissionId.make(input.missionId),
      market: input.market,
      previousStopPrice: input.previousStopPrice,
      newStopPrice: input.newStopPrice,
      justification: input.justification,
      createdAt,
    })
    // The stop is already resting on the exchange; failing to announce it costs
    // the UI a refresh, not the protection.
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not announce a stop adjustment to the orchestration engine", {
          missionId: input.missionId,
          cause,
        }),
      ),
    );
});

/**
 * Tell the run's decision funnel that an entry was attempted and refused.
 *
 * The reactor records the refusals it produces itself, but an entry is priced,
 * sized and pre-checked before anything is dispatched, so the refusals that
 * matter most — a ceiling, the mandatory stop, a stop inside the noise floor —
 * never reach it. Losing the record costs the funnel a turn, never the
 * refusal, so it is logged and dropped rather than raised.
 */
const recordEntryRefusal = (missionId: string, reason: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => recordExecutionRefusal(sql, { missionId, reason })),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not record an entry refusal against the run", { missionId, cause }),
    ),
  );

/** An execution whose intent and versions are already settled. */
interface ResolvedExecuteInput {
  readonly missionId?: string | undefined;
  readonly intent: TradingOrderIntent;
  readonly expectedAuthorityVersion: number;
  readonly activeHarnessRunId: string;
}

/**
 * Submit one execution intent and wait for what actually happened to it.
 *
 * Shared by `trading_enter` and the three exit tools, so an entry and an exit
 * cannot drift into two ways of reporting what happened.
 */
const executeIntent = (input: ResolvedExecuteInput) =>
  Effect.gen(function* () {
    const { threadId, mission } = yield* resolveBoundCall(input.missionId);
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* engine
      .dispatch({
        type: "trading.execution.requested",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(threadId),
        missionId: TradingMissionId.make(mission.id),
        intent: input.intent,
        expectedAuthorityVersion: input.expectedAuthorityVersion,
        activeHarnessRunId: input.activeHarnessRunId,
        createdAt,
      })
      .pipe(Effect.orDie);

    // The dispatch is a question; the reactor answers it on its own worker.
    // Wait for that answer rather than reporting the question as an outcome —
    // a harness told "submitted" for a request that was refused at preview
    // goes on to manage a position that does not exist.
    const outcomes = yield* TradingExecutionOutcome;
    const missions = yield* TradingMissionService;
    const masterAddress = yield* missions
      .getMasterWalletAddress(mission.tradingAccountId)
      .pipe(Effect.orDie);

    return yield* outcomes.awaitOutcome({
      missionId: mission.id,
      executionSequence: input.intent.executionSequence,
      actionType: input.intent.actionType,
      maximumCumulativeLossUsd: mission.authority.maximumCumulativeLossUsd,
      fallbackTakerFeeBpsPerSide: mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
      masterAddress,
    });
  });

/**
 * Run one exit: size it from the canonical position, then execute it.
 *
 * The three exit tools have their own preparation because the thing
 * that makes them worth having is that they cannot be called wrongly. There is
 * no intent to hand-build, so there is no side to get backwards, no size to
 * exceed the position, no version to be stale, and no sequence to collide. What
 * the server cannot derive — nothing is held, no order was named — comes back
 * as a refusal in the same result shape, so a harness reads one outcome type
 * for every write it makes.
 */
const executeExit = (request: {
  readonly missionId: string | undefined;
  readonly kind: "close" | "reduce" | "cancel";
  readonly market?: string | undefined;
  readonly sizeEth?: number | undefined;
  readonly fraction?: number | undefined;
  readonly cloid?: string | undefined;
  readonly urgency?: TradingUrgency | undefined;
}) =>
  Effect.gen(function* () {
    const { mission } = yield* resolveBoundCall(request.missionId);
    const exits = yield* TradingExitService;
    const prepared = yield* exits.prepare({ ...request, missionId: mission.id });

    if (prepared.outcome === "refused") {
      return {
        status: "rejected" as const,
        cloid: "",
        orderResults: [],
        budget: { remainingCumulativeLossUsd: 0, exhausted: false },
        detail: `${prepared.reason}: ${prepared.detail}`,
        recovery: classifyFailure({ reason: prepared.reason }),
      };
    }

    const executed = yield* executeIntent({
      missionId: mission.id,
      intent: prepared.intent,
      expectedAuthorityVersion: prepared.expectedAuthorityVersion,
      activeHarnessRunId: prepared.activeHarnessRunId,
    });

    // A size the server changed — clamped, or promoted past the dust threshold
    // — has to travel with the outcome, or the harness sizes its next decision
    // against the number it asked for rather than the one that went out.
    if (prepared.note === null) return executed;
    return {
      ...executed,
      detail:
        executed.detail === undefined ? prepared.note : `${executed.detail}; ${prepared.note}`,
    };
  });

/**
 * Read the multi-timeframe structure, priced at the size the mission would
 * actually take.
 *
 * Lifted out of the retired `trading_get_market_structure` handler unchanged:
 * one history read per timeframe concurrently, the prior-read memory write
 * (plan 27 B2), and the candidate table joined with the live cost of taking
 * each setup (plan 29 2.6 prices it at the plan's intended notional, not at the
 * approved ceiling). A cost read that fails costs the multiples, never the
 * read.
 */
const readMarketStructure = Effect.fn("TradingToolkit.readMarketStructure")(function* (input: {
  readonly market: TradingMarket;
  readonly mission: TradingMission | null;
}) {
  const gateway = yield* HyperliquidGateway;
  const histories = yield* Effect.all(
    MARKET_STRUCTURE_TIMEFRAMES.map((interval) =>
      gateway
        .getMarketHistory({
          market: input.market,
          interval,
          maxBars: MARKET_STRUCTURE_LOOKBACK_BARS,
        })
        .pipe(Effect.map((history) => ({ interval, history }))),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.orDie);

  const structure = analyseMarketStructure({
    market: input.market,
    measuredAt: histories[0]?.history.freshness.observedAt ?? 0,
    frames: histories.map(({ interval, history }) => ({ interval, candles: history.candles })),
  });

  const mission = input.mission;
  if (mission !== null) {
    yield* Effect.forEach(
      structure.timeframes.filter((frame) => frame.sufficientData),
      (frame) =>
        recordStructureRead({
          missionId: mission.id,
          market: input.market,
          interval: frame.interval,
          classification: structure.regime.classification,
          swingHigh: frame.swingHighPrice ?? null,
          swingLow: frame.swingLowPrice ?? null,
          measuredAt: structure.measuredAt,
        }),
    );
  }

  const cost =
    mission === null
      ? null
      : yield* Effect.gen(function* () {
          const missions = yield* TradingMissionService;
          const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
          const estimator = yield* TradingCostEstimator;
          const fallbackFeeBps = mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide;
          // The approved ceiling first: the fallback answer, and the read of
          // the fee rate, mark and half spread the plan's size is derived from,
          // so both estimates price the same market.
          const atCeiling = yield* estimator.estimate({
            market: input.market,
            masterAddress,
            notionalUsd: mission.authority.allocatedCapitalUsd,
            fallbackTakerFeeBpsPerSide: fallbackFeeBps,
          });

          const strategies = yield* TradingStrategyService;
          const plan = yield* strategies
            .getCurrentStrategy(mission.id)
            .pipe(Effect.catchCause(() => Effect.succeed(Option.none<TradingPlanState>())));
          const currentPlan = Option.isSome(plan) ? plan.value : null;
          const intended = currentPlan?.entry.initialNotionalUsd;
          const sized =
            currentPlan === null ||
            currentPlan.intent === "stand_aside" ||
            intended === undefined ||
            intended <= 0
              ? null
              : Math.min(Math.max(intended, MIN_NOTIONAL_USD), atCeiling.notionalUsd);
          if (sized === null || sized >= atCeiling.notionalUsd) return atCeiling;
          return yield* estimator.estimate({
            market: input.market,
            masterAddress,
            notionalUsd: sized,
            fallbackTakerFeeBpsPerSide: fallbackFeeBps,
          });
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const candidates = compareCandidates(
    structure,
    cost === null ? null : { breakEvenPriceMoveUsd: cost.breakEvenPriceMoveUsd },
  );

  // A degraded estimate is a lower bound — part of the round trip could not be
  // read — and the table was built on it silently. One line on each row the
  // estimate priced; said, never a gate.
  const pricedCandidates =
    cost !== null && cost.degraded
      ? candidates.map((candidate) =>
          candidate.costMultiple === undefined
            ? candidate
            : {
                ...candidate,
                note:
                  `${candidate.note} — cost caveat: the estimate this multiple was priced on ` +
                  "is degraded (part of the round trip could not be read, so the true cost is " +
                  "higher than shown)",
              },
        )
      : candidates;

  // Plan 33 fix A: the structure read is the numeric-heaviest thing a look
  // returns, and almost all of it is derived arithmetic. Rounded here, at the
  // read model, so the detectors above still score on the exact numbers and
  // only what rides back to the model is trimmed.
  return roundMarketStructure({ ...structure, candidates: pricedCandidates });
});

/**
 * `trading_look` — the one read, plan 29 step 6.1.
 *
 * Twelve read tools and the `TradingWakeupComposer` were two implementations of
 * "what does the model need to know". This is the surviving one: the composer's
 * own gather step, returned as a structure instead of rendered into a wakeup.
 *
 * An unbound thread still gets the market half. Market data is the same answer
 * whoever asks, and a mission that has just ended is exactly when the model
 * most needs to be able to read why — so `mission.bound: false` is an answer,
 * not a refusal.
 */
const readObservation = Effect.fn("TradingToolkit.readObservation")(function* (
  input: TradingLookInput,
) {
  const call = yield* resolveReadCall(input.missionId);
  // Omitting `missionId` resolves to the bound mission. Naming a different one
  // is still a mismatch, not an unbound read.
  if (
    call.mission !== null &&
    input.missionId !== undefined &&
    call.mission.id !== input.missionId
  ) {
    return yield* rejectCall({
      reason: "mission_not_bound_to_thread",
      threadId: call.threadId,
      missionId: input.missionId,
    });
  }

  const mission = call.mission;
  const market = input.market ?? mission?.market ?? DEFAULT_TRADING_MARKET;
  const observedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const scopes = resolveLookScopes(input);

  // The mission half first, and never conditional on the exchange. A look that
  // failed because Hyperliquid was unreachable would go dark at exactly the
  // moment the model most needs to read what it holds and what it is allowed
  // to do — so the market half below is best-effort, and its failure costs the
  // fields it would have filled and nothing else.
  //
  // `mission` is the one part that is answered even when it was not asked for:
  // `mission.bound` is what tells the caller whether anything else in the
  // response is about its own mission, so a look without it is ambiguous.
  const missionResult =
    mission === null
      ? yield* readUnboundMission(call.threadId)
      : yield* readMission(mission, scopes.has("retrospect"));

  const marketHalf = yield* readMarketHalf({
    market,
    mission,
    scopes,
    ...(input.interval === undefined ? {} : { interval: input.interval }),
    ...(input.bars === undefined ? {} : { bars: input.bars }),
    ...(input.indicators === undefined ? {} : { indicators: input.indicators }),
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("trading_look: the market half could not be read", {
        market,
        missionId: mission?.id,
        cause,
      }).pipe(Effect.as({ marketReadFailed: describeMarketReadFailure(market, cause) })),
    ),
  );

  const trades =
    mission === null || !scopes.has("trades")
      ? null
      : yield* Effect.gen(function* () {
          const history = yield* TradingTradeHistoryService;
          return yield* history.read({ missionId: mission.id });
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const observation = {
    observedAt,
    market,
    ...marketHalf,
    ...(trades === null ? {} : { trades }),
    mission: missionResult,
  } satisfies TradingObservation;

  // Plan 33 fix 2.3: which part of a look is actually expensive, measured
  // rather than eyeballed off a transcript. The next thing to trim gets chosen
  // from this.
  yield* Effect.logInfo("trading_look: response size", {
    missionId: mission?.id,
    scopes: [...scopes],
    ...measurePartChars(observation),
  });

  return observation;
});

/**
 * Encoded size of each part of a look, in characters.
 *
 * One level into the mission half as well, because `mission` is a single field
 * covering several very different costs — the watch registry and the plan
 * history do not grow at the same rate or for the same reason.
 */
const measurePartChars = (observation: TradingObservation): Record<string, number> => {
  const chars: Record<string, number> = {};
  const measure = (prefix: string, value: object) => {
    for (const [key, part] of Object.entries(value)) {
      chars[`${prefix}${key}Chars`] = JSON.stringify(part)?.length ?? 0;
    }
  };
  measure("", observation);
  measure("mission.", observation.mission);
  return chars;
};

/**
 * Why the market half is missing, in one line the model can act on.
 *
 * "the exchange read failed" alone reads the same whether Hyperliquid is down
 * (retry) or the market does not exist (do not retry, ever), and a model told
 * the first will keep asking for the second. The squashed cause carries which
 * one it was; it is bounded because this rides back inside every look.
 */
const MARKET_READ_FAILURE_CHARS = 200;

const describeMarketReadFailure = (market: string, cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  const detail = squashed instanceof Error ? squashed.message : String(squashed);
  return `the ${market} exchange read failed: ${detail.slice(0, MARKET_READ_FAILURE_CHARS)}`;
};

/**
 * Everything a look reports about the market and the position in it.
 *
 * With a mission, this IS the composer's `observe` — the same snapshots, the
 * same volatility pair, the same cost line — so what a look reports and what a
 * wake carries can never drift apart. Without one, it is the market alone.
 */
/**
 * The book readings, or nothing — never a `microstructure: null` field.
 *
 * The unbound half builds them here from its own book read; the mission half
 * takes the composer's, so the two paths measure the same thing.
 *
 * An unbound look has no mission to have kept a previous sample under, so it
 * reports the current spread and depth with no change beside them. That is the
 * honest answer: there is nothing to compare against, which the schema states
 * by leaving the change fields absent rather than reporting a zero.
 */
const withMicrostructure = (
  orderBook: OrderBook,
  candles: ReadonlyArray<MarketCandle>,
  snapshot: AgentMarketSnapshot,
) => {
  const microstructure = readMicrostructure({
    orderBook,
    candles,
    observedAt: snapshot.freshness.observedAt,
    markPrice: snapshot.markPrice,
    openInterest: snapshot.openInterest,
    previousSample: null,
  });
  return microstructure === null ? {} : { microstructure: roundMicrostructure(microstructure) };
};

/**
 * Trim a candle series to the bars this call asked for, newest last.
 *
 * The measurements above it were taken over the full lookback either way —
 * clipping the series does not change the volatility, it changes how much of
 * the chart rides back in the response.
 */
const boundCandles = (history: MarketHistory, bars: number, note?: string): MarketCandleSeries => {
  const withNote = (series: MarketCandleSeries): MarketCandleSeries =>
    note === undefined ? series : { ...series, note };
  // `slice(-0)` is `slice(0)` — the whole series. Zero bars is a real answer
  // here, so it is taken before the arithmetic that would return everything.
  if (bars <= 0) return withNote(toCandleSeries({ ...history, candles: [] }));
  if (history.candles.length <= bars) return toCandleSeries(history);
  return withNote(toCandleSeries({ ...history, candles: history.candles.slice(-bars) }));
};

/**
 * The book, bounded to the depth the readings beside it are measured over.
 *
 * The gateway returns twenty levels a side and `microstructure` scores ten of
 * them; the other ten were characters nothing in the response referred to.
 */
const boundOrderBook = (book: OrderBook): OrderBook => ({
  ...book,
  bids: book.bids.slice(0, TRADING_LOOK_BOOK_LEVELS),
  asks: book.asks.slice(0, TRADING_LOOK_BOOK_LEVELS),
});

/**
 * How much of the chart this call gets echoed back — plan 34 step 1.1.
 *
 * A look that named `indicators` said what it wanted read off the bars, and
 * the reading is 140 characters where the window it was read from is 18,000.
 * Sending both is how one look became a third of a context window, so naming
 * indicators without naming `bars` means the readings and no chart. `bars: 0`
 * asks for the same thing outright; everything else is the number asked for,
 * or a short tail when nothing was.
 */
const readMarketHalf = Effect.fn("TradingToolkit.readMarketHalf")(function* (input: {
  readonly market: TradingMarket;
  readonly mission: TradingMission | null;
  readonly scopes: ReadonlySet<TradingLookScope>;
  readonly interval?: TradingTimeframe;
  readonly bars?: number;
  readonly indicators?: ReadonlyArray<IndicatorRequest>;
}) {
  const { market, mission, scopes } = input;
  // A mission-less call has no position by definition; the mission branch below
  // re-resolves this once the canonical position is in hand.
  const echoedBars = echoedBarsForLook(input);

  // The indicator readings this call asked for, computed on the same bars the
  // candle read fetched — the model pulls `ema(20)` instead of deriving it
  // from raw bars in context. Computed on the FULL fetched window, not the
  // bounded slice riding back, so a 50-period read works beside `bars: 20`.
  const indicatorReadings = (history: MarketHistory) => {
    const requests = (input.indicators ?? []).slice(0, INDICATOR_MAX_REQUESTS);
    return requests.length === 0
      ? {}
      : { indicators: requests.map((request) => computeIndicator(request, history.candles)) };
  };
  const gateway = yield* HyperliquidGateway;
  const wantsMarket = scopes.has("market");
  const wantsCandles = scopes.has("candles");
  const wantsStructure = scopes.has("structure");

  if (mission === null) {
    // No mission means no position and no history, so the market scopes are
    // the only ones with anything to answer here.
    const interval = input.interval ?? "1m";
    const needsBars = wantsCandles || wantsMarket;
    const [resolvedMarket, snapshot, orderBook, candles, structure] = yield* Effect.all(
      [
        wantsMarket ? gateway.resolveMarket(market) : Effect.succeed(null),
        wantsMarket ? gateway.getMarketSnapshot(market) : Effect.succeed(null),
        wantsMarket ? gateway.getOrderBook(market) : Effect.succeed(null),
        needsBars
          ? gateway.getMarketHistory({ market, interval, maxBars: VOLATILITY_LOOKBACK_BARS })
          : Effect.succeed(null),
        wantsStructure ? readMarketStructure({ market, mission: null }) : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );
    return {
      ...(resolvedMarket === null ? {} : { resolvedMarket }),
      ...(snapshot === null ? {} : { snapshot }),
      ...(orderBook === null ? {} : { orderBook: boundOrderBook(orderBook) }),
      ...(candles === null || !wantsCandles
        ? {}
        : {
            candles: boundCandles(candles, echoedBars),
            volatility: roundObservedVolatility(
              measureVolatility({
                market,
                interval,
                candles: candles.candles,
                measuredAt: candles.freshness.observedAt,
              }),
            ),
            ...indicatorReadings(candles),
          }),
      ...(orderBook === null || candles === null || snapshot === null
        ? {}
        : withMicrostructure(orderBook, candles.candles, snapshot)),
      ...(structure === null ? {} : { structure: digestMarketStructure(structure) }),
    };
  }

  const wantsPosition = scopes.has("position");

  const composer = yield* TradingWakeupComposer;
  const strategies = yield* TradingStrategyService;
  const plan = yield* strategies
    .getCurrentStrategy(mission.id)
    .pipe(Effect.catchCause(() => Effect.succeed(Option.none<TradingPlanState>())));
  // One observation covers all four market scopes: `observe` is the composer's
  // own gather step, and splitting it apart per scope would be a second
  // implementation of the read the shared market half exists to prevent. What
  // scope decides is which of its answers ride back in the response.
  const facts = yield* composer.observe({
    mission,
    occurredAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
    market,
    ...(Option.isNone(plan) ? {} : { activeStrategy: plan.value }),
  });

  // `observe` measures on the mission's runtime timeframe. A call that names a
  // different interval is asking a question that read cannot answer, so it
  // gets its own bounded history — and the volatility beside it stays the
  // runtime one, which is what every other cadence in the mission is measured
  // on and what the plan's levels mean.
  const namedInterval =
    input.interval !== undefined && input.interval !== facts.history.interval
      ? input.interval
      : null;
  const namedHistory =
    wantsCandles && namedInterval !== null
      ? yield* gateway
          .getMarketHistory({
            market,
            interval: namedInterval,
            maxBars: VOLATILITY_LOOKBACK_BARS,
          })
          .pipe(Effect.catchCause(() => Effect.succeed(null)))
      : null;

  // What the chart costs depends on whether there is a trade to manage. Flat,
  // it is capped; holding, the call gets the window it asked for.
  const holdingPosition = (facts.position?.size ?? 0) !== 0;
  // The close review is a flat turn that is nevertheless about a trade: the
  // playbook sends it to the `retrospect` scope to grade the hold it just
  // finished, and a chart capped to sixty bars there would hide the very hold
  // being graded.
  const readsFullChart = holdingPosition || scopes.has("retrospect");
  const heldBars = echoedBarsForLook({ ...input, holdingPosition: readsFullChart });
  // Said where the shortened table is, so the cap is a fact the model can act
  // on rather than a silent truncation it reads as the whole chart.
  const barsNote =
    !readsFullChart && (input.bars ?? 0) > heldBars
      ? `flat: the chart is capped at ${TRADING_LOOK_FLAT_BAR_CAP} bars (you asked for ` +
        `${input.bars}). Every measurement and indicator here was still computed over the full ` +
        `lookback. Ask again while holding a position, or name indicators, to read further back`
      : undefined;

  // The book is NOT re-read here. `observe` already took it, and a second read
  // would let a look and a wake quote two different books — the drift the
  // shared market half exists to prevent.
  const [resolvedMarket, structure, openOrders] = yield* Effect.all(
    [
      wantsMarket ? gateway.resolveMarket(market) : Effect.succeed(null),
      wantsStructure ? readMarketStructure({ market, mission }) : Effect.succeed(null),
      wantsPosition ? gateway.getOpenOrders(facts.address as `0x${string}`) : Effect.succeed(null),
    ],
    { concurrency: "unbounded" },
  );

  return {
    ...(resolvedMarket === null ? {} : { resolvedMarket }),
    ...(wantsMarket
      ? {
          snapshot: facts.marketSnapshot,
          ...(facts.orderBook === null ? {} : { orderBook: boundOrderBook(facts.orderBook) }),
          ...(facts.microstructure === null ? {} : { microstructure: facts.microstructure }),
          ...(facts.costContext === null ? {} : { cost: facts.costContext }),
        }
      : {}),
    ...(wantsCandles
      ? {
          candles: boundCandles(namedHistory ?? facts.history, heldBars, barsNote),
          volatility: facts.observedVolatility,
          ...(facts.higherTimeframeVolatility === null
            ? {}
            : { higherTimeframeVolatility: facts.higherTimeframeVolatility }),
          ...indicatorReadings(namedHistory ?? facts.history),
        }
      : {}),
    ...(structure === null ? {} : { structure: digestMarketStructure(structure) }),
    ...(wantsPosition
      ? {
          account: facts.accountSnapshot,
          position: facts.position,
          openOrders: openOrders ?? [],
          ...(facts.positionCosts === null ? {} : { positionCosts: facts.positionCosts }),
        }
      : {}),
  };
});

/**
 * Move the stop on an open position, inside policy — plan 24 §5, now
 * `trading_exit`'s `move_stop` action (plan 29 step 6.5).
 *
 * Lifted out of the retired `trading_exit`'s `move_stop` handler unchanged. Two steps
 * and no third: the policy decides, and an approved decision goes out as an
 * ordinary `modify_stop` intent. Nothing here re-implements the replacement —
 * the confirm-before-cancel sequence, the §17.5 escalation and the execution
 * record are the same ones `trading_enter` produces.
 */
/**
 * How much of an approved entry has to fill before the fill is unremarkable.
 *
 * Below this the difference between what was approved and what is held is
 * large enough that every number derived from the approved size — the stop's
 * planned loss, the target, the next entry's headroom — is about a different
 * position than the one the mission is in.
 */
const ENTRY_FILL_SHORTFALL_RATIO = 0.9;

/**
 * A giveback threshold that is actually ahead of the position.
 *
 * Half the current drawdown again, to the cent: far enough that the level is
 * not reached by the noise that just moved it, near enough to still be a
 * give-back rather than a surrender. A suggestion in the refusal's own words —
 * nothing arms it.
 */
const roundGivebackSuggestion = (drawdownUsd: number): string =>
  (Math.ceil(drawdownUsd * 150) / 100).toFixed(2);

/**
 * Retire one active watch — `trading_watch`'s `cancel` (plan 29 step 6.5).
 *
 * Lifted out of the retired `trading_cancel_watch` handler unchanged, including
 * the distinction the model needs: a watch that is not there and a watch that
 * is there but already terminal are different facts about the armed set, and
 * collapsing them would tell a harness its level is gone when it fired.
 */
/**
 * Turn what the model quoted back into one watch id.
 *
 * Every model-facing surface renders a watch as an eight-character handle, so
 * `cancel` and `replacesWatchId` arrive as handles — and sometimes as the full
 * id, from a turn that read one before this change or copied one out of a tool
 * result. Both resolve here against the mission's own registry.
 *
 * An unmatched handle is passed through unchanged: "no such watch" is the
 * cancel path's own answer and it distinguishes a missing watch from a
 * terminal one, which a refusal raised here would flatten.
 */
const resolveWatchId = Effect.fn("TradingToolkit.resolveWatchId")(function* (
  missionId: string,
  handle: string,
) {
  const strategies = yield* TradingStrategyService;
  const watches = yield* strategies.listWatchesForRead(missionId).pipe(Effect.orDie);
  const matches = resolveWatchHandle(
    handle,
    watches.map((watch) => watch.id),
  );
  // Two watches behind one handle is not something to guess at. Prefer the
  // active one; only a genuine tie is ambiguous, and eight hex characters make
  // that vanishingly unlikely inside one mission.
  if (matches.length > 1) {
    const active = watches.filter(
      (watch) => matches.includes(watch.id) && watch.status === "active",
    );
    if (active.length === 1) return active[0]!.id;
  }
  return matches.length === 1 ? matches[0]! : handle;
});

const cancelWatch = Effect.fn("TradingToolkit.cancelWatch")(function* (
  threadId: string,
  missionId: string,
  watchId: string,
) {
  const watches = yield* TradingWatchService;
  const cancelled = yield* watches.cancelWatch({ missionId, watchId }).pipe(
    Effect.catchTags({
      TradingMissionNotFoundError: () =>
        new TradingToolRejectedError({ reason: "mission_not_found", threadId, missionId }),
      PersistenceSqlError: (error) => Effect.die(error),
    }),
  );
  if (cancelled === null) {
    // Distinguish "no such watch" from "watch exists but is terminal".
    const existing = yield* watches.getWatch(watchId).pipe(Effect.orDie);
    return {
      outcome: "rejected" as const,
      reason: existing === null ? ("watch_not_found" as const) : ("watch_not_active" as const),
    };
  }
  yield* announceWatchCancelled({ threadId, missionId, watchId });
  return { outcome: "cancelled" as const, watch: cancelled };
});

const moveStop = Effect.fn("TradingToolkit.moveStop")(function* (input: {
  readonly missionId?: string | undefined;
  readonly market?: TradingMarket | undefined;
  readonly newStopPrice: number;
  readonly justification: StopAdjustmentJustification;
  readonly expectedPlanUpdatedAt: number;
}) {
  const market = input.market ?? DEFAULT_TRADING_MARKET;
  const { newStopPrice, justification, expectedPlanUpdatedAt } = input;
  const { threadId, mission } = yield* resolveBoundCall(input.missionId);
  const adjustments = yield* TradingStopAdjustmentService;
  const decision = yield* adjustments
    .evaluate({
      missionId: mission.id,
      market: market,
      newStopPrice: newStopPrice,
      expectedPlanUpdatedAt: expectedPlanUpdatedAt,
    })
    .pipe(Effect.orDie);

  if (decision.outcome === "refused") {
    yield* Effect.logInfo("trading stop adjustment refused", {
      missionId: mission.id,
      refusalCode: decision.refusalCode,
      detail: decision.detail,
    });
    return {
      status: "refused" as const,
      refusalCode: decision.refusalCode,
      previousStop: decision.previousStop,
      newStop: decision.newStop,
      detail: decision.detail,
    };
  }

  const sql = yield* SqlClient.SqlClient;
  const activeRuns = yield* sql<{ readonly run_id: string }>`
          SELECT run_id FROM trading_harness_runs
          WHERE mission_id = ${mission.id} AND status NOT IN ('completed', 'failed')
          ORDER BY started_at DESC
          LIMIT 1
        `.pipe(Effect.orDie);
  const activeHarnessRunId = activeRuns[0]?.run_id;
  if (activeHarnessRunId === undefined) {
    return {
      status: "refused" as const,
      refusalCode: "replacement_failed" as const,
      previousStop: decision.previousStop,
      newStop: decision.newStop,
      detail: "no harness run currently owns the decision lease",
    };
  }
  const executionSequence = yield* allocateExecutionSequence(sql, mission.id).pipe(Effect.orDie);

  const executed = yield* executeIntent({
    missionId: mission.id,
    intent: {
      missionId: mission.id,
      executionSequence,
      actionType: "modify_stop",
      market: market,
      // A stop reduces, so it rests on the side that closes the position.
      side: decision.positionSize > 0 ? "sell" : "buy",
      size: Math.abs(decision.positionSize),
      orderPreference: "resting_limit",
      limitPrice: newStopPrice,
      stop: {
        stopPrice: newStopPrice,
        plannedLossAtStopUsd: decision.plannedLossAtStopUsd,
      },
      reduceOnly: true,
    },
    expectedAuthorityVersion: mission.authorityVersion,
    activeHarnessRunId,
  });

  if (executed.status !== "succeeded") {
    return {
      status: "refused" as const,
      refusalCode: "replacement_failed" as const,
      previousStop: decision.previousStop,
      newStop: decision.newStop,
      detail: executed.detail ?? `the replacement ended ${executed.status}`,
    };
  }

  yield* adjustments
    .record({
      missionId: mission.id,
      market: market,
      previousStopPrice: decision.previousStop,
      newStopPrice: decision.newStop,
      justification: justification,
    })
    .pipe(Effect.orDie);
  yield* announceStopAdjusted({
    threadId,
    missionId: mission.id,
    market: market,
    previousStopPrice: decision.previousStop,
    newStopPrice: decision.newStop,
    justification: justification,
  });

  return {
    status: "adjusted" as const,
    previousStop: decision.previousStop,
    newStop: decision.newStop,
    stopDistanceUsd: decision.stopDistanceUsd,
    plannedLossAtStopUsd: decision.plannedLossAtStopUsd,
    remainingAdjustments: decision.remainingAdjustments,
  };
});

/**
 * Tell a plan that its target sits under the rung — in band, never blocking.
 *
 * The target is what the runtime arms `pnl_above` at, so a target below twice
 * the round trip wakes the mission to bank a move that barely paid for itself.
 * One measured mission published twelve such targets in fifteen directional
 * plans, and it was not the model's fault: the cost block is omitted when flat,
 * so every ENTRY plan was written with no rung in front of it and the accepted
 * result echoed no numbers back.
 *
 * A warning, not a refusal. A hard publish-time rejection was tried and
 * reverted — it made `trading_plan` fail in a way nothing could attribute —
 * and a refusal that fires on a degraded estimate is worse than a plan with an
 * optimistic target. So: state both numbers, accept the plan, let the next
 * revision act on it.
 *
 * Priced at what the account can actually fund, for the same reason the wake's
 * flat cost line is: the declared entry notional is not enforced anywhere, and
 * pricing the rung against a number the entry will not take produces a rung
 * that nothing fails.
 */
const targetBelowRungWarning = Effect.fn("TradingToolkit.targetBelowRungWarning")(
  function* (input: { readonly mission: TradingMission; readonly strategy: TradingPlanState }) {
    const target = input.strategy.target.profitUsd;
    if (input.strategy.intent === "stand_aside" || target === undefined || !(target > 0))
      return null;

    const sql = yield* SqlClient.SqlClient;
    const missions = yield* TradingMissionService;
    const estimator = yield* TradingCostEstimator;
    const masterAddress = yield* missions.getMasterWalletAddress(input.mission.tradingAccountId);
    const fundable = yield* readAccountMarginCapacityUsd(sql, {
      missionId: input.mission.id,
      market: input.strategy.market,
    });
    const estimate = yield* estimator.estimate({
      market: input.strategy.market,
      masterAddress,
      notionalUsd:
        fundable ??
        input.strategy.entry.initialNotionalUsd ??
        input.mission.authority.allocatedCapitalUsd,
      fallbackTakerFeeBpsPerSide: input.mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
    });
    if (target >= estimate.preferredTargetUsd) return null;

    return (
      `target ${target.toFixed(2)} USD is under the ${estimate.preferredTargetUsd.toFixed(2)} USD ` +
      `this trade should clear — twice the ${estimate.roundTripUsd.toFixed(2)} USD round trip at the ` +
      `${estimate.notionalUsd.toFixed(2)} USD the account can fund. The plan stands; the target wakes ` +
      `you for a move that barely pays for itself.`
    );
    // A cost read is an enrichment. A plan is never held up because one failed.
  },
  Effect.catchCause(() => Effect.succeed(null)),
);

const handlers = {
  trading_look: (input) => readObservation(input),

  trading_plan: (input) =>
    Effect.gen(function* () {
      const { threadId, mission } = yield* resolveBoundCall(input.missionId);
      // The strategy service keys off `input.missionId`; resolve it to the bound
      // mission so an omitted `missionId` reaches the publish path.
      const resolvedInput = { ...input, missionId: mission.id };
      // Publish plus everything an accepted publish drags behind it — the
      // announcements, the exchange reconcile, the withdrawn resting entry.
      // It lives in `TradingPlanPublication` because step 8.4's chart drag is a
      // plan revision too, and a revision that only wrote the row would move
      // the stop on screen and not on Hyperliquid.
      const outcome = yield* publishPlanWithAftermath({
        threadId,
        mission,
        publish: resolvedInput,
      });
      const published = outcome.published;
      if (published.outcome !== "accepted") return published;

      const rungWarning = yield* targetBelowRungWarning({
        mission,
        strategy: published.strategy,
      });
      const warnings = [
        ...(outcome.warnings.length === published.warnings.length
          ? published.warnings
          : outcome.warnings),
        ...(rungWarning === null ? [] : [rungWarning]),
      ];
      if (warnings.length === published.warnings.length) return published;
      return { ...published, warnings };
    }),

  /**
   * Price, size, pre-check and submit one entry.
   *
   * Everything executing used to demand of the harness is derived here from
   * state the server owns; the harness supplies only what it can actually see
   * — a side, a stop, and how much it wants on. The sizing the retired quote
   * used to return in its own call travels out with the outcome instead.
   */
  trading_enter: (input) =>
    Effect.gen(function* () {
      const { mission } = yield* resolveBoundCall(input.missionId);
      const entries = yield* TradingEntryService;
      const prepared = yield* entries.prepare({
        missionId: mission.id,
        market: input.market,
        side: input.side,
        stopPrice: input.stopPrice,
        sizeEth: input.sizeEth,
        notionalUsd: input.notionalUsd,
        actionType: input.actionType,
        urgency: input.urgency,
      });

      if (prepared.outcome === "refused") {
        // The checklist runs here now, not on the reactor, so this is the only
        // place that can tell the run's funnel an entry was attempted and
        // stopped. Without it a turn that tried, was refused by a ceiling, and
        // published a stand-aside records as `no_setup` — the same shape as a
        // turn that never wanted to trade.
        yield* recordEntryRefusal(mission.id, prepared.reason);
        return {
          status: "rejected" as const,
          cloid: "",
          orderResults: [],
          budget: { remainingCumulativeLossUsd: 0, exhausted: false },
          detail: `${prepared.reason}: ${prepared.detail}`,
          ...(prepared.feasibleSize === undefined ? {} : { feasibleSize: prepared.feasibleSize }),
          recovery: prepared.recovery,
        };
      }

      const executed = yield* executeIntent({
        missionId: mission.id,
        intent: prepared.intent,
        expectedAuthorityVersion: prepared.expectedAuthorityVersion,
        activeHarnessRunId: prepared.activeHarnessRunId,
      });

      // What actually went on, as opposed to what was approved. An IOC that
      // cannot be funded fills part of the request and still reports
      // `filled` — 12% of it, on the mission that found this — so a harness
      // reading only the approved size writes its plan's risk arithmetic
      // against a position that does not exist.
      const filledSize = (executed.orderResults as ReadonlyArray<TradingOrderResult>)
        .filter((row) => row.role !== "protection")
        .reduce((sum, row) => sum + (row.filledSize ?? 0), 0);
      const shortfall = filledSize > 0 && filledSize < prepared.size * ENTRY_FILL_SHORTFALL_RATIO;
      const notes = shortfall
        ? [
            ...prepared.notes,
            `filled ${filledSize} of the approved ${prepared.size} — the rest did not fill, so ` +
              `size your stop and your plan's risk off ${filledSize}`,
          ]
        : prepared.notes;

      // What the position actually risks at the stop: the same stop distance,
      // at the size that is really on.
      const plannedLossAtStopUsd =
        filledSize > 0 && prepared.size > 0
          ? (prepared.plannedLossAtStopUsd * filledSize) / prepared.size
          : prepared.plannedLossAtStopUsd;

      // What the server decided rides along with what the exchange did. A
      // harness told only "accepted" has to guess the size it is now holding,
      // and the guess is what it sizes its stop and its next entry against.
      return {
        ...executed,
        size: prepared.size,
        constrainedBy: prepared.constrainedBy,
        notionalUsd: prepared.notionalUsd,
        plannedLossAtStopUsd,
        estimatedRoundTripCostUsd: prepared.estimatedRoundTripCostUsd,
        ...(notes.length === 0 ? {} : { notes }),
      };
    }),

  /**
   * One `action` on exposure the mission already has.
   *
   * The dispatch is the whole of the merge: `close`, `reduce` and
   * `cancel_order` are the same `executeExit` call three retired tools made,
   * and `move_stop` is the retired `trading_exit`'s `move_stop` handler unchanged —
   * the same policy evaluation, the same `modify_stop` intent, the same record
   * and announce. Nothing about any gate moved; only the name did.
   *
   * The call is checked before anything is measured or sent, so a call that
   * does not name an exit costs no read and no transaction.
   */
  trading_exit: (input) =>
    Effect.gen(function* () {
      const refusal = readExitRequest(input);
      if (refusal !== null) {
        return {
          status: "refused_request" as const,
          reason: refusal.code,
          detail: refusal.detail,
          recovery: classifyFailure({ tag: "TradingExitRefusal", reason: refusal.code }),
        };
      }

      if (input.action === "move_stop") {
        const { newStopPrice, justification, expectedPlanUpdatedAt } = input;
        if (
          newStopPrice === undefined ||
          justification === undefined ||
          expectedPlanUpdatedAt === undefined
        ) {
          // `readExitRequest` refused exactly this a moment ago. If the two
          // ever disagree, a stop must not reach the envelope check with an
          // undefined price or an undefined plan version to lock against.
          return yield* Effect.die(
            new Error("trading_exit: a move_stop passed readExitRequest without its fields"),
          );
        }
        return yield* moveStop({
          missionId: input.missionId,
          market: input.market,
          newStopPrice,
          justification,
          expectedPlanUpdatedAt,
        });
      }

      return yield* executeExit({
        missionId: input.missionId,
        kind: input.action === "cancel_order" ? "cancel" : input.action,
        market: input.market,
        sizeEth: input.sizeEth,
        fraction: input.fraction,
        cloid: input.cloid,
        urgency: input.urgency,
      });
    }),

  // -- §14.2 read-only market-data tools -------------------------------------
  //
  // Every read handler resolves the bound mission first (the same capability +
  // thread-binding check as the §14.3 tools), then delegates to the gateway.
  // Account reads additionally resolve the master-wallet address from the
  // mission's trading account — the harness never supplies an address.
  //
  // Gateway transport errors (network, decode, identity) are defects here, not
  // typed tool failures: the only declared failure is `TradingToolRejectedError`
  // (an authz refusal), and a transport failure is an internal error the MCP
  // boundary surfaces generically. `Effect.orDie` collapses the gateway's typed
  // errors into a defect so they never widen the handler's error channel.

  trading_strategy: (input) =>
    Effect.gen(function* () {
      // Static contract data, not mission state: an unbound thread reads it
      // too. The capability is still required; only the binding is optional.
      yield* resolveReadCall(input.missionId);
      // `TradingPlaybookName` is a literal union, so an unknown name is
      // rejected at the schema boundary before this handler runs and this find
      // is exhaustive. The guard is defensive: if the union ever widens without
      // PLAYBOOKS keeping up, a die here is more honest than a silent undefined.
      const entry = PLAYBOOKS.find((playbook) => playbook.name === input.name);
      if (entry === undefined) {
        return yield* Effect.die(new Error(`trading_strategy: no playbook named ${input.name}`));
      }
      return entry;
    }),

  // -- §14.4 watch tools ------------------------------------------------------
  //
  // Each starts with the same resolveBoundCall authorization gate, then writes
  // through TradingWatchService. register and cancel announce the change on the
  // orchestration event stream so the workspace sees it over the ordered WS push
  // path; list is a plain read.

  trading_watch: (input) =>
    Effect.gen(function* () {
      const { threadId, mission } = yield* resolveBoundCall(input.missionId);

      // One call does one thing to the armed set. Neither named, or both, is a
      // rule about the call, so it stands down like every other one.
      const refuseAmbiguous = (detail: string) => ({
        outcome: "refused" as const,
        reason: "needs_condition_or_cancel" as const,
        detail,
        recovery: classifyFailure({
          tag: "TradingWatchRefusal",
          reason: "needs_condition_or_cancel",
        }),
      });
      if (input.condition !== undefined && input.cancel !== undefined) {
        return refuseAmbiguous("a call arms a condition or cancels a watch, not both");
      }
      if (input.cancel !== undefined) {
        const watchId = yield* resolveWatchId(mission.id, input.cancel);
        return yield* cancelWatch(threadId, mission.id, watchId);
      }
      if (input.condition === undefined) {
        return refuseAmbiguous("name a condition to arm, or a watch id in `cancel` to retire");
      }

      // The condition is derived into the persisted predicate before anything
      // is written, so a condition that cannot be armed arms nothing and costs
      // no transaction. What to do about it is the classifier's answer, not
      // this handler's — one place decides what a refusal means (step 6.2).
      const derived = toMarketWatch(input.condition);
      if (isWatchRefusal(derived)) {
        return {
          outcome: "refused" as const,
          reason: derived.code,
          detail: derived.detail,
          recovery: classifyFailure({ tag: "TradingWatchRefusal", reason: derived.code }),
        };
      }

      // A `giveback` the position has already given back is true the moment it
      // is written: it fires on the next sweep and wakes the run to widen the
      // same threshold again. Refusing costs the model one turn's arm; the
      // mission this was found on spent three wakes in ninety seconds on it.
      if (input.condition.kind === "giveback") {
        const missions = yield* TradingMissionService;
        const drawdown = yield* missions
          .readDrawdownFromPeak({ missionId: mission.id, market: input.condition.market })
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (drawdown !== null && drawdown >= input.condition.drawdownUsd) {
          const suggested = roundGivebackSuggestion(drawdown);
          return {
            outcome: "refused" as const,
            reason: "giveback_below_current_drawdown" as const,
            detail:
              `this position has already given back $${drawdown.toFixed(2)} of its peak, so a ` +
              `giveback at $${input.condition.drawdownUsd} would fire on the next sweep. Arm ` +
              `above the current drawdown — $${suggested} or wider — or bank the position now`,
            recovery: classifyFailure({
              tag: "TradingWatchRefusal",
              reason: "giveback_below_current_drawdown",
            }),
          };
        }
      }

      // A level armed on both sides of the current price fires on the next bar
      // whichever way it goes: the pair is a poll, not an alert, and each
      // firing costs a full turn to reconclude what the indicators already
      // said. Refused with the incumbent's handle, so the correction available
      // to the model is either to keep the level its thesis turns on or to
      // re-level this one through `replacesWatchId`.
      if (
        (derived.type === "price_cross" || derived.type === "candle_close") &&
        input.replacesWatchId === undefined
      ) {
        const strategies = yield* TradingStrategyService;
        const existing = yield* strategies
          .listWatches(mission.id)
          .pipe(Effect.catchCause(() => Effect.succeed([])));
        const mirrored = findMirroredLevel({
          market: derived.market,
          price: derived.price,
          direction: derived.direction,
          watches: existing,
        });
        // `findMirroredLevel` only ever returns a price level, so this narrows
        // rather than filters — but the union needs the check to say so.
        const incumbent = mirrored?.watch;
        if (
          incumbent !== undefined &&
          (incumbent.type === "price_cross" || incumbent.type === "candle_close")
        ) {
          const confirmation = incumbent.type === "candle_close" ? "on the close" : "on touch";
          return {
            outcome: "refused" as const,
            reason: "level_mirrors_active_watch" as const,
            detail:
              `watch ${mirrored?.id} is already armed ${confirmation} ${incumbent.direction} ` +
              `${incumbent.price}, and this level is ${derived.direction} ${derived.price} — the ` +
              `pair straddles the current price, so one side fires on the next bar whichever way ` +
              `the market goes. Arm the level your thesis turns on, or arm nothing and let the ` +
              `reassessment carry you; to move the existing level, pass ` +
              `replacesWatchId=${mirrored?.id}`,
            recovery: classifyFailure({
              tag: "TradingWatchRefusal",
              reason: "level_mirrors_active_watch",
            }),
          };
        }
      }

      const replaces =
        input.replacesWatchId === undefined
          ? undefined
          : yield* resolveWatchId(mission.id, input.replacesWatchId);

      const watches = yield* TradingWatchService;
      const registered = yield* watches
        .registerWatch({
          missionId: mission.id,
          watch: derived,
          ...(replaces === undefined ? {} : { replacesWatchId: replaces }),
        })
        .pipe(
          Effect.catchTags({
            // The mission ended, or the thread's binding is stale. Nothing
            // about the condition is wrong, so the answer is to look.
            TradingMissionNotFoundError: () => Effect.succeed(null as null),
            PersistenceSqlError: (error) => Effect.die(error),
          }),
        );
      if (registered === null) {
        return {
          outcome: "refused" as const,
          reason: "mission_not_found" as const,
          detail: "this thread's mission is no longer active; nothing was armed",
          recovery: classifyFailure({ tag: "TradingWatchRefusal", reason: "mission_not_found" }),
        };
      }
      yield* announceWatchRegistered({
        threadId,
        missionId: mission.id,
        watch: registered.watch,
      });
      // A replacement is two changes to the armed set, and the workspace has to
      // see both or it renders a level that is no longer standing.
      if (registered.replaced !== undefined) {
        yield* announceWatchCancelled({
          threadId,
          missionId: mission.id,
          watchId: registered.replaced.id,
        });
      }
      return {
        outcome: "armed" as const,
        watch: registered.watch,
        ...(registered.replaced === undefined ? {} : { replaced: registered.replaced }),
      };
    }),

  /**
   * Append one note, or read the recent ones back.
   *
   * One tool for both because they are one vocabulary: the field the model
   * writes (`note`) is the field it reads back, in the entries it wrote. A
   * separate read tool would be a second name for the same thing and a second
   * chance to drift.
   */
  trading_journal: (input) =>
    Effect.gen(function* () {
      const { mission } = yield* resolveBoundCall(input.missionId);
      const journal = yield* TradingJournalService;

      const read = (
        entries: ReadonlyArray<TradingJournalEntry>,
      ): { readonly outcome: "read"; readonly entries: ReadonlyArray<TradingJournalEntry> } => ({
        outcome: "read",
        entries,
      });

      const entries = yield* journal
        .list({ missionId: mission.id })
        .pipe(Effect.catchTag("PersistenceSqlError", (error) => Effect.die(error)));

      // No note is a read. Nothing is written and nothing can be refused.
      if (input.note === undefined) return read(entries);

      // The note is normalised before anything is written, so a note that
      // cannot be recorded costs no transaction. What to do about it is the
      // classifier's answer, not this handler's — the same rule the watch
      // refusals moved onto in step 6.3.
      const note = readJournalNote(input.note);
      if (isJournalRefusal(note)) {
        return {
          outcome: "refused" as const,
          reason: note.code,
          detail: note.detail,
          recovery: classifyFailure({ tag: "TradingJournalRefusal", reason: note.code }),
          entries,
        };
      }

      const appended = yield* journal
        .append({ missionId: mission.id, note })
        .pipe(Effect.catchTag("PersistenceSqlError", (error) => Effect.die(error)));
      if (appended === null) {
        return {
          outcome: "refused" as const,
          reason: "mission_not_found" as const,
          detail: "this thread's mission is no longer active; nothing was recorded",
          recovery: classifyFailure({
            tag: "TradingJournalRefusal",
            reason: "mission_not_found",
          }),
          entries,
        };
      }

      return {
        outcome: "noted" as const,
        entry: appended,
        entries: [appended, ...entries].slice(0, TRADING_JOURNAL_READ_LIMIT),
      };
    }),
} satisfies Parameters<typeof TradingToolkit.toLayer>[0];

export const TradingToolkitHandlersLive = TradingToolkit.toLayer(handlers);
