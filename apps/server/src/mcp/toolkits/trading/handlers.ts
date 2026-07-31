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
import { CommandId, ThreadId, TradingMissionId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

import type { TradingMission } from "../../../trading/Schemas.ts";
import type { PersistedWatch } from "../../../trading/Schemas.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { TradingWatchService } from "../../../trading/TradingWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { TradingToolkit } from "./tools.ts";

interface BoundCall {
  readonly threadId: string;
  readonly mission: TradingMission;
}

/**
 * Resolve the mission a trading tool call is authorized to act on.
 *
 * Capability is granted per session; authorization is resolved per call. §10.2
 * freezes one active mission onto one provider thread, so the thread carried by
 * the credential — not an argument the harness supplies — decides which mission
 * is reachable. A `missionId` argument is checked against that binding rather
 * than trusted.
 */
const resolveBoundCall = Effect.fn("TradingToolkit.resolveBoundCall")(function* (
  missionId: string,
): Effect.fn.Return<
  BoundCall,
  TradingToolRejectedError,
  McpInvocationContext.McpInvocationContext | TradingMissionService
> {
  const scope = yield* McpInvocationContext.requireCapability(
    "trading",
    (denial) =>
      new TradingToolRejectedError({
        reason: "capability_not_granted",
        threadId: denial.threadId,
        missionId,
      }),
  );

  const missions = yield* TradingMissionService;
  const bound = yield* missions.findMissionByThreadId(scope.threadId).pipe(Effect.orDie);

  if (Option.isNone(bound)) {
    return yield* new TradingToolRejectedError({
      reason: "thread_not_bound_to_mission",
      threadId: scope.threadId,
      missionId,
    });
  }

  if (bound.value.id !== missionId) {
    return yield* new TradingToolRejectedError({
      reason: "mission_not_bound_to_thread",
      threadId: scope.threadId,
      missionId,
    });
  }

  return { threadId: scope.threadId, mission: bound.value };
});

const readMission = Effect.fn("TradingToolkit.readMission")(function* (mission: TradingMission) {
  const strategies = yield* TradingStrategyService;
  const strategy = yield* strategies.getCurrentStrategy(mission.id).pipe(Effect.orDie);
  const watches = yield* strategies.listWatches(mission.id).pipe(Effect.orDie);

  return {
    mission,
    authority: mission.authority,
    authorityVersion: mission.authorityVersion,
    ...(Option.isNone(strategy) ? {} : { strategy: strategy.value }),
    strategyVersion: mission.strategyVersion,
    watches,
    control: mission.control,
    harness: mission.harness,
  } satisfies TradingGetMissionResult;
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

const handlers = {
  trading_get_mission: (input) =>
    resolveBoundCall(input.missionId).pipe(Effect.flatMap(({ mission }) => readMission(mission))),

  trading_publish_momentum_strategy: (input) =>
    Effect.gen(function* () {
      const { threadId } = yield* resolveBoundCall(input.missionId);
      const strategies = yield* TradingStrategyService;
      const published = yield* strategies.publishMomentumStrategy(input).pipe(
        Effect.catchTags({
          // The mission was resolved a moment ago, so a miss here means it was
          // deleted mid-call. Report it as a rejection rather than a defect.
          TradingMissionNotFoundError: () =>
            new TradingToolRejectedError({
              reason: "mission_not_found",
              threadId,
              missionId: input.missionId,
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
          missionId: input.missionId,
          strategyVersion: published.strategyVersion,
          supersededWatchIds: published.supersededWatchIds,
        });
      }

      return published;
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
      yield* resolveBoundCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.resolveMarket(input.market).pipe(Effect.orDie);
    }),

  trading_get_market_snapshot: (input) =>
    Effect.gen(function* () {
      yield* resolveBoundCall(input.missionId);
      const gateway = yield* HyperliquidGateway;
      return yield* gateway.getMarketSnapshot(input.market).pipe(Effect.orDie);
    }),

  trading_get_market_history: (input) =>
    Effect.gen(function* () {
      yield* resolveBoundCall(input.missionId);
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

  trading_get_order_book: (input) =>
    Effect.gen(function* () {
      yield* resolveBoundCall(input.missionId);
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
      return yield* gateway.getPosition(address, input.market).pipe(Effect.orDie);
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

  // -- §14.4 watch tools ------------------------------------------------------
  //
  // Each starts with the same resolveBoundCall authorization gate, then writes
  // through TradingWatchService. register and cancel announce the change on the
  // orchestration event stream so the workspace sees it over the ordered WS push
  // path; list is a plain read.

  trading_register_watch: (input) =>
    Effect.gen(function* () {
      const { threadId } = yield* resolveBoundCall(input.missionId);
      const watches = yield* TradingWatchService;
      const watch = yield* watches.registerWatch(input).pipe(
        Effect.catchTags({
          TradingMissionNotFoundError: () =>
            new TradingToolRejectedError({
              reason: "mission_not_found",
              threadId,
              missionId: input.missionId,
            }),
          PersistenceSqlError: (error) => Effect.die(error),
        }),
      );
      yield* announceWatchRegistered({
        threadId,
        missionId: input.missionId,
        watch,
      });
      return watch;
    }),

  trading_schedule_reassessment: (input) =>
    Effect.gen(function* () {
      const { threadId } = yield* resolveBoundCall(input.missionId);
      const watches = yield* TradingWatchService;
      // A scheduled reassessment is a watch of type `scheduled_reassessment`;
      // it rides the same register/announce path as any other watch.
      const watch = yield* watches
        .registerWatch({
          missionId: input.missionId,
          watch: { type: "scheduled_reassessment", runAt: input.runAt },
        })
        .pipe(
          Effect.catchTags({
            TradingMissionNotFoundError: () =>
              new TradingToolRejectedError({
                reason: "mission_not_found",
                threadId,
                missionId: input.missionId,
              }),
            PersistenceSqlError: (error) => Effect.die(error),
          }),
        );
      yield* announceWatchRegistered({
        threadId,
        missionId: input.missionId,
        watch,
      });
      return watch;
    }),

  trading_list_watches: (input) =>
    Effect.gen(function* () {
      yield* resolveBoundCall(input.missionId);
      // listWatches lives on TradingStrategyService (the mission read model
      // reads watches through it).
      const strategies = yield* TradingStrategyService;
      return yield* strategies.listWatches(input.missionId).pipe(
        Effect.catchTags({
          PersistenceSqlError: (error) => Effect.die(error),
        }),
      );
    }),

  trading_cancel_watch: (input) =>
    Effect.gen(function* () {
      const { threadId } = yield* resolveBoundCall(input.missionId);
      const watches = yield* TradingWatchService;
      const cancelled = yield* watches.cancelWatch(input).pipe(
        Effect.catchTags({
          TradingMissionNotFoundError: () =>
            new TradingToolRejectedError({
              reason: "mission_not_found",
              threadId,
              missionId: input.missionId,
            }),
          PersistenceSqlError: (error) => Effect.die(error),
        }),
      );
      if (cancelled === null) {
        return { outcome: "rejected", reason: "watch_not_active" as const };
      }
      yield* announceWatchCancelled({
        threadId,
        missionId: input.missionId,
        watchId: input.watchId,
      });
      return { outcome: "cancelled" as const, watch: cancelled };
    }),
} satisfies Parameters<typeof TradingToolkit.toLayer>[0];

export const TradingToolkitHandlersLive = TradingToolkit.toLayer(handlers);
