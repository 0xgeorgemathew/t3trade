/**
 * Trading authority and risk policy - spec §10.4.
 *
 * `TradingAuthority` is the user-authorized limit set; `TradingRiskPolicy` is
 * the deterministic fee and slippage accounting policy. The POC defaults are
 * deliberately narrower than the type allows: the type admits cross margin and
 * direction reversal so a user can grant them later, the defaults do not.
 *
 * @module TradingAuthority
 */
import { Schema } from "effect";
import { PositiveUsdAmount, UnixMillis, UsdAmount } from "./primitives.ts";

export const TradingDirection = Schema.Literals(["long", "short"]);
export type TradingDirection = typeof TradingDirection.Type;

export const TradingMarginMode = Schema.Literals(["cross", "isolated"]);
export type TradingMarginMode = typeof TradingMarginMode.Type;

/**
 * `"until_revoked"` for an open-ended mandate, otherwise an expiry in epoch
 * millis.
 *
 * The sentinel used to be spelled `"revoked"`, which read as a statement of
 * fact rather than a duration. The whole authority is handed to the harness in
 * its mission context, and a harness that reads `validUntil: "revoked"` quite
 * reasonably concludes its mandate is gone and refuses to trade. The value is
 * never enforced anywhere — it is documentation for the model — so it has to
 * say what it means.
 */
export const TradingAuthorityValidUntil = Schema.Union([
  Schema.Literal("until_revoked"),
  UnixMillis,
]);
export type TradingAuthorityValidUntil = typeof TradingAuthorityValidUntil.Type;

export const TradingRiskPolicy = Schema.Struct({
  feeRateSource: Schema.Literal("hyperliquid_user_fees"),
  fallbackTakerFeeBpsPerSide: Schema.Number,
  stopSlippageReserveBps: Schema.Number,
  positivePnlExpandsLossBudget: Schema.Literal(false),
});
export type TradingRiskPolicy = typeof TradingRiskPolicy.Type;

export const TradingAuthority = Schema.Struct({
  allocatedCapitalUsd: PositiveUsdAmount,
  allowedDirections: Schema.Array(TradingDirection),

  maximumLeverage: Schema.Number.check(Schema.isGreaterThan(0)),
  maximumGrossNotionalUsd: UsdAmount,
  maximumCumulativeLossUsd: UsdAmount,
  maximumPlannedRiskPerPositionUsd: UsdAmount,

  marginModes: Schema.Array(TradingMarginMode),

  allowScaleIn: Schema.Boolean,
  allowPartialReduction: Schema.Boolean,
  allowReentry: Schema.Boolean,
  allowDirectionReversal: Schema.Boolean,

  /**
   * The fee/slippage policy the budget reserve and preview apply. Defaults to
   * `pocRiskPolicyDefaults` when the mission creator does not override it.
   */
  riskPolicy: TradingRiskPolicy,

  validUntil: TradingAuthorityValidUntil,
});
export type TradingAuthority = typeof TradingAuthority.Type;

/**
 * POC risk-policy defaults - spec §10.4.
 *
 * Taker fee rate sourced from Hyperliquid `userFees`, falling back to 5 bps per
 * side when the read is stale/unreadable. Stop-slippage reserve is 25 bps of
 * protected notional. Positive PnL does not expand the loss budget (§16.2).
 */
export const pocRiskPolicyDefaults: TradingRiskPolicy = {
  feeRateSource: "hyperliquid_user_fees",
  fallbackTakerFeeBpsPerSide: 5,
  stopSlippageReserveBps: 25,
  positivePnlExpandsLossBudget: false,
};

/**
 * POC authority defaults - spec §10.4.
 *
 * A $1,000 mandate yields 3x leverage, $3,000 gross notional, a $100 cumulative
 * loss budget, and $20 planned risk per position. The harness may choose lower
 * exposure; it may never exceed these.
 */
export const pocAuthorityDefaults = (allocatedCapitalUsd: number): TradingAuthority => ({
  allocatedCapitalUsd,
  allowedDirections: ["long", "short"],

  maximumLeverage: 3,
  maximumGrossNotionalUsd: allocatedCapitalUsd * 3,
  maximumCumulativeLossUsd: allocatedCapitalUsd * 0.1,
  maximumPlannedRiskPerPositionUsd: allocatedCapitalUsd * 0.02,

  // POC decision: isolated margin only. Reject the mission if
  // isolated is unavailable; do not fall back to cross.
  marginModes: ["isolated"],

  allowScaleIn: true,
  allowPartialReduction: true,
  allowReentry: true,
  // POC decision: reversal off by default. Reversal is a harness
  // power the user must grant explicitly via an authority patch.
  allowDirectionReversal: false,

  riskPolicy: pocRiskPolicyDefaults,

  validUntil: "until_revoked",
});
