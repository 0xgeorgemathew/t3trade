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
import { TradingAccountBootstrapLive } from "./TradingAccountBootstrap.ts";
import { HyperliquidReconcilerLive } from "./HyperliquidReconciler.ts";
import { TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingExecutionOutcomeLive } from "./TradingExecutionOutcome.ts";
import { TradingExecutionGuardLive } from "./TradingExecutionGuard.ts";
import { InterimSignerConfigLive } from "./InterimSignerConfig.ts";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import { AutoMissionConfigLive } from "./AutoMissionConfig.ts";
import { TradingMarketChartLive } from "./TradingMarketChart.ts";
import { TradingMarketPriceLive } from "./TradingMarketPrice.ts";
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
import { TradingControlServiceLive } from "./TradingControlService.ts";
import { TradingCostEstimatorLive } from "./TradingCostEstimator.ts";
import { TradingTradeHistoryServiceLive } from "./TradingTradeHistoryService.ts";
import { TradingCalibrationServiceLive } from "./TradingCalibrationService.ts";

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
  // The read surfaces quote a live mark even while the mission is flat, which
  // no local table carries — so this sits with the projection it feeds.
  TradingMarketPriceLive.pipe(Layer.provide(gatewayWithRead)),
  // The chart surface pairs the same live snapshot with candle history; it
  // shares the read gateway so the two never disagree on freshness.
  TradingMarketChartLive.pipe(Layer.provide(gatewayWithRead)),
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
);

const costEstimatorWithGateway = TradingCostEstimatorLive.pipe(
  Layer.provide(HyperliquidReadLayerLive),
);

const composerWithDeps = TradingWakeupComposerLive.pipe(
  Layer.provide(HyperliquidReadLayerLive),
  // The wakeup carries the round trip on the size actually held, so the
  // composer prices it through the same estimator the tool uses.
  Layer.provide(costEstimatorWithGateway),
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingWatchServiceLive),
  // The wakeup publishes the full armed-watch list, which `listWatches` owns.
  Layer.provideMerge(TradingStrategyServiceLive),
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
  // Both IOC crossing allowances, read per call so a testnet run can move them.
  IocSlippageConfigLive,
  // The shortcut reads the signer to decide whether this checkout is a trading
  // lab, so it is built on top of the signer rather than beside it.
  AutoMissionConfigLive.pipe(Layer.provide(InterimSignerConfigLive)),
  exchangeWithHttp,
  HyperliquidNonceCoordinatorLive(),
  HyperliquidWebSocketClientLive,
);

const TradingWithPreview = Layer.mergeAll(TradingPreviewServiceLive, TradingBudgetReaderLive).pipe(
  Layer.provideMerge(TradingFoundation),
);

const TradingExecutionCore = Layer.mergeAll(
  HyperliquidExecutionServiceLive,
  // The reconciler writes an inbox event when the exchange moved a position no
  // order of T3's explains, so it needs the inbox at build.
  HyperliquidReconcilerLive.pipe(Layer.provide(TradingEventInboxLive)),
).pipe(Layer.provideMerge(TradingWithPreview));

const TradingProtectionLayerLive = TradingProtectionServiceLive.pipe(
  Layer.provideMerge(TradingExecutionCore),
);

// The control service sits on top of protection: `cancel_entries` routes
// through `cancelEntriesWithProtection` (§17.3), so protection has to be built
// first rather than merged alongside.
const TradingExecutionLayerLive = Layer.mergeAll(
  TradingExecutionGuardLive,
  TradingFillReconcilerLive,
  TradingEmergencyCloseServiceLive,
  TradingControlServiceLive,
  // Provisions the account row a mission names. Merged here because it needs
  // the resolved interim signer, which the foundation below supplies.
  TradingAccountBootstrapLive,
  // Reports an execution's real outcome back to `trading_request_entry`; needs
  // the budget reader and the gateway the layers below supply, plus the inbox
  // the reactor records refusals in.
  TradingExecutionOutcomeLive.pipe(Layer.provide(TradingEventInboxLive)),
).pipe(Layer.provideMerge(TradingProtectionLayerLive));

export const TradingLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  TradingWatchServiceLive,
  TradingEventInboxLive,
  // `trading_estimate_costs` reads the book, the mark, and the fee rate — all
  // through the gateway the read layer already builds.
  costEstimatorWithGateway,
  // `trading_get_trade_history` is a pure read-join over the mission's own
  // fills and strategy versions.
  TradingTradeHistoryServiceLive,
  // `trading_get_target_calibration` scores those targets against the closed
  // trades the reconciler recorded.
  TradingCalibrationServiceLive,
  coordinatorWithDeps,
  TradingExecutionLayerLive,
  HyperliquidWsLayerLive,
).pipe(Layer.provideMerge(infoWithHttp));
