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
  TradingGetPlaybookInput,
  TradingGetTargetCalibrationInput,
  TradingListWatchesInput,
  TradingListWatchesResult,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
  TradingWatchInput,
  TradingWatchResult,
  TradingAdjustStopInput,
  TradingAdjustStopResult,
  TradingEnterResult,
  TradingRequestEntryResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
import { TradingLookInput, TradingObservation } from "@t3tools/trading-contracts/observation";
import { TradingEnterInput } from "@t3tools/trading-contracts/entry";
import {
  TradingCancelOrderInput,
  TradingClosePositionInput,
  TradingReducePositionInput,
} from "@t3tools/trading-contracts/exit";
import { Playbook } from "@t3tools/trading-contracts/playbook";
import { TargetCalibration } from "@t3tools/trading-contracts/calibration";
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
import { TradingEntryService } from "../../../trading/TradingEntryService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { TradingStopAdjustmentService } from "../../../trading/TradingStopAdjustmentService.ts";
import { TradingWatchService } from "../../../trading/TradingWatchService.ts";
import { TradingWakeupComposer } from "../../../trading/TradingWakeupComposer.ts";
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
  // `trading_look` reaches Hyperliquid through the gateway.
  HyperliquidGateway,
  // `trading_look` prices its cost line from the live fee rate and book.
  TradingCostEstimator,
  // `trading_look` reads the mission's own completed orders.
  TradingTradeHistoryService,
  // `trading_get_target_calibration` grades the targets against those trades.
  TradingCalibrationService,
  // `trading_enter` reports what the reactor actually did with the request,
  // not that the request was raised.
  TradingExecutionOutcome,
  // `trading_adjust_stop` measures the mission before it moves the stop.
  TradingStopAdjustmentService,
  // `trading_enter` prices, sizes and pre-checks the entry it then submits.
  TradingEntryService,
  // The three exit tools size themselves from the canonical position.
  TradingExitService,
  // An accepted publish reconciles the exchange's stop and target to the plan
  // (plan 29 step 4.5) and retracts the mission's resting working entries.
  TradingPlanProtectionService,
  TradingWorkingOrderService,
  // `trading_look` is the composer's gather step, returned rather than
  // rendered (plan 29 step 6.1).
  TradingWakeupComposer,
  SqlClient.SqlClient,
];

export const TradingLookTool = Tool.make("trading_look", {
  description:
    "The one read: mark, book, candles, volatility, multi-timeframe `structure` with scored `candidates[]`, plus `position` (flat is size 0), `account`, `openOrders`, `trades`, and `mission` (mandate, authority, plan, watches). `cost` is one line — the round trip in USD and bps at a stated notional — context for whether the move pays, never a gate; holding, `positionCosts` prices the exit. `mission.bound: false` with `lastMission` once the mission has ended.",
  parameters: TradingLookInput,
  success: TradingObservation,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Look")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingPublishPlanTool = Tool.make("trading_publish_plan", {
  description:
    'Publish the eight-field plan: market, intent, entry, stop, target, invalidation, reassess, because. Declining to trade is intent "stand_aside". Derive the target off measured volatility over the intended hold. `expectedMissionVersion` (from trading_look); a stale publish is rejected. Revising replaces the plan in place — watches survive, so cancel or replace any trigger you no longer want.',
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

// -- §14.4 watch tools (Phase 3) ---------------------------------------------

export const TradingWatchTool = Tool.make("trading_watch", {
  description:
    'Arm one `condition` — `price` (a level; `confirm: "close"` needs an `interval`, otherwise it fires on touch), `pnl`, `giveback`, `fill`, `time`. Fires exactly once, then terminal — re-arm to keep a level standing. `replacesWatchId` moves a level: cancel and arm in one transaction; if that watch already fired, what was armed is an ADDITION, not a swap. A refused condition arms nothing and says in `recovery` whether to restate it or read state first.',
  parameters: TradingWatchInput,
  success: TradingWatchResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Watch")
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

export const TradingEnterTool = Tool.make("trading_enter", {
  description:
    "Enter in one call: name the market, the side and your stop; the server derives the limit, the precision, the versions, the lease, and the largest size every risk ceiling allows — the approved trade — pre-checks it, and sends it. Omit the size for that ceiling; too large comes back smaller with `constrainedBy`. `urgency` defaults to `now` (cross); `patient` rests at the near side and the server works it. Refuses stops inside the noise floor. `notes` is what is true of it but does not stop it.",
  parameters: TradingEnterInput,
  success: TradingEnterResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Enter")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  // Deliberately NOT idempotent: with the quote token retired there is nothing
  // for a second call to replay, so it allocates a fresh sequence, derives a
  // fresh cloid, and is a second trade. Saying otherwise would invite exactly
  // the double entry the annotation is supposed to prevent.
  .annotate(Tool.Idempotent, false)
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
  TradingLookTool,
  TradingPublishPlanTool,
  TradingGetTargetCalibrationTool,
  TradingGetPlaybookTool,
  TradingWatchTool,
  TradingListWatchesTool,
  TradingCancelWatchTool,
  TradingEnterTool,
  TradingClosePositionTool,
  TradingReducePositionTool,
  TradingCancelOrderTool,
  TradingAdjustStopTool,
);
