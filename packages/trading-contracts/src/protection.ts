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

// ---------------------------------------------------------------------------
// §17.2 steps 6–9 · The bounded reconciliation window
// ---------------------------------------------------------------------------

/**
 * How long T3 may hold an acknowledged increase before full protection is
 * confirmed, and how often it re-reads canonical state inside that window.
 *
 * §17 defines the window as "the shortest technically necessary" one but fixes
 * no number, and Phase 4 did not land one either despite the Phase 5 brief
 * saying it had. These are therefore fork-owned values, chosen to be a few
 * exchange round-trips wide and no wider: the window is a liability, not a
 * budget. When it expires without confirmed protection, §17.2 step 9 escalates
 * to the deterministic emergency close rather than waiting longer.
 */
export const PROTECTION_RECONCILIATION = {
  /** Total time protection may stay unconfirmed before escalation. */
  windowMillis: 15_000,
  /** Gap between canonical re-reads inside the window. */
  confirmPollMillis: 750,
  /** How many placement attempts the window allows before escalation. */
  maximumPlacementAttempts: 3,
} as const;

/**
 * Sizes below this are treated as flat. Exchange sizes are decimal strings
 * truncated to `szDecimals`, so a residual far below any tradable increment is
 * rounding, not exposure.
 */
export const PROTECTION_SIZE_EPSILON = 1e-9;

/** The shape protection confirmation reads out of canonical open orders. */
export interface ProtectiveOrderCandidate {
  readonly market: string;
  readonly side: TradingOrderSide;
  readonly remainingSize: number;
  readonly reduceOnly: boolean;
  readonly isTrigger: boolean;
  readonly triggerPrice?: number | undefined;
}

/** What confirmation inspects: the canonical position and the resting orders. */
export interface ProtectionConfirmationInput {
  readonly market: string;
  /** Signed canonical position size; positive long, negative short. */
  readonly positionSize: number;
  /** Current mark, used to tell a protective stop from a take-profit. */
  readonly referencePrice: number;
  readonly openOrders: ReadonlyArray<ProtectiveOrderCandidate>;
}

/**
 * True when one resting order is exchange-native protection for this position.
 *
 * All four must hold. Reduce-only and trigger are what make it protection at
 * all; the reducing side is what makes it protect *this* position; and the
 * trigger sitting on the losing side of the mark is what separates a stop from
 * a take-profit. A take-profit is also a reduce-only trigger on the reducing
 * side, and counting one as protection would report a position as safe while
 * its entire downside is uncovered.
 */
export function isProtectiveOrder(
  order: ProtectiveOrderCandidate,
  input: ProtectionConfirmationInput,
): boolean {
  if (order.market !== input.market) return false;
  if (!order.reduceOnly || !order.isTrigger) return false;
  if (order.triggerPrice === undefined) return false;
  if (order.remainingSize <= PROTECTION_SIZE_EPSILON) return false;

  const isLong = input.positionSize > 0;
  const reducingSide = isLong ? "sell" : "buy";
  if (order.side !== reducingSide) return false;

  return isLong
    ? order.triggerPrice < input.referencePrice
    : order.triggerPrice > input.referencePrice;
}

/**
 * The confirmed protected size for a position (§17.2 steps 7–8).
 *
 * Sums the qualifying reduce-only stops and clamps to the position — resting
 * protection larger than the position does not make it more than fully
 * protected. Returns 0 for a flat position.
 */
export function confirmedProtectedSize(input: ProtectionConfirmationInput): number {
  const exposure = Math.abs(input.positionSize);
  if (exposure <= PROTECTION_SIZE_EPSILON) return 0;

  const covered = input.openOrders
    .filter((order) => isProtectiveOrder(order, input))
    .reduce((sum, order) => sum + order.remainingSize, 0);

  return Math.min(covered, exposure);
}

/** True when the position is fully covered by confirmed protection. */
export function isFullyProtected(input: ProtectionConfirmationInput): boolean {
  const exposure = Math.abs(input.positionSize);
  if (exposure <= PROTECTION_SIZE_EPSILON) return true;
  return confirmedProtectedSize(input) >= exposure - PROTECTION_SIZE_EPSILON;
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
