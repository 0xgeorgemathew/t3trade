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
  SqlClient.SqlClient,
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
    "Publish the plan this mission runs against. " +
    "`expectedVersion` from trading_get_mission (0 before any publish); stale rejected, accepted increments it. Accepted supersedes the PRIOR version's watches but NOT its resting orders (cancel via trading_execute `cancel`). " +
    "`timeframes[0]` is the primary timeframe (name >=1). `protection.targetProfitUsd` + `protection.targetProfitBasis` REQUIRED, basis CHECKED: `(measuredMoveUsd / referencePrice) x positionNotionalUsd` within 5% of `targetProfitUsd`. Target must clear round-trip cost (trading_estimate_costs). The target-wake is a DECISION POINT, not a close order. " +
    "`mode`=free-text label. `missionId` optional. A DECLINED ENTRY STILL PUBLISHES with `standDownCode` naming the actual reason; set `insufficientVolatility: true` only for that reason. `targetProfitUsd`=the minimum viable target the costs demanded. " +
    "WAITING: give each trigger a `conditions[].priceLevel` AND arm it — prose wakes nothing (wakeups flag `unarmedEntryConditions`). " +
    "`plainSummary` REQUIRED: 2-4 sentences a non-trader can follow (market, plan + direction, trigger, risk vs reward) — no tool/field names, no scores; it is the user's headline. `alternativesConsidered[]`: `{strategy, direction, verdict, reason}` per declined tournament candidate.",
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
    '`minimumViableTargetUsd`=2× round trip — the floor for any target. `protection.targetProfitUsd` is GROSS (`pnl_above` fires on exchange unrealised PnL, nets neither fees nor funding). `degraded` true when part unread (`notes` says which; total a LOWER BOUND). `fundingCostPer8hUsd`=per-funding holding cost (positive=long pays), outside round trip. Quote rates with units and the dollars they make ("4.5 bps/side = $0.90"); a bare rate reads as dollars.',
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
    "Directional structure across 1m/5m/15m/1h. Per timeframe: `directionScore` ([-1,1] net/total travel), `recentDirectionScore` (last 30 bars; turns first in a grind), `pivotTrend` (trailing pivot runs; 2+ one way is trend structure), `atrExpansionRatio` (>1 expanding), `lastImpulse`/`impulseIsFresh`; `sufficientData` false under 30 bars. `alignment` says whether the timeframes agree. " +
    "Also: `positionInRangePercent`, `rangeStabilityPercent` (under 30 stable), `swingHighDriftUsd`/`swingLowDriftUsd` (bounds sliding one way = a grind, not a range), `excursionSymmetryRatio` (~1 paid both sides), touch counts, `breakout` (`closedBeyond` is a break; `wickOnly` is not). " +
    "`regime` applies the classify playbook: trending/ranging/transition, `evidence[]`, `conflicts[]` (non-empty = a transition beginning); overrule only against the named evidence. " +
    "`setups[]`: scored candidates, best first — `level` to arm, `closeConfirmed` (TRUE=`candle_close`, FALSE=`price_cross`), kinds incl. `trend_continuation` (close-confirmed at the pullback extreme). `candidates[]` joins each setup with its playbook's cost gate at the live book (`costMultiple` vs `requiredCostMultiple`, `clearsCostGate`, `distanceToTriggerUsd`); absent cost fields mean unknown, not free. Evidence, never permission.",
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

export const TradingQuoteEntryTool = Tool.make("trading_quote_entry", {
  description:
    "Price and size one entry, then execute it with `trading_execute { quoteId }` — the ONLY thing you need to build an entry. " +
    "You give `market`, `side` (buy=long, sell=short), `stopPrice` (on the LOSING side), and optionally `sizeEth` or `notionalUsd`. The SERVER derives strategyVersion, authorityVersion, the lease-owning run, executionSequence, a crossing `limitPrice` off the live BBO, `szDecimals` precision, `plannedLossAtStopUsd`, and the largest size inside every ceiling — then runs the SAME §16.3 preview `trading_execute` will run. " +
    "Omit the size and you get the maximum feasible one — an upper bound to size DOWN from, not the size to trade. Too much gets a SMALLER quote plus `constrainedBy` (`gross_notional`, `leverage`, `planned_loss_ceiling`, `loss_budget`) — take it or re-quote. " +
    "`outcome: refused` carries the preview item that refused it and `feasibleSize`. Quotes expire in 90s and are single-purpose: executing one twice returns the SAME execution (same sequence, same cloid). Nothing is reserved or signed by quoting. " +
    "`stopPrice` must clear the noise floor — max(2x half-spread, 0.35x ATR), trading_adjust_stop's rule — or the quote refuses (`stop_inside_noise_floor`). Anchor the stop beyond the level that invalidates the thesis.",
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
    "Submit an entry with `{ quoteId }` from trading_quote_entry and nothing else — the server already derived and pre-checked every other field. Full intents remain decodable for old clients but are refused: use trading_close_position, trading_reduce_position, trading_cancel_order, or trading_adjust_stop for the rest of the lifecycle. " +
    "For `marketable_ioc` the SERVER prices the crossing limit from the fresh BBO; the result reports the placed `limitPrice` + `avgFillPrice`. " +
    "Rejection codes: `mission_active`, `strategy_version_current`, `market_is_eth`, `no_conflicting_execution_pending`. Outcomes: `filled`/`cancelled`/`rejected`/`failed` terminal; `accepted` rests on book (`orderResults`); `succeeded`=`cancel`/`modify_stop`; `submitted`=unknown. `reduce`/`close` report `remainingSize`.",
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

export const TradingAdjustStopTool = Tool.make("trading_adjust_stop", {
  description:
    "Move the stop on an open position, inside the policy — prefer this over trading_execute `modify_stop`, which is unbounded. Same place-and-confirm-before-cancel path. " +
    "The server measures the position, the RESTING stop, mark, half-spread and its own ATR (primary timeframe), then checks: risk never past the entry's approved stop (`risk_envelope`); step <= min(0.5xATR, 25% of stop distance) (`step_too_large`); your `observedAtrUsd` within 30% of the server's (`atr_mismatch`); stop outside max(2xhalf-spread, 0.35xATR) (`noise_floor` — the same shared rule trading_quote_entry enforces at entry) and no further than halfway from entry to target (`target_encroachment`); a stop past entry never crosses back (`breakeven_ratchet`); 1 per 3 bars, 8 per position (`adjustment_budget`). Plus `wrong_side`, `no_position`, `no_resting_stop`, `stale_strategy_version`, `market_data_unavailable`, `replacement_failed`. " +
    "Refused leaves the resting stop untouched. Adjusted returns `previousStop`, `newStop`, `stopDistanceUsd`, `plannedLossAtStopUsd`, `remainingAdjustments`. The server allocates the execution sequence, authority version, and lease-owning run after the policy accepts.",
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
    "Flatten the mission's whole position, now. Takes NOTHING but an optional market — the server reads the canonical position, derives the closing side from it, sizes the order to all of it, prices a crossing IOC off the live BBO, and sends it reduce-only. " +
    "This works where an entry would not: entries switched off, the loss budget exhausted, the mission blocked for cumulative loss, a long-only authority, and a dust position under the exchange minimum. Getting out never fails for a reason belonging to getting in. " +
    "Returns the same result as trading_execute, with `remainingSize` read from the reconciled position: a close that did not flatten is reported, not assumed.",
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
    "Take part of the position off — the scale-out. Name EITHER `sizeEth` (base units) OR `fraction` (0-1; 0.5 is half); the server derives the closing side, clamps to what is actually held, truncates to exchange precision, and sends a crossing reduce-only IOC. It cannot reverse or increase exposure whatever you ask for. " +
    "Ask for a size that would leave behind less than the $10 exchange minimum and the WHOLE position is closed instead — dust cannot be exited later in a normal order — reported in `detail`. " +
    "Refused with `no_position` when nothing is held, `no_size_named` when neither field is given, and `direction_permitted` when the authority forbids partial reduction (a full close still clears).",
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
    "Withdraw one resting order by its `cloid`, which trading_get_open_orders lists. Publishing a plan supersedes watches but NOT exchange orders — an order you no longer want stays on the book until this is called. Touches no position and needs no size, price, or version.",
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
