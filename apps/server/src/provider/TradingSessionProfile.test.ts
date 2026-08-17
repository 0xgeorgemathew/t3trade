// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";

import { TradingToolkit } from "../mcp/toolkits/trading/tools.ts";
import { clearAllSessionProfiles, setSessionProfile } from "./SessionProfile.ts";
import {
  applyTradingTurnContract,
  resetTradingContractDelivery,
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
    await NodeFSP.readFile(new URL(`./Layers/${file}`, import.meta.url), "utf8");

  const claude = await read("ClaudeAdapter.ts");
  expect(claude).toContain("TRADING_SYSTEM_PROMPT");
  expect(claude).toContain("TRADING_ALLOWED_TOOL_NAMES");

  for (const adapter of [
    "CodexAdapter.ts",
    "CursorAdapter.ts",
    "GrokAdapter.ts",
    "OpenCodeAdapter.ts",
  ]) {
    const source = await read(adapter);
    expect(source, adapter).toContain("applyTradingTurnContract(input.threadId");
    // Both halves of the once-per-session delivery, or the adapter either
    // repeats the contract forever or drops it after a failed turn.
    expect(source, adapter).toContain("resetTradingContractDelivery(input.threadId)");
    expect(source, adapter).toContain("markDelivered()");
  }
});

it("prefixes the contract onto a trading thread's turn, and leaves other threads alone", () => {
  clearAllSessionProfiles();
  const tradingThread = ThreadId.make("thread-trading");
  const codingThread = ThreadId.make("thread-coding");
  setSessionProfile({ threadId: tradingThread, kind: "trading" });
  resetTradingContractDelivery(tradingThread);

  const wakeup = '{"kind":"trading-harness-wakeup"}';
  const prefixed = applyTradingTurnContract(tradingThread, wakeup);
  expect(prefixed.text.endsWith(wakeup)).toBe(true);
  expect(prefixed.text).toContain("trading_plan");
  expect(prefixed.text).toContain("blocked_by_data");
  expect(applyTradingTurnContract(codingThread, wakeup).text).toBe(wakeup);

  clearAllSessionProfiles();
});

// The contract is 9.5k chars and does not change. On the 206-wake thread the
// token audit measured, prefixing it to every turn was 1.9M characters of
// identical text the model paid to read again on each one.
it("sends the contract once per session instance, and only once it has arrived", () => {
  clearAllSessionProfiles();
  const tradingThread = ThreadId.make("thread-trading-once");
  setSessionProfile({ threadId: tradingThread, kind: "trading" });
  resetTradingContractDelivery(tradingThread);

  const wakeup = '{"kind":"trading-harness-wakeup"}';

  // A turn that never dispatched must not swallow the contract.
  expect(applyTradingTurnContract(tradingThread, wakeup).text).toContain("blocked_by_data");

  const first = applyTradingTurnContract(tradingThread, wakeup);
  expect(first.text).toContain("blocked_by_data");
  first.markDelivered();

  const second = applyTradingTurnContract(tradingThread, wakeup);
  expect(second.text).not.toContain("blocked_by_data");
  expect(second.text).toContain("t3-trade trading session");
  expect(second.text.endsWith(wakeup)).toBe(true);
  expect(second.text.length).toBeLessThan(first.text.length / 10);

  // A new session instance starts the thread over.
  resetTradingContractDelivery(tradingThread);
  expect(applyTradingTurnContract(tradingThread, wakeup).text).toContain("blocked_by_data");

  clearAllSessionProfiles();
});
