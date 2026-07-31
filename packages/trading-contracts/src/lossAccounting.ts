/**
 * Cumulative-loss budget accounting - spec §16.2, implemented as pure functions.
 *
 * The six equations convert reconciled fills, open positions, and pending
 * reservations into a hard mission-loss ceiling the harness cannot enlarge or
 * exceed. Two load-bearing rules:
 *
 *   - **Paid fees are not double-counted.** Paid entry fees live in
 *     `realizedMissionResultUsd`; they must not also be reserved as unpaid
 *     open-position fees. A queued-but-unfilled entry reserves both estimated
 *     entry and exit fees; a filled position reserves only unpaid fees.
 *   - **Profits reduce realised loss, never the ceiling.** `positivePnlExpands
 *     LossBudget` is `false` by policy. Profits may reduce `realizedLossUsedUsd`
 *     toward zero but never raise `maximumCumulativeLossUsd`.
 *
 * Property tests pin every equation. The functions take already-reconciled
 * inputs (Hyperliquid is canonical, §18.2); they never read the exchange.
 *
 * @module TradingLossAccounting
 */

import type {
  TradingLossBudget,
  TradingOpenPositionRiskInput,
  TradingPendingEntryRiskInput,
} from "./execution.ts";
import type { UnixMillis } from "./primitives.ts";

const max0 = (n: number): number => (n > 0 ? n : 0);

/**
 * Equation 3 — `openPositionRiskUsd` for one open position (§16.2).
 *
 * `max(0, estimatedLossFromWeightedEntryToStopUsd) + estimatedUnpaidExitFeeUsd
 * + stopSlippageReserveUsd`. The loss-to-stop is floored at zero (a position
 * already in profit contributes no directional loss to the budget).
 */
export function openPositionRisk(input: TradingOpenPositionRiskInput): number {
  // Estimated loss from the weighted entry to the stop, derived by the caller
  // from the reconciled entry/stop. Floored at zero so an in-profit position
  // does not add negative risk (which would inflate the budget).
  const stopDistance =
    input.direction === "long"
      ? (input.weightedEntryPrice ?? 0) - (input.stopPrice ?? 0)
      : (input.stopPrice ?? 0) - (input.weightedEntryPrice ?? 0);
  const estimatedLossToStop = stopDistance > 0 ? stopDistance * input.size : 0;

  return max0(estimatedLossToStop) + input.estimatedExitFeeUsd + input.stopSlippageReserveUsd;
}

/**
 * Equation 4 — `pendingEntryRiskUsd` for one reserved, unfilled entry (§16.2).
 *
 * `plannedLossAtStopUsd + estimatedEntryFeeUsd + estimatedExitFeeUsd +
 * stopSlippageReserveUsd`. A queued entry reserves both entry and exit fees
 * because neither has been paid yet.
 */
export function pendingEntryRisk(input: TradingPendingEntryRiskInput): number {
  return (
    input.plannedLossAtStopUsd +
    input.estimatedEntryFeeUsd +
    input.estimatedExitFeeUsd +
    input.stopSlippageReserveUsd
  );
}

/** Inputs to the full budget snapshot (§16.2 equations 1, 2, 5, 6). */
export interface LossBudgetInput {
  readonly maximumCumulativeLossUsd: number;

  /** Closed PnL across the mission (from reconciled fills). */
  readonly closedPnlUsd: number;
  /** Net funding paid/received (negative = paid). */
  readonly netFundingUsd: number;
  /** All fees already charged to the mission, including on open positions. */
  readonly allPaidTradingFeesUsd: number;

  /** One `TradingOpenPositionRiskInput` per open position. */
  readonly openPositions: ReadonlyArray<TradingOpenPositionRiskInput>;
  /** One `TradingPendingEntryRiskInput` per reserved, unfilled entry. */
  readonly pendingEntries: ReadonlyArray<TradingPendingEntryRiskInput>;

  readonly observedAt: UnixMillis;
}

/**
 * Evaluate the full cumulative-loss budget (§16.2), all six equations.
 *
 * Returns the snapshot plus an `exhausted` flag (§16.4: remaining ≤ 0).
 *
 * `positivePnlExpandsLossBudget` is honoured implicitly: a positive
 * `realizedMissionResultUsd` drives `realizedLossUsedUsd` to zero (via the
 * `max(0, -result)` clamp) but never raises `maximumCumulativeLossUsd`.
 */
export function evaluateLossBudget(input: LossBudgetInput): TradingLossBudget {
  // Eq 1: realised mission result = closedPnl + netFunding - allPaidFees.
  const realizedMissionResultUsd =
    input.closedPnlUsd + input.netFundingUsd - input.allPaidTradingFeesUsd;

  // Eq 2: realised loss used = max(0, -result). Profits clamp this to zero.
  const realizedLossUsedUsd = max0(-realizedMissionResultUsd);

  // Eq 3 (summed) + Eq 4 (summed).
  const openPositionRiskUsd = input.openPositions.reduce((sum, p) => sum + openPositionRisk(p), 0);
  const pendingEntryRiskUsd = input.pendingEntries.reduce((sum, e) => sum + pendingEntryRisk(e), 0);

  // Eq 5: budget used = realised loss + open risk + pending risk.
  const lossBudgetUsedUsd = realizedLossUsedUsd + openPositionRiskUsd + pendingEntryRiskUsd;

  // Eq 6: remaining = max(0, ceiling - used). Never negative.
  const remainingCumulativeLossUsd = max0(input.maximumCumulativeLossUsd - lossBudgetUsedUsd);

  return {
    maximumCumulativeLossUsd: input.maximumCumulativeLossUsd,
    closedPnlUsd: input.closedPnlUsd,
    netFundingUsd: input.netFundingUsd,
    allPaidTradingFeesUsd: input.allPaidTradingFeesUsd,
    realizedMissionResultUsd,
    realizedLossUsedUsd,
    openPositionRiskUsd,
    pendingEntryRiskUsd,
    lossBudgetUsedUsd,
    remainingCumulativeLossUsd,
    exhausted: remainingCumulativeLossUsd <= 0,
    observedAt: input.observedAt,
  };
}

/**
 * §16.4 exhaustion policy. When the budget is exhausted, position-increasing
 * actions (open, scale_in) and reversals/re-entries are blocked, while
 * cancellation, reduction, close, and revocation remain permitted.
 */
const EXHAUSTION_PERMITTED_ACTIONS: ReadonlySet<string> = new Set(["cancel", "reduce", "close"]);

/** True when `actionType` is permitted under exhaustion (§16.4). */
export function isPermittedUnderExhaustion(actionType: string): boolean {
  return EXHAUSTION_PERMITTED_ACTIONS.has(actionType);
}
