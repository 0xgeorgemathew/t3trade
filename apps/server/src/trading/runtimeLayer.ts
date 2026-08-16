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
import { TradingExecutionReceiptsLive } from "./TradingExecutionReceipts.ts";
import { TradingExecutionGuardLive } from "./TradingExecutionGuard.ts";
import { InterimSignerConfigLive } from "./InterimSignerConfig.ts";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import { AutoMissionConfigLive } from "./AutoMissionConfig.ts";
import { TradingMarketChartLive } from "./TradingMarketChart.ts";
import { TradingMarketPriceLive } from "./TradingMarketPrice.ts";
import { TradingMissionProjectionLive } from "./TradingMissionProjection.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingAutoMissionLive } from "./TradingAutoMission.ts";
import { TradingMissionSweepLive } from "./TradingMissionSweep.ts";
import { TradingPreviewServiceLive } from "./TradingPreviewService.ts";
import { TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";
import { TradingWakeupComposerLive } from "./TradingWakeupComposer.ts";
import { TradingWatchServiceLive } from "./TradingWatchService.ts";
import { TradingBudgetReaderLive } from "./TradingBudgetReader.ts";
import { TradingFillReconcilerLive } from "./TradingFillReconciler.ts";
import { TradingProtectionServiceLive } from "./TradingProtectionService.ts";
import { TradingPlanProtectionServiceLive } from "./TradingPlanProtectionService.ts";
import { TradingWorkingOrderServiceLive } from "./TradingWorkingOrderService.ts";
import { TradingEmergencyCloseServiceLive } from "./TradingEmergencyCloseService.ts";
import { TradingControlServiceLive } from "./TradingControlService.ts";
import { TradingCostEstimatorLive } from "./TradingCostEstimator.ts";
import { TradingTradeHistoryServiceLive } from "./TradingTradeHistoryService.ts";
import { TradingCalibrationServiceLive } from "./TradingCalibrationService.ts";
import { TradingStopAdjustmentServiceLive } from "./TradingStopAdjustmentService.ts";
import { TradingExitServiceLive } from "./TradingExitService.ts";
import { TradingEntryServiceLive } from "./TradingEntryService.ts";

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
  // One shared set of execution latches: the reactor opens them, the tool
  // waiting on `trading_enter` blocks on them. Built here so both sides see
  // the same instance rather than two maps that never meet.
  TradingExecutionReceiptsLive,
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

// Plan 29 step 2.4: the working-order loop re-places resting patient entries
// through the constrained preview-free path on the execution service, so it
// builds on the same core the protection service does. Plain `provide` (not
// provideMerge): it sits inside the merge below, and re-exporting the core's
// services there would make the build order ambiguous.
const TradingWorkingOrderLayerLive = TradingWorkingOrderServiceLive.pipe(
  Layer.provide(TradingExecutionCore),
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
  // The mission reactor's working-order guard pass; also the direct
  // withdrawal the terminal transitions call.
  TradingWorkingOrderLayerLive,
).pipe(Layer.provideMerge(TradingProtectionLayerLive));

export const TradingLayerLive = Layer.mergeAll(
  TradingMissionServiceLive,
  // Housekeeping, once at boot: settled missions and missions whose thread is
  // gone are deleted rather than accumulated. See `TradingMissionSweep`.
  TradingMissionSweepLive.pipe(Layer.provide(TradingMissionServiceLive)),
  TradingStrategyServiceLive,
  TradingWatchServiceLive,
  TradingEventInboxLive,
  // `trading_look` reads the book, the mark, and the fee rate — all
  // through the gateway the read layer already builds.
  costEstimatorWithGateway,
  // `trading_look` is a pure read-join over the mission's own
  // fills and strategy versions.
  TradingTradeHistoryServiceLive,
  // `trading_get_target_calibration` scores those targets against the closed
  // trades the reconciler recorded.
  TradingCalibrationServiceLive,
  // `trading_adjust_stop` measures the position, the resting stop and the
  // server's own ATR before it allows a move, so it needs the read gateway and
  // both mission services at build.
  TradingStopAdjustmentServiceLive.pipe(
    Layer.provide(HyperliquidReadLayerLive),
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(TradingStrategyServiceLive),
  ),
  // `trading_enter` prices and sizes an entry against the mission, the
  // lease, the live book and the budget, so it needs the mission service and
  // the slippage config at build; everything else it reads per call.
  TradingEntryServiceLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(IocSlippageConfigLive),
    Layer.provide(TradingBudgetReaderLive),
    Layer.provide(costEstimatorWithGateway),
    Layer.provide(HyperliquidReadLayerLive),
  ),
  // The three exit tools size themselves from the canonical position, so they
  // need the mission service, the book, and the slippage allowance the crossing
  // reduce-only IOC is priced with.
  TradingExitServiceLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(IocSlippageConfigLive),
    Layer.provide(HyperliquidReadLayerLive),
  ),
  // Plan 29 step 4.5: an accepted publish reconciles the exchange's stop and
  // resting target to the plan immediately. Built on the protection layer (it
  // routes its legs through the same reconciles the watchdog uses) and the
  // read gateway for the canonical position.
  TradingPlanProtectionServiceLive.pipe(
    Layer.provide(HyperliquidReadLayerLive),
    Layer.provide(TradingProtectionLayerLive),
  ),
  coordinatorWithDeps,
  // A thread's first message is what creates its mission, so the decision sits
  // on the dispatch path in `ws.ts` rather than in the reactor.
  TradingAutoMissionLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(AutoMissionConfigLive.pipe(Layer.provide(InterimSignerConfigLive))),
  ),
  TradingExecutionLayerLive,
  HyperliquidWsLayerLive,
).pipe(Layer.provideMerge(infoWithHttp));
