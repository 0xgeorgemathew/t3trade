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

// The bounded stop tool is only safe because the harness can read WHY a move
// was refused and correct it. A description that names the tool without naming
// the rules leaves it guessing, and a guessing agent retries the same refusal.
it("names the bounds trading_adjust_stop actually enforces", () => {
  const adjust = TradingToolkit.tools[TRADING_ADJUST_STOP_TOOL].description ?? "";
  // Where it sits relative to the unbounded primitive.
  expect(adjust).toContain("trading_execute");
  // The five policy rules, in the codes the result reports them under.
  expect(adjust).toContain("risk_envelope");
  expect(adjust).toContain("step_too_large");
  expect(adjust).toContain("atr_mismatch");
  expect(adjust).toContain("noise_floor");
  expect(adjust).toContain("breakeven_ratchet");
  expect(adjust).toContain("adjustment_budget");
  // A refusal costs nothing, which is what makes trying one safe.
  expect(adjust).toContain("Refused leaves the resting stop untouched");
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
// no single description over 1,300 chars, the total under 11,400, and the tool
// count pinned at 20.
//
// The total was 10,000 while there were 19 tools. Plan 24's
// `trading_adjust_stop` is the 20th, and it pays for itself: the eight refusal
// codes it enumerates are the tool's actual contract, and an agent that cannot
// read them tries the same refused move again. The per-tool cap is unchanged —
// that is the rule that actually stops verbosity; the total only tracks how
// many tools there are.
//
// Plan 25 bought the last 200: `trading_publish_plan` now states that a
// declined entry still publishes (a turn that stood down silently left the
// mission with no thesis and no watches, so nothing woke it again), and
// `trading_estimate_costs` asks for rates to be quoted with their units — an
// operator read "4.5" as $4.50 and there was nothing in the tool to prevent it.
// Steps 3 and 4 of the viability plan bought the next 1,800. `trading_quote_entry`
// is the 21st tool, and it exists because the eight fields it derives were eight
// ways for a correct read of the market to die on the way to an order — its own
// description pays part of itself back by shortening `trading_execute`'s entry
// half. `trading_get_market_structure` gained the setup evidence that used to be
// prose in the playbooks: the touch counts, the range stability, and the
// close-versus-wick distinction every breakout rule already turned on.
//
// Step 5 adds the last three: `trading_close_position`, `trading_reduce_position`
// and `trading_cancel_order`. They are cheap to describe precisely because there
// is nothing to describe — a close takes no arguments at all — and what their
// descriptions do buy is the sentence a harness most needs, which is that an
// exit works in every state an entry does not.
it("keeps every description on a budget", () => {
  const tools = Object.values(TradingToolkit.tools);

  expect(tools.length, "expected exactly 24 trading tools").toBe(24);

  const total = tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0);
  expect(total, "total description chars must stay under 15,000").toBeLessThan(15_000);

  for (const tool of tools) {
    const len = (tool.description ?? "").length;
    expect(len, `${tool.name} description is ${len} chars, must be <= 1,300`).toBeLessThanOrEqual(
      1_300,
    );
  }
});
