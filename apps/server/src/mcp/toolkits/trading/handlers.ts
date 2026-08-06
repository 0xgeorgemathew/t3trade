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
  type TradingRequestEntryInput,
} from "@t3tools/trading-contracts/tools";
import { CommandId, ThreadId, TradingMissionId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

import type { TradingMission } from "../../../trading/Schemas.ts";
import type { PersistedWatch } from "../../../trading/Schemas.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingStopAdjustmentService } from "../../../trading/TradingStopAdjustmentService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { TradingWatchService } from "../../../trading/TradingWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { AgentNetPosition } from "@t3tools/trading-contracts/account-snapshot";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import {
  analyseMomentum,
  MOMENTUM_LOOKBACK_BARS,
  MOMENTUM_TIMEFRAMES,
} from "@t3tools/trading-contracts/momentum";
import { PLAYBOOKS } from "@t3tools/trading-contracts/playbook";
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
 * What `trading_get_mission` answers when the thread has no live mission: the
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

const readMission = Effect.fn("TradingToolkit.readMission")(function* (mission: TradingMission) {
  const strategies = yield* TradingStrategyService;
  const strategy = yield* strategies.getCurrentStrategy(mission.id).pipe(Effect.orDie);
  const watches = yield* strategies.listWatches(mission.id).pipe(Effect.orDie);
  const missions = yield* TradingMissionService;
  // The same set preview item 16 refuses against, so a harness told
  // `no_conflicting_execution_pending` can read what is holding the lock.
  const pendingExecutions = yield* missions.listPendingExecutions(mission.id).pipe(Effect.orDie);
  // What the mission has believed, not only what it believes now. A harness
  // that has republished three times cannot otherwise see the targets it set
  // before this one.
  const strategyHistory = yield* strategies.listStrategyVersions(mission.id).pipe(Effect.orDie);

  return {
    bound: true,
    mission,
    authority: mission.authority,
    authorityVersion: mission.authorityVersion,
    ...(Option.isNone(strategy) ? {} : { strategy: strategy.value }),
    strategyVersion: mission.strategyVersion,
    watches,
    control: mission.control,
    harness: mission.harness,
    pendingExecutions,
    strategyHistory,
  } satisfies TradingGetMissionResult;
});

/**
 * Add the position's high-water mark and how far it has come off it.
 *
 * The gateway reads the exchange, and the exchange has no memory of what a
 * position was worth at its best — so a harness woken after a winner faded
 * could not tell it from a trade that never worked. The peak is T3's own,
 * maintained by the reconciler; a position with no recorded peak is returned
 * untouched rather than reported as having given back nothing.
 */
const withPeakPnl = Effect.fn("TradingToolkit.withPeakPnl")(function* (
  position: AgentNetPosition,
  missionId: string,
  market: string,
) {
  const missions = yield* TradingMissionService;
  const peak = yield* missions.readPeakUnrealisedPnl({ missionId, market }).pipe(Effect.orDie);
  if (peak === null) return position;
  return {
    ...position,
    peakUnrealisedPnl: peak,
    drawdownFromPeakUsd: Math.max(0, peak - position.unrealisedPnl),
  };
});

const announceStrategyPublished = Effect.fn("TradingToolkit.announceStrategyPublished")(
  function* (input: {
    readonly threadId: string;
    readonly missionId: string;
    readonly strategyVersion: number;
    readonly supersededWatchIds: ReadonlyArray<string>;
  }) {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    yield* engine
      .dispatch({
        type: "trading.mission.strategy-published",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(input.threadId),
        missionId: TradingMissionId.make(input.missionId),
        strategyVersion: input.strategyVersion,
        supersededWatchIds: input.supersededWatchIds,
        createdAt,
      })
      // The strategy is already durable; failing to announce it costs the UI a
      // refresh, not the publish.
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not announce a published strategy to the orchestration engine", {
            missionId: input.missionId,
            strategyVersion: input.strategyVersion,
            cause,
          }),
        ),
      );
  },
);

/**
 * Put the mission's post-publish status on the WS push path.
 *
 * `publishMomentumStrategy` moves a mission out of `analysing` as part of the
 * publish itself (§11.1 `analysing → waiting`). That write is durable but
 * invisible to the workspace, which learns about mission status from
 * `trading.mission.status-set` events; announcing the status the publish
 * settled on is what closes that gap.
 */
const announceMissionStatus = Effect.fn("TradingToolkit.announceMissionStatus")(function* (input: {
  readonly threadId: string;
  readonly missionId: string;
}) {
  const missions = yield* TradingMissionService;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  yield* Effect.gen(function* () {
    const mission = yield* missions.getMission(input.missionId);
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* engine.dispatch({
      type: "trading.mission.status-set",
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make(input.threadId),
      missionId: TradingMissionId.make(input.missionId),
      status: mission.status,
      createdAt,
    });
  }).pipe(
    // The publish and its status are already durable; failing to announce them
    // costs the UI a refresh, not the publish.
    Effect.catchCause((cause) =>
      Effect.logWarning("could not announce a mission status after a strategy publish", {
        missionId: input.missionId,
        cause,
      }),
    ),
  );
});

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
 * Submit one execution intent and wait for what actually happened to it.
 *
 * Shared by `trading_execute` and its older alias `trading_request_entry` —
 * one implementation, so the two names can never drift into two behaviours.
 */
const executeIntent = (input: TradingRequestEntryInput) =>
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

const handlers = {
  trading_get_mission: (input) =>
    Effect.gen(function* () {
      const call = yield* resolveReadCall(input.missionId);
      if (call.mission === null) return yield* readUnboundMission(call.threadId);
      // Omitting `missionId` resolves to the bound mission. Naming a different
      // one is still a mismatch, not an unbound read.
      if (input.missionId !== undefined && call.mission.id !== input.missionId) {
        return yield* rejectCall({
          reason: "mission_not_bound_to_thread",
          threadId: call.threadId,
          missionId: input.missionId,
        });
      }
      return yield* readMission(call.mission);
    }),

  trading_publish_plan: (input) =>
    Effect.gen(function* () {
      const { threadId, mission } = yield* resolveBoundCall(input.missionId);
      // The strategy service keys off `input.missionId`; resolve it to the bound
      // mission so an omitted `missionId` reaches the publish path.
      const resolvedInput = { ...input, missionId: mission.id };
      const strategies = yield* TradingStrategyService;
      const published = yield* strategies.publishMomentumStrategy(resolvedInput).pipe(
        Effect.catchTags({
          // The mission was resolved a moment ago, so a miss here means it was
          // deleted mid-call. Report it as a rejection rather than a defect.
          TradingMissionNotFoundError: () =>
            new TradingToolRejectedError({
              reason: "mission_not_found",
              threadId,
              missionId: mission.id,
            }),
          PersistenceSqlError: (error) => Effect.die(error),
        }),
      );

      // An accepted publish is mission state the workspace has to see. Raising
      // it as an orchestration command is what puts it on the ordered WS push
      // path instead of leaving the UI to poll.
      if (published.outcome === "accepted") {
        yield* announceStrategyPublished({
          threadId,
          missionId: mission.id,
          strategyVersion: published.strategyVersion,
          supersededWatchIds: published.supersededWatchIds,
        });
        yield* announceMissionStatus({ threadId, missionId: mission.id });
      }

      return published;
    }),

  trading_execute: (input) => executeIntent(input),

  /**
   * The bounded stop move (plan 24 §5).
   *
   * Two steps and no third: the policy decides, and an approved decision goes
   * out as an ordinary `modify_stop` intent. Nothing here re-implements the
   * replacement — the confirm-before-cancel sequence, the §17.5 escalation and
   * the execution record are the same ones `trading_execute` produces.
   */
  trading_adjust_stop: (input) =>
    Effect.gen(function* () {
      const { threadId, mission } = yield* resolveBoundCall(input.missionId);
      const adjustments = yield* TradingStopAdjustmentService;
      const decision = yield* adjustments
        .evaluate({
          missionId: mission.id,
          market: input.market,
          newStopPrice: input.newStopPrice,
          observedAtrUsd: input.observedAtrUsd,
          expectedVersion: input.expectedVersion,
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

      const executed = yield* executeIntent({
        missionId: mission.id,
        intent: {
          missionId: mission.id,
          strategyVersion: input.expectedVersion,
          executionSequence: input.executionSequence,
          actionType: "modify_stop",
          market: input.market,
          // A stop reduces, so it rests on the side that closes the position.
          side: decision.positionSize > 0 ? "sell" : "buy",
          size: Math.abs(decision.positionSize),
          orderPreference: "resting_limit",
          limitPrice: input.newStopPrice,
          stop: {
            stopPrice: input.newStopPrice,
            plannedLossAtStopUsd: decision.plannedLossAtStopUsd,
          },
          reduceOnly: true,
        },
        expectedAuthorityVersion: input.expectedAuthorityVersion,
        activeHarnessRunId: input.activeHarnessRunId,
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
          market: input.market,
          previousStopPrice: decision.previousStop,
          newStopPrice: decision.newStop,
          justification: input.justification,
        })
        .pipe(Effect.orDie);
      yield* announceStopAdjusted({
        threadId,
        missionId: mission.id,
        market: input.market,
        previousStopPrice: decision.previousStop,
        newStopPrice: decision.newStop,
        justification: input.justification,
      });

      return {
        status: "adjusted" as const,
        previousStop: decision.previousStop,
        newStop: decision.newStop,
        stopDistanceUsd: decision.stopDistanceUsd,
        plannedLossAtStopUsd: decision.plannedLossAtStopUsd,
        remainingAdjustments: decision.remainingAdjustments,
      };
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

  trading_resolve_market: (input) =>
    Effect.gen(function* () {
      // Market data, not mission state: an unbound thread reads it too.
      yield* resolveReadCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.resolveMarket(input.market).pipe(Effect.orDie);
    }),

  trading_get_market_snapshot: (input) =>
    Effect.gen(function* () {
      // Market data, not mission state: an unbound thread reads it too.
      yield* resolveReadCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.getMarketSnapshot(input.market).pipe(Effect.orDie);
    }),

  trading_get_market_history: (input) =>
    Effect.gen(function* () {
      // Market data, not mission state: an unbound thread reads it too.
      yield* resolveReadCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway
        .getMarketHistory({
          market: input.market,
          interval: input.interval,
          startTime: input.startTime,
          endTime: input.endTime,
          maxBars: input.maxBars,
        })
        .pipe(Effect.orDie);
    }),

  trading_measure_volatility: (input) =>
    Effect.gen(function* () {
      // Market data, not mission state: an unbound thread reads it too.
      yield* resolveReadCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      const history = yield* gateway
        .getMarketHistory({
          market: input.market,
          interval: input.interval,
          maxBars: input.lookbackBars ?? VOLATILITY_LOOKBACK_BARS,
        })
        .pipe(Effect.orDie);

      // The candles carry their own observation time, so the measurement is
      // stamped with when the data was read rather than when this returned.
      return measureVolatility({
        market: input.market,
        interval: input.interval,
        candles: history.candles,
        measuredAt: history.freshness.observedAt,
        ...(input.holdBars === undefined ? {} : { holdHorizons: input.holdBars }),
      });
    }),

  trading_estimate_costs: (input) =>
    Effect.gen(function* () {
      // The fee rate is per-wallet, so this one needs the bound mission: both
      // to resolve the master address and to read the authority's fallback rate.
      const { mission } = yield* resolveBoundCall(input.missionId);
      const missions = yield* TradingMissionService;
      const masterAddress = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.orDie);
      const estimator = yield* TradingCostEstimator;
      return yield* estimator.estimate({
        market: input.market,
        masterAddress,
        sizeEth: input.sizeEth,
        notionalUsd: input.notionalUsd,
        fallbackTakerFeeBpsPerSide: mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
      });
    }),

  trading_get_market_structure: (input) =>
    Effect.gen(function* () {
      // Market data, not mission state: an unbound thread reads it too.
      yield* resolveReadCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      const intervals = input.intervals ?? MOMENTUM_TIMEFRAMES;
      const maxBars = input.lookbackBars ?? MOMENTUM_LOOKBACK_BARS;

      // One read per timeframe, concurrently — the point of the tool is the
      // comparison, so serialising them would put seconds between the fastest
      // and the slowest view of the same moment.
      const histories = yield* Effect.all(
        intervals.map((interval) =>
          gateway
            .getMarketHistory({ market: input.market, interval, maxBars })
            .pipe(Effect.map((history) => ({ interval, history }))),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.orDie);

      return analyseMomentum({
        market: input.market,
        // The candles carry their own observation time, so the reading is
        // stamped with when the data was read rather than when this returned.
        measuredAt: histories[0]?.history.freshness.observedAt ?? 0,
        frames: histories.map(({ interval, history }) => ({
          interval,
          candles: history.candles,
        })),
      });
    }),

  trading_get_trade_history: (input) =>
    Effect.gen(function* () {
      // A mission's own trades are mission state, so this one needs the binding.
      const { mission } = yield* resolveBoundCall(input.missionId);
      const history = yield* TradingTradeHistoryService;
      return yield* history.read({ missionId: mission.id, limit: input.limit }).pipe(Effect.orDie);
    }),

  trading_get_target_calibration: (input) =>
    Effect.gen(function* () {
      // A mission grading its own targets is mission state.
      const { mission } = yield* resolveBoundCall(input.missionId);
      const calibration = yield* TradingCalibrationService;
      return yield* calibration.read({ missionId: mission.id }).pipe(Effect.orDie);
    }),

  trading_get_order_book: (input) =>
    Effect.gen(function* () {
      // Market data, not mission state: an unbound thread reads it too.
      yield* resolveReadCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.getOrderBook(input.market).pipe(Effect.orDie);
    }),

  trading_get_account_state: (input) =>
    Effect.gen(function* () {
      const { mission } = yield* resolveBoundCall(input.missionId);
      const missions = yield* TradingMissionService;
      const address = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.orDie);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.getAccountSnapshot(address).pipe(Effect.orDie);
    }),

  trading_get_position: (input) =>
    Effect.gen(function* () {
      const { mission } = yield* resolveBoundCall(input.missionId);
      const missions = yield* TradingMissionService;
      const address = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.orDie);
      const gateway = yield* HyperliquidGateway;
      const position = yield* gateway.getPosition(address, input.market).pipe(Effect.orDie);
      return yield* withPeakPnl(position, mission.id, input.market);
    }),

  trading_get_open_orders: (input) =>
    Effect.gen(function* () {
      const { mission } = yield* resolveBoundCall(input.missionId);
      const missions = yield* TradingMissionService;
      const address = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.orDie);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.getOpenOrders(address).pipe(Effect.orDie);
    }),

  trading_get_playbook: (input) =>
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
        return yield* Effect.die(
          new Error(`trading_get_playbook: no playbook named ${input.name}`),
        );
      }
      return entry;
    }),

  // -- §14.4 watch tools ------------------------------------------------------
  //
  // Each starts with the same resolveBoundCall authorization gate, then writes
  // through TradingWatchService. register and cancel announce the change on the
  // orchestration event stream so the workspace sees it over the ordered WS push
  // path; list is a plain read.

  trading_register_watch: (input) =>
    Effect.gen(function* () {
      const { threadId, mission } = yield* resolveBoundCall(input.missionId);
      const watches = yield* TradingWatchService;
      const registered = yield* watches.registerWatch({ ...input, missionId: mission.id }).pipe(
        Effect.catchTags({
          TradingMissionNotFoundError: () =>
            new TradingToolRejectedError({
              reason: "mission_not_found",
              threadId,
              missionId: mission.id,
            }),
          PersistenceSqlError: (error) => Effect.die(error),
        }),
      );
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
      return registered;
    }),

  trading_list_watches: (input) =>
    Effect.gen(function* () {
      const { mission } = yield* resolveBoundCall(input.missionId);
      // listWatches lives on TradingStrategyService (the mission read model
      // reads watches through it).
      const strategies = yield* TradingStrategyService;
      return yield* strategies.listWatches(mission.id).pipe(
        Effect.catchTags({
          PersistenceSqlError: (error) => Effect.die(error),
        }),
      );
    }),

  trading_cancel_watch: (input) =>
    Effect.gen(function* () {
      const { threadId, mission } = yield* resolveBoundCall(input.missionId);
      const watches = yield* TradingWatchService;
      const cancelled = yield* watches
        .cancelWatch({ missionId: mission.id, watchId: input.watchId })
        .pipe(
          Effect.catchTags({
            TradingMissionNotFoundError: () =>
              new TradingToolRejectedError({
                reason: "mission_not_found",
                threadId,
                missionId: mission.id,
              }),
            PersistenceSqlError: (error) => Effect.die(error),
          }),
        );
      if (cancelled === null) {
        // Distinguish "no such watch" from "watch exists but is terminal".
        const existing = yield* watches.getWatch(input.watchId).pipe(Effect.orDie);
        return {
          outcome: "rejected" as const,
          reason: existing === null ? ("watch_not_found" as const) : ("watch_not_active" as const),
        };
      }
      yield* announceWatchCancelled({
        threadId,
        missionId: mission.id,
        watchId: input.watchId,
      });
      return { outcome: "cancelled" as const, watch: cancelled };
    }),
} satisfies Parameters<typeof TradingToolkit.toLayer>[0];

export const TradingToolkitHandlersLive = TradingToolkit.toLayer(handlers);
