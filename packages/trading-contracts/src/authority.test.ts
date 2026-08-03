import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  pocAuthorityDefaults,
  pocRiskPolicyDefaults,
  TradingAuthority,
  TradingRiskPolicy,
} from "./authority.ts";

const decodeAuthority = Schema.decodeUnknownSync(TradingAuthority);
const decodeRiskPolicy = Schema.decodeUnknownSync(TradingRiskPolicy);

describe("pocAuthorityDefaults (§10.4 worked example)", () => {
  const authority = pocAuthorityDefaults(1_000);

  it("derives the published $1,000 mandate exactly", () => {
    expect(authority).toEqual({
      allocatedCapitalUsd: 1_000,
      allowedDirections: ["long", "short"],
      maximumLeverage: 3,
      maximumGrossNotionalUsd: 3_000,
      maximumCumulativeLossUsd: 100,
      maximumPlannedRiskPerPositionUsd: 20,
      marginModes: ["isolated"],
      allowScaleIn: true,
      allowPartialReduction: true,
      allowReentry: true,
      allowDirectionReversal: false,
      riskPolicy: {
        feeRateSource: "hyperliquid_user_fees",
        fallbackTakerFeeBpsPerSide: 5,
        stopSlippageReserveBps: 25,
        positivePnlExpandsLossBudget: false,
      },
      validUntil: "until_revoked",
    });
  });

  it("is 3x leverage on a $3,000 notional ceiling", () => {
    expect(authority.maximumLeverage).toBe(3);
    expect(authority.maximumGrossNotionalUsd).toBe(3_000);
    expect(authority.maximumGrossNotionalUsd).toBe(authority.allocatedCapitalUsd * 3);
  });

  it("budgets $100 cumulative loss and $20 planned risk per position", () => {
    expect(authority.maximumCumulativeLossUsd).toBe(100);
    expect(authority.maximumPlannedRiskPerPositionUsd).toBe(20);
  });

  it("is isolated-margin only, with reversal off", () => {
    expect(authority.marginModes).toEqual(["isolated"]);
    expect(authority.marginModes).not.toContain("cross");
    expect(authority.allowDirectionReversal).toBe(false);
  });

  it("permits both directions, scale-in, partial reduction, and re-entry", () => {
    expect(authority.allowedDirections).toEqual(["long", "short"]);
    expect(authority.allowScaleIn).toBe(true);
    expect(authority.allowPartialReduction).toBe(true);
    expect(authority.allowReentry).toBe(true);
  });

  it("stays open-ended until revoked", () => {
    expect(authority.validUntil).toBe("until_revoked");
  });

  // The harness reads the whole authority verbatim in its mission context. The
  // sentinel was once spelled "revoked", and a live mission's harness reported
  // its own mandate as revoked and placed no orders. It must name a duration,
  // never a state the mission might actually be in.
  it("never spells the open-ended sentinel as a terminal mission status", () => {
    expect(authority.validUntil).not.toBe("revoked");
    expect(authority.validUntil).not.toBe("completed");
  });

  it("decodes as a TradingAuthority", () => {
    expect(decodeAuthority(authority)).toEqual(authority);
  });

  it("scales the ratios with the mandate", () => {
    const larger = pocAuthorityDefaults(5_000);
    expect(larger.maximumGrossNotionalUsd).toBe(15_000);
    expect(larger.maximumCumulativeLossUsd).toBe(500);
    expect(larger.maximumPlannedRiskPerPositionUsd).toBe(100);
    // The POC decisions do not vary with size.
    expect(larger.maximumLeverage).toBe(3);
    expect(larger.marginModes).toEqual(["isolated"]);
    expect(larger.allowDirectionReversal).toBe(false);
  });
});

describe("pocRiskPolicyDefaults (§10.4)", () => {
  it("matches the published policy", () => {
    expect(pocRiskPolicyDefaults).toEqual({
      feeRateSource: "hyperliquid_user_fees",
      fallbackTakerFeeBpsPerSide: 5,
      stopSlippageReserveBps: 25,
      positivePnlExpandsLossBudget: false,
    });
  });

  it("never lets positive PnL expand the loss budget", () => {
    expect(pocRiskPolicyDefaults.positivePnlExpandsLossBudget).toBe(false);
  });

  it("decodes as a TradingRiskPolicy", () => {
    expect(decodeRiskPolicy(pocRiskPolicyDefaults)).toEqual(pocRiskPolicyDefaults);
  });
});
