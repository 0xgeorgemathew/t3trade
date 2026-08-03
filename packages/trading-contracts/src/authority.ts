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

/**
 * Testnet lab authority defaults — the mandate a ~$100 account can actually
 * trade under.
 *
 * `pocAuthorityDefaults` is written for the spec's $1,000 worked example and
 * does not scale down. On $100 it yields $2 of planned risk per position, and
 * $2 does not survive contact with the accounting: a $300 entry already spends
 * $0.75 on the 25 bps stop-slippage reserve and $0.30 on the two 5 bps fee
 * estimates before a single dollar of stop distance is bought. Entries come
 * back refused as unviable, or the harness compresses the stop until it sits
 * inside the noise and gets taken out by a wick.
 *
 * The four numbers, and why each is where it is (C = allocated capital):
 *
 * - `maximumLeverage: 20` — the operator's stated testnet ceiling. ETH on
 *   Hyperliquid testnet allows 25x, so this is T3's limit rather than the
 *   exchange's. Note that preview measures leverage as notional ÷ *mandate*,
 *   not notional ÷ margin, so in practice the gross cap below binds first;
 *   this number is the documented ceiling, not the working constraint.
 * - `maximumGrossNotionalUsd: 8 × C` — $800 on $100. At 20x that is $40 of
 *   isolated margin, leaving most of the account as headroom. Sized to what
 *   the loss budget can protect rather than to what the margin allows: the
 *   ~$2,000 the exchange would permit is notional the $35 budget cannot stand
 *   behind.
 * - `maximumCumulativeLossUsd: 0.35 × C` — $35 on $100. Roughly four full
 *   per-position risks, so a losing streak ends the mission rather than the
 *   account.
 * - `maximumPlannedRiskPerPositionUsd: 0.07 × C` — $7 on $100. At the largest
 *   allowed $800 entry (0.267 ETH near $3,000) that funds a stop 0.9% away;
 *   at a more typical $400 entry, 1.75%. Both are real distances on a 1m
 *   momentum timeframe, which is the whole test.
 *
 * Everything else — isolated margin only, reversal off, the risk policy — is
 * the POC mandate unchanged. This widens size, not permissions.
 */
export const testnetAuthorityDefaults = (allocatedCapitalUsd: number): TradingAuthority => ({
  ...pocAuthorityDefaults(allocatedCapitalUsd),

  maximumLeverage: 20,
  maximumGrossNotionalUsd: allocatedCapitalUsd * 8,
  // Written as percentages rather than as `× 0.35` / `× 0.07`: the decimal
  // forms land on 35.000000000000004 and 7.000000000000001, and a mandate the
  // user reads should not have a float artifact in it.
  maximumCumulativeLossUsd: (allocatedCapitalUsd * 35) / 100,
  maximumPlannedRiskPerPositionUsd: (allocatedCapitalUsd * 7) / 100,
});
