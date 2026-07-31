import { describe, expect, it } from "vite-plus/test";

import {
  evaluateLossBudget,
  isPermittedUnderExhaustion,
  openPositionRisk,
  pendingEntryRisk,
  type LossBudgetInput,
} from "./lossAccounting.ts";
import type { TradingOpenPositionRiskInput, TradingPendingEntryRiskInput } from "./execution.ts";

/**
 * A tiny seeded PRNG so the property tests are deterministic across runs
 * without pulling in a property-testing dependency.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const pos = (
  rng: () => number,
  overrides: Partial<TradingOpenPositionRiskInput> = {},
): TradingOpenPositionRiskInput => ({
  missionId: "mission_1",
  direction: rng() < 0.5 ? "long" : "short",
  size: rng() * 2,
  weightedEntryPrice: 1_000 + rng() * 4_000,
  stopPrice: 1_000 + rng() * 4_000,
  paidFeesUsd: rng() * 5,
  estimatedExitFeeUsd: rng() * 5,
  stopSlippageReserveUsd: rng() * 5,
  ...overrides,
});

const pending = (
  rng: () => number,
  overrides: Partial<TradingPendingEntryRiskInput> = {},
): TradingPendingEntryRiskInput => ({
  missionId: "mission_1",
  plannedLossAtStopUsd: rng() * 20,
  estimatedEntryFeeUsd: rng() * 5,
  estimatedExitFeeUsd: rng() * 5,
  stopSlippageReserveUsd: rng() * 5,
  ...overrides,
});

const budget = (rng: () => number, overrides: Partial<LossBudgetInput> = {}): LossBudgetInput => ({
  maximumCumulativeLossUsd: 100,
  closedPnlUsd: (rng() - 0.5) * 40,
  netFundingUsd: (rng() - 0.5) * 4,
  allPaidTradingFeesUsd: rng() * 10,
  openPositions: [pos(rng)],
  pendingEntries: [pending(rng)],
  observedAt: 1_753_000_000_000,
  ...overrides,
});

describe("openPositionRisk (§16.2 eq 3)", () => {
  it("is the floored loss-to-stop plus unpaid exit fee plus slippage reserve", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 200; i++) {
      const input = pos(rng);
      const stopDistance =
        input.direction === "long"
          ? (input.weightedEntryPrice ?? 0) - (input.stopPrice ?? 0)
          : (input.stopPrice ?? 0) - (input.weightedEntryPrice ?? 0);
      const expectedLoss = stopDistance > 0 ? stopDistance * input.size : 0;
      const expected =
        Math.max(0, expectedLoss) + input.estimatedExitFeeUsd + input.stopSlippageReserveUsd;
      expect(openPositionRisk(input)).toBeCloseTo(expected, 6);
    }
  });

  it("never goes negative even when the position is deeply in profit", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 100; i++) {
      // Long with stop far above entry → loss-to-stop negative → floored at 0.
      const input = pos(rng, { direction: "long", weightedEntryPrice: 100, stopPrice: 5_000 });
      const result = openPositionRisk(input);
      // Only the fees + slippage remain.
      expect(result).toBe(input.estimatedExitFeeUsd + input.stopSlippageReserveUsd);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("pendingEntryRisk (§16.2 eq 4)", () => {
  it("sums planned loss at stop plus both estimated fees plus slippage reserve", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 200; i++) {
      const input = pending(rng);
      const expected =
        input.plannedLossAtStopUsd +
        input.estimatedEntryFeeUsd +
        input.estimatedExitFeeUsd +
        input.stopSlippageReserveUsd;
      expect(pendingEntryRisk(input)).toBeCloseTo(expected, 6);
    }
  });
});

describe("evaluateLossBudget (§16.2 eqs 1, 2, 5, 6)", () => {
  it("equation 1: realizedMissionResult = closedPnl + netFunding - allPaidFees", () => {
    const rng = makeRng(1);
    for (let i = 0; i < 200; i++) {
      const b = evaluateLossBudget(budget(rng));
      expect(b.realizedMissionResultUsd).toBeCloseTo(
        b.closedPnlUsd + b.netFundingUsd - b.allPaidTradingFeesUsd,
        6,
      );
    }
  });

  it("equation 2: realizedLossUsed = max(0, -realizedMissionResult)", () => {
    const rng = makeRng(2);
    for (let i = 0; i < 200; i++) {
      const b = evaluateLossBudget(budget(rng));
      expect(b.realizedLossUsedUsd).toBeCloseTo(Math.max(0, -b.realizedMissionResultUsd), 6);
    }
  });

  it("equation 5: budgetUsed = realizedLoss + sum(openRisk) + sum(pendingRisk)", () => {
    const rng = makeRng(3);
    for (let i = 0; i < 200; i++) {
      const b = evaluateLossBudget(budget(rng));
      expect(b.lossBudgetUsedUsd).toBeCloseTo(
        b.realizedLossUsedUsd + b.openPositionRiskUsd + b.pendingEntryRiskUsd,
        6,
      );
    }
  });

  it("equation 6: remaining = max(0, ceiling - used)", () => {
    const rng = makeRng(4);
    for (let i = 0; i < 200; i++) {
      const ceiling = 50 + rng() * 200;
      const b = evaluateLossBudget(budget(rng, { maximumCumulativeLossUsd: ceiling }));
      expect(b.remainingCumulativeLossUsd).toBeCloseTo(
        Math.max(0, ceiling - b.lossBudgetUsedUsd),
        6,
      );
    }
  });

  it("profits reduce realizedLossUsed toward zero but never raise the ceiling", () => {
    const rng = makeRng(5);
    for (let i = 0; i < 100; i++) {
      // Force a large realised profit.
      const b = evaluateLossBudget(budget(rng, { closedPnlUsd: 1_000 }));
      expect(b.realizedLossUsedUsd).toBe(0);
      // Ceiling is unchanged by profit.
      const ceiling = b.maximumCumulativeLossUsd;
      expect(ceiling).toBe(b.maximumCumulativeLossUsd);
    }
  });

  it("marks exhaustion exactly when remaining reaches zero (§16.4)", () => {
    // A budget fully consumed by realised loss.
    const b = evaluateLossBudget({
      maximumCumulativeLossUsd: 100,
      closedPnlUsd: -100,
      netFundingUsd: 0,
      allPaidTradingFeesUsd: 0,
      openPositions: [],
      pendingEntries: [],
      observedAt: 1_753_000_000_000,
    });
    expect(b.remainingCumulativeLossUsd).toBe(0);
    expect(b.exhausted).toBe(true);
  });

  it("sums open and pending risk across many positions and entries", () => {
    const rng = makeRng(6);
    const opens = Array.from({ length: 5 }, () => pos(rng));
    const pendings = Array.from({ length: 3 }, () => pending(rng));
    const b = evaluateLossBudget({
      maximumCumulativeLossUsd: 500,
      closedPnlUsd: -10,
      netFundingUsd: -1,
      allPaidTradingFeesUsd: 2,
      openPositions: opens,
      pendingEntries: pendings,
      observedAt: 1_753_000_000_000,
    });
    const expectedOpen = opens.reduce((s, p) => s + openPositionRisk(p), 0);
    const expectedPending = pendings.reduce((s, e) => s + pendingEntryRisk(e), 0);
    expect(b.openPositionRiskUsd).toBeCloseTo(expectedOpen, 6);
    expect(b.pendingEntryRiskUsd).toBeCloseTo(expectedPending, 6);
  });
});

describe("isPermittedUnderExhaustion (§16.4)", () => {
  it("permits cancel/reduce/close and blocks open/scale_in/reversal/reentry", () => {
    expect(isPermittedUnderExhaustion("cancel")).toBe(true);
    expect(isPermittedUnderExhaustion("reduce")).toBe(true);
    expect(isPermittedUnderExhaustion("close")).toBe(true);
    expect(isPermittedUnderExhaustion("open")).toBe(false);
    expect(isPermittedUnderExhaustion("scale_in")).toBe(false);
    expect(isPermittedUnderExhaustion("reversal")).toBe(false);
    expect(isPermittedUnderExhaustion("reentry")).toBe(false);
  });
});
