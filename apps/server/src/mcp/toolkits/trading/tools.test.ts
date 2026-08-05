import { expect, it } from "@effect/vitest";
import {
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_ESTIMATE_COSTS_TOOL,
  TRADING_EXECUTE_TOOL,
  TRADING_GET_MARKET_STRUCTURE_TOOL,
  TRADING_GET_PLAYBOOK_TOOL,
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
  TRADING_PUBLISH_PLAN_TOOL,
  TRADING_REGISTER_WATCH_TOOL,
  TRADING_RESOLVE_MARKET_TOOL,
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
      TRADING_PUBLISH_PLAN_TOOL,
      TRADING_RESOLVE_MARKET_TOOL,
      TRADING_GET_MARKET_SNAPSHOT_TOOL,
      TRADING_GET_MARKET_HISTORY_TOOL,
      TRADING_MEASURE_VOLATILITY_TOOL,
      TRADING_ESTIMATE_COSTS_TOOL,
      TRADING_GET_MARKET_STRUCTURE_TOOL,
      TRADING_GET_TRADE_HISTORY_TOOL,
      TRADING_GET_TARGET_CALIBRATION_TOOL,
      TRADING_GET_ORDER_BOOK_TOOL,
      TRADING_GET_ACCOUNT_STATE_TOOL,
      TRADING_GET_POSITION_TOOL,
      TRADING_GET_OPEN_ORDERS_TOOL,
      TRADING_GET_PLAYBOOK_TOOL,
      TRADING_REGISTER_WATCH_TOOL,
      TRADING_EXECUTE_TOOL,
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

// The publish description states the publish contract (versioning, what a
// publish touches and does not, the checked basis), not the target-derivation
// methodology that now lives in the playbook. The doctrine prose used to live
// here; what remains is the contract the runtime actually enforces.
it("publish description states the publish contract, not the methodology", () => {
  const publish = TradingToolkit.tools[TRADING_PUBLISH_PLAN_TOOL].description ?? "";

  // Optimistic concurrency on expectedVersion.
  expect(publish).toContain("expectedVersion");
  // A publish supersedes the prior version's watches.
  expect(publish).toContain("supersede");
  // The basis is checked at publish, so the description must say what the check
  // actually is rather than only asking for the field.
  expect(publish).toContain("targetProfitBasis");
  expect(publish).toContain("(measuredMoveUsd / referencePrice) x positionNotionalUsd");
  // A target wake is a decision, not a close order.
  expect(publish).toContain("DECISION POINT");
  // The one allowed cross-reference: the target must clear its round-trip cost.
  expect(publish).toContain("trading_estimate_costs");
  // How the harness records that no viable target exists.
  expect(publish).toContain("insufficientVolatility");
  // The doctrine is gone — the two-timeframe measurement procedure is not.
  expect(publish).not.toContain("MEASURE TWO TIMEFRAMES");
});

// The volatility tool still carries its own methodology, which the publish
// description no longer duplicates.
it("keeps the measure-volatility description pointing at the round-trip cost", () => {
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
  const momentum = TradingToolkit.tools[TRADING_GET_MARKET_STRUCTURE_TOOL].description ?? "";
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
  expect(annotations(TradingToolkit.tools[TRADING_PUBLISH_PLAN_TOOL])).toEqual({
    readonly: false,
    idempotent: false,
    destructive: false,
    openWorld: false,
  });
});

// A description says what the tool returns and what each field means — not when
// to call it, what to conclude, or another tool's contract. Keep the whole
// toolkit on a budget so a verbose description cannot quietly creep back in:
// no single description over 1,300 chars, the total under 10,000, and the tool
// count pinned at 19 (T6 added the playbook read; this guards against a
// regression).
it("keeps every description on a budget", () => {
  const tools = Object.values(TradingToolkit.tools);

  expect(tools.length, "expected exactly 19 trading tools").toBe(19);

  const total = tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0);
  expect(total, "total description chars must stay under 10,000").toBeLessThan(10_000);

  for (const tool of tools) {
    const len = (tool.description ?? "").length;
    expect(len, `${tool.name} description is ${len} chars, must be <= 1,300`).toBeLessThanOrEqual(
      1_300,
    );
  }
});
