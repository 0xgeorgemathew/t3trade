/**
 * The mandate a mission is created under, and the knobs that adjust it.
 *
 * `testnetAuthorityDefaults` carries the reasoning about the numbers; this
 * module is only the seam where an operator can move them without a rebuild.
 * It follows `AutoMissionConfig`'s shape deliberately — a pure function over an
 * env bag, so the resolution is testable without a process — and its rule for
 * bad input is the same: a value that is not a positive finite number falls
 * back to the default rather than failing. A typo'd risk ceiling must not be
 * the thing that stops a mission from being created; the documented default is
 * the safer answer.
 *
 *   - `T3_TRADES_AUTHORITY_MAX_LEVERAGE`
 *   - `T3_TRADES_AUTHORITY_MAX_GROSS_NOTIONAL_USD`
 *   - `T3_TRADES_AUTHORITY_MAX_CUMULATIVE_LOSS_USD`
 *   - `T3_TRADES_AUTHORITY_MAX_PLANNED_RISK_USD`
 *
 * All four are absolute values, not multiples of capital: an operator raising a
 * ceiling is thinking in dollars about a specific account, not in ratios.
 *
 * These widen or narrow size only. Nothing here can grant direction reversal,
 * switch margin mode, or touch the risk policy — those are authority the user
 * grants explicitly, not a number in the environment.
 *
 * @module TestnetAuthority
 */
import { testnetAuthorityDefaults } from "@t3tools/trading-contracts/authority";
import type { TradingAuthority } from "@t3tools/trading-contracts/authority";

/** A positive finite override, or `null` when the variable is unset or junk. */
const positiveNumber = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * The authority a new mission gets: the testnet preset for this capital, with
 * any env override applied on top.
 */
export const resolveTestnetAuthority = (
  env: Record<string, string | undefined>,
  allocatedCapitalUsd: number,
): TradingAuthority => {
  const base = testnetAuthorityDefaults(allocatedCapitalUsd);

  const maximumLeverage = positiveNumber(env.T3_TRADES_AUTHORITY_MAX_LEVERAGE);
  const maximumGrossNotionalUsd = positiveNumber(env.T3_TRADES_AUTHORITY_MAX_GROSS_NOTIONAL_USD);
  const maximumCumulativeLossUsd = positiveNumber(env.T3_TRADES_AUTHORITY_MAX_CUMULATIVE_LOSS_USD);
  const maximumPlannedRiskPerPositionUsd = positiveNumber(
    env.T3_TRADES_AUTHORITY_MAX_PLANNED_RISK_USD,
  );

  return {
    ...base,
    ...(maximumLeverage === null ? {} : { maximumLeverage }),
    ...(maximumGrossNotionalUsd === null ? {} : { maximumGrossNotionalUsd }),
    ...(maximumCumulativeLossUsd === null ? {} : { maximumCumulativeLossUsd }),
    ...(maximumPlannedRiskPerPositionUsd === null ? {} : { maximumPlannedRiskPerPositionUsd }),
  };
};
