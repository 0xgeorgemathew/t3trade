/**
 * The trading services the server runtime provides.
 *
 * The SQL-backed services sit on the migration-035/-036/-037 tables; the
 * hyperliquid transport (Info + Exchange HTTP clients, market resolver, read
 * gateway, nonce coordinator) sits on the server's `HttpClient`.
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
} from "@t3tools/hyperliquid";
import { HyperliquidExecutionServiceLive } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconcilerLive } from "./HyperliquidReconciler.ts";
import { TradingExecutionGuardLive } from "./TradingExecutionGuard.ts";
import { InterimSignerConfigLive } from "./InterimSignerConfig.ts";
import { TradingMissionProjectionLive } from "./TradingMissionProjection.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingPreviewServiceLive } from "./TradingPreviewService.ts";
import { TradingStrategyServiceLive } from "./TradingStrategyService.ts";

/**
 * The Hyperliquid read path, composed bottom-up so each service's build-time
 * dependency is provided at the right level:
 *
 *  1. `FetchHttpClient.layer` → provides `HttpClient.HttpClient`.
 *  2. `HyperliquidInfoClientLive` → yields HttpClient at build; provided (1).
 *  3. `HyperliquidMarketResolverLive` → yields InfoClient at build; provided (2).
 *  4. `HyperliquidGatewayLive` → yields InfoClient + Resolver at build; provided (2)+(3).
 *
 * Only `HyperliquidGateway` surfaces from this layer.
 */
// FetchHttpClient needs NodeServices; bake it in so the trading layer is
// self-contained and doesn't leak HttpClient requirements to consumers.
const httpWithNode = FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer));

const infoWithHttp = HyperliquidInfoClientLive.pipe(Layer.provide(httpWithNode));
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));

export const HyperliquidReadLayerLive = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

/**
 * The Hyperliquid write path. The exchange client shares the same HttpClient
 * as the read path; the nonce coordinator is a single serialized lane per
 * wallet (in-memory for the POC; a persisted recovery hint lands with the
 * restart-recovery work).
 */
const exchangeWithHttp = HyperliquidExchangeClientLive.pipe(Layer.provide(httpWithNode));

/**
 * The core trading layer: mission/strategy/projection + the read path. This
 * is what the mission reactor and its tests need — it does not pull in the
 * exchange write path or the execution services, so a test exercising only
 * mission orchestration is not forced to provide an HttpClient for signing.
 */
export const TradingCoreLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  TradingMissionProjectionLive,
  HyperliquidReadLayerLive,
);

/**
 * The full trading layer. The foundational services (core + signer + the
 * exchange write path) are merged first; the preview + execution services
 * are then provided-merge'd on top because they depend on those foundations.
 * This ordering satisfies the layer-dependency constraint that `Layer.mergeAll`
 * (parallel) would otherwise violate.
 */
const TradingFoundation = Layer.mergeAll(
  TradingCoreLayerLive,
  InterimSignerConfigLive,
  exchangeWithHttp,
  HyperliquidNonceCoordinatorLive(),
);

export const TradingLayerLive = TradingFoundation.pipe(
  Layer.provideMerge(TradingPreviewServiceLive),
  Layer.provideMerge(HyperliquidExecutionServiceLive),
  Layer.provideMerge(HyperliquidReconcilerLive),
  Layer.provideMerge(TradingExecutionGuardLive),
);
