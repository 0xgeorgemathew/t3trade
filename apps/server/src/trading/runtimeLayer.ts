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
import { TradingBudgetReaderLive } from "./TradingBudgetReader.ts";
import { TradingFillReconcilerLive } from "./TradingFillReconciler.ts";
import { TradingProtectionServiceLive } from "./TradingProtectionService.ts";
import { TradingEmergencyCloseServiceLive } from "./TradingEmergencyCloseService.ts";

const httpWithNode = FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer));
const infoWithHttp = HyperliquidInfoClientLive.pipe(Layer.provide(httpWithNode));
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));
const gatewayWithRead = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

export const HyperliquidReadLayerLive = Layer.mergeAll(
  infoWithHttp,
  resolverWithInfo,
  gatewayWithRead,
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
 * The full trading layer. Foundations are built first, then supplied to the
 * preview/budget consumers and finally to the execution consumers.
 */
const TradingFoundation = Layer.mergeAll(
  TradingCoreLayerLive,
  InterimSignerConfigLive,
  exchangeWithHttp,
  HyperliquidNonceCoordinatorLive(),
  HyperliquidWebSocketClientLive,
);

const TradingWithPreview = Layer.mergeAll(TradingPreviewServiceLive, TradingBudgetReaderLive).pipe(
  Layer.provideMerge(TradingFoundation),
);

const TradingExecutionCore = Layer.mergeAll(
  HyperliquidExecutionServiceLive,
  HyperliquidReconcilerLive,
).pipe(Layer.provideMerge(TradingWithPreview));

const TradingExecutionLayerLive = Layer.mergeAll(
  TradingExecutionGuardLive,
  TradingFillReconcilerLive,
  TradingProtectionServiceLive,
  TradingEmergencyCloseServiceLive,
).pipe(Layer.provideMerge(TradingExecutionCore));

export const TradingLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  TradingWatchServiceLive,
  TradingEventInboxLive,
  coordinatorWithDeps,
  TradingExecutionLayerLive,
  HyperliquidWsLayerLive,
).pipe(Layer.provideMerge(infoWithHttp));
