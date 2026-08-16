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
  TradingGetPlaybookInput,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
  TradingWatchInput,
  TradingWatchResult,
  TradingExitResult,
  TradingEnterResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
import { TradingLookInput, TradingObservation } from "@t3tools/trading-contracts/observation";
import { TradingEnterInput } from "@t3tools/trading-contracts/entry";
import { TradingExitInput } from "@t3tools/trading-contracts/exit";
import { Playbook } from "@t3tools/trading-contracts/playbook";
import { TradingJournalInput, TradingJournalResult } from "@t3tools/trading-contracts/journal";
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
import { TradingJournalService } from "../../../trading/TradingJournalService.ts";
import { TradingWakeupComposer } from "../../../trading/TradingWakeupComposer.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  TradingMissionService,
  TradingStrategyService,
  // `trading_watch` arms and retires through the watch service.
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
  // `trading_look` grades the mission's published targets against those
  // trades — the retired calibration tool's read, off the hot path.
  TradingCalibrationService,
  // `trading_enter` reports what the reactor actually did with the request,
  // not that the request was raised.
  TradingExecutionOutcome,
  // `trading_exit`'s `move_stop` measures the mission before it moves the stop.
  TradingStopAdjustmentService,
  // `trading_enter` prices, sizes and pre-checks the entry it then submits.
  TradingEntryService,
  // `trading_exit` sizes itself from the canonical position.
  TradingExitService,
  // An accepted publish reconciles the exchange's stop and target to the plan
  // (plan 29 step 4.5) and retracts the mission's resting working entries.
  TradingPlanProtectionService,
  TradingWorkingOrderService,
  // `trading_look` is the composer's gather step, returned rather than
  // rendered (plan 29 step 6.1).
  TradingWakeupComposer,
  // `trading_journal` appends to and reads back the mission's memory.
  TradingJournalService,
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

export const TradingPlanTool = Tool.make("trading_plan", {
  description:
    'Publish the eight-field plan: market, intent, entry, stop, target, invalidation, reassess, because. Declining to trade is intent "stand_aside". Derive the target off measured volatility over the intended hold. `expectedMissionVersion` (from trading_look); a stale publish is rejected. Revising replaces the plan in place — watches survive, so cancel or replace any trigger you no longer want.',
  parameters: TradingPublishPlanInput,
  success: TradingPublishPlanResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Plan")
  .annotate(Tool.Readonly, false)
  // Publishing revises the mission's state (and the plan the exchange is
  // reconciled to), so it is not a repeatable no-op.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

// -- §14.4 watch tools (Phase 3) ---------------------------------------------

export const TradingWatchTool = Tool.make("trading_watch", {
  description:
    'Arm one `condition` — `price` (a level; `confirm: "close"` needs an `interval`, otherwise it fires on touch), `pnl`, `giveback`, `fill`, `time` — or retire one by id with `cancel`; exactly one of the two per call. The armed set is on `trading_look`. Fires exactly once, then terminal — re-arm to keep a level standing. `replacesWatchId` moves a level in one transaction; if that watch already fired, what was armed is an ADDITION, not a swap. A refusal changes nothing and `recovery` says what to do.',
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

export const TradingJournalTool = Tool.make("trading_journal", {
  description:
    "Append one `note` to the mission's memory; omit `note` to read it back. Append-only — a note survives the plan revisions that overwrite `because`, so write what will still matter next turn: a level that chopped you, a read you are waiting on. Every call returns `entries`, newest first.",
  parameters: TradingJournalInput,
  success: TradingJournalResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Journal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  // A second identical call appends a second note. Reading (no `note`) is
  // idempotent, but the annotation describes the tool, not the branch.
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

export const TradingStrategyTool = Tool.make("trading_strategy", {
  description:
    "Read one named strategy. Each returns whenItApplies (trigger), procedure[] (ordered steps), gates[] (must clear before entry), standDownIf[] (retire a setup). In discretionary mode this is reference; when trading_look reports mode execute_strategy it is the decision procedure for the named one.",
  parameters: TradingGetPlaybookInput,
  success: Playbook,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Strategy")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingExitTool = Tool.make("trading_exit", {
  description:
    'One `action` on exposure you hold. `close` flattens it, taking no size or side. `reduce` takes part off by `sizeEth` or `fraction`, closing instead if what remains would be dust. `cancel_order` withdraws a resting order by `cloid`. `move_stop` trails the stop in policy — never past the entry\'s approved stop, bounded steps, outside the noise floor, never back below entry once past it, rate-limited. `urgency: "patient"` rests it. A refusal sends nothing.',
  parameters: TradingExitInput,
  success: TradingExitResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Exit")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  // `cancel_order` and `move_stop` are repeatable no-ops; `close` and `reduce`
  // are not. The annotation describes the tool, so it takes the stricter half.
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TradingToolkit = Toolkit.make(
  TradingLookTool,
  TradingPlanTool,
  TradingStrategyTool,
  TradingWatchTool,
  TradingJournalTool,
  TradingEnterTool,
  TradingExitTool,
);
