/**
 * The mandatory-stop gate and the protective-order invariant - spec §17.
 *
 * §17's target invariant is that no acknowledged position increase may remain
 * without confirmed exchange-native reduce-only protection beyond the bounded
 * reconciliation window. The first half of that is enforced here, before any
 * signing: an action that can increase exposure must carry stop information,
 * and that stop must be on the losing side of the entry.
 *
 * This module is pure. It is evaluated twice on every increase — once by the
 * §16.3 preview checklist and once by the execution service immediately before
 * it signs — so the two gates cannot drift apart.
 *
 * @module TradingProtection
 */
import { Schema } from "effect";
import type { TradingOrderSide, TradingStopInfo } from "./execution.ts";

// ---------------------------------------------------------------------------
// §16.4 / §17 · Which actions can increase exposure
// ---------------------------------------------------------------------------

/**
 * Actions that only ever shrink exposure. Mirrors §16.4's
 * exhaustion-permitted set, and `TradingExecutionGuard.blockForExhaustion`
 * reads the same three names out of SQL.
 */
const EXPOSURE_REDUCING_ACTIONS: ReadonlySet<string> = new Set(["cancel", "reduce", "close"]);

/**
 * True when `actionType` can increase exposure and therefore requires a stop.
 *
 * Fail-closed by construction: anything that is not a known reducing action is
 * treated as increasing, so a new action type added later inherits the gate
 * rather than slipping past it.
 */
export function isPositionIncreasing(actionType: string): boolean {
  return !EXPOSURE_REDUCING_ACTIONS.has(actionType);
}

// ---------------------------------------------------------------------------
// §16.3 item 17 / §17 · The mandatory-stop gate
// ---------------------------------------------------------------------------

/** Why stop information failed the mandatory-stop gate. */
export const StopGateDefect = Schema.Literals([
  "stop_missing",
  "stop_price_not_positive",
  "stop_on_wrong_side_of_entry",
]);
export type StopGateDefect = typeof StopGateDefect.Type;

/** What the gate inspects. `stop` is absent when the request carried none. */
export interface StopGateInput {
  readonly actionType: string;
  readonly side: TradingOrderSide;
  /** The entry price the stop is measured against. */
  readonly referencePrice: number;
  readonly stop: TradingStopInfo | undefined;
}

/**
 * Run the mandatory-stop gate. Returns the defect, or `null` when the request
 * may proceed.
 *
 * A reducing action needs no stop: a reduce-only close is itself the exit, and
 * demanding a stop on it would reject the very action that removes exposure.
 * An increasing action must carry one, priced on the losing side of the entry
 * — below for a long, above for a short.
 */
export function checkStopInformation(input: StopGateInput): StopGateDefect | null {
  if (!isPositionIncreasing(input.actionType)) return null;

  const stop = input.stop;
  if (stop === undefined) return "stop_missing";
  if (!(stop.stopPrice > 0)) return "stop_price_not_positive";

  const isLong = input.side === "buy";
  const onLosingSide = isLong
    ? stop.stopPrice < input.referencePrice
    : stop.stopPrice > input.referencePrice;
  return onLosingSide ? null : "stop_on_wrong_side_of_entry";
}

/** Human-readable reason for a defect, used in both rejection messages. */
export function describeStopGateDefect(defect: StopGateDefect, input: StopGateInput): string {
  switch (defect) {
    case "stop_missing":
      return `${input.actionType} is position-increasing and carries no stop information (§16.3 item 17)`;
    case "stop_price_not_positive":
      return `stop price ${input.stop?.stopPrice} is not a positive price`;
    case "stop_on_wrong_side_of_entry":
      return `stop ${input.stop?.stopPrice} is on the wrong side of entry ${input.referencePrice} for a ${input.side}`;
  }
}
