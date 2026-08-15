/**
 * The terminal decision vocabulary a harness turn ends on.
 *
 * A trading turn used to end in one of two observable ways: a published plan,
 * or nothing at all. "Nothing at all" covered a model that found no edge, a
 * model that could not read the market, a model that malformed a tool call, and
 * a model that was refused at the execution gate — four different problems with
 * one indistinguishable symptom. This module names them, once, so the prompt
 * that asks for a decision and the telemetry that counts decisions use the same
 * words.
 *
 * @module TradingDecision
 */
import { Schema } from "effect";

/**
 * How a harness run ended.
 *
 * - `entered` — a position-increasing order reached the exchange.
 * - `managed_position` — an exit, cancel, or protection change reached the exchange.
 * - `waiting_with_setup` — a plan is published with armed levels; the entry
 *   evidence has not arrived yet.
 * - `no_setup` — the market was read and offers no edge worth taking. The
 *   stand-down publish is the record of it.
 * - `blocked_by_data` — the turn could not get the evidence it needed (a tool
 *   failed, data was stale or unavailable).
 * - `execution_refused` — the turn tried to execute and a server gate refused.
 * - `no_decision` — the run ended without any of the above. This is the outcome
 *   the funnel exists to drive to zero.
 */
export const TradingDecisionOutcome = Schema.Literals([
  "entered",
  "managed_position",
  "waiting_with_setup",
  "no_setup",
  "blocked_by_data",
  "execution_refused",
  "no_decision",
]);
export type TradingDecisionOutcome = typeof TradingDecisionOutcome.Type;

/**
 * Why a run that did not enter did not enter.
 *
 * Narrower than the outcome: two runs can both be `no_setup` and disagree about
 * whether the market was flat or the costs were too high. The code is what a
 * threshold change is later measured against.
 */
export const TradingStandDownCode = Schema.Literals([
  /** The observed fluctuation does not support a target worth taking. */
  "insufficient_volatility",
  /** Costs eat the available move: the target cannot clear its round trip. */
  "costs_exceed_target",
  /** The regime read did not resolve to a playbook (readings disagreed). */
  "regime_unclear",
  /** A published thesis is waiting on a level that has not been reached. */
  "awaiting_trigger",
  /** A market/account read failed, so no decision could be grounded. */
  "data_unavailable",
  /** A tool call was malformed and the turn did not recover. */
  "tool_call_failed",
  /** A deterministic preview check refused the attempted order. */
  "preview_refused",
  /** The exchange answered the submission with a terminal rejection/failure. */
  "exchange_rejected",
  /** The run ended without publishing anything. */
  "not_published",
]);
export type TradingStandDownCode = typeof TradingStandDownCode.Type;

/**
 * The facts a run accumulates while it is open, from which its terminal outcome
 * is derived. Every field is observed by the server — none is asserted by the
 * model.
 *
 * There is no explicit stand-down reason any more: the plan document stopped
 * carrying one (plan 29 step 4.1 — standing aside is `intent: "stand_aside"`
 * and the reasoning is prose in `because`), so `no_setup` attribution falls to
 * the derived default below.
 */
export interface TradingRunFacts {
  /** Tool names called during the run, in call order, with repeats. */
  readonly toolsCalled: ReadonlyArray<string>;
  /** How many of those calls returned an error. */
  readonly toolErrorCount: number;
  /** `tool: message` for the first error, when there was one. */
  readonly firstToolError?: string | undefined;
  /** A `trading_publish_plan` call was accepted during the run. */
  readonly publishedPlan: boolean;
  /** The published plan declared itself a stand-aside (`intent: "stand_aside"`). */
  readonly publishedStandDown: boolean;
  /** The published plan carries at least one armed entry level. */
  readonly hasArmedEntry: boolean;
  /** `trading_execute` or `trading_adjust_stop` was called. */
  readonly executeAttempted: boolean;
  /** The first preview/guard refusal reason, when the attempt was refused. */
  readonly firstPreviewRefusal?: string | undefined;
  /** Which exchange mutation was attempted, when one reached the exchange. */
  readonly exchangeAction?: string | undefined;
  /** The persisted/exchange status of that mutation. */
  readonly exchangeStatus?: string | undefined;
}

/**
 * Derive the one terminal decision a run ended on.
 *
 * Ordered most-specific first: reaching the exchange beats everything, a
 * refusal beats a publish (the turn wanted to trade and was stopped), and a
 * data failure beats a stand-down only when nothing was published — a turn that
 * hit a failed read and still published a reasoned stand-down made a decision.
 */
export function deriveDecisionOutcome(facts: TradingRunFacts): TradingDecisionOutcome {
  if (facts.exchangeStatus === "rejected" || facts.exchangeStatus === "failed") {
    return "execution_refused";
  }
  if (facts.exchangeAction === "open" || facts.exchangeAction === "scale_in") return "entered";
  if (facts.exchangeAction !== undefined) return "managed_position";
  if (facts.firstPreviewRefusal !== undefined) return "execution_refused";
  if (!facts.publishedPlan) {
    return facts.toolErrorCount > 0 ? "blocked_by_data" : "no_decision";
  }
  if (facts.publishedStandDown) return "no_setup";
  return facts.hasArmedEntry ? "waiting_with_setup" : "no_setup";
}

/**
 * The stand-down code that goes with a derived outcome. `entered` has none.
 */
export function deriveStandDownCode(
  facts: TradingRunFacts,
  outcome: TradingDecisionOutcome,
): TradingStandDownCode | undefined {
  switch (outcome) {
    case "entered":
    case "managed_position":
      return undefined;
    case "execution_refused":
      return facts.exchangeStatus === "rejected" || facts.exchangeStatus === "failed"
        ? "exchange_rejected"
        : "preview_refused";
    case "blocked_by_data":
      return facts.toolErrorCount > 0 ? "data_unavailable" : "tool_call_failed";
    case "no_decision":
      return "not_published";
    case "waiting_with_setup":
      return "awaiting_trigger";
    case "no_setup":
      return facts.publishedStandDown ? "insufficient_volatility" : "regime_unclear";
  }
}
