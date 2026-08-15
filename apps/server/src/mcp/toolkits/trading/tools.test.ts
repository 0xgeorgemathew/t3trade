import { expect, it } from "@effect/vitest";
import {
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_ADJUST_STOP_TOOL,
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
import { TRADING_QUOTE_ENTRY_TOOL } from "@t3tools/trading-contracts/quote";
import {
  TRADING_CANCEL_ORDER_TOOL,
  TRADING_CLOSE_POSITION_TOOL,
  TRADING_REDUCE_POSITION_TOOL,
} from "@t3tools/trading-contracts/exit";
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
      TRADING_QUOTE_ENTRY_TOOL,
      TRADING_EXECUTE_TOOL,
      TRADING_CLOSE_POSITION_TOOL,
      TRADING_REDUCE_POSITION_TOOL,
      TRADING_CANCEL_ORDER_TOOL,
      TRADING_LIST_WATCHES_TOOL,
      TRADING_CANCEL_WATCH_TOOL,
      TRADING_ADJUST_STOP_TOOL,
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

it("advertises only the server-owned quote form for execution", () => {
  const schema = Tool.getJsonSchema(TradingToolkit.tools[TRADING_EXECUTE_TOOL]) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["missionId", "quoteId"]);
  expect(schema.required).toContain("quoteId");
});

// The publish description states the publish contract (versioning, what a
// publish touches and does not, the checked target), not the target-derivation
// methodology or doctrine — those live in the playbook.
it("publish description states the publish contract, not the methodology", () => {
  const publish = TradingToolkit.tools[TRADING_PUBLISH_PLAN_TOOL].description ?? "";

  // Optimistic concurrency on expectedVersion.
  expect(publish).toContain("expectedVersion");
  // A publish supersedes the prior version's watches.
  expect(publish).toContain("supersede");
  // The basis is checked at publish, against the round-trip cost.
  expect(publish).toContain("targetProfitBasis");
  expect(publish).toContain("round-trip cost");
  // But never the resting orders — that division of labor is the contract.
  expect(publish).toContain("resting orders");
  // How the harness records that no viable target exists.
  expect(publish).toContain("standDownCode");
  // The doctrine is gone.
  expect(publish).not.toContain("MEASURE TWO TIMEFRAMES");
});

// The volatility tool carries its own measurement contract; the caveat that
// matters is that every figure is gross of costs.
it("keeps the measure-volatility description honest about costs and data", () => {
  const measure = TradingToolkit.tools[TRADING_MEASURE_VOLATILITY_TOOL].description ?? "";
  expect(measure).toContain("horizons[]");
  expect(measure).toContain("gross of costs");
  expect(measure).toContain("sufficientData");
});

// The cost tool is context, not a gate (plan 29 step 3.1): the description
// names the total it exists to produce and the honesty flag, and no floor.
it("points the cost tool at the total it exists to compute", () => {
  const costs = TradingToolkit.tools[TRADING_ESTIMATE_COSTS_TOOL].description ?? "";
  expect(costs).toContain("roundTripUsd");
  expect(costs).toContain("degraded");
  expect(costs).toContain("never a gate");
  expect(costs).not.toContain("minimumViableTargetUsd");
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
  // The close-versus-wick distinction every breakout rule turns on.
  expect(momentum).toContain("wickOnly");
  expect(momentum).toContain("candidates");

  const history = TradingToolkit.tools[TRADING_GET_TRADE_HISTORY_TOOL].description ?? "";
  // Fills arrive as partials; the harness reads orders and flat-to-flat pairs.
  expect(history).toContain("aggregate into orders");
  expect(history).toContain("roundTrips");
  // Each order scored against the target it was actually published under.
  expect(history).toContain("targetProfitUsd");
});

// The two learning reads: what the mission believed before, and whether any of
// it worked. Both are useless unless the description names the field that
// carries the answer.
it("points the calibration read at the verdict it exists to produce", () => {
  const calibration = TradingToolkit.tools[TRADING_GET_TARGET_CALIBRATION_TOOL].description ?? "";
  // The distinction the whole read turns on: touched, not banked.
  expect(calibration).toContain("touched");
  expect(calibration).toContain("observedHitRatePercent");
  expect(calibration).toContain("claimedHitRatePercent");
  expect(calibration).toContain("recommendation");

  const mission = TradingToolkit.tools[TRADING_GET_MISSION_TOOL].description ?? "";
  // Authority numbers are ceilings, and an ended mission is reported, not
  // hidden.
  expect(mission).toContain("ceilings");
  expect(mission).toContain("lastMission");
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

// The bounded stop tool is only safe because a refusal costs nothing and the
// harness can read which bound it hit. The numbers behind each bound live in
// the server, not the description — what must survive is the bounds
// themselves and the free retry.
it("names the bounds trading_adjust_stop actually enforces", () => {
  const adjust = TradingToolkit.tools[TRADING_ADJUST_STOP_TOOL].description ?? "";
  // The risk line: no move past what entry approval signed off on.
  expect(adjust).toContain("approved stop");
  // And the other named bounds.
  expect(adjust).toContain("noise floor");
  expect(adjust).toContain("never back below entry");
  expect(adjust).toContain("rate-limited");
  // A refusal costs nothing, which is what makes trying one safe.
  expect(adjust).toContain("A refusal leaves the resting stop untouched");
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

// A description says what the tool returns and the non-obvious behaviors —
// not rejection-code enumerations, cross-tool walkthroughs, formatting
// instructions, arithmetic, or parameters the schema already defines. Those
// belong to the runtime and the schemas, and restating them here just burns
// context on every turn.
//
// Plan 29 Step 1.3 cut the toolkit from ~15,000 to under 6,000 description
// chars on that rule; the budgets below keep it there. The per-tool cap sits
// above the measured maximum so small edits do not trip it, but any new
// enumeration will.
it("keeps every description on a budget", () => {
  const tools = Object.values(TradingToolkit.tools);

  expect(tools.length, "expected exactly 24 trading tools").toBe(24);

  const total = tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0);
  expect(total, "total description chars must stay under 6,000").toBeLessThan(6_000);

  for (const tool of tools) {
    const len = (tool.description ?? "").length;
    // Measured max at the plan-29 shrink: 350 chars
    // (trading_get_market_structure). 400 leaves edit headroom, not room for
    // a new field glossary.
    expect(len, `${tool.name} description is ${len} chars, must be <= 400`).toBeLessThanOrEqual(
      400,
    );
  }
});

// Plan 29 Step 2.3: the harness speaks urgency, never a time-in-force. The
// write tools' descriptions are where it learns that vocabulary, so they name
// `urgency` and none of them names the execution-layer words the server owns.
it("teaches urgency and keeps time-in-force vocabulary out of the descriptions", () => {
  for (const tool of Object.values(TradingToolkit.tools)) {
    expect(tool.description ?? "", tool.name).not.toContain("IOC");
    expect(tool.description ?? "", tool.name).not.toContain("time-in-force");
  }

  const quote = TradingToolkit.tools[TRADING_QUOTE_ENTRY_TOOL].description ?? "";
  expect(quote).toContain("urgency");
  expect(quote).toContain("patient");
  const close = TradingToolkit.tools[TRADING_CLOSE_POSITION_TOOL].description ?? "";
  expect(close).toContain("urgency");
  const reduce = TradingToolkit.tools[TRADING_REDUCE_POSITION_TOOL].description ?? "";
  expect(reduce).toContain("urgency");
});
