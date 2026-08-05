import { expect, it } from "@effect/vitest";
import {
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_ESTIMATE_COSTS_TOOL,
  TRADING_EXECUTE_TOOL,
  TRADING_GET_MOMENTUM_CONTEXT_TOOL,
  TRADING_GET_TARGET_CALIBRATION_TOOL,
  TRADING_GET_TRADE_HISTORY_TOOL,
  TRADING_GET_ACCOUNT_STATE_TOOL,
  TRADING_GET_MARKET_HISTORY_TOOL,
  TRADING_MEASURE_VOLATILITY_TOOL,
  TRADING_GET_MARKET_SNAPSHOT_TOOL,
  TRADING_GET_MISSION_TOOL,
  TRADING_GET_OPEN_ORDERS_TOOL,
  TRADING_GET_ORDER_BOOK_TOOL,
  TRADING_GET_POSITION_TOOL,
  TRADING_LIST_WATCHES_TOOL,
  TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL,
  TRADING_REGISTER_WATCH_TOOL,
  TRADING_REQUEST_ENTRY_TOOL,
  TRADING_RESOLVE_MARKET_TOOL,
  TRADING_SCHEDULE_REASSESSMENT_TOOL,
} from "@t3tools/trading-contracts/tools";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { TradingToolkit } from "./tools.ts";

it("exposes the §14.3 mission tools, the §14.2 read tools, and the §14.4 watch tools", () => {
  expect(
    Object.values(TradingToolkit.tools)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(
    [
      TRADING_GET_MISSION_TOOL,
      TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL,
      TRADING_RESOLVE_MARKET_TOOL,
      TRADING_GET_MARKET_SNAPSHOT_TOOL,
      TRADING_GET_MARKET_HISTORY_TOOL,
      TRADING_MEASURE_VOLATILITY_TOOL,
      TRADING_ESTIMATE_COSTS_TOOL,
      TRADING_GET_MOMENTUM_CONTEXT_TOOL,
      TRADING_GET_TRADE_HISTORY_TOOL,
      TRADING_GET_TARGET_CALIBRATION_TOOL,
      TRADING_GET_ORDER_BOOK_TOOL,
      TRADING_GET_ACCOUNT_STATE_TOOL,
      TRADING_GET_POSITION_TOOL,
      TRADING_GET_OPEN_ORDERS_TOOL,
      TRADING_REGISTER_WATCH_TOOL,
      TRADING_EXECUTE_TOOL,
      TRADING_REQUEST_ENTRY_TOOL,
      TRADING_SCHEDULE_REASSESSMENT_TOOL,
      TRADING_LIST_WATCHES_TOOL,
      TRADING_CANCEL_WATCH_TOOL,
    ].sort(),
  );
});

it("exports provider-compatible object schemas the harness can fill in", () => {
  for (const tool of Object.values(TradingToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    // Every trading call names the mission it is acting on, so the server can
    // check it against the mission the calling thread is bound to.
    expect(
      schema.properties?.missionId,
      `${tool.name} must take an explicit missionId`,
    ).toBeDefined();
  }
});

// The profit-target methodology lives entirely in these two descriptions until
// `trading_estimate_costs` and publish-time validation ship, so the guidance is
// load-bearing rather than decorative — a silent edit that drops the cost floor
// or the second timeframe is what produced a $1.70 target on $2,000 of notional.
it("carries the profit-target methodology in the publish and measure descriptions", () => {
  const publish = TradingToolkit.tools[TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL].description ?? "";

  // Two timeframes: a 1m window alone tops out at a 20-minute view.
  expect(publish).toContain("MEASURE TWO TIMEFRAMES");
  expect(publish).toContain("15m or 1h");
  // The measured excursion starts from a flat bar close; a momentum entry does not.
  expect(publish).toContain("DISCOUNT FOR ENTRY LOCATION");
  // The cost floor, now computable — the description has to name the tool that
  // computes it, and the field on its result that IS the floor.
  expect(publish).toContain("trading_estimate_costs");
  expect(publish).toContain("minimumViableTargetUsd");
  // The basis is checked at publish, so the description must say what the check
  // actually is rather than only asking for the field.
  expect(publish).toContain("(measuredMoveUsd / referencePrice) x positionNotionalUsd");
  // The target is armed gross, so it has to clear the round trip on its own.
  expect(publish).toContain("GROSS");
  // One number can be armed; the other rungs live in the rationale.
  expect(publish).toContain("targetProfitRationale");

  // A target wake is a decision, not a close order.
  expect(publish).toContain("DECISION POINT");
  expect(publish).not.toContain("the default action is to close");

  // The entry-location discount is now a number the harness can read rather
  // than one it has to eyeball, so the description has to name where from.
  expect(publish).toContain("trading_get_momentum_context");
  expect(publish).toContain("lastImpulse.sizeUsd");

  const measure = TradingToolkit.tools[TRADING_MEASURE_VOLATILITY_TOOL].description ?? "";
  expect(measure).toContain("higherTimeframeVolatility");
  // Every figure this tool reports is gross, so it has to hand the reader on to
  // the one place the round trip is actually priced.
  expect(measure).toContain("GROSS");
  expect(measure).toContain("trading_estimate_costs");
});

// The cost floor is no longer only prose: `trading_estimate_costs` computes it
// from the live fee rate and book, and the publish path checks the target
// against a basis. The description is what points the harness at both.
it("points the cost tool at the floor it exists to compute", () => {
  const costs = TradingToolkit.tools[TRADING_ESTIMATE_COSTS_TOOL].description ?? "";
  expect(costs).toContain("minimumViableTargetUsd");
  expect(costs).toContain("GROSS");
  expect(costs).toContain("degraded");
});

// The two Phase 2 reads exist to answer questions the harness was previously
// left to guess at: which way the timeframes point, and how its own last trades
// actually went. A description that does not name the fields carrying those
// answers leaves the tool as decorative as the data was before it.
it("points the research reads at the fields that carry the answer", () => {
  const momentum = TradingToolkit.tools[TRADING_GET_MOMENTUM_CONTEXT_TOOL].description ?? "";
  expect(momentum).toContain("directionScore");
  expect(momentum).toContain("atrExpansionRatio");
  // The entry-location discount, which nothing else measures.
  expect(momentum).toContain("lastImpulse");
  expect(momentum).toContain("alignment");

  const history = TradingToolkit.tools[TRADING_GET_TRADE_HISTORY_TOOL].description ?? "";
  // Orders, not the partials the exchange reports them as.
  expect(history).toContain("ORDERS");
  expect(history).toContain("netPnlUsd");
  // Each order scored against the target it was actually published under.
  expect(history).toContain("targetProfitUsd");
});

// Phase 3 renamed the execution tool and kept the old name working. The alias
// has to stay a pointer, not a second copy of the methodology — two long
// descriptions of the same call is the prompt paying twice for one tool.
it("keeps trading_request_entry as a short alias pointing at trading_execute", () => {
  const execute = TradingToolkit.tools[TRADING_EXECUTE_TOOL];
  const alias = TradingToolkit.tools[TRADING_REQUEST_ENTRY_TOOL];

  // Identical call, so identical parameters.
  expect(Tool.getJsonSchema(alias)).toEqual(Tool.getJsonSchema(execute));

  const aliasText = alias.description ?? "";
  expect(aliasText).toContain("DEPRECATED ALIAS");
  expect(aliasText).toContain("trading_execute");
  expect(aliasText.length).toBeLessThan((execute.description ?? "").length / 2);

  // The methodology lives on the new name, and the old name is not still
  // being quoted as the tool to reach for.
  const executeText = execute.description ?? "";
  expect(executeText).toContain("marketable_ioc");
  expect(executeText).toContain("no_conflicting_execution_pending");
  const publish = TradingToolkit.tools[TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL].description ?? "";
  expect(publish).not.toContain("trading_request_entry");
});

// The two learning reads: what the mission believed before, and whether any of
// it worked. Both are useless unless the description names the field that
// carries the answer.
it("points the calibration read at the verdict it exists to produce", () => {
  const calibration = TradingToolkit.tools[TRADING_GET_TARGET_CALIBRATION_TOOL].description ?? "";
  // The distinction the whole read turns on.
  expect(calibration).toContain("REACHED");
  expect(calibration).toContain("observedHitRatePercent");
  expect(calibration).toContain("claimedHitRatePercent");
  expect(calibration).toContain("recommendation");

  const mission = TradingToolkit.tools[TRADING_GET_MISSION_TOOL].description ?? "";
  expect(mission).toContain("strategyHistory");
});

// Re-levelling used to be cancel-then-register, with the side being re-levelled
// unwatched in between. The description has to name the parameter that closes
// that, and the case where it silently does not.
it("tells the harness how to move a level rather than add one", () => {
  const register = TradingToolkit.tools[TRADING_REGISTER_WATCH_TOOL].description ?? "";
  expect(register).toContain("replacesWatchId");
  expect(register).toContain("one transaction");
  // The failure mode: a stale id means an addition, not a swap.
  expect(register).toContain("ADDITION");
});

it("marks reading as safe and publishing as non-idempotent", () => {
  const annotations = (tool: Tool.Any) => ({
    readonly: Context.get(tool.annotations, Tool.Readonly),
    idempotent: Context.get(tool.annotations, Tool.Idempotent),
    destructive: Context.get(tool.annotations, Tool.Destructive),
    openWorld: Context.get(tool.annotations, Tool.OpenWorld),
  });

  expect(annotations(TradingToolkit.tools[TRADING_GET_MISSION_TOOL])).toEqual({
    readonly: true,
    idempotent: true,
    destructive: false,
    openWorld: false,
  });
  expect(annotations(TradingToolkit.tools[TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL])).toEqual({
    readonly: false,
    idempotent: false,
    destructive: false,
    openWorld: false,
  });
});
