/**
 * Harness-facing trading tools - spec §14.3.
 *
 * These ride the existing upstream MCP boundary: the first-party MCP server in
 * `apps/server`, reached with the per-session bearer credential every provider
 * adapter already injects as `t3-trade`. There is no second transport and no
 * per-harness MCP configuration.
 *
 * Every schema here is imported from `@t3tools/trading-contracts/tools`; none
 * is redeclared.
 *
 * @module TradingToolkitTools
 */
import {
  TradingCancelWatchInput,
  TradingCancelWatchResult,
  TradingEstimateCostsInput,
  TradingGetMissionInput,
  TradingGetMissionResult,
  TradingGetAccountStateInput,
  TradingGetMarketHistoryInput,
  TradingGetMarketSnapshotInput,
  TradingGetMarketStructureInput,
  TradingGetOpenOrdersInput,
  TradingGetOrderBookInput,
  TradingGetPlaybookInput,
  TradingGetPositionInput,
  TradingGetTargetCalibrationInput,
  TradingGetTradeHistoryInput,
  TradingListWatchesInput,
  TradingListWatchesResult,
  TradingMeasureVolatilityInput,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
  TradingRegisterWatchInput,
  TradingRegisterWatchResult,
  TradingResolveMarketInput,
  TradingRequestEntryInput,
  TradingRequestEntryResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
import { Playbook } from "@t3tools/trading-contracts/playbook";
import {
  AgentAccountSnapshot,
  AgentNetPosition,
  AgentOpenOrder,
} from "@t3tools/trading-contracts/account-snapshot";
import {
  AgentMarketSnapshot,
  MarketHistory,
  OrderBook,
  ResolvedMarket,
} from "@t3tools/trading-contracts/market";
import { TradingCostEstimate } from "@t3tools/trading-contracts/costs";
import { MarketStructure } from "@t3tools/trading-contracts/momentum";
import { TradingTradeHistory } from "@t3tools/trading-contracts/history";
import { TargetCalibration } from "@t3tools/trading-contracts/calibration";
import { ObservedVolatility } from "@t3tools/trading-contracts/volatility";
import { Schema } from "effect";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TradingCostEstimator } from "../../../trading/TradingCostEstimator.ts";
import { TradingCalibrationService } from "../../../trading/TradingCalibrationService.ts";
import { TradingTradeHistoryService } from "../../../trading/TradingTradeHistoryService.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { TradingWatchService } from "../../../trading/TradingWatchService.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  TradingMissionService,
  TradingStrategyService,
  // Watch tools (register/cancel/list) write through the watch service.
  TradingWatchService,
  // An accepted publish or watch change is announced on the orchestration event
  // stream so the workspace sees it over the ordered WS push path.
  OrchestrationEngineService,
  Crypto.Crypto,
  // Phase 2 read tools reach Hyperliquid through the gateway.
  HyperliquidGateway,
  // `trading_estimate_costs` prices a round trip from the live fee rate and book.
  TradingCostEstimator,
  // `trading_get_trade_history` reads the mission's own completed orders.
  TradingTradeHistoryService,
  // `trading_get_target_calibration` grades the targets against those trades.
  TradingCalibrationService,
  // `trading_request_entry` reports what the reactor actually did with the
  // request, not that the request was raised.
  TradingExecutionOutcome,
];

export const TradingGetMissionTool = Tool.make("trading_get_mission", {
  description:
    "Read the mission this session is bound to: status, mandate (authority + risk policy), strategy + version, watches, control flags, pending executions. " +
    "`authority.allocatedCapitalUsd` and derived maximums are ceilings (don't move with account value); what's free is `accountSnapshot.withdrawable` (trading_get_account_state). `pendingExecutions[]` is the lock behind `no_conflicting_execution_pending` (while any entry is listed trading_execute refuses). It embeds `watches` — no need to call trading_list_watches in the same turn. " +
    "`strategyHistory[]` is every published version (newest first, with target + basis); `strategy` is the current thesis only. `bound: false` (with `lastMission`, `activeMissionId`) when the held mission has ended. `missionId` optional.",
  parameters: TradingGetMissionInput,
  success: TradingGetMissionResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get trading mission")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingPublishPlanTool = Tool.make("trading_publish_plan", {
  description:
    "Publish the trading plan this mission runs against. " +
    "`expectedVersion` from trading_get_mission (0 before any publish); stale rejected, accepted increments it. Publishing supersedes the PRIOR version's watches but NOT its resting orders — cancel those with trading_execute actionType `cancel`. " +
    "`timeframes[0]` is the primary timeframe (name >=1). `protection.targetProfitUsd` + `protection.targetProfitBasis` REQUIRED, basis CHECKED: `(measuredMoveUsd / referencePrice) x positionNotionalUsd` within 5% of `targetProfitUsd`. Target must clear round-trip cost (trading_estimate_costs). A target-wake (runtime arms `pnl_above` at `targetProfitUsd`) is a DECISION POINT, not a close order. " +
    "`mode`=free-text label. `missionId` optional. `insufficientVolatility: true` when no viable target exists after costs. " +
    "WAITING: give each trigger a `conditions[].priceLevel` AND arm it — prose wakes nothing (wakeups flag `unarmedEntryConditions`).",
  parameters: TradingPublishPlanInput,
  success: TradingPublishPlanResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Publish trading plan")
  .annotate(Tool.Readonly, false)
  // Publishing supersedes the prior version's watches, so it is not a
  // repeatable no-op — but it never touches exchange state.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

// -- §14.2 read-only market-data tools (Phase 2) -----------------------------

export const TradingResolveMarketTool = Tool.make("trading_resolve_market", {
  description:
    "Resolve canonical exchange identifiers for a market: asset index, szDecimals, max leverage, availability. Asset index is resolved from live metadata at runtime — never assume a fixed index.",
  parameters: TradingResolveMarketInput,
  success: ResolvedMarket,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Resolve market")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetMarketSnapshotTool = Tool.make("trading_get_market_snapshot", {
  description:
    "Read the current market snapshot: mark, mid, oracle, 8h funding rate, open interest, 24h volume, best bid/offer, 24h percent change. Each value carries a freshness stamp; stale BBO (2s) or asset context (5s) blocks execution submission rather than silently degrading.",
  parameters: TradingGetMarketSnapshotInput,
  success: AgentMarketSnapshot,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get market snapshot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetMarketHistoryTool = Tool.make("trading_get_market_history", {
  description:
    "Read bounded candle history for a market and interval (1m, 3m, 5m, 15m, or 1h — no local synthesis). One response is capped at 500 bars (~8h20m on 1m, ~5 days on 1h); `maxBars` only lowers that ceiling. Page further back with `startTime`/`endTime` (Unix millis). Response marks the most-recent finalised close.",
  parameters: TradingGetMarketHistoryInput,
  success: MarketHistory,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get market history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingMeasureVolatilityTool = Tool.make("trading_measure_volatility", {
  description:
    "Measure fluctuation over a bounded candle window — the basis every profit target is derived from. Returns (real candles, no model): `atrUsd`/`atrPercent` (mean true range, last 14 bars), `realizedVolatilityPercentPerBar` (stdev of bar-to-bar log returns), `swingRangeUsd`/`swingRangePercent` (window high-to-low), `horizons[]`. " +
    "`horizons[]` sets a target: per holding period reports p25/p50/p75 of the move from a bar's close (`favourableUpUsd` long / `favourableDownUsd` short). Range fields: `swingHighUsd`/`swingLowUsd`, `positionInRangePercent` (0 floor/100 ceiling), `excursionSymmetryRatio` (~1 ranging, far from 1 trending). `sufficientData` false under 30 bars. Defaults 120 bars; horizons 3,5,10,20,30,60; `holdBars` overrides. " +
    "Wakeups already carry `observedVolatility` (primary) + `higherTimeframeVolatility`. Magnitude only — direction: trading_get_market_structure. All GROSS; round-trip cost: trading_estimate_costs (hold the target against `minimumViableTargetUsd`).",
  parameters: TradingMeasureVolatilityInput,
  success: ObservedVolatility,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Measure volatility")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingEstimateCostsTool = Tool.make("trading_estimate_costs", {
  description:
    "Cost a round trip at a given size from the live fee rate and book. Name the position by `sizeEth` or `notionalUsd` (at the mark). " +
    "Three non-overlapping parts: `roundTripFeeUsd` (two taker fills at `takerFeeBpsPerSide`), `roundTripSpreadUsd` (crossing bid/ask twice, from `halfSpreadUsd`), `roundTripSlippageUsd` (walking the book past the touch). `roundTripUsd`=total; `breakEvenPriceMoveUsd`=move/unit to exit flat. " +
    "`minimumViableTargetUsd`=2× round trip — the floor for any target. `protection.targetProfitUsd` is GROSS (`pnl_above` fires on exchange unrealised PnL, nets neither fees nor funding). `degraded` true when part unread (`notes` says which; total a LOWER BOUND). `fundingCostPer8hUsd`=per-funding holding cost (positive=long pays), outside round trip.",
  parameters: TradingEstimateCostsInput,
  success: TradingCostEstimate,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Estimate trading costs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetMarketStructureTool = Tool.make("trading_get_market_structure", {
  description:
    "Directional structure across four timeframes (1m, 5m, 15m, 1h default), deterministic arithmetic over real candles. Per timeframe: `directionScore` (net/total travel, [-1,1]; 1 straight up, 0 round trip); `direction` thresholds that at 0.15. `atrExpansionRatio` (last 14 bars' ATR / prior 14; >1 expanding). `lastImpulse` (last completed leg pivot-to-pivot: `sizeUsd`, `ageBars`); `pullbackDepthUsd`/`pullbackPercentOfImpulse`. `distanceToSwingHighUsd`/`distanceToSwingLowUsd` signed from last close (positive=level ahead). `alignment` (composite: majority direction, agreement count; `mixed`=contradiction/chop). `sufficientData` false under 30 bars.",
  parameters: TradingGetMarketStructureInput,
  success: MarketStructure,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get market structure")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetTradeHistoryTool = Tool.make("trading_get_trade_history", {
  description:
    "Read this mission's OWN completed trades, newest first: size, size-weighted average price, fee, realised PnL, and the strategy version + `targetProfitUsd` current when each filled. " +
    "Fills aggregate into ORDERS (one market order = many partials; `fillCount`, `firstFillAt`/`lastFillAt`). `netPnlUsd`=`closedPnlUsd`−`feeUsd`; an open/add order reports `closedPnlUsd` 0. `summary` spans EVERY order, not just the page `limit`. " +
    "`roundTrips[]` pairs trades flat-to-flat (direction, size-weighted entry/exit, hold, gross, fees, net). `summary.recentFeeShareOfGrossPercent` (last 3 trips) and `feeShareOfGrossPercent` (life) flag costs eating the result.",
  parameters: TradingGetTradeHistoryInput,
  success: TradingTradeHistory,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get trade history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingGetTargetCalibrationTool = Tool.make("trading_get_target_calibration", {
  description:
    "Score published profit targets against what trades actually reached. A target is REACHED when unrealised PnL ever touched it, not when banked — `peakUnrealisedPnlUsd` is what makes that distinction. " +
    "Each entry is one strategy version: `targetProfitUsd`, `claimedHitRatePercent` (its basis), `observedHitRatePercent` (its trades), `meanPeakUsd`/`meanTroughUsd`. `verdict`=`optimistic`/`conservative`/`as_claimed`/`insufficient_sample` (under 5 trades: count published, rate withheld). `recommendation` is the line to act on.",
  parameters: TradingGetTargetCalibrationInput,
  success: TargetCalibration,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get target calibration")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingGetOrderBookTool = Tool.make("trading_get_order_book", {
  description:
    "Read the current order book (up to 20 levels per side) with the derived best bid/offer and a 2-second freshness stamp.",
  parameters: TradingGetOrderBookInput,
  success: OrderBook,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get order book")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetAccountStateTool = Tool.make("trading_get_account_state", {
  description:
    "Read the canonical account state for this mission's trading account: account value, margin used, withdrawable, open positions. Queried with the master-wallet address (execution-wallet is never identity). `withdrawable` is what's free now; ceilings live in the mission's `authority`. Read this for SIZING; trading_get_position for what you hold.",
  parameters: TradingGetAccountStateInput,
  success: AgentAccountSnapshot,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get account state")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetPositionTool = Tool.make("trading_get_position", {
  description:
    "Read the canonical net position for a market: signed size (positive long, negative short), entry price, unrealised PnL, cumulative funding, margin used. Flat returns size 0, no entry price (valid, not an error). " +
    "`peakUnrealisedPnl`/`drawdownFromPeakUsd` are T3's own: the highest this position has been worth, and how much given back. Absent while flat or never in profit.",
  parameters: TradingGetPositionInput,
  success: AgentNetPosition,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get position")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetOpenOrdersTool = Tool.make("trading_get_open_orders", {
  description:
    "List currently open orders for this mission's trading account: exchange order id, optional client order id, side (buy/sell), limit price, size, status.",
  parameters: TradingGetOpenOrdersInput,
  success: Schema.Array(AgentOpenOrder),
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get open orders")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

// -- §14.4 watch tools (Phase 3) ---------------------------------------------

export const TradingRegisterWatchTool = Tool.make("trading_register_watch", {
  description:
    "Register a typed market watch bound to the mission's current strategy version. Active on creation, fires EXACTLY ONCE when its predicate matches, then terminal; re-register to keep a level standing. " +
    "To MOVE a level pass `replacesWatchId`: cancel and arm in one transaction. Result `replaced`=cancelled watch; if absent the named watch had fired/been superseded — what was armed is an ADDITION, not a swap. " +
    "Required fields per type (missing→rejected): `price_cross`(market,priceSource,direction,price); `candle_close`(market,INTERVAL 1m/3m/5m/15m/1h,direction,price); `order_update`(cloid); `position_update`(market); `pnl_above`(market,valueUsd); `pnl_below`(market,valueUsd SIGNED); `pnl_giveback`(market,drawdownUsd); `scheduled_reassessment`(runAt). " +
    "`position_update`/`order_update` fire on a reconciled size change. `pnl_above`/`pnl_below` fire on reconciled unrealised PnL (≥/≤`valueUsd`); flat fires neither. `pnl_giveback` fires when PnL falls `drawdownUsd` from its high-water mark. Runtime auto-arms a target `pnl_above` and a staleness `scheduled_reassessment` while holding. `missionId` optional. " +
    "PREFER CONDITIONS: arm the price/PnL level that would change your decision; use `scheduled_reassessment` only for known-time events.",
  parameters: TradingRegisterWatchInput,
  success: TradingRegisterWatchResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Register watch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TradingListWatchesTool = Tool.make("trading_list_watches", {
  description:
    "List every watch registered for this mission, newest first, including status (active, triggered, superseded, cancelled).",
  parameters: TradingListWatchesInput,
  success: TradingListWatchesResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "List watches")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingCancelWatchTool = Tool.make("trading_cancel_watch", {
  description:
    "Cancel an active watch by id. Only an active watch can be cancelled; one that already fired, was superseded by a strategy publish, or does not exist is rejected.",
  parameters: TradingCancelWatchInput,
  success: TradingCancelWatchResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Cancel watch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TradingExecuteTool = Tool.make("trading_execute", {
  description:
    "Submit one execution intent for the bound mission; `intent.actionType` selects the step. " +
    "`open`/`scale_in` start/add — REFUSED without a valid `intent.stop` (stopPrice on the losing side, plus plannedLossAtStopUsd). `reduce` removes part (reduce-only); `close` flattens regardless of size. `cancel` withdraws a resting order by `intent.targetCloid` (a publish supersedes watches but NOT exchange orders). `modify_stop` moves protection to `intent.stop.stopPrice` (replacement confirmed before old stop cancelled; wrong-side-of-mid REFUSED, escalates to §17.5 emergency close). The last four need no stop. " +
    "For `marketable_ioc` the SERVER prices the crossing limit (BBO + 50 bps) — `intent.limitPrice` is preview only (still required, >0, must cross); result reports placed `limitPrice` + `avgFillPrice`. " +
    "Rejection codes: `mission_active`, `strategy_version_current`, `market_is_eth`, `no_conflicting_execution_pending`. Outcomes: `filled`/`cancelled`/`rejected`/`failed` terminal; `accepted` rests on book (`orderResults`); `succeeded`=`cancel`/`modify_stop`; `submitted`=unknown. `reduce`/`close` report `remainingSize`.",
  parameters: TradingRequestEntryInput,
  success: TradingRequestEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Execute trading intent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetPlaybookTool = Tool.make("trading_get_playbook", {
  description:
    "Read one named playbook: classify (regime read), momentum, range_reversion, opening_range, standing_rules. Each returns whenItApplies (trigger), procedure[] (ordered steps), gates[] (must clear before entry), standDownIf[] (retire a setup). Static data, same for every mission; nothing in the runtime branches on it. `missionId` optional.",
  parameters: TradingGetPlaybookInput,
  success: Playbook,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get playbook")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingToolkit = Toolkit.make(
  TradingGetMissionTool,
  TradingPublishPlanTool,
  TradingResolveMarketTool,
  TradingGetMarketSnapshotTool,
  TradingGetMarketHistoryTool,
  TradingMeasureVolatilityTool,
  TradingEstimateCostsTool,
  TradingGetMarketStructureTool,
  TradingGetTradeHistoryTool,
  TradingGetTargetCalibrationTool,
  TradingGetOrderBookTool,
  TradingGetAccountStateTool,
  TradingGetPositionTool,
  TradingGetOpenOrdersTool,
  TradingGetPlaybookTool,
  TradingRegisterWatchTool,
  TradingListWatchesTool,
  TradingCancelWatchTool,
  TradingExecuteTool,
);
