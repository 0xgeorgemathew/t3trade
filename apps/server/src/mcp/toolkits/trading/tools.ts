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
  TradingGetMissionInput,
  TradingGetMissionResult,
  TradingGetAccountStateInput,
  TradingGetMarketHistoryInput,
  TradingGetMarketSnapshotInput,
  TradingGetOpenOrdersInput,
  TradingGetOrderBookInput,
  TradingGetPositionInput,
  TradingListWatchesInput,
  TradingListWatchesResult,
  TradingPublishMomentumStrategyInput,
  TradingPublishMomentumStrategyResult,
  TradingRegisterWatchInput,
  TradingRegisterWatchResult,
  TradingResolveMarketInput,
  TradingRequestEntryInput,
  TradingRequestEntryResult,
  TradingScheduleReassessmentInput,
  TradingScheduleReassessmentResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
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
import { Schema } from "effect";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
  // `trading_request_entry` reports what the reactor actually did with the
  // request, not that the request was raised.
  TradingExecutionOutcome,
];

export const TradingGetMissionTool = Tool.make("trading_get_mission", {
  description:
    "Read the current state of the trading mission this agent session is bound to: status, mandate (authority and risk policy), the published momentum strategy and its version, registered watches, the user's control flags, and any executions still in flight. Call this at the start of every turn before deciding anything. " +
    "The mandate is the user's hard rails, not a balance: `authority.allocatedCapitalUsd` and the maximums derived from it are ceilings you may never exceed, and they do not move when the account value does. What is actually free to trade right now is `accountSnapshot.withdrawable` from trading_get_account_state. Sizing within the rails, against the live balance, is your judgement to exercise. " +
    "`pendingExecutions[]` is the lock behind the `no_conflicting_execution_pending` refusal: while any entry is listed there, trading_request_entry refuses every new intent. Each entry names the cloid, the action, its status, and how long it has sat there. " +
    "When the mission this thread held has ended, this returns `bound: false` instead of failing — with `lastMission` (its terminal status is the answer to what happened) and `activeMissionId` when a newer mission holds the slot. Market reads keep working on an unbound thread; nothing that writes does. " +
    "`missionId` is optional — omit it and the call acts on the mission this session is bound to.",
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

export const TradingPublishMomentumStrategyTool = Tool.make("trading_publish_momentum_strategy", {
  description:
    "Publish the momentum strategy this mission should now be executed against. Supply expectedVersion as the strategy version you read from trading_get_mission (0 before any publish). A stale expectedVersion is rejected with the server's current version and leaves the published strategy untouched; an accepted publish increments the version and supersedes the watches registered by the previous one — re-arm the watches you still want, and cancel any resting order from the old thesis with trading_request_entry actionType `cancel`, which a publish does not touch. " +
    "This is also how you switch strategies: republish at the next version with a different mode or direction when the thesis fails or the market goes stale. " +
    "Every entry in `strategy.entryPlan.conditions[]` REQUIRES a non-empty `description` — the prose conclusion is the field that matters; `timeframe`, `priceLevel`, and `invalidatedBy` are optional display hints. A conditions entry without a description is rejected. A condition may also be supplied as a bare prose string, which is read as `{ description: <the string> }`. " +
    "`missionId` is optional — omit it and the call acts on the mission this session is bound to.",
  parameters: TradingPublishMomentumStrategyInput,
  success: TradingPublishMomentumStrategyResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Publish momentum strategy")
  .annotate(Tool.Readonly, false)
  // Publishing supersedes the prior version's watches, so it is not a
  // repeatable no-op — but it never touches exchange state.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

// -- §14.2 read-only market-data tools (Phase 2) -----------------------------

export const TradingResolveMarketTool = Tool.make("trading_resolve_market", {
  description:
    "Resolve the canonical exchange identifiers for a market: asset index, size decimals (szDecimals), maximum leverage, and availability. The asset index is resolved from live metadata at runtime — never assume a fixed index. Call this before sizing or pricing any order.",
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
    "Read the current market snapshot: mark, mid, oracle, 8h funding rate, open interest, 24h volume, best bid/offer, and the 24h percent change. Every value carries a freshness stamp; stale BBO (2s) or asset context (5s) blocks execution submission rather than silently degrading.",
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
    "Read bounded candle history for a market and interval (1m, 3m, 5m, 15m, or 1h — no local synthesis). One response is capped at 500 bars — about 8h20m on 1m, five days on 1h — and `maxBars` only lowers that ceiling. Page further back with `startTime`/`endTime` (Unix millis) rather than asking for more. The response marks the most-recent finalised close, which is processed at most once. " +
    "Form a thesis on enough bars to see the structure you are claiming: fewer than about 60 on the mission's timeframe is a guess about a chart you have not looked at, and a momentum claim from a handful of candles is the one the market punishes first.",
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

export const TradingGetOrderBookTool = Tool.make("trading_get_order_book", {
  description:
    "Read the current order book (up to 20 levels per side) with the derived best bid/offer and a 2-second freshness stamp. Use this for execution-critical reads where a fresh bid/ask matters.",
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
    "Read the canonical account state for this mission's trading account: account value, margin used, withdrawable, and open positions. Account state is always queried with the user-owned master-wallet address — the execution-wallet address is never used as identity. " +
    "This is the live balance, not your mandate: `withdrawable` is what is actually free right now, while the ceilings you must stay under live in the mission's `authority`. The mandate was sized from this account when the mission was created and does not follow it afterwards, so a balance that has moved changes what you can afford, never what you are allowed.",
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
    "Read the canonical net position for a market: signed size (positive long, negative short), entry price, unrealised PnL, cumulative funding, and margin used. Returns a flat position with size 0 and no entry price when none is open — that is a valid net-zero state, not an error.",
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
    "List the currently open orders for this mission's trading account, keyed by canonical identity. Each order carries its exchange order id, optional client order id, side (buy/sell), limit price, size, and status.",
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
    "Register a typed market watch bound to the mission's current strategy version. The watch is created active; it fires when its predicate matches (a candle's final close, a price cross against a fresh mark/mid, an order or position update). The evaluator sweeps every 2 seconds, so a fire lands within a couple of seconds of the condition — not on the tick. " +
    "A watch fires EXACTLY ONCE and is then terminal. A level you want to keep standing has to be re-registered after it fires; nothing re-arms it for you. " +
    "Watches also do NOT survive a strategy publish — publishing supersedes every watch the previous version armed, so re-arm what you still need after switching. " +
    "`position_update` and `order_update` read T3's reconciled local tables, not the exchange directly: they fire on a change in the size the last reconcile recorded, so they follow fills and cancels rather than quotes. " +
    'While a position is open, arm levels on BOTH sides of the mark: the two differential types fire on a change in size and will not wake you for a move in your favour. A run that ends holding a position with nothing armed above and below, and no reassessment due within ten minutes, gets a reassessment registered for it automatically — and so does a FLAT mission that still has a published thesis. That automatic wake carries `wakeReason: "staleness_floor"`: it means nothing crossed and nothing fired, so the thing to reconsider is the thesis — re-level, republish at the next version, or stand down. ' +
    "`missionId` is optional — omit it and the call acts on the mission this session is bound to.",
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

export const TradingScheduleReassessmentTool = Tool.make("trading_schedule_reassessment", {
  description:
    "Schedule a time-based reassessment of this mission at a future Unix-millisecond timestamp. This registers a scheduled_reassessment watch through the same path as trading_register_watch; the evaluator fires it when the timestamp passes. Use this when the harness should wake at a known time (e.g. a funding settlement) rather than on a market signal. Like every watch it fires once and is then terminal — schedule the next one from the turn it wakes.",
  parameters: TradingScheduleReassessmentInput,
  success: TradingScheduleReassessmentResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Schedule reassessment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TradingListWatchesTool = Tool.make("trading_list_watches", {
  description:
    "List every watch registered for this mission, newest first, including its status (active, triggered, superseded, cancelled). Call this to see which conditions are currently armed before deciding whether to register another.",
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
    "Cancel an active watch by id. Only an active watch can be cancelled; a watch that already fired, was superseded by a strategy publish, or does not exist is rejected. Use this to disarm a condition that is no longer relevant.",
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

export const TradingRequestEntryTool = Tool.make("trading_request_entry", {
  description:
    "Submit one execution intent for the bound mission. Despite the name this is the whole position lifecycle, not just entries — `intent.actionType` selects which: " +
    "`open` starts a position and `scale_in` adds to one; both are position-increasing and are REFUSED without valid `intent.stop` (a stopPrice on the losing side of entry, plus plannedLossAtStopUsd). " +
    "`reduce` takes part of the position off — set `size` to the amount to remove and the server clamps it to the canonical position, submits it reduce-only, and reports what remains; this is how you scale out or take partial profit. " +
    "`close` flattens the whole position regardless of the size you name. " +
    "`cancel` withdraws one resting order named by `intent.targetCloid` (read the cloid from trading_get_open_orders); use it to retire a stale resting entry, since publishing a new strategy supersedes watches but does NOT cancel orders already working on the exchange. " +
    "`modify_stop` moves the protection on an open position to a new `intent.stop.stopPrice` — the replacement is confirmed on-exchange before the old stop is cancelled — which is how you trail a stop or pull it to break-even. A stop on the wrong side of the current mid is REFUSED outright before anything is submitted, because a stop that cannot be confirmed escalates to §17.5's emergency close: the position is flattened and the mission is blocked. Check the number against trading_get_order_book before sending it. " +
    "`reduce`, `close`, `cancel`, and `modify_stop` need no stop of their own and stay available even when the loss budget is exhausted. " +
    'PRICING: there is no market order, and for `marketable_ioc` the SERVER prices the crossing limit — it takes the fresh best bid/offer and pushes it through by the configured slippage allowance (50 bps by default). Your `intent.limitPrice` is NOT that bound: it feeds the preview arithmetic only, and is still required and still must be greater than 0, priced to cross (buy: at or above the best ask; sell: at or below the best bid). The result reports `limitPrice` — the bound actually placed — and `avgFillPrice`, what it actually filled at. The Hyperliquid UI\'s "Price" column for an IOC shows the placed limit bound, not the fill, which is why that column reads about half a percent away from the fill T3 reports. ' +
    "VALIDATION before signing: the mission must be in an admitting status (`mission_active` — waiting or position_open), the strategy version must be current (`strategy_version_current` — republish and retry if it has moved), the market must be ETH (`market_is_eth`), a position-increasing intent must carry a valid stop, the loss budget must admit it, the exchange reads must be fresh, and NO other execution of this mission may be mid-submission (`no_conflicting_execution_pending` — read `pendingExecutions[]` from trading_get_mission to see what is holding it and how stale). " +
    "Then it waits for the real outcome. `filled`, `cancelled`, `rejected`, and `failed` are the record's terminal word. `accepted` means the order reached the exchange and rests on the book — read `orderResults`. `succeeded` is a `cancel` or `modify_stop` that did what it was asked; `detail` says what. `rejected` with no cloid means the request was refused before signing and no order exists. `submitted` means the outcome was not yet known when this returned; read the position and open orders before assuming anything filled. A `reduce` or `close` also reports `remainingSize`, the signed canonical position left.",
  parameters: TradingRequestEntryInput,
  success: TradingRequestEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Request trading entry")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingToolkit = Toolkit.make(
  TradingGetMissionTool,
  TradingPublishMomentumStrategyTool,
  TradingResolveMarketTool,
  TradingGetMarketSnapshotTool,
  TradingGetMarketHistoryTool,
  TradingGetOrderBookTool,
  TradingGetAccountStateTool,
  TradingGetPositionTool,
  TradingGetOpenOrdersTool,
  TradingRegisterWatchTool,
  TradingScheduleReassessmentTool,
  TradingListWatchesTool,
  TradingCancelWatchTool,
  TradingRequestEntryTool,
);
