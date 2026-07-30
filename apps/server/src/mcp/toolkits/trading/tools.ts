/**
 * Harness-facing trading tools - spec §14.3.
 *
 * These ride the existing upstream MCP boundary: the first-party MCP server in
 * `apps/server`, reached with the per-session bearer credential every provider
 * adapter already injects as `t3-code`. There is no second transport and no
 * per-harness MCP configuration.
 *
 * Every schema here is imported from `@t3tools/trading-contracts/tools`; none
 * is redeclared.
 *
 * @module TradingToolkitTools
 */
import {
  TradingGetMissionInput,
  TradingGetMissionResult,
  TradingPublishMomentumStrategyInput,
  TradingPublishMomentumStrategyResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  TradingMissionService,
  TradingStrategyService,
];

export const TradingGetMissionTool = Tool.make("trading_get_mission", {
  description:
    "Read the current state of the trading mission this agent session is bound to: status, mandate (authority and risk policy), the published momentum strategy and its version, registered watches, and the user's control flags. Call this at the start of every turn before deciding anything.",
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
    "Publish the momentum strategy this mission should now be executed against. Supply expectedVersion as the strategy version you read from trading_get_mission (0 before any publish). A stale expectedVersion is rejected with the server's current version and leaves the published strategy untouched; an accepted publish increments the version and supersedes the watches registered by the previous one.",
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

export const TradingToolkit = Toolkit.make(
  TradingGetMissionTool,
  TradingPublishMomentumStrategyTool,
);
