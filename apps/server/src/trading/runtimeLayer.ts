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
import { TradingWakeupComposerLive } from "./TradingWakeupComposer.ts";
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
 * The wakeup composer depends on the gateway, mission, watch, and inbox
 * services, so it is built with those provided rather than merged flat.
 */
const composerWithDeps = TradingWakeupComposerLive.pipe(
  Layer.provide(HyperliquidReadLayerLive),
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingWatchServiceLive),
  Layer.provideMerge(TradingEventInboxLive),
);

/**
 * The trading services. The turn coordinator and the wakeup composer depend on
 * the mission, strategy, watch, and inbox services, so each is built with those
 * provided rather than merged flat — this keeps `TradingLayerLive` free of
 * unsatisfied requirements for those internal deps. The coordinator also
 * requires `OrchestrationEngineService` (to dispatch the resumed turn); that
 * service is owned by the orchestration layer and provided at the composition
 * site (server.ts / the engine harness), not re-declared here.
 */
const coordinatorWithDeps = TradingTurnCoordinatorLive.pipe(
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingStrategyServiceLive),
  Layer.provideMerge(TradingEventInboxLive),
  Layer.provideMerge(composerWithDeps),
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
