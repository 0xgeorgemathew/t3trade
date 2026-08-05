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
  TradingGetMomentumContextInput,
  TradingGetOpenOrdersInput,
  TradingGetOrderBookInput,
  TradingGetPositionInput,
  TradingGetTargetCalibrationInput,
  TradingGetTradeHistoryInput,
  TradingListWatchesInput,
  TradingListWatchesResult,
  TradingMeasureVolatilityInput,
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
import { TradingCostEstimate } from "@t3tools/trading-contracts/costs";
import { MomentumContext } from "@t3tools/trading-contracts/momentum";
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
    "Read the current state of the trading mission this agent session is bound to: status, mandate (authority and risk policy), the published momentum strategy and its version, registered watches, the user's control flags, and any executions still in flight. Call this at the start of every turn before deciding anything. " +
    "The mandate is the user's hard rails, not a balance: `authority.allocatedCapitalUsd` and the maximums derived from it are ceilings you may never exceed, and they do not move when the account value does. What is actually free to trade right now is `accountSnapshot.withdrawable` from trading_get_account_state. Sizing within the rails, against the live balance, is your judgement to exercise. " +
    "`pendingExecutions[]` is the lock behind the `no_conflicting_execution_pending` refusal: while any entry is listed there, trading_execute refuses every new intent. Each entry names the cloid, the action, its status, and how long it has sat there. " +
    '`strategyHistory[]` is every version this mission has published, newest first, with each one\'s target and the basis it was derived from. `strategy` is only the current thesis; the history is how you tell "the thesis changed" from "the thesis has changed four times in an hour", and how you see the targets you set before this one. Pair it with trading_get_target_calibration to find out whether any of them were reachable. ' +
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
    "Publish the momentum strategy this mission should now be executed against. Supply expectedVersion as the strategy version you read from trading_get_mission (0 before any publish). A stale expectedVersion is rejected with the server's current version and leaves the published strategy untouched; an accepted publish increments the version and supersedes the watches registered by the previous one — re-arm the watches you still want, and cancel any resting order from the old thesis with trading_execute actionType `cancel`, which a publish does not touch. " +
    "This is also how you switch strategies: republish at the next version with a different mode or direction when the thesis fails or the market goes stale. " +
    "`strategy.timeframes[0]` is the primary timeframe that drives the monitoring cadence; it must name at least one timeframe. " +
    "Every entry in `strategy.entryPlan.conditions[]` REQUIRES a non-empty `description` — the prose conclusion is the field that matters; `timeframe`, `priceLevel`, and `invalidatedBy` are optional display hints. A conditions entry without a description is rejected. A condition may also be supplied as a bare prose string, which is read as `{ description: <the string> }`. " +
    "`protection.targetProfitUsd` is REQUIRED: the unrealised-PnL level, in USD, at which this position is worth banking or re-justifying — the CONSERVATIVE rung of the ladder you derive below, not your best case. It is shown to the user and the runtime arms a `pnl_above` watch at it while you hold a position. That wake is a DECISION POINT, not a close order: read the book and the momentum, then bank (close, or `reduce` half and keep a runner) if the move is fading, or extend — republish at the next version with the base rung and a fresh basis — if it is not. Treating every target wake as an automatic close turns a deliberately conservative estimate into a cap on every win you will ever take. You may additionally place your own resting take-profit order via trading_execute if you judge one right; the target watch still stands. " +
    "Derive that target from the fluctuation this instrument is actually producing, not from a round number or a feeling about the setup. Four steps, in order: " +
    "(1) MEASURE TWO TIMEFRAMES. Read `observedVolatility` from the wakeup for your thesis timeframe and call trading_measure_volatility on ONE HIGHER timeframe (15m or 1h) as well. A 1m window alone maxes out at a 20-minute view and cannot tell you whether the structure supports the move you are about to ask for. Pick the measurement that fits your thesis: `horizons[].favourableUpUsd.p50` for a long, `favourableDownUsd.p50` for a short, is the move price actually delivered over that many bars in half the recent windows; the p75 in a quarter of them. `atr`, `realized_volatility`, and `swing_range` are single-number summaries of the same window. " +
    "(2) DISCOUNT FOR ENTRY LOCATION. Those quantiles measure the move from a flat bar close. A momentum entry happens AFTER the impulse has begun, so the whole measured move is not still ahead of you. Call trading_get_momentum_context and use its numbers rather than guessing: subtract roughly half of `lastImpulse.sizeUsd` from the measured move, check `ageBars` (a leg that ended twenty bars ago is over, not pulling back), require `atrExpansionRatio` above 1 and an `alignment` that is not `mixed`, and cap the target at `distanceToSwingHighUsd` (long) or `distanceToSwingLowUsd` (short) on the higher timeframe. " +
    "(3) CONVERT. Percentage move off the current mark x position notional (margin x leverage) = USD target. Worked example: 100 USD margin at 20x = 2000 USD notional; a measured 0.35% move over a 10-bar hold = 7.00 USD. " +
    "(4) CHECK IT AGAINST COST — this is the gate that matters. Call trading_estimate_costs at your size: it prices the round trip from the fee rate this wallet actually pays and the live book, and reports `minimumViableTargetUsd` (twice the round trip). `targetProfitUsd` is GROSS (`pnl_above` fires on the exchange's unrealised PnL, which nets neither fees nor funding), so a target under that figure is not a trade — it is a fee donation with variance. As a rough check without the tool: two taker fills at 5 bps per side is 0.10% of notional, about 2.00 USD on 2000 USD, so the floor is roughly 4.00 USD, a 0.20% move. If your measured, entry-discounted move does not clear it, stand down. " +
    "Publish the ladder — conservative / base / extension, each with its USD figure and each net of the round trip — in `protection.targetProfitRationale`, since only one number can be armed as a watch and the wake needs somewhere to extend to. " +
    "`protection.targetProfitBasis` is REQUIRED and is CHECKED: a publish with no basis is rejected, and so is one whose target does not follow from it — `(measuredMoveUsd / referencePrice) x positionNotionalUsd` must come out within 5% of `targetProfitUsd`. Record measurement, timeframe, lookbackBars, expectedHoldBars, measuredMoveUsd (USD of PRICE), referencePrice, targetPriceMovePercent, positionNotionalUsd, `historicalHitRatePercent` when the measurement gives one (a p50 is 50), and a `rationale` naming BOTH timeframes measured, the entry-location discount applied, and the round-trip cost the target clears. An accepted publish returns `warnings[]`; a target under twice its cost is reported there rather than refused, and is still a target you should not be arming. " +
    "If the observed fluctuation does not support a target worth taking after costs, say so: set `insufficientVolatility: true`, explain it in the rationale, and stand down rather than inventing a number to fill the field. " +
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

export const TradingMeasureVolatilityTool = Tool.make("trading_measure_volatility", {
  description:
    "Measure the fluctuation a market is actually producing over a bounded candle window — the basis every profit target has to be derived from. Returns, all computed from real candles with no model or assumed distribution: `atrUsd`/`atrPercent` (mean true range over the last 14 bars), `realizedVolatilityPercentPerBar` (standard deviation of bar-to-bar log returns), `swingRangeUsd`/`swingRangePercent` (the window's high-to-low), and `horizons[]`. " +
    "`horizons[]` is the one to set a target from: for each holding period in bars it reports, over every window of that length in the lookback, the distribution (p25/p50/p75) of the move price delivered from a bar's close — `favourableUpUsd` for a long, `favourableDownUsd` for a short. A target at the p50 was available in half the recent windows of that length; at the p75, in a quarter. That is what makes a target attainable rather than hopeful. " +
    "`sufficientData` is false when the window is too short to measure from (under 30 bars) — read a longer window before setting a target off it. " +
    "Every wakeup already carries this for the mission's primary timeframe as `observedVolatility` AND for one higher timeframe as `higherTimeframeVolatility`, so the pair a target needs is normally in hand before you call anything. Reach for this tool for a third interval, a longer lookback, or different hold horizons. Defaults to 120 bars and hold horizons of 3, 5, 10, and 20 bars. " +
    "This measures magnitude only and says nothing about direction: call trading_get_momentum_context for which way the timeframes point, whether the range is expanding, and where the last impulse started. " +
    "Two things this does NOT tell you, and you must supply both yourself. It measures the move from a FLAT BAR CLOSE, so a momentum entry taken after the impulse began has less of that move left — discount by roughly half the impulse already travelled. And every figure here is GROSS: no fee, spread, or funding is netted anywhere in this output. Call trading_estimate_costs for what the round trip actually costs at your size and hold the target against the `minimumViableTargetUsd` it reports.",
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
    "Cost a round trip on this market at a given size, from the live fee rate and the live book. Call this BEFORE publishing a profit target and again before deciding whether to bank one — it is the only place the fee rate the account actually pays is visible to you. " +
    "Name the position either way: `sizeEth` in base units, or `notionalUsd`, which is converted at the current mark. " +
    "Returns the round trip itemised into three non-overlapping parts, so summing them is not double-counting: `roundTripFeeUsd` (two taker fills at `takerFeeBpsPerSide`), `roundTripSpreadUsd` (crossing the bid/ask twice, from `halfSpreadUsd`), and `roundTripSlippageUsd` (what walking the visible book PAST the touch costs this size, both sides). `roundTripUsd` is the total; `breakEvenPriceMoveUsd` is how far price has to move per unit just to get out flat. " +
    "`minimumViableTargetUsd` is the number to hold a target against: twice the round trip. `protection.targetProfitUsd` is GROSS — `pnl_above` fires on the exchange's unrealised PnL, which nets neither fees nor funding — so a target under this figure is a fee donation with variance, not a trade. If your measured, entry-discounted move does not clear it, stand down and say so. " +
    "`degraded` is true when part of the cost could not be read (the fee rate fell back to the authority's default, or the visible book could not absorb your size); `notes` says which, and the total is then a LOWER BOUND. `fundingCostPer8hUsd` is the holding cost on top, positive meaning a long pays it — it is outside the round trip and matters only if you intend to hold across a funding interval.",
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

export const TradingGetMomentumContextTool = Tool.make("trading_get_momentum_context", {
  description:
    "Read the directional structure of this market across four timeframes at once (1m, 5m, 15m, 1h by default). trading_measure_volatility says how FAR this thing moves; this says which WAY, whether it is speeding up, where the last leg started, and what it runs into next. Call it before forming a thesis, and again at a profit-target wake before deciding to extend. All deterministic arithmetic over real candles — no indicator model, nothing to tune. " +
    "Per timeframe: `directionScore` is net travel divided by total travel, in [-1, 1] — 1.0 is a straight line up, 0 is a window that ended where it started however far it went in between, so it separates trend from chop in one number. `direction` applies a threshold to it (0.15). `atrExpansionRatio` is the last 14 bars' ATR over the 14 before them: above 1 the market is covering more ground per bar than it just was, which is the condition a momentum entry actually needs; below 1 the move is running out of range. " +
    "`lastImpulse` is the last completed leg measured pivot to pivot — its `sizeUsd`, and `ageBars` since it ended. THIS is the number the entry-location discount comes from: subtract roughly half of `sizeUsd` from a measured move before calling the rest yours, and treat a large `ageBars` as the impulse being over rather than as a pullback to buy. `pullbackDepthUsd` and `pullbackPercentOfImpulse` say how much of that leg has already been given back. " +
    "`distanceToSwingHighUsd`/`distanceToSwingLowUsd` are signed from the last close: positive means the level is still ahead and CAPS a long's target, negative means price already traded through it, which is a breakout rather than a ceiling. " +
    "`alignment` is the composite: which way a majority of the measured timeframes point, how many agree, and the mean score. `mixed` means the timeframes contradict each other or all of them are chopping — in either case a momentum thesis on the fast one is a thesis about noise. `sufficientData` is false on any timeframe with under 30 bars; do not read structure off one.",
  parameters: TradingGetMomentumContextInput,
  success: MomentumContext,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Get momentum context")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingGetTradeHistoryTool = Tool.make("trading_get_trade_history", {
  description:
    "Read this mission's OWN completed trades: every order it filled, newest first, with size, size-weighted average price, fee, realised PnL, and — the field that makes this a record of decisions rather than of trades — the strategy version and `targetProfitUsd` that were current when it filled. Call this after a position closes, and before re-entering, so the next thesis is informed by the last one instead of repeating it. " +
    "Fills are aggregated into ORDERS. Hyperliquid reports one market order as a dozen partials; a history of slices is not a history of decisions. `fillCount` says how many partials an order took, and `firstFillAt`/`lastFillAt` show a slow fill as one. " +
    "`netPnlUsd` is `closedPnlUsd` less `feeUsd`, per order and in the summary, and it is the only figure that says whether any of this worked. An order that merely opened or added to a position reports `closedPnlUsd` 0 — it has no result yet and is not counted as a win or a loss. `summary` spans EVERY order the mission has placed, not just the page `limit` returns. " +
    "Read the wins and losses against the targets beside them. A string of orders closed well under their published `targetProfitUsd` means the targets were too far out; a string of small wins next to a large `feesPaidUsd` means they were too close.",
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
    "Score the profit targets this mission has published against what its trades actually reached. This is the only read that can tell you your own habit is wrong: a target derived from a p50 measurement should be reached about half the time, and one reached a fifth of the time was not bad luck — it was read off the wrong rung. Call it in the cooldown after a close, before setting the next target. " +
    "A target counts as REACHED when the trade's unrealised PnL ever touched it, not when it was banked there. Those grade different things: the first grades the target, the second grades your decision to hold. `peakUnrealisedPnlUsd` is what makes the distinction possible and it exists nowhere else. " +
    "Each entry is one strategy version: its `targetProfitUsd`, the `claimedHitRatePercent` its basis published, the `observedHitRatePercent` its trades produced, and `meanPeakUsd`/`meanTroughUsd` — how good and how bad those trades got. `verdict` is `optimistic` when the target came in well under its claim, `conservative` when it came in well over (the move was there and you were not asking for it), `as_claimed` in between, and `insufficient_sample` under five trades, where the count is published and the rate is withheld rather than computed from noise. " +
    "`recommendation` is the single line to act on. Until there is a sample it says so — no evidence and evidence that you are fine are different answers, and only one of them should change what you do next.",
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
    "Read the canonical net position for a market: signed size (positive long, negative short), entry price, unrealised PnL, cumulative funding, and margin used. Returns a flat position with size 0 and no entry price when none is open — that is a valid net-zero state, not an error. " +
    "`peakUnrealisedPnl` and `drawdownFromPeakUsd` are T3's own, not the exchange's: the highest this position has ever been worth, and how much of that it has since given back. The exchange reports only what a position is worth now, so without these you cannot tell a winner that faded from a trade that never worked. Both are absent while flat and on a position that has never been in profit.",
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
    "Register a typed market watch bound to the mission's current strategy version. The watch is created active; it fires when its predicate matches (a candle's final close, a price cross against a fresh mark/mid, an order or position update, the unrealised PnL reaching a target). The evaluator sweeps every 2 seconds, so a fire lands within a couple of seconds of the condition — not on the tick. " +
    "A watch fires EXACTLY ONCE and is then terminal. A level you want to keep standing has to be re-registered after it fires; nothing re-arms it for you. " +
    "To MOVE a level rather than add one, pass `replacesWatchId` with the id of the watch it supersedes: the cancel and the new arm happen in one transaction, so the side you are re-levelling is never momentarily unwatched, and a failure leaves the OLD level standing rather than nothing. The result returns `replaced` with the watch that was cancelled — if it comes back absent, the watch you named had already fired or been superseded, so what you just armed is an ADDITION, not a swap, and the old level is not there to be relied on. " +
    "Each type carries its own required fields, and a missing one is rejected outright: `price_cross` takes market, priceSource, direction, price; `candle_close` takes market, INTERVAL (1m/3m/5m/15m/1h — the timeframe whose close is read), direction, price; `order_update` takes cloid; `position_update` takes market; `pnl_above` takes market and valueUsd; `pnl_below` takes market and valueUsd, SIGNED (a loss floor is negative, e.g. -6); `pnl_giveback` takes market and drawdownUsd; `scheduled_reassessment` takes runAt. " +
    "Watches also do NOT survive a strategy publish — publishing supersedes every watch the previous version armed, so re-arm what you still need after switching. " +
    "`position_update` and `order_update` read T3's reconciled local tables, not the exchange directly: they fire on a change in the size the last reconcile recorded, so they follow fills and cancels rather than quotes. " +
    "`pnl_above` fires when the reconciled unrealised PnL for `market` is at least `valueUsd`; `pnl_below` is its mirror, firing when PnL falls to or below a SIGNED level. A flat position fires neither. While you hold a position, the runtime also arms its own `pnl_above` at the strategy's `protection.targetProfitUsd` with `armedReason: \"profit_target\"` — that is the wake-and-decide win target. A wake from it is a decision point, not a close order: bank the profit (close, or `reduce` half and keep a runner) if momentum is fading, or republish at the ladder's next rung with a fresh basis if it is not. " +
    "`pnl_giveback` is what makes the second choice survivable. It fires when unrealised PnL has fallen `drawdownUsd` from its own HIGH-WATER MARK on this position — T3 records that mark durably (the exchange never reports it), it survives a restart, and it resets when you go flat. Whenever a target wake decides to extend rather than bank, arm one beneath the peak: extending without it bets the entire open profit on the next leg, which is how a winner round-trips to nothing. It never fires on a position that has only ever lost — that is the stop's job. Read `peakUnrealisedPnl` and `drawdownFromPeakUsd` on trading_get_position or the wakeup to see where the mark currently sits. " +
    'While a position is open, arm levels on BOTH sides of the mark: the two differential types fire on a change in size and will not wake you for a move in your favour. A reassessment is auto-armed a few bars out — 3 bars of your primary timeframe while holding, 10 bars while flat (clamped 2m–30m) — whenever a run ends with nothing else due to wake the mission. That automatic wake carries `armedReason: "staleness_floor"`: it means nothing crossed and nothing fired, so the thing to reconsider is the thesis — re-level, republish at the next version, or stand down. ' +
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

export const TradingExecuteTool = Tool.make("trading_execute", {
  description:
    "Submit one execution intent for the bound mission. This is the whole position lifecycle, not just entries — `intent.actionType` selects which: " +
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
  .annotate(Tool.Title, "Execute trading intent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

/**
 * The original name, kept working.
 *
 * `trading_request_entry` describes one of the six things the call does, and a
 * harness picks a tool by name before it reads the description — which is how a
 * `close` ends up looking like the wrong tool for the job. The name changed;
 * the behaviour did not. This alias exists so a session that already learned
 * the old one is not broken by the rename, and its description is short on
 * purpose: it points at the tool whose description carries the detail.
 */
export const TradingRequestEntryTool = Tool.make("trading_request_entry", {
  description:
    "DEPRECATED ALIAS of trading_execute — identical parameters, identical behaviour, same server path. Prefer trading_execute: this call is the whole position lifecycle (`open`, `scale_in`, `reduce`, `close`, `cancel`, `modify_stop` via `intent.actionType`), not just entries, and the old name reads as though `close` belongs somewhere else. Read trading_execute's description for the pricing rules, the mandatory stop on position-increasing intents, the preview checklist, and what each returned status means.",
  parameters: TradingRequestEntryInput,
  success: TradingRequestEntryResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Request trading entry (deprecated)")
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
  TradingMeasureVolatilityTool,
  TradingEstimateCostsTool,
  TradingGetMomentumContextTool,
  TradingGetTradeHistoryTool,
  TradingGetTargetCalibrationTool,
  TradingGetOrderBookTool,
  TradingGetAccountStateTool,
  TradingGetPositionTool,
  TradingGetOpenOrdersTool,
  TradingRegisterWatchTool,
  TradingScheduleReassessmentTool,
  TradingListWatchesTool,
  TradingCancelWatchTool,
  TradingExecuteTool,
  TradingRequestEntryTool,
);
