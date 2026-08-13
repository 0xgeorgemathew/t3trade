/**
 * The policy that bounds a stop move - plan 24 §5.3.
 *
 * `trading_execute` `modify_stop` can already put the stop anywhere on the
 * losing side of the mark. That is the right primitive and the wrong tool for
 * routine trailing: an unconfirmed replacement escalates to the §17.5 emergency
 * close, so a stop that moves on a whim moves the whole position's safety with
 * it. This module is the bounded version — the rules `trading_adjust_stop`
 * checks before it reaches the same `replaceProtection` path.
 *
 * Every rule here is server-enforced and none is negotiable by prompt. The
 * module is pure so the tool and its tests read the same arithmetic.
 *
 * @module TradingStopAdjustment
 */
import { Schema } from "effect";
import { checkStopReplacement } from "./protection.ts";

/** Why the agent says it is moving the stop. Recorded, never trusted. */
export const StopAdjustmentJustification = Schema.Literals([
  /** Trail behind a winner that has run. */
  "trail_peak",
  /** Pull to (or past) the entry so the trade can no longer lose. */
  "breakeven",
  /** A new swing level makes the old stop the wrong place. */
  "structure_shift",
  /** Volatility expanded; the stop needs the room back, within the envelope. */
  "volatility_room",
]);
export type StopAdjustmentJustification = typeof StopAdjustmentJustification.Type;

/**
 * Why an adjustment was refused.
 *
 * A refusal is agent feedback, not a user-facing event: the position keeps the
 * stop it has, which is always a safe outcome.
 */
export const StopAdjustmentRefusalCode = Schema.Literals([
  /** The new stop is not on the losing side of the mark. */
  "wrong_side",
  /** The move would risk more than the entry was approved with. */
  "risk_envelope",
  /** The agent's ATR and the server's disagree — it is reasoning on stale data. */
  "atr_mismatch",
  /** One call may only take a small step. */
  "step_too_large",
  /** The new stop sits inside the market's own noise. */
  "noise_floor",
  /** Tightening this far would exit the trade rather than protect it. */
  "target_encroachment",
  /** The stop has already crossed to the winning side and may not cross back. */
  "breakeven_ratchet",
  /** Too soon after the last adjustment, or too many on this position. */
  "adjustment_budget",
]);
export type StopAdjustmentRefusalCode = typeof StopAdjustmentRefusalCode.Type;

/**
 * The numeric bounds. Named constants because the tests assert against them and
 * the tool description quotes them.
 */
export const STOP_ADJUSTMENT_LIMITS = {
  /** Largest single step, as a multiple of ATR. */
  maximumStepAtrMultiple: 0.5,
  /** Largest single step, as a fraction of the current stop distance. */
  maximumStepDistanceFraction: 0.25,
  /** How far the agent's measured ATR may diverge from the server's. */
  maximumAtrDivergence: 0.3,
  /** Minimum stop distance, as a multiple of the half-spread. */
  noiseFloorHalfSpreadMultiple: 2,
  /** Minimum stop distance, as a multiple of ATR. */
  noiseFloorAtrMultiple: 0.35,
  /** How far toward the target a stop may be dragged, as a fraction of entry→target. */
  maximumTargetApproachFraction: 0.5,
  /** Minimum gap between two adjustments, in primary-timeframe bars. */
  minimumBarsBetweenAdjustments: 3,
  /** Adjustments allowed on one position. */
  maximumAdjustmentsPerPosition: 8,
} as const;

/** Everything the policy measures. All prices are absolute, not distances. */
export interface StopAdjustmentPolicyInput {
  /** Signed canonical position size; positive long, negative short. */
  readonly positionSize: number;
  readonly entryPrice: number;
  /** Current mark or mid the new stop is measured against. */
  readonly markPrice: number;
  /** The stop resting now. */
  readonly currentStopPrice: number;
  readonly newStopPrice: number;
  /**
   * The stop the entry was approved with — the published risk envelope.
   *
   * Loosening back toward it is allowed; loosening past it is not, because that
   * risks money the plan never approved.
   */
  readonly originalStopPrice: number;
  /** The price the profit target sits at, when the strategy names one. */
  readonly targetPrice?: number | undefined;
  /** ATR the server measured this turn over the primary timeframe. */
  readonly serverAtrUsd: number;
  /** ATR the agent says it measured. Cross-checked, never used as the bound. */
  readonly observedAtrUsd: number;
  readonly halfSpreadUsd: number;
  readonly nowMillis: number;
  /** One primary-timeframe bar, in milliseconds. */
  readonly barMillis: number;
  /** When this position's stop was last adjusted, if it ever was. */
  readonly lastAdjustmentAtMillis?: number | undefined;
  /** Accepted adjustments on this position so far. Resets when it goes flat. */
  readonly adjustmentsThisPosition: number;
}

/**
 * The closest a stop may sit to the price it is measured against.
 *
 * `max(2x half-spread, 0.35x ATR)`: any closer and the stop is inside the
 * market's own noise — not protection, a scheduled exit. One function because
 * two callers enforce it, the adjustment policy and the entry quote, and the
 * rule drifting between them is exactly the failure a shared constant table
 * exists to prevent.
 */
export function stopNoiseFloorUsd(input: {
  readonly halfSpreadUsd: number;
  readonly atrUsd: number;
}): number {
  return Math.max(
    STOP_ADJUSTMENT_LIMITS.noiseFloorHalfSpreadMultiple * Math.max(0, input.halfSpreadUsd),
    STOP_ADJUSTMENT_LIMITS.noiseFloorAtrMultiple * Math.max(0, input.atrUsd),
  );
}

/** The planned loss if the position stopped out at `stopPrice`. */
export function plannedLossAtStopUsd(input: {
  readonly positionSize: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
}): number {
  const isLong = input.positionSize > 0;
  const adverseMove = isLong
    ? input.entryPrice - input.stopPrice
    : input.stopPrice - input.entryPrice;
  return Math.max(0, adverseMove) * Math.abs(input.positionSize);
}

/**
 * Run the policy. Returns the refusal code, or `null` when the move may
 * proceed to `replaceProtection`.
 *
 * Order matters only for which code a doubly-bad request reports, and it is
 * chosen so the most fundamental objection wins: a stop on the wrong side of
 * the mark is reported as that, not as an oversized step.
 */
export function checkStopAdjustment(
  input: StopAdjustmentPolicyInput,
): StopAdjustmentRefusalCode | null {
  const isLong = input.positionSize > 0;

  // 0. The same wrong-side check `modify_stop` runs. A stop through the mark
  // triggers the instant it rests.
  if (
    checkStopReplacement({
      positionSize: input.positionSize,
      referencePrice: input.markPrice,
      stopPrice: input.newStopPrice,
    }) !== null
  ) {
    return "wrong_side";
  }

  // 1. The agent's own measurement, cross-checked. A stop derived from an ATR
  // that no longer holds is a stop derived from a market that no longer exists.
  if (input.serverAtrUsd > 0) {
    const divergence = Math.abs(input.observedAtrUsd - input.serverAtrUsd) / input.serverAtrUsd;
    if (divergence > STOP_ADJUSTMENT_LIMITS.maximumAtrDivergence) return "atr_mismatch";
  }

  // 2. Risk never grows past the plan. Tightening is always allowed; loosening
  // only back toward the stop the entry was approved with.
  const approvedLoss = plannedLossAtStopUsd({
    positionSize: input.positionSize,
    entryPrice: input.entryPrice,
    stopPrice: input.originalStopPrice,
  });
  const proposedLoss = plannedLossAtStopUsd({
    positionSize: input.positionSize,
    entryPrice: input.entryPrice,
    stopPrice: input.newStopPrice,
  });
  if (proposedLoss > approvedLoss + PRICE_EPSILON) return "risk_envelope";

  // 3. Once the stop has crossed to the winning side of entry, it stays there.
  // A trade that can no longer lose does not get to become one that can again.
  const currentOnWinningSide = isLong
    ? input.currentStopPrice >= input.entryPrice
    : input.currentStopPrice <= input.entryPrice;
  const newOnWinningSide = isLong
    ? input.newStopPrice >= input.entryPrice - PRICE_EPSILON
    : input.newStopPrice <= input.entryPrice + PRICE_EPSILON;
  if (currentOnWinningSide && !newOnWinningSide) return "breakeven_ratchet";

  // 4. Small steps only — trailing, not jumping.
  const currentDistance = Math.abs(input.markPrice - input.currentStopPrice);
  const step = Math.abs(input.newStopPrice - input.currentStopPrice);
  const maximumStep = Math.min(
    STOP_ADJUSTMENT_LIMITS.maximumStepAtrMultiple * input.serverAtrUsd,
    STOP_ADJUSTMENT_LIMITS.maximumStepDistanceFraction * currentDistance,
  );
  if (step > maximumStep + PRICE_EPSILON) return "step_too_large";

  // 5. Never choke the trade: the stop has to sit outside the market's own
  // noise, or it is not protection, it is a scheduled exit.
  const newDistance = Math.abs(input.markPrice - input.newStopPrice);
  const noiseFloor = stopNoiseFloorUsd({
    halfSpreadUsd: input.halfSpreadUsd,
    atrUsd: input.serverAtrUsd,
  });
  if (newDistance < noiseFloor - PRICE_EPSILON) return "noise_floor";

  // 6. And it may not be dragged more than halfway from entry to target. Past
  // that the stop, not the target, is what ends the trade — profit protection
  // turned into an early exit while the move it was published for is still
  // available.
  const target = input.targetPrice;
  if (target !== undefined) {
    const reach = STOP_ADJUSTMENT_LIMITS.maximumTargetApproachFraction;
    const cap = input.entryPrice + reach * (target - input.entryPrice);
    const encroaches = isLong
      ? input.newStopPrice > cap + PRICE_EPSILON
      : input.newStopPrice < cap - PRICE_EPSILON;
    if (encroaches) return "target_encroachment";
  }

  // 7. Trailing, not twitching.
  if (input.adjustmentsThisPosition >= STOP_ADJUSTMENT_LIMITS.maximumAdjustmentsPerPosition) {
    return "adjustment_budget";
  }
  const last = input.lastAdjustmentAtMillis;
  if (
    last !== undefined &&
    input.nowMillis - last < STOP_ADJUSTMENT_LIMITS.minimumBarsBetweenAdjustments * input.barMillis
  ) {
    return "adjustment_budget";
  }

  return null;
}

/**
 * Slack for comparing prices that were derived by arithmetic rather than read
 * off the book. Without it a stop moved exactly to the cap is refused by a
 * floating-point residue.
 */
const PRICE_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// §5.4 · The stop-proximity watch
// ---------------------------------------------------------------------------

/** How far ahead of the stop the proximity watch sits, in ATR. */
export const STOP_PROXIMITY_ATR_MULTIPLE = 1;

/**
 * Where to arm the wake that gives the agent a turn *before* the exchange takes
 * the decision.
 *
 * The stop is on the losing side, so price approaching it moves the losing way:
 * a long is woken on the way down at `stop + ATR`, a short on the way up at
 * `stop - ATR`. Returns `null` when there is no usable ATR, or when the level
 * would already be through the mark — a watch that was true before it was
 * written is not coverage, it is an immediate wake.
 */
/**
 * How far toward the planned stop loss the decision wake sits, as a fraction.
 *
 * Plan 27 G4: the wake fires at ~70% of the way to the stop, not AT it, so
 * the turn it buys can still choose — thesis broken (exit better than the
 * stop), or noise (hold, or tighten legally). The exchange stop stays resting
 * as the backstop either way.
 */
export const STOP_DECISION_WAKE_FRACTION = 0.7;

/**
 * The unrealised-PnL level to arm the `pnl_below` decision wake at, for a
 * position whose stop-out would lose `plannedLossAtStopUsd`.
 *
 * Null when the stop cannot lose anything — at or past breakeven the losing
 * side is covered by the ratchet, and a wake at zero would fire on every
 * flat tick.
 */
export function stopDecisionWakePnlUsd(plannedLossAtStopUsd: number): number | null {
  if (!(plannedLossAtStopUsd > 0)) return null;
  return -STOP_DECISION_WAKE_FRACTION * plannedLossAtStopUsd;
}

export function stopProximityWatchLevel(input: {
  readonly positionSize: number;
  readonly stopPrice: number;
  readonly markPrice: number;
  readonly atrUsd: number;
}): { readonly price: number; readonly direction: "above" | "below" } | null {
  if (!(input.atrUsd > 0) || !(input.stopPrice > 0)) return null;
  const isLong = input.positionSize > 0;
  if (input.positionSize === 0) return null;

  const offset = STOP_PROXIMITY_ATR_MULTIPLE * input.atrUsd;
  const price = isLong ? input.stopPrice + offset : input.stopPrice - offset;
  if (!(price > 0)) return null;
  if (isLong ? price >= input.markPrice : price <= input.markPrice) return null;
  return { price, direction: isLong ? "below" : "above" };
}
