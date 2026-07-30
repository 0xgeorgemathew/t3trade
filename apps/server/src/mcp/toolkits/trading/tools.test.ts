import { expect, it } from "@effect/vitest";
import {
  TRADING_GET_MISSION_TOOL,
  TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL,
} from "@t3tools/trading-contracts/tools";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { TradingToolkit } from "./tools.ts";

it("exposes exactly the two §14.3 mission tools", () => {
  expect(
    Object.values(TradingToolkit.tools)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual([TRADING_GET_MISSION_TOOL, TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL].sort());
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
