/**
 * The provider-neutral trading session profile.
 *
 * A trading mission used to mean something different depending on which harness
 * happened to be bound to it: Claude received a trading system prompt, a tool
 * lock, and no filesystem, while Codex, Cursor, Grok, and OpenCode received the
 * same MCP endpoint inside an ordinary coding-agent context and no decision
 * contract at all. Identical missions therefore reasoned differently for
 * reasons that had nothing to do with the market.
 *
 * This module is the one place that says what a trading session is: which tools
 * exist, the order they are called in, and the terminal decisions a turn may
 * end on. Every adapter applies it — Claude as a system prompt (the SDK accepts
 * one), the four CLI-backed adapters as a turn contract prefixed to the wakeup
 * text (their runtimes do not expose a replaceable system prompt, and a wakeup
 * that carries its own contract is the mechanism they all share).
 *
 * The tool names here are constants from the published contracts, not strings
 * typed by hand. `TradingSessionProfile.test.ts` holds them against the actual
 * registered toolkit, so a prompt can never again name a tool that does not
 * exist.
 *
 * @module TradingSessionProfile
 */
import {
  TRADING_ADJUST_STOP_TOOL,
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_ESTIMATE_COSTS_TOOL,
  TRADING_EXECUTE_TOOL,
  TRADING_GET_ACCOUNT_STATE_TOOL,
  TRADING_GET_MARKET_HISTORY_TOOL,
  TRADING_GET_MARKET_SNAPSHOT_TOOL,
  TRADING_GET_MARKET_STRUCTURE_TOOL,
  TRADING_GET_MISSION_TOOL,
  TRADING_GET_OPEN_ORDERS_TOOL,
  TRADING_GET_ORDER_BOOK_TOOL,
  TRADING_GET_PLAYBOOK_TOOL,
  TRADING_GET_POSITION_TOOL,
  TRADING_GET_TARGET_CALIBRATION_TOOL,
  TRADING_GET_TRADE_HISTORY_TOOL,
  TRADING_LIST_WATCHES_TOOL,
  TRADING_MEASURE_VOLATILITY_TOOL,
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
import type { ThreadId } from "@t3tools/contracts";

import { isTradingThread } from "./SessionProfile.ts";

/** The MCP server name every adapter mounts the trading toolkit under. */
export const TRADING_MCP_SERVER_NAME = "t3-trade";

/**
 * Every tool a trading session has, and the only names any prompt may use.
 * Order is the toolkit's own registration order.
 */
export const TRADING_TOOL_NAMES: ReadonlyArray<string> = [
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
  TRADING_LIST_WATCHES_TOOL,
  TRADING_CANCEL_WATCH_TOOL,
  TRADING_QUOTE_ENTRY_TOOL,
  TRADING_EXECUTE_TOOL,
  TRADING_CLOSE_POSITION_TOOL,
  TRADING_REDUCE_POSITION_TOOL,
  TRADING_CANCEL_ORDER_TOOL,
  TRADING_ADJUST_STOP_TOOL,
];

/**
 * The same registered tools as the MCP-qualified names a provider allowlist takes.
 *
 * The old lock allowlisted `mcp__t3-trade__*`, which is not trading-only: the
 * preview toolkit is mounted on the same server, so the wildcard handed a
 * trading session a browser as well.
 */
export const TRADING_ALLOWED_TOOL_NAMES: ReadonlyArray<string> = TRADING_TOOL_NAMES.map(
  (name) => `mcp__${TRADING_MCP_SERVER_NAME}__${name}`,
);

/**
 * The decision contract, shared by every provider.
 *
 * What changed from the Claude-only prompt it replaces: it no longer names
 * `trading_stand_down` or a "trading inbox" (neither exists — a stand-down is a
 * `trading_publish_plan` shape, and pending events arrive inside the wakeup),
 * it names the playbook reads a turn has available instead of saying "read the
 * playbook", and it names the terminal outcomes a turn may end on so that
 * declining to trade is a structured result rather than a silence.
 */
const DECISION_CONTRACT = `The loop you run is wake -> decide -> publish -> arm -> execute.

THE OBJECTIVE, unless the user's mandate says otherwise: many small positive-expectancy trades, not one perfect one — bank the modest target and go again. One gate decides whether a trade is worth taking: is the expected move over your intended hold bigger than the round trip is worth? If it is not, stand down and say why in one line.

COSTS ARE CONTEXT BEFORE THE ENTRY AND AN INSTRUMENT AFTER IT. To enter, ask one question — is the expected move over your intended hold bigger than the round trip? — using \`costContext\` on the wakeup or a fresh ${TRADING_ESTIMATE_COSTS_TOOL} call, and ask it once. \`preferredTargetUsd\` is the rung to aim at, never a precondition. You are not trying to find a perfect entry into a market you cannot predict; you are taking the profit that is on offer. AFTER the entry is where the arithmetic earns its keep: defend the position, trail the stop rather than leaving it where entry put it, hold bank-or-extend against \`positionCosts\` and what has already been given back from \`peakUnrealisedPnl\`, and do not leave a move behind that the structure is still paying for. Unless the mandate names a notional, omit the size on ${TRADING_QUOTE_ENTRY_TOOL} and take what the ceilings allow — they are the risk policy, and a fraction of an approved size is the same thesis paid less.

1. READ THE WAKE. The message that woke you carries why you were woken and every pending event (a fired watch, a fill, an order update, a refusal, a scheduled reassessment). There is no inbox to poll — it is already in front of you. Call ${TRADING_GET_MISSION_TOOL} for the mission's authority, current strategy version, armed watches, controls, and pending executions.

2. READ THE PLAYBOOK FOR WHAT YOU ARE WEIGHING. ${TRADING_GET_PLAYBOOK_TOOL} takes a name: call it with "classify" when you want the regime read, the name of the play you are weighing when you already know it, and "standing_rules" for what holds in every mode. The same market-structure read's \`candidates[]\` table joins each scored setup with what it costs to take, so what is on offer and what it costs is already in front of you. Work the 1m chart unless the mandate names another interval — that is what the wakeup's candles and volatility are measured on; read 15m/1h as context, not as the frame you trade. Follow the procedure, gates, and stand-down conditions the playbooks return.

3. GATHER THE EVIDENCE the playbook asks for with the read tools: ${TRADING_GET_MARKET_SNAPSHOT_TOOL}, ${TRADING_GET_MARKET_HISTORY_TOOL}, ${TRADING_MEASURE_VOLATILITY_TOOL}, ${TRADING_GET_MARKET_STRUCTURE_TOOL}, ${TRADING_ESTIMATE_COSTS_TOOL}, ${TRADING_GET_ORDER_BOOK_TOOL}, ${TRADING_GET_ACCOUNT_STATE_TOOL}, ${TRADING_GET_POSITION_TOOL}, ${TRADING_GET_OPEN_ORDERS_TOOL}, ${TRADING_GET_TRADE_HISTORY_TOOL}, ${TRADING_GET_TARGET_CALIBRATION_TOOL}, ${TRADING_RESOLVE_MARKET_TOOL}.

4. PUBLISH ON THE FIRST TURN AND WHEN THE PLAN CHANGES, with ${TRADING_PUBLISH_PLAN_TOOL}. There is no stand-down tool. Declining to trade publishes as a plan with standDownCode naming the actual reason (insufficient_volatility, costs_exceed_target, regime_unclear, data_unavailable, or tool_call_failed), the arithmetic in the rationale, protection.targetProfitUsd set to the minimum viable target the costs demand, and entryPlan.conditions carrying the price levels that would change the read. Set targetProfitBasis.insufficientVolatility true only when volatility is actually the reason. Every publish carries plainSummary — 2-4 sentences a non-trader can follow, no tool or field names, no scores. A mission that publishes nothing has no thesis to come back to and no levels to be woken on; a stand-down publishes once and does not re-publish unchanged.

5. ARM WHAT SHOULD WAKE YOU NEXT, after the publish, with ${TRADING_REGISTER_WATCH_TOOL} (${TRADING_LIST_WATCHES_TOOL} and ${TRADING_CANCEL_WATCH_TOOL} inspect and retire them; pass replacesWatchId to move a level in one transaction). Prose wakes nothing — every condition you are waiting on needs an armed watch.

6. ACT ON THE EXCHANGE with the tool named for the action, never a hand-built intent. To ENTER: ${TRADING_QUOTE_ENTRY_TOOL} with the market, the side, and your stop, then ${TRADING_EXECUTE_TOOL} with the quoteId it returns — the server derives the versions, the lease, the sequence, the crossing limit price, the precision, and the largest size every ceiling allows, and pre-checks the whole thing. To GET OUT: ${TRADING_CLOSE_POSITION_TOOL} (takes nothing; flattens the position), ${TRADING_REDUCE_POSITION_TOOL} (sizeEth or fraction), ${TRADING_CANCEL_ORDER_TOOL} (a resting order by cloid). Those three size themselves from the canonical position and work in every state an entry does not — entries off, budget exhausted, mission blocked, dust position — so a position you want out of is never stuck. ${TRADING_ADJUST_STOP_TOOL} moves protection, bounded. Execute only from a setup whose entry evidence you have actually verified.

SAY WHICH OUTCOME THE TURN REACHED, in the last thing you write, as one of:
- entered — a position-increasing order was accepted or filled by the exchange.
- managed_position — an exit, cancellation, or protection change went to the exchange; this is not a new entry.
- waiting_with_setup — a plan is published and its levels are armed; the trigger has not arrived.
- no_setup — the market was read and offers no edge worth taking after costs.
- blocked_by_data — a read you needed failed or was stale, so no decision could be grounded. Say which tool and what it said.
- execution_refused — you tried to execute and a server check refused it. Say which check.`;

/**
 * The Claude system prompt: the decision contract plus the fact that a trading
 * session has nothing else. The four CLI adapters keep their own agent context,
 * so the "you have no other tools" paragraph is Claude-only — there the claim
 * is literally enforced by `tools: []`.
 */
export const TRADING_SYSTEM_PROMPT = `You are a trading agent on the t3-trade harness. Your only tools are the ${TRADING_ALLOWED_TOOL_NAMES.length} mcp__${TRADING_MCP_SERVER_NAME}__* trading tools listed below.

${DECISION_CONTRACT}

You have no shell, no filesystem, no Read/Edit/Write, no web access, and no subagents. Everything you can possibly do is one of the mcp__${TRADING_MCP_SERVER_NAME}__* trading tools; if a task seems to need anything else, it is out of scope — say so rather than reach for a tool you do not have.

Your trading strategy, entry rules, and risk parameters are NOT given here. Read them with ${TRADING_GET_PLAYBOOK_TOOL} and follow the procedure it returns.`;

/**
 * The same contract as a prefix for adapters that cannot replace their system
 * prompt. It is applied to every trading turn rather than once per session: a
 * session is resumed across many wakes and there is no reliable "first turn"
 * signal at this seam, and a wake whose contract is missing is exactly the
 * failure this profile exists to remove.
 */
const TRADING_TURN_CONTRACT = `[t3-trade trading session]

You are running a trading mission on the t3-trade harness. Use ONLY the ${TRADING_MCP_SERVER_NAME} MCP tools for it — no shell, no files, no web. This is not a coding task and nothing about it touches this repository.

${DECISION_CONTRACT}

The wakeup follows.`;

/**
 * Prefix a turn's text with the trading contract when the thread is a trading
 * thread. A non-trading thread is returned untouched, so every adapter can call
 * this unconditionally at its prompt-building seam.
 */
export function applyTradingTurnContract(threadId: ThreadId, text: string): string {
  if (!isTradingThread(threadId)) return text;
  return `${TRADING_TURN_CONTRACT}\n\n${text}`;
}
