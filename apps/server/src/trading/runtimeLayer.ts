/**
 * The trading services the server runtime provides.
 *
 * The SQL-backed services sit on the migration-035/-036/-037 tables; the
 * Hyperliquid transport and execution services are composed here so callers
 * receive a complete trading runtime.
 *
 * @module TradingRuntimeLayer
 */
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  HyperliquidExchangeClientLive,
  HyperliquidGatewayLive,
  HyperliquidInfoClientLive,
  HyperliquidMarketResolverLive,
  HyperliquidNonceCoordinatorLive,
  HyperliquidWebSocketClientLive,
} from "@t3tools/hyperliquid";
import { HyperliquidExecutionServiceLive } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconcilerLive } from "./HyperliquidReconciler.ts";
import { TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingExecutionGuardLive } from "./TradingExecutionGuard.ts";
import { InterimSignerConfigLive } from "./InterimSignerConfig.ts";
import { TradingMissionProjectionLive } from "./TradingMissionProjection.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingPreviewServiceLive } from "./TradingPreviewService.ts";
import { TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";
import { TradingWakeupComposerLive } from "./TradingWakeupComposer.ts";
import { TradingWatchServiceLive } from "./TradingWatchService.ts";

const httpWithNode = FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer));
const infoWithHttp = HyperliquidInfoClientLive.pipe(Layer.provide(httpWithNode));
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));

export const HyperliquidReadLayerLive = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

export const HyperliquidWsLayerLive = HyperliquidWebSocketClientLive;

/**
 * Mission services that do not require the exchange write path. This layer is
 * kept for the reactor's narrow unit tests.
 */
export const TradingCoreLayerLive = Layer.mergeAll(
  TradingMissionProjectionLive,
  HyperliquidReadLayerLive,
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
);

const composerWithDeps = TradingWakeupComposerLive.pipe(
  Layer.provide(HyperliquidReadLayerLive),
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingWatchServiceLive),
);

const coordinatorWithDeps = TradingTurnCoordinatorLive.pipe(
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingStrategyServiceLive),
  Layer.provideMerge(TradingEventInboxLive),
  Layer.provideMerge(composerWithDeps),
);

const exchangeWithHttp = HyperliquidExchangeClientLive.pipe(Layer.provide(httpWithNode));

/**
 * The full trading layer. A1 will correct the consumer/foundation direction
 * of the final composition; keeping the stages explicit makes that boundary
 * visible and preserves both the wakeup and execution services after merge.
 */
const TradingFoundation = Layer.mergeAll(
  TradingCoreLayerLive,
  InterimSignerConfigLive,
  exchangeWithHttp,
  HyperliquidNonceCoordinatorLive(),
);

const TradingExecutionLayerLive = TradingFoundation.pipe(
  Layer.provideMerge(TradingPreviewServiceLive),
  Layer.provideMerge(HyperliquidExecutionServiceLive),
  Layer.provideMerge(HyperliquidReconcilerLive),
  Layer.provideMerge(TradingExecutionGuardLive),
);

export const TradingLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  TradingWatchServiceLive,
  TradingEventInboxLive,
  coordinatorWithDeps,
  TradingExecutionLayerLive,
  HyperliquidWsLayerLive,
);
