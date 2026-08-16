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
import { OrderPreference } from "./strategy.ts";

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
 * `gtc` rests at the limit until cancelled; `alo` (add-limit-only) rests as
 * post-only — the exchange rejects it rather than let it take liquidity, so
 * the mapper refuses a limit that would have crossed before signing. The
 * harness expresses a preference via `OrderPreference`; the order
 * mapper turns it into one of these.
 */
export const TradingOrderTimeInForce = Schema.Literals(["ioc", "gtc", "alo"]);
export type TradingOrderTimeInForce = typeof TradingOrderTimeInForce.Type;

/**
 * The action-type discriminator fed into the deterministic cloid (§15.5) and
 * the execution-sequence counter. Retries of the *same* action reuse the
 * same `(executionSequence, actionType)` and therefore the same cloid.
 *
 * Two of these never place a position-taking order. `cancel` withdraws one
 * resting order named by `targetCloid`; `modify_stop` moves the reduce-only
 * protection on an open position to a new trigger price. Both are exposure-
 * reducing, so they carry no stop requirement and stay permitted under §16.4
 * exhaustion — see `isPositionIncreasing` and `isPermittedUnderExhaustion`,
 * which read the same names.
 */
export const TradingExecutionActionType = Schema.Literals([
  "open",
  "scale_in",
  "reduce",
  "close",
  "cancel",
  "modify_stop",
]);
export type TradingExecutionActionType = typeof TradingExecutionActionType.Type;

// ---------------------------------------------------------------------------
// §15.5 · Client order id (cloid) — deterministic, 16 bytes
// ---------------------------------------------------------------------------

/**
 * The deterministic client order id (§15.5).
 *
 * `derive16Bytes(missionId, executionSequence, actionType)` — SHA-256 of the
 * concatenated inputs, truncated to the first 16 bytes, hex-encoded as a
 * `0x`-prefixed 34-character string.
 *
 * The `0x` prefix is the Hyperliquid wire convention (the exchange validates
 * `len(cloid[2:]) == 32`). An unprefixed cloid is accepted on submission and
 * then silently stored as `null`, which is how the Gate-E entry ended up
 * unjoinable to its own fill — see `HyperliquidCloid` for that finding.
 */
export const TradingCloid = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{32}$/));
export type TradingCloid = typeof TradingCloid.Type;

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
  orderPreference: OrderPreference,
  limitPrice: Price,

  /**
   * Required for every position-increasing action (§16.3 item 17, §17).
   *
   * Optional in the schema, not optional in behaviour: a reduce-only action is
   * itself an exit and carries no stop, while an increase without one is
   * refused by the mandatory-stop gate (`checkStopInformation`) at preview and
   * again immediately before signing. Encoding "required" in the decoder
   * instead would put the safety rule in a place neither gate can test.
   */
  stop: Schema.optional(TradingStopInfo),

  reduceOnly: Schema.Boolean,

  /**
   * The resting order a `cancel` withdraws, as its client order id.
   *
   * Required for `cancel` and meaningless for every other action type; the
   * reactor rejects a `cancel` without one rather than guessing which of the
   * mission's orders was meant.
   */
  targetCloid: Schema.optional(TradingCloid),
});
export type TradingOrderIntent = typeof TradingOrderIntent.Type;

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
 * The statuses an execution attempt sits in while it is still in flight.
 *
 * A record is written at `previewed`, reserved, signed, and moved to
 * `submitted` before the POST; nothing after that is pending, because
 * `accepted`, `filled`, `rejected`, `cancelled` and `failed` all mean the
 * exchange has answered. Preview item 16 refuses a new entry while one of these
 * exists, the reconciler settles them, and the mission service reports them —
 * three readers of one set, which is why it lives here and not in three SQL
 * literals free to disagree about, say, whether `previewed` counts.
 */
export const PENDING_EXECUTION_STATUSES = [
  "previewed",
  "reserved",
  "signed",
  "submitted",
] as const satisfies ReadonlyArray<TradingExecutionStatus>;

/**
 * Pending, plus `accepted`: an accepted order rests on the book and has not
 * reached a terminal status either, so a settlement pass has to look at it even
 * though a new entry is no longer blocked by it.
 */
export const NON_TERMINAL_EXECUTION_STATUSES = [
  ...PENDING_EXECUTION_STATUSES,
  "accepted",
] as const satisfies ReadonlyArray<TradingExecutionStatus>;

/** True while an execution attempt is still in flight (§18). */
export function isPendingExecutionStatus(status: string): boolean {
  return (PENDING_EXECUTION_STATUSES as ReadonlyArray<string>).includes(status);
}

/**
 * Per-order status as returned by the exchange, recorded verbatim (§17.2
 * step 4: inspect EVERY per-order status; do not assume batch atomicity).
 */
export const TradingOrderResultStatus = Schema.Literals([
  "filled",
  "resting",
  "waiting_for_fill",
  /**
   * A parent-linked TP/SL child whose parent has not fully filled. Present in
   * the response and NOT live protection (§17.1) — the distinction this
   * literal exists to preserve.
   */
  "waiting_for_trigger",
  "success",
  "error",
]);
export type TradingOrderResultStatus = typeof TradingOrderResultStatus.Type;

/**
 * A single per-order result from a grouped submission (§17.2 step 4).
 * The exchange returns one status per order in a batch; T3 records each.
 */
export const TradingOrderResult = Schema.Struct({
  /**
   * The cloid this row belongs to. Positional: the exchange returns statuses
   * in submission order, and a `filled` row does not always echo the cloid
   * back, so the submitter attributes each row to the leg it sent.
   */
  cloid: Schema.String,
  status: TradingOrderResultStatus,
  /** Exchange-assigned order id when available. */
  orderId: Schema.optional(Schema.Number),
  /** Executed size on a `filled` row. */
  filledSize: Schema.optional(Schema.Number),
  /** Error/reason text when status is `error`. */
  reason: Schema.optional(Schema.String),
  /** Which leg of the submission this was. */
  role: Schema.optional(Schema.Literals(["entry", "protection"])),
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
  /**
   * Where this fill sat in the position's life — the exchange's own `dir`,
   * verbatim: "Open Long", "Close Long", "Open Short", "Close Short", or a
   * reversal like "Long > Short".
   *
   * Recorded rather than derived because it cannot be recovered afterwards. A
   * sell is an open on a short and a close on a long, and the running position
   * that would tell the two apart is not in the fill. Optional: rows written
   * before this was carried, and any fill the exchange sent without it, simply
   * have no lifecycle to report.
   */
  direction: Schema.optional(Schema.String),
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
  /**
   * Leverage the exchange has this market configured at, e.g. 20.
   *
   * A setting rather than a measurement, so it is the one column that survives
   * the mission going flat: the leverage its next entry will run at is the same
   * one its last entry ran at, and its receipts are read long after the position
   * they belong to has closed.
   */
  leverage: Schema.optional(Schema.Number),
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
