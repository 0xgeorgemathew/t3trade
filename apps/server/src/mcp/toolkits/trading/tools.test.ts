import { expect, it } from "@effect/vitest";
import {
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_ADJUST_STOP_TOOL,
  TRADING_GET_PLAYBOOK_TOOL,
  TRADING_GET_TARGET_CALIBRATION_TOOL,
  TRADING_LIST_WATCHES_TOOL,
  TRADING_PUBLISH_PLAN_TOOL,
  TRADING_WATCH_TOOL,
} from "@t3tools/trading-contracts/tools";
import { TRADING_LOOK_TOOL } from "@t3tools/trading-contracts/observation";
import { TRADING_ENTER_TOOL } from "@t3tools/trading-contracts/entry";
import { TRADING_JOURNAL_TOOL } from "@t3tools/trading-contracts/journal";
import {
  TRADING_CANCEL_ORDER_TOOL,
  TRADING_CLOSE_POSITION_TOOL,
  TRADING_REDUCE_POSITION_TOOL,
} from "@t3tools/trading-contracts/exit";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { TradingToolkit } from "./tools.ts";

it("exposes one read, the mission tools, and the watch tools", () => {
  expect(
    Object.values(TradingToolkit.tools)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(
    [
      TRADING_LOOK_TOOL,
      TRADING_PUBLISH_PLAN_TOOL,
      TRADING_GET_TARGET_CALIBRATION_TOOL,
      TRADING_GET_PLAYBOOK_TOOL,
      TRADING_WATCH_TOOL,
      TRADING_JOURNAL_TOOL,
      TRADING_ENTER_TOOL,
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

// Plan 29 step 6.2: entering is one call, and its input is only what the
// harness can actually see. Nothing about the order's identity — no sequence,
// no versions, no lease, no limit price, and no token to hand back — is
// advertised, because a field a harness can fill in is a field it can fill in
// wrongly.
it("advertises only what the harness can see, and asks for the stop", () => {
  const schema = Tool.getJsonSchema(TradingToolkit.tools[TRADING_ENTER_TOOL]) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
    "actionType",
    "market",
    "missionId",
    "notionalUsd",
    "side",
    "sizeEth",
    "stopPrice",
    "urgency",
  ]);
  // The mandatory stop is a required field, not a hope.
  expect(schema.required).toContain("stopPrice");
  expect(schema.required).toContain("side");
  for (const owned of ["quoteId", "executionSequence", "limitPrice", "activeHarnessRunId"]) {
    expect(schema.properties?.[owned], `${owned} is the server's`).toBeUndefined();
  }
});

// The publish description states the publish contract (optimistic
// concurrency, what a publish touches and does not, where the target comes
// from), not the doctrine — those live in the playbook.
it("publish description states the publish contract, not the methodology", () => {
  const publish = TradingToolkit.tools[TRADING_PUBLISH_PLAN_TOOL].description ?? "";

  // Optimistic concurrency on the mission row's version.
  expect(publish).toContain("expectedMissionVersion");
  // A publish revises the plan in place; watches survive it (plan 29 step 4.2).
  expect(publish).toContain("watches survive");
  // The target is derived off measured volatility; nothing grades it (plan 29
  // step 3.2 took the basis ceremony out).
  expect(publish).toContain("measured volatility");
  expect(publish).not.toContain("targetProfitBasis");
  // How the harness records that no viable target exists: the explicit
  // no-position intent (plan 29 step 4.1).
  expect(publish).toContain("stand_aside");
  // The doctrine is gone.
  expect(publish).not.toContain("MEASURE TWO TIMEFRAMES");
});

// Twelve read tools became one (plan 29 step 6.1), so one description now
// carries what twelve carried. What it must still say is which fields answer
// the questions those tools existed for — and that the cost line is context.
it("points the one read at the fields that carry the answers", () => {
  const look = TradingToolkit.tools[TRADING_LOOK_TOOL].description ?? "";
  // The multi-timeframe read and its scored setups.
  expect(look).toContain("structure");
  expect(look).toContain("candidates");
  // Flat is a state, not an absence — the distinction a merged read can blur.
  expect(look).toContain("flat is size 0");
  // Cost survived the un-gating as context only (plan 29 step 3.1).
  expect(look).toContain("never a gate");
  expect(look).not.toContain("minimumViableTargetUsd");
  // An ended mission is reported, not hidden.
  expect(look).toContain("lastMission");
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
});

// Re-levelling used to be cancel-then-register, with the side being re-levelled
// unwatched in between. The description has to name the parameter that closes
// that, and the case where it silently does not.
it("tells the harness how to move a level rather than add one", () => {
  const watch = TradingToolkit.tools[TRADING_WATCH_TOOL].description ?? "";
  expect(watch).toContain("replacesWatchId");
  expect(watch).toContain("one transaction");
  // The failure mode: a stale id means an addition, not a swap.
  expect(watch).toContain("ADDITION");
});

// Plan 29 step 6.3: one condition union replaced the eight sibling predicates,
// so the description has to name the five kinds and the one thing the server
// will not guess on the model's behalf.
it("names the five conditions and the interval it refuses to guess", () => {
  const watch = TradingToolkit.tools[TRADING_WATCH_TOOL].description ?? "";
  for (const kind of ["`price`", "`pnl`", "`giveback`", "`fill`", "`time`"]) {
    expect(watch, kind).toContain(kind);
  }
  expect(watch).toContain("interval");
  // A refusal is an outcome the harness can act on, not a dead end.
  expect(watch).toContain("recovery");
  // The eight-way type choice is gone from the vocabulary the model reads.
  for (const retired of ["price_cross", "candle_close", "pnl_above", "position_update"]) {
    expect(watch, retired).not.toContain(retired);
  }
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

  expect(annotations(TradingToolkit.tools[TRADING_LOOK_TOOL])).toEqual({
    readonly: true,
    idempotent: true,
    destructive: false,
    openWorld: true,
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

  expect(tools.length, "expected exactly 13 trading tools").toBe(13);

  const total = tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0);
  expect(total, "total description chars must stay under 4,000").toBeLessThan(4_000);

  for (const tool of tools) {
    const len = (tool.description ?? "").length;
    // `trading_look` answers what twelve tools used to, so it carries the
    // longest description in the set. 500 leaves edit headroom, not room for
    // a new field glossary.
    expect(len, `${tool.name} description is ${len} chars, must be <= 500`).toBeLessThanOrEqual(
      500,
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

  const enter = TradingToolkit.tools[TRADING_ENTER_TOOL].description ?? "";
  expect(enter).toContain("urgency");
  expect(enter).toContain("patient");
  const close = TradingToolkit.tools[TRADING_CLOSE_POSITION_TOOL].description ?? "";
  expect(close).toContain("urgency");
  const reduce = TradingToolkit.tools[TRADING_REDUCE_POSITION_TOOL].description ?? "";
  expect(reduce).toContain("urgency");
});
