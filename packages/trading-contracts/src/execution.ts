/**
 * Execution-domain contracts - spec §14.4–§14.7, §15, §16.2, §18.
 *
 * Phase 0–3 published the read path and the mission/authority/strategy
 * domain. This module authors the deferred execution records: the order
 * intent the harness requests, the persisted execution record that makes
 * retries idempotent, the fills and position snapshots reconciliation
 * produces, and the risk-reservation ledger that gates signing.
 *
 * Identity rule (§10.6, load-bearing): account and position reads use the
 * master-wallet address. The execution-wallet address signs actions and
 * appears only on the order/execution records as the signer of record.
 *
 * @module TradingExecution
 */
import { Schema } from "effect";
import {
  EvmAddress,
  Price,
  TradingId,
  TradingMarket,
  UnixMillis,
  UsdAmount,
} from "./primitives.ts";
import { TradingDirection } from "./authority.ts";
import { MomentumOrderPreference } from "./strategy.ts";

// ---------------------------------------------------------------------------
// §15.3 · Order side, time-in-force, and the action-type discriminator
// ---------------------------------------------------------------------------

/** Exchange order side, in the harness's vocabulary (not the wire `B`/`A`). */
export const TradingOrderSide = Schema.Literals(["buy", "sell"]);
export type TradingOrderSide = typeof TradingOrderSide.Type;

/**
 * Hyperliquid time-in-force for the mapped order.
 *
 * `marketable_ioc` prices off a fresh best bid/ask plus slippage (§15.4);
 * `gtc` rests at the limit until cancelled. The harness expresses a
 * preference via `MomentumOrderPreference`; the order mapper turns it into
 * one of these.
 */
export const TradingOrderTimeInForce = Schema.Literals(["ioc", "gtc"]);
export type TradingOrderTimeInForce = typeof TradingOrderTimeInForce.Type;

/**
 * The action-type discriminator fed into the deterministic cloid (§15.5) and
 * the execution-sequence counter. Retries of the *same* action reuse the
 * same `(executionSequence, actionType)` and therefore the same cloid.
 */
export const TradingExecutionActionType = Schema.Literals([
  "open",
  "scale_in",
  "reduce",
  "close",
  "cancel",
]);
export type TradingExecutionActionType = typeof TradingExecutionActionType.Type;

// ---------------------------------------------------------------------------
// §14.4 / §15.4 · The order intent the harness requests and T3 validates
// ---------------------------------------------------------------------------

/**
 * Stop information an entry must carry (§16.3 item 17: "a valid stop is
 * defined"). An entry without a stop is rejected at preview.
 */
export const TradingStopInfo = Schema.Struct({
  /** Reduce-only trigger price. */
  stopPrice: Price,
  /**
   * USD loss the harness plans to take if the stop executes, derived from
   * the weighted entry to the stop. Reserves `pendingEntryRiskUsd`.
   */
  plannedLossAtStopUsd: UsdAmount,
});
export type TradingStopInfo = typeof TradingStopInfo.Type;

/**
 * A position-increasing entry request the harness submits for preview.
 *
 * This is the input to `trading_preview_order`. The preview runs the full
 * §16.3 checklist, normalises precision (§15.3), checks BBO freshness
 * (§15.4), requires the stop (§16.3 item 17), and reserves risk before any
 * signing.
 */
export const TradingOrderIntent = Schema.Struct({
  missionId: TradingId,
  strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Per-mission counter; retries reuse the same value to reuse the cloid. */
  executionSequence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  actionType: TradingExecutionActionType,

  market: TradingMarket,
  side: TradingOrderSide,
  /** Absolute size in base units, already positive. */
  size: Schema.Number.check(Schema.isGreaterThan(0)),
  /**
   * Harness limit preference. For `marketable_ioc` the mapper derives the
   * wire price from a fresh best bid/ask ± slippage (§15.4); for
   * `resting_limit` it rests at this price as GTC.
   */
  orderPreference: MomentumOrderPreference,
  limitPrice: Price,

  /** Required for every position-increasing action (§16.3 item 17). */
  stop: TradingStopInfo,

  reduceOnly: Schema.Boolean,
});
export type TradingOrderIntent = typeof TradingOrderIntent.Type;

// ---------------------------------------------------------------------------
// §15.5 · Client order id (cloid) — deterministic, 16 bytes
// ---------------------------------------------------------------------------

/**
 * The deterministic client order id (§15.5).
 *
 * `derive16Bytes(missionId, strategyVersion, executionSequence, actionType)`
 * — SHA-256 of the concatenated inputs, truncated to the first 16 bytes,
 * hex-encoded as a 32-character string (no `0x` prefix, matching the
 * Hyperliquid wire convention for `cloid`).
 */
export const TradingCloid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));
export type TradingCloid = typeof TradingCloid.Type;

// ---------------------------------------------------------------------------
// §15.3 / §15.4 · The wire-shaped order the mapper produces
// ---------------------------------------------------------------------------

/**
 * A normalised order ready for Hyperliquid wire encoding (§15.3 precision,
 * §15.4 pricing). This is what the order mapper hands the submit path; the
 * harness never sees it directly.
 */
export const TradingWireOrder = Schema.Struct({
  cloid: TradingCloid,
  coin: TradingMarket,
  side: TradingOrderSide,
  /** String price, trailing zeros stripped (§15.3). */
  limitPrice: Schema.String,
  /** String size, truncated to szDecimals (§15.3). */
  size: Schema.String,
  timeInForce: TradingOrderTimeInForce,
  /** Whether this order may only reduce an existing position. */
  reduceOnly: Schema.Boolean,
});
export type TradingWireOrder = typeof TradingWireOrder.Type;

// ---------------------------------------------------------------------------
// §18 · Persisted execution record, order, fill
// ---------------------------------------------------------------------------

/** Lifecycle of a single execution attempt. Drives the order-intent card. */
export const TradingExecutionStatus = Schema.Literals([
  "previewed",
  "reserved",
  "signed",
  "submitted",
  "accepted",
  "filled",
  "rejected",
  "cancelled",
  "failed",
]);
export type TradingExecutionStatus = typeof TradingExecutionStatus.Type;

/**
 * Per-order status as returned by the exchange, recorded verbatim (§17.2
 * step 4: inspect EVERY per-order status; do not assume batch atomicity).
 */
export const TradingOrderResultStatus = Schema.Literals(["ok", "err", "queued", "triggered"]);
export type TradingOrderResultStatus = typeof TradingOrderResultStatus.Type;

/**
 * A single per-order result from a grouped submission (§17.2 step 4).
 * The exchange returns one status per order in a batch; T3 records each.
 */
export const TradingOrderResult = Schema.Struct({
  cloid: TradingCloid,
  status: TradingOrderResultStatus,
  /** Exchange-assigned order id when available. */
  orderId: Schema.optional(Schema.Number),
  /** Error/reason text when status is `err`. */
  reason: Schema.optional(Schema.String),
});
export type TradingOrderResult = typeof TradingOrderResult.Type;

/**
 * The persisted execution record (§18 `trading_execution_records`).
 *
 * Persisted BEFORE signing (§15.5, §17.2 step 2). A retry reuses the same
 * `cloid` and `idempotencyKey`, so the exchange deduplicates on `cloid` and
 * the local write deduplicates on `idempotencyKey`.
 */
export const TradingExecutionRecord = Schema.Struct({
  executionId: TradingId,
  missionId: TradingId,
  strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  executionSequence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  actionType: TradingExecutionActionType,

  cloid: TradingCloid,
  /** Reused across retries of the same execution. */
  idempotencyKey: TradingId,

  market: TradingMarket,
  side: TradingOrderSide,
  size: Schema.Number.check(Schema.isGreaterThan(0)),
  limitPrice: Price,
  timeInForce: TradingOrderTimeInForce,
  reduceOnly: Schema.Boolean,

  /**
   * The intent's stop, persisted so the budget reader can thread it into
   * `openPositionRisk` once the entry fills and the reservation is released.
   * Optional because legacy rows (and reduce-only/close records) may not
   * carry one; the columns are nullable.
   */
  stopPrice: Schema.optional(Price),
  plannedLossAtStopUsd: Schema.optional(UsdAmount),

  /** The interim execution-wallet address that signed the action. */
  signerAddress: EvmAddress,

  status: TradingExecutionStatus,
  /** Per-order results from the last submission, if any. */
  orderResults: Schema.Array(TradingOrderResult),

  createdAt: UnixMillis,
  updatedAt: UnixMillis,
});
export type TradingExecutionRecord = typeof TradingExecutionRecord.Type;

/**
 * A reconciled fill (§18 `trading_fills`). Source of truth is the master
 * address's `userFills`; a locally cached fill is a hint until reconciled.
 */
export const TradingFill = Schema.Struct({
  fillId: Schema.String,
  missionId: TradingId,
  executionId: Schema.optional(TradingId),
  cloid: Schema.optional(TradingCloid),
  orderId: Schema.Number,
  market: TradingMarket,
  side: TradingOrderSide,
  /** Absolute executed size in base units. */
  filledSize: Schema.Number.check(Schema.isGreaterThan(0)),
  /** Average fill price. */
  avgFillPrice: Price,
  /** Exchange-assigned fee for this fill, in USD (already paid). */
  feeUsd: Schema.Number,
  /** Exchange-assigned fee in base/quote currency, verbatim. */
  feeToken: Schema.String,
  /** Realised PnL the exchange attributes to this fill (§16.2 closedPnl). */
  closedPnl: Schema.Number,
  tradedAt: UnixMillis,
  observedAt: UnixMillis,
});
export type TradingFill = typeof TradingFill.Type;

// ---------------------------------------------------------------------------
// §18 / §10.6 · Reconciled position snapshot and open order
// ---------------------------------------------------------------------------

/**
 * A reconciled position snapshot (§18 `trading_position_snapshots`).
 *
 * Reconciled from canonical clearinghouse state read with the master-wallet
 * address. `unrealisedPnl` and `entryPrice` come straight from the exchange;
 * `direction` is derived from the sign of `size` for the UI.
 */
export const TradingPositionSnapshot = Schema.Struct({
  missionId: TradingId,
  market: TradingMarket,
  /** Signed net size; positive long, negative short. Zero == flat. */
  size: Schema.Number,
  entryPrice: Schema.optional(Price),
  unrealisedPnl: Schema.Number,
  marginUsed: UsdAmount,
  /**
   * Confirmed protected size, where an exchange-native reduce-only stop is
   * verified in place. Zero when no protection is confirmed. §17.2 steps
   * 6–8: only canonical confirmation marks a position protected.
   */
  protectedSize: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Exchange liquidation price (`clearinghouseState.liquidationPx`). */
  liquidationPrice: Schema.optional(Price),
  /**
   * Current mark price. Derived from unrealised PnL until the protection layer
   * reads it from the asset context directly (see HyperliquidReconciler).
   */
  markPx: Schema.optional(Price),
  observedAt: UnixMillis,
});
export type TradingPositionSnapshot = typeof TradingPositionSnapshot.Type;

/**
 * A reconciled open order keyed by cloid (§18 `trading_orders`).
 */
export const TradingOpenOrderRecord = Schema.Struct({
  missionId: TradingId,
  cloid: TradingCloid,
  orderId: Schema.Number,
  market: TradingMarket,
  side: TradingOrderSide,
  limitPrice: Price,
  /** Remaining size after partial fills. */
  remainingSize: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  reduceOnly: Schema.Boolean,
  observedAt: UnixMillis,
});
export type TradingOpenOrderRecord = typeof TradingOpenOrderRecord.Type;

// ---------------------------------------------------------------------------
// §16.2 · Risk reservation ledger
// ---------------------------------------------------------------------------

/**
 * State of a risk reservation against the cumulative-loss budget.
 *
 * `reserved` while the execution is in flight; `released` once the fill
 * settles into open-position risk or the execution is rejected/cancelled.
 * Paid fees live in `realizedMissionResultUsd` and must never be
 * double-counted as unpaid open-position fees (§16.2).
 */
export const TradingReservationStatus = Schema.Literals(["reserved", "released"]);
export type TradingReservationStatus = typeof TradingReservationStatus.Type;

/**
 * A risk reservation against the cumulative-loss budget (§18
 * `trading_risk_reservations`, §16.2).
 *
 * A queued-but-unfilled entry reserves `pendingEntryRiskUsd` (planned loss
 * at stop + estimated entry fee + estimated exit fee + slippage reserve).
 * A filled position releases the pending reservation and the reconciler
 * opens `openPositionRiskUsd` against the actual entry/stop instead.
 */
export const TradingRiskReservation = Schema.Struct({
  reservationId: TradingId,
  missionId: TradingId,
  executionId: TradingId,
  cloid: TradingCloid,
  actionType: TradingExecutionActionType,

  /**
   * USD reserved against the budget for this execution. For a pending entry
   * this is `pendingEntryRiskUsd`; never double-counted with paid fees.
   */
  reservedRiskUsd: UsdAmount,
  status: TradingReservationStatus,

  reservedAt: UnixMillis,
  releasedAt: Schema.optional(UnixMillis),
});
export type TradingRiskReservation = typeof TradingRiskReservation.Type;

// ---------------------------------------------------------------------------
// §16.2 · Cumulative-loss accounting (the six equations)
// ---------------------------------------------------------------------------

/**
 * The cumulative-loss budget snapshot (§16.2). All six equations, evaluated
 * as pure functions over reconciled fills, positions, and reservations.
 *
 * `positivePnlExpandsLossBudget` is `false` by policy (§16.1): profits may
 * reduce `realizedLossUsedUsd` toward zero but never raise
 * `maximumCumulativeLossUsd`.
 */
export const TradingLossBudget = Schema.Struct({
  maximumCumulativeLossUsd: UsdAmount,

  closedPnlUsd: Schema.Number,
  netFundingUsd: Schema.Number,
  allPaidTradingFeesUsd: Schema.Number,

  realizedMissionResultUsd: Schema.Number,
  realizedLossUsedUsd: UsdAmount,

  /** Sum of `openPositionRiskUsd` across open positions. */
  openPositionRiskUsd: UsdAmount,
  /** Sum of `pendingEntryRiskUsd` across reserved, unfilled entries. */
  pendingEntryRiskUsd: UsdAmount,

  lossBudgetUsedUsd: UsdAmount,
  remainingCumulativeLossUsd: UsdAmount,

  /** True when `remainingCumulativeLossUsd` has reached zero (§16.4). */
  exhausted: Schema.Boolean,
  observedAt: UnixMillis,
});
export type TradingLossBudget = typeof TradingLossBudget.Type;

/**
 * Inputs to one `openPositionRiskUsd` (§16.2) for a single open position.
 *
 * `estimatedLossFromWeightedEntryToStopUsd` is floored at zero; unpaid exit
 * fees are the fees not yet paid on the remaining position; the slippage
 * reserve is `stopSlippageReserveBps` of the protected notional.
 */
export const TradingOpenPositionRiskInput = Schema.Struct({
  missionId: TradingId,
  direction: TradingDirection,
  /** Absolute size in base units. */
  size: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  weightedEntryPrice: Schema.optional(Price),
  stopPrice: Schema.optional(Price),
  /** USD fees already paid on this position (excluded from unpaid). */
  paidFeesUsd: UsdAmount,
  /** Estimated total exit fee at the taker rate. */
  estimatedExitFeeUsd: UsdAmount,
  /** Slippage reserve from `stopSlippageReserveBps` × protected notional. */
  stopSlippageReserveUsd: UsdAmount,
});
export type TradingOpenPositionRiskInput = typeof TradingOpenPositionRiskInput.Type;

/**
 * Inputs to one `pendingEntryRiskUsd` (§16.2) for a single reserved entry.
 */
export const TradingPendingEntryRiskInput = Schema.Struct({
  missionId: TradingId,
  plannedLossAtStopUsd: UsdAmount,
  estimatedEntryFeeUsd: UsdAmount,
  estimatedExitFeeUsd: UsdAmount,
  stopSlippageReserveUsd: UsdAmount,
});
export type TradingPendingEntryRiskInput = typeof TradingPendingEntryRiskInput.Type;
