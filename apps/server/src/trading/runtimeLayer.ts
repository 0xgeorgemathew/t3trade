/**
 * The trading services the server runtime provides.
 *
 * The SQL-backed services sit on the migration-035/-036 tables; the hyperliquid
 * transport (Info HTTP client + market resolver + read gateway) sits on the
 * server's `HttpClient`.
 *
 * @module TradingRuntimeLayer
 */
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  HyperliquidGatewayLive,
  HyperliquidInfoClientLive,
  HyperliquidMarketResolverLive,
  HyperliquidWebSocketClientLive,
} from "@t3tools/hyperliquid";
import { TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingMissionProjectionLive } from "./TradingMissionProjection.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";
import { TradingWatchServiceLive } from "./TradingWatchService.ts";

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
const infoWithHttp = HyperliquidInfoClientLive.pipe(Layer.provide(FetchHttpClient.layer));
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));

export const HyperliquidReadLayerLive = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

/**
 * The WebSocket client layer. It owns a scoped socket, so it is kept separate
 * from the read layer (which is HTTP-only) and provided to the services that
 * consume streams — currently the watch evaluator.
 */
export const HyperliquidWsLayerLive = HyperliquidWebSocketClientLive;

/**
 * The trading services. The turn coordinator depends on the mission, strategy,
 * and inbox services, so it is built with those provided rather than merged
 * flat — this keeps `TradingLayerLive` free of unsatisfied requirements for
 * consumers that provide it wholesale (the reactor wiring, the engine harness).
 */
const coordinatorWithDeps = TradingTurnCoordinatorLive.pipe(
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingStrategyServiceLive),
  Layer.provideMerge(TradingEventInboxLive),
);

export const TradingLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  TradingWatchServiceLive,
  TradingEventInboxLive,
  coordinatorWithDeps,
  TradingMissionProjectionLive,
  HyperliquidReadLayerLive,
  HyperliquidWsLayerLive,
);
