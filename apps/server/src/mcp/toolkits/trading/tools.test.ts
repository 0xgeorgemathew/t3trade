import { expect, it } from "@effect/vitest";
import {
  TRADING_CANCEL_WATCH_TOOL,
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
      TRADING_GET_ORDER_BOOK_TOOL,
      TRADING_GET_ACCOUNT_STATE_TOOL,
      TRADING_GET_POSITION_TOOL,
      TRADING_GET_OPEN_ORDERS_TOOL,
      TRADING_REGISTER_WATCH_TOOL,
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
  // The cost floor, spelled out until a cost tool can compute it.
  expect(publish).toContain("5 bps per side");
  expect(publish).toContain("TWICE the round-trip cost");
  // The target is armed gross, so it has to clear the round trip on its own.
  expect(publish).toContain("GROSS");
  // One number can be armed; the other rungs live in the rationale.
  expect(publish).toContain("targetProfitRationale");

  // A target wake is a decision, not a close order.
  expect(publish).toContain("DECISION POINT");
  expect(publish).not.toContain("the default action is to close");

  const measure = TradingToolkit.tools[TRADING_MEASURE_VOLATILITY_TOOL].description ?? "";
  expect(measure).toContain("HIGHER timeframe");
  expect(measure).toContain("5 bps per side");
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
