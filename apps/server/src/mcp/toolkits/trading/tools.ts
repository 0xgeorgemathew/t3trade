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
  TradingAdjustStopInput,
  TradingAdjustStopResult,
  TradingExecuteInput,
  TradingRequestEntryResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
import { TradingQuoteEntryInput, TradingQuoteEntryResult } from "@t3tools/trading-contracts/quote";
import {
  TradingCancelOrderInput,
  TradingClosePositionInput,
  TradingReducePositionInput,
} from "@t3tools/trading-contracts/exit";
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TradingCostEstimator } from "../../../trading/TradingCostEstimator.ts";
import { TradingCalibrationService } from "../../../trading/TradingCalibrationService.ts";
import { TradingTradeHistoryService } from "../../../trading/TradingTradeHistoryService.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingExitService } from "../../../trading/TradingExitService.ts";
import { TradingPlanProtectionService } from "../../../trading/TradingPlanProtectionService.ts";
import { TradingWorkingOrderService } from "../../../trading/TradingWorkingOrderService.ts";
import { TradingQuoteService } from "../../../trading/TradingQuoteService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { TradingStopAdjustmentService } from "../../../trading/TradingStopAdjustmentService.ts";
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
  // `trading_adjust_stop` measures the mission before it moves the stop.
  TradingStopAdjustmentService,
  // `trading_quote_entry` prices and sizes an entry; `trading_execute` turns a
  // quote back into the intent the server built for it.
  TradingQuoteService,
  // The three exit tools size themselves from the canonical position.
  TradingExitService,
  // An accepted publish reconciles the exchange's stop and target to the plan
  // (plan 29 step 4.5) and retracts the mission's resting working entries.
  TradingPlanProtectionService,
  TradingWorkingOrderService,
  SqlClient.SqlClient,
];

export const TradingGetMissionTool = Tool.make("trading_get_mission", {
  description:
    "Read the mission this session is bound to: mandate (authority + risk policy), strategy, watches, pending executions. `authority` maximums are ceilings, not balances; `withdrawable` is what is free. `bound: false` with `lastMission` when the held mission has ended.",
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
    'Publish the eight-field plan: market, intent, entry, stop, target, invalidation, reassess, because. Declining to trade is intent "stand_aside". Derive the target off measured volatility over the intended hold. `expectedMissionVersion` (from trading_get_mission); a stale publish is rejected. Revising replaces the plan in place — watches survive, so cancel or replace any trigger you no longer want.',
  parameters: TradingPublishPlanInput,
  success: TradingPublishPlanResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Publish trading plan")
  .annotate(Tool.Readonly, false)
  // Publishing revises the mission's state (and the plan the exchange is
  // reconciled to), so it is not a repeatable no-op.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

// -- §14.2 read-only market-data tools (Phase 2) -----------------------------

export const TradingResolveMarketTool = Tool.make("trading_resolve_market", {
  description:
    "Resolve canonical exchange identifiers for a market: asset index, szDecimals, max leverage, availability. The asset index comes from live metadata — never assume a fixed one.",
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
    "Read the current market snapshot: mark, mid, oracle, 8h funding, open interest, 24h volume, best bid/offer — each with a freshness stamp; stale BBO (2s) or asset context (5s) blocks execution rather than degrading.",
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
    "Read bounded candle history for a market and interval (1m/3m/5m/15m/1h — no local synthesis). Capped at 500 bars per response; page with the time bounds. The last finalised close is marked.",
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
    "Measure fluctuation over a bounded candle window from real candles, no model: ATR, per-bar realised volatility, swing range, and `horizons[]` p25/p50/p75 favourable moves per holding period. Figures are gross of costs; `sufficientData` is false under 30 bars.",
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
    "Cost a round trip at a given size from the live fee rate and book. Returns `roundTripFeeUsd` (two taker fills), `roundTripSpreadUsd`, `roundTripSlippageUsd`, and their total `roundTripUsd` — context for whether the expected move pays, never a gate. `degraded` true means part of the book was unread: the total is a lower bound.",
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
    "Directional structure across 1m/5m/15m/1h: per-timeframe `directionScore` (-1..1), `pivotTrend`, `atrExpansionRatio`, `lastImpulse`, `breakout` (a `wickOnly` break does not count), plus `alignment`, a `regime` label with evidence and conflicts, and `candidates[]` — each scored setup joined with the live cost of taking it; absent cost fields mean unknown, not free.",
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
    "Read this mission's completed trades, newest first: size, average price, fee, `netPnlUsd`, and the `targetProfitUsd` in force when each filled. Fills aggregate into orders; `roundTrips[]` pairs them flat-to-flat; `summary` spans every order, not just the page.",
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
    "Score published profit targets against what trades actually reached: a target is reached when unrealised PnL ever touched it, not when it was banked. One entry per plan revision: `claimedHitRatePercent`, `observedHitRatePercent`, `verdict`, `recommendation`.",
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
    "Read the canonical account state: account value, margin used, withdrawable, open positions. `withdrawable` is what is free now; ceilings live in the mission `authority`.",
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
    "Read the canonical net position for a market: signed size (positive long, negative short), entry price, unrealised PnL, cumulative funding, margin used. Flat returns size 0 and no entry price — valid, not an error. `drawdownFromPeakUsd` tracks the high-water mark; absent while flat.",
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
    "Register a typed market watch. Active on creation, fires exactly once when its predicate matches, then terminal — re-register to keep a level standing. `replacesWatchId` moves a level: cancel and arm in one transaction; if that watch already fired, what was armed is an ADDITION, not a swap.",
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
    "List every watch registered for this mission, newest first, including status (active, triggered, consumed, cancelled, expired).",
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
    "Cancel an active watch by id; only an active watch can be cancelled — one that already fired or was cancelled is terminal.",
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

export const TradingQuoteEntryTool = Tool.make("trading_quote_entry", {
  description:
    "Price and size one entry: the server derives the limit and the largest size every risk ceiling allows — that is the approved trade. `urgency` defaults to `now` (cross immediately); `patient` rests at the near side as a maker order. Too large gets a smaller quote plus `constrainedBy`. Quotes expire in 90s; executing one twice returns the same execution. Refuses stops inside the noise floor.",
  parameters: TradingQuoteEntryInput,
  success: TradingQuoteEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Quote an entry")
  // A quote writes a row, but reserves nothing and touches no exchange state.
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TradingExecuteTool = Tool.make("trading_execute", {
  description:
    "Submit an entry with `{ quoteId }` from trading_quote_entry — the server derived and pre-checked every other field; full intents are refused. `accepted` rests on the book, `submitted` means outcome unknown, `reduce`/`close` report `remainingSize`; every other outcome is terminal.",
  parameters: TradingExecuteInput,
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
    "Read one named playbook. Each returns whenItApplies (trigger), procedure[] (ordered steps), gates[] (must clear before entry), standDownIf[] (retire a setup). Static data; nothing in the runtime branches on it.",
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

export const TradingAdjustStopTool = Tool.make("trading_adjust_stop", {
  description:
    "Move the stop on an open position, inside policy: never past the entry's approved stop, in bounded steps, outside the noise floor, never back below entry once past it, and rate-limited. A refusal leaves the resting stop untouched.",
  parameters: TradingAdjustStopInput,
  success: TradingAdjustStopResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Adjust stop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingClosePositionTool = Tool.make("trading_close_position", {
  description:
    "Flatten the mission's whole position now; takes no size or side. The server derives side and size from the canonical position and sends a reduce-only order that crosses immediately, or rests at the near side when `urgency` is `patient`. Works in states an entry does not (entries switched off, loss budget exhausted, mission blocked). Reports `remainingSize` from the reconciled position.",
  parameters: TradingClosePositionInput,
  success: TradingRequestEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Close position")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TradingReducePositionTool = Tool.make("trading_reduce_position", {
  description:
    'Take part of the position off by size or fraction. The server derives the closing side, clamps to what is held, and sends a reduce-only order that crosses (`urgency: "patient"` rests it at the near side) — it cannot reverse or increase exposure. If what would remain is under the exchange minimum, the whole position closes instead.',
  parameters: TradingReducePositionInput,
  success: TradingRequestEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Reduce position")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TradingCancelOrderTool = Tool.make("trading_cancel_order", {
  description:
    "Withdraw one resting order by its `cloid`. A plan revision withdraws its own resting working entries, but any other resting order stays until this is called. Touches no position.",
  parameters: TradingCancelOrderInput,
  success: TradingRequestEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Cancel resting order")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

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
  TradingQuoteEntryTool,
  TradingExecuteTool,
  TradingClosePositionTool,
  TradingReducePositionTool,
  TradingCancelOrderTool,
  TradingAdjustStopTool,
);
