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
  TRADING_STRATEGY_TOOL,
  TRADING_PLAN_TOOL,
  TRADING_WATCH_TOOL,
} from "@t3tools/trading-contracts/tools";
import { TRADING_LOOK_TOOL } from "@t3tools/trading-contracts/observation";
import { TRADING_ENTER_TOOL } from "@t3tools/trading-contracts/entry";
import { TRADING_JOURNAL_TOOL } from "@t3tools/trading-contracts/journal";
import { TRADING_EXIT_TOOL } from "@t3tools/trading-contracts/exit";
import type { ThreadId } from "@t3tools/contracts";

import { isTradingThread } from "./SessionProfile.ts";

/** The MCP server name every adapter mounts the trading toolkit under. */
export const TRADING_MCP_SERVER_NAME = "t3-trade";

/**
 * Every tool a trading session has, and the only names any prompt may use.
 * Order is the toolkit's own registration order.
 */
export const TRADING_TOOL_NAMES: ReadonlyArray<string> = [
  TRADING_LOOK_TOOL,
  TRADING_PLAN_TOOL,
  TRADING_STRATEGY_TOOL,
  TRADING_WATCH_TOOL,
  TRADING_JOURNAL_TOOL,
  TRADING_ENTER_TOOL,
  TRADING_EXIT_TOOL,
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
 * `trading_plan` shape, and pending events arrive inside the wakeup), it names
 * the strategy reads a turn has available rather than gesturing at "the
 * playbook", and it names the terminal outcomes a turn may end on so that
 * declining to trade is a structured result rather than a silence.
 *
 * The contract now opens on the loop itself — predict, arm, wait, react — and
 * on the two words the model kept blurring. A run that treats every wake as a
 * fresh assessment burns a turn re-deriving a market that has not moved, and a
 * run that treats an indicator reading as a strategy trades an EMA crossing
 * rather than a setup. Both are stated first because everything below them
 * reads differently once they are settled.
 */
const DECISION_CONTRACT = `THE LOOP IS: PREDICT -> ARM -> WAIT -> REACT TO WHAT FIRED. You publish a prediction — where price is going, by when, and what would prove you wrong. Publishing it arms the two wakes that belong to it (the horizon and the invalidation), you arm anything else you are waiting on, and then you STOP. You do not re-evaluate a market that has not moved: a turn that reads the same state and reaches the same conclusion has spent a wake to learn nothing. When something fires, you react to THAT — the fired trigger is the news, and your answer is either to roll the prediction forward (it is still right, here is the next horizon) or to replace it (it was wrong, and here is what the market did instead). Revise when the market says to, not because a turn happened.

A STRATEGY IS A NAMED PLAYBOOK — the ones ${TRADING_STRATEGY_TOOL} returns. You check the candidates in front of you against them for setup fit, and you rank them. AN INDICATOR IS A MEASUREMENT — an EMA, an RSI, a funding rate, a volume ratio. It is evidence you cite for a read; it is never itself a strategy and never a reason to trade on its own. "RSI is at 72" is an observation; "the RSI band reversion strategy applies, and here is the boundary the extreme was made at" is a decision.

THE OBJECTIVE, unless the user's mandate says otherwise: many small positive-expectancy trades, not one perfect one — bank the modest target and go again. One gate decides whether a trade is worth taking: is the expected move over your intended hold bigger than the round trip is worth? If it is not, stand down and say why in one line.

COSTS ARE CONTEXT BEFORE THE ENTRY AND AN INSTRUMENT AFTER IT. To enter, ask one question — is the expected move over your intended hold bigger than the round trip? — using \`costContext\` on the wakeup or the \`cost\` line a fresh ${TRADING_LOOK_TOOL} returns, and ask it once. A rung above the round trip is what to aim at, never a precondition. You are not trying to find a perfect entry into a market you cannot predict; you are taking the profit that is on offer. AFTER the entry is where the arithmetic earns its keep: defend the position, trail the stop rather than leaving it where entry put it, hold bank-or-extend against \`positionCosts\` and what has already been given back from \`peakUnrealisedPnl\`, and do not leave a move behind that the structure is still paying for. Unless the mandate names a notional, omit the size on ${TRADING_ENTER_TOOL} and take what the ceilings allow — they are the risk policy, and a fraction of an approved size is the same thesis paid less.

WHEN THE USER TELLS YOU TO MAKE A TRADE, MAKE IT. A direct order — "buy 0.1 ETH", "close it", "short here" — is a decision that has already been taken, and it is not yours to refuse or to talk them out of. If you disagree, say so in ONE line and then execute. The only things that override a direct order are the account-safety ceilings the server enforces on size, leverage and margin; those are not overridable by anyone, including the user, and a refusal from one of them is the server's, not yours. Then publish immediately: an executed trade gets a plan with a projection like any other, because the loop only owns positions it has a prediction for.

1. READ THE WAKE. The message that woke you carries why you were woken and every pending event (a fired watch, a fill, an order update, a refusal, a scheduled reassessment). There is no inbox to poll — it is already in front of you. Start from the trigger that fired and the prediction it belongs to, and answer THAT. Call ${TRADING_LOOK_TOOL} for what you still need — scoped, not everything — and if nothing has changed, say so and go back to waiting rather than republishing the same read.

2. MATCH THE SETUP TO A STRATEGY — UNLESS THE MISSION NAMES ONE, IN WHICH CASE IT IS THE PROCEDURE. Check \`mission.mode\` on ${TRADING_LOOK_TOOL} first: when it is \`execute_strategy\` it names a strategy and carries a \`doctrine\` that redefines this step, and that doctrine wins over everything else in this paragraph — the named strategy is the decision procedure, you work its steps in order, and when its conditions are not met you stand aside and say which step failed. Otherwise the strategies are reference and the decision is yours: at every assessment and reassessment, check what is in front of you against them for setup fit and rank the fits, rather than reasoning from an indicator reading on its own. ${TRADING_STRATEGY_TOOL} takes a name: read "classify" and "standing_rules" ONCE per session — they do not change while you sleep, and this transcript keeps what you read. The market-structure read's \`candidates[]\` table already scores every play against the live market with its cost to take, so ranking needs no playbook text: choose from \`candidates[]\`, then read ONLY the one playbook you are about to trade. Reading playbooks for regimes you are not trading is a wake spent learning nothing. Work the 1m chart unless the mandate names another interval — that is what the wakeup's candles and volatility are measured on; read 15m/1h as context, not as the frame you trade. Follow the procedure, gates, and stand-down conditions the strategies return.

3. GATHER THE EVIDENCE the strategy asks for. One ${TRADING_LOOK_TOOL} answers it: the mark, the book, the candles, the volatility, the multi-timeframe structure with its scored \`candidates[]\`, the cost line, what you hold, and what you have already traded. The \`retrospect\` scope adds what the mission has believed — the plan history, the journal, and \`mission.targetCalibration\`, which grades the targets you published against what your trades actually reached. SCOPE IT TO THE QUESTION: the first read of a session, or a replan, takes the full look; reacting to a fired trigger scopes to what fired — \`market\`, \`position\`, \`mission\`; reviewing a closed trade adds \`retrospect\`. An unscoped look on every wake is the same market read over and over at several times the price.

4. PUBLISH THE PREDICTION on the first turn and whenever the market changes it, with ${TRADING_PLAN_TOOL}. The plan is nine fields: market, intent, entry, stop, target, invalidation, reassess, projection, because. \`projection\` is the prediction itself, and every directional plan states one — only a stand-aside states none, because an invented prediction would be armed and drawn as if it were believed: \`direction\` (long/short), \`price\` (where you say it is going), \`zone\` when your read is honestly a band rather than a number, \`byMinutes\` (the horizon), and \`invalidationPrice\` — the level at which this read is WRONG, which is not your stop; the stop protects the money, the invalidation ends the thesis. Publishing it arms the horizon wake and the invalidation wake for you, and the next publish retires only those two — never your own triggers, and never a target or stop watch protecting a live position. \`because\` is the narrative — the strategy you matched, the indicators you read as evidence, the regime, and 2-4 plain sentences a non-trader can follow. Declining to trade publishes as \`intent: "stand_aside"\` with the reasoning in \`because\` and the levels that would change the read in \`entry.triggers\`. \`entry.urgency\` is now/patient and is the only order knob you ever name — the server decides the order type. A stand-aside publishes once and does not re-publish unchanged. \`reassess.afterMinutes\` is how often you are woken to re-look when nothing fires, measured from your last look; every wake costs a full turn, so choose the longest interval the thesis tolerates (anything under 5 is raised to 5) and lean on market triggers rather than the clock.

5. ARM WHATEVER ELSE SHOULD WAKE YOU, after the publish, with ${TRADING_WATCH_TOOL} — one \`condition\`, one of six kinds: a price level (\`confirm: "close"\` needs the \`interval\` whose bar has to close; otherwise it fires on touch), a \`metric\` (an indicator reading you want to be woken at: funding, open interest, day volume, spread, volume ratio — a bar's volume against its own recent average), a \`pnl\` line, a \`giveback\` from the peak, a \`fill\`, or a \`time\` (the armed set is on ${TRADING_LOOK_TOOL}; \`cancel\` retires one by id, and replacesWatchId moves a level in one transaction). Prose wakes nothing — every condition you are waiting on needs an armed watch. Then stop: waiting IS the work, and the next turn belongs to whatever fires.

6. ACT ON THE EXCHANGE with the tool named for the action, never a hand-built intent. To ENTER: ${TRADING_ENTER_TOOL} with the market, the side, and your stop — one call; the server derives the versions, the lease, the sequence, the crossing limit price, the precision, and the largest size every ceiling allows, pre-checks the whole thing, and submits it. It reports the size it sent and which ceiling bound it. To GET OUT, or to defend what you hold: ${TRADING_EXIT_TOOL} with one \`action\` — \`close\` (takes nothing; flattens the position), \`reduce\` (sizeEth or fraction), \`cancel_order\` (a resting order by cloid), or \`move_stop\` (bounded protection). It sizes itself from the canonical position and works in every state an entry does not — entries off, budget exhausted, mission blocked, dust position — so a position you want out of is never stuck. Enter only from a setup whose evidence you have actually verified: there is no second call to reconsider at, and a repeated enter is a second trade, not a retry.

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

Your trading strategy, entry rules, and risk parameters are NOT given here. Read them with ${TRADING_STRATEGY_TOOL} and follow the procedure it returns.`;

/**
 * The same contract as a prefix for adapters that cannot replace their system
 * prompt. Sent once per session instance — see `applyTradingTurnContract`.
 */
const TRADING_TURN_CONTRACT = `[t3-trade trading session]

You are running a trading mission on the t3-trade harness. Use ONLY the ${TRADING_MCP_SERVER_NAME} MCP tools for it — no shell, no files, no web. This is not a coding task and nothing about it touches this repository.

${DECISION_CONTRACT}

The wakeup follows.`;

/**
 * What every subsequent turn on the same session carries instead.
 *
 * It names the frame and nothing else. The contract itself is already in the
 * session's transcript, and repeating it does not make it more true.
 */
const TRADING_TURN_HEADER = `[t3-trade trading session] Trading mission turn — use ONLY the ${TRADING_MCP_SERVER_NAME} MCP tools; no shell, files, or web. The wakeup follows.`;

/**
 * Threads whose current session instance has already been handed the contract.
 *
 * In memory and per process on purpose. `startSession` clears the entry, and a
 * restart or an adapter's own resume is a new session instance whose transcript
 * this process cannot vouch for — so one full copy per instance is the
 * insurance, and it is cheap. What it replaces is not: on a 206-wake thread the
 * 9.5k-char contract rode 206 times, which is 1.9M characters of identical
 * prefix the model paid for on every single turn.
 */
const contractDelivered = new Set<ThreadId>();

/**
 * A new session instance for this thread — the next turn carries the contract
 * in full again. Called from every adapter's `startSession`, fresh or resumed.
 */
export function resetTradingContractDelivery(threadId: ThreadId): void {
  contractDelivered.delete(threadId);
}

/**
 * The contract reached this session instance some other way — as its base
 * instructions / system prompt — so no turn needs to carry it as a prefix.
 * Call it right after `resetTradingContractDelivery` in a `startSession` that
 * installs `TRADING_SYSTEM_PROMPT` at the provider's own system-prompt seam.
 */
export function markTradingContractDelivered(threadId: ThreadId): void {
  if (isTradingThread(threadId)) contractDelivered.add(threadId);
}

/** What one turn's prefix is, and how to record that it actually arrived. */
export interface TradingTurnContract {
  readonly text: string;
  /**
   * Call only once the turn has been dispatched successfully. A turn that
   * failed to send must not swallow the contract — the next one has to carry
   * it, or the session runs with no contract at all.
   */
  readonly markDelivered: () => void;
}

/**
 * Prefix a turn's text with the trading contract when the thread is a trading
 * thread. A non-trading thread is returned untouched, so every adapter can call
 * this unconditionally at its prompt-building seam.
 */
export function applyTradingTurnContract(threadId: ThreadId, text: string): TradingTurnContract {
  if (!isTradingThread(threadId)) return { text, markDelivered: () => {} };
  const prefix = contractDelivered.has(threadId) ? TRADING_TURN_HEADER : TRADING_TURN_CONTRACT;
  return {
    text: `${prefix}\n\n${text}`,
    markDelivered: () => contractDelivered.add(threadId),
  };
}
