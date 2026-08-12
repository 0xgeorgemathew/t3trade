// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { readFile } from "node:fs/promises";

import { TradingToolkit } from "../mcp/toolkits/trading/tools.ts";
import { clearAllSessionProfiles, setSessionProfile } from "./SessionProfile.ts";
import {
  applyTradingTurnContract,
  TRADING_ALLOWED_TOOL_NAMES,
  TRADING_SYSTEM_PROMPT,
  TRADING_TOOL_NAMES,
} from "./TradingSessionProfile.ts";

const registeredToolNames = Object.values(TradingToolkit.tools).map((tool) => tool.name);

it("names exactly the tools the toolkit registers", () => {
  expect([...TRADING_TOOL_NAMES].sort()).toEqual([...registeredToolNames].sort());
});

it("allowlists the trading tools by name rather than the whole MCP server", () => {
  expect(TRADING_ALLOWED_TOOL_NAMES).toHaveLength(registeredToolNames.length);
  expect(TRADING_ALLOWED_TOOL_NAMES.every((name) => name.startsWith("mcp__t3-trade__"))).toBe(true);
  expect(TRADING_ALLOWED_TOOL_NAMES).not.toContain("mcp__t3-trade__*");
});

it("mentions only registered tool names in the system prompt", () => {
  // Every `trading_*` token the prompt uses must be a tool that exists. The
  // prompt this replaced directed the harness to `trading_stand_down` and a
  // "trading inbox", neither of which was ever registered.
  const mentioned = new Set(TRADING_SYSTEM_PROMPT.match(/trading_[a-z_]+/g) ?? []);
  expect(mentioned.size).toBeGreaterThan(0);
  for (const name of mentioned) {
    expect(registeredToolNames).toContain(name);
  }
});

it("enumerates the playbook call order and the terminal decision outcomes", () => {
  expect(TRADING_SYSTEM_PROMPT).toContain('"classify"');
  expect(TRADING_SYSTEM_PROMPT).toContain('"standing_rules"');
  for (const outcome of [
    "entered",
    "managed_position",
    "waiting_with_setup",
    "no_setup",
    "blocked_by_data",
    "execution_refused",
  ]) {
    expect(TRADING_SYSTEM_PROMPT).toContain(outcome);
  }
});

it("has every provider adapter apply the profile", async () => {
  // The variance this guards against is not a behaviour one adapter got wrong;
  // it is an adapter that never opted in at all. Claude applies the profile as
  // a system prompt plus an explicit allowlist; the four CLI-backed adapters
  // apply it as a turn contract, because their runtimes expose no replaceable
  // system prompt at the seam a turn is built.
  const read = async (file: string) =>
    await readFile(new URL(`./Layers/${file}`, import.meta.url), "utf8");

  const claude = await read("ClaudeAdapter.ts");
  expect(claude).toContain("TRADING_SYSTEM_PROMPT");
  expect(claude).toContain("TRADING_ALLOWED_TOOL_NAMES");

  for (const adapter of [
    "CodexAdapter.ts",
    "CursorAdapter.ts",
    "GrokAdapter.ts",
    "OpenCodeAdapter.ts",
  ]) {
    expect(await read(adapter), adapter).toContain("applyTradingTurnContract(input.threadId");
  }
});

it("prefixes the same contract onto a trading thread's turn, and leaves other threads alone", () => {
  clearAllSessionProfiles();
  const tradingThread = ThreadId.make("thread-trading");
  const codingThread = ThreadId.make("thread-coding");
  setSessionProfile({ threadId: tradingThread, kind: "trading" });

  const wakeup = '{"kind":"trading-harness-wakeup"}';
  const prefixed = applyTradingTurnContract(tradingThread, wakeup);
  expect(prefixed.endsWith(wakeup)).toBe(true);
  expect(prefixed).toContain("trading_publish_plan");
  expect(prefixed).toContain("blocked_by_data");
  expect(applyTradingTurnContract(codingThread, wakeup)).toBe(wakeup);

  clearAllSessionProfiles();
});
