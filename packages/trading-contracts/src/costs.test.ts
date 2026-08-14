import { describe, expect, it } from "@effect/vitest";

import {
  checkProfitTarget,
  estimateTradingCosts,
  feeOnlyRoundTripUsd,
  ENTRY_COST_MULTIPLE,
  PROFIT_TARGET_COST_MULTIPLE,
  walkBook,
  type CostEstimateInput,
} from "./costs.ts";

const freshness = { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 } as const;

const input = (overrides: Partial<CostEstimateInput> = {}): CostEstimateInput => ({
  market: "ETH",
  sizeEth: 1,
  referencePrice: 2_000,
  takerFeeBpsPerSide: 5,
  feeRateSource: "hyperliquid_user_fees",
  bids: [
    { price: 1_999.5, size: 10 },
    { price: 1_999, size: 10 },
  ],
  asks: [
    { price: 2_000.5, size: 10 },
    { price: 2_001, size: 10 },
  ],
  measuredAt: 1_000,
  freshness,
  ...overrides,
});

describe("walkBook", () => {
  it("charges only what the walk costs beyond the touch", () => {
    // 3 at the touch is free; the next 2 pay 1.00 each.
    const walked = walkBook(
      [
        { price: 2_000, size: 3 },
        { price: 2_001, size: 5 },
      ],
      5,
    );
    expect(walked.filled).toBe(5);
    expect(walked.slippageUsd).toBeCloseTo(2, 10);
  });

  // Never extrapolate past the last visible level: the price out there is not
  // something a book read knows, and inventing one understates the cost.
  it("reports a partial fill rather than guessing past the last level", () => {
    const walked = walkBook([{ price: 2_000, size: 1 }], 4);
    expect(walked.filled).toBe(1);
    expect(walked.slippageUsd).toBe(0);
  });

  it("costs nothing on an empty book", () => {
    expect(walkBook([], 5)).toEqual({ slippageUsd: 0, filled: 0 });
  });
});

describe("estimateTradingCosts", () => {
  it("itemises the round trip without double-counting the spread", () => {
    const estimate = estimateTradingCosts(input());

    // 1 ETH @ 2000 = 2000 notional; 5 bps/side = 1.00 per fill.
    expect(estimate.notionalUsd).toBe(2_000);
    expect(estimate.entryFeeUsd).toBeCloseTo(1, 10);
    expect(estimate.roundTripFeeUsd).toBeCloseTo(2, 10);
    // Spread is 1.00 wide, so half is 0.50 and crossing it twice costs 1.00.
    expect(estimate.halfSpreadUsd).toBeCloseTo(0.5, 10);
    expect(estimate.roundTripSpreadUsd).toBeCloseTo(1, 10);
    // 1 ETH sits entirely on the touch of both sides — nothing walks.
    expect(estimate.roundTripSlippageUsd).toBe(0);
    expect(estimate.roundTripUsd).toBeCloseTo(3, 10);
    expect(estimate.breakEvenPriceMoveUsd).toBeCloseTo(3, 10);
    // The entry floor is 1.3 round trips; the rung the trade aims at is 2.
    expect(estimate.minimumViableTargetUsd).toBeCloseTo(3.9, 10);
    expect(estimate.preferredTargetUsd).toBeCloseTo(6, 10);
    expect(estimate.degraded).toBe(false);
  });

  it("walks both sides of the book, because a round trip pays both", () => {
    const estimate = estimateTradingCosts(
      input({
        sizeEth: 5,
        asks: [
          { price: 2_000.5, size: 1 },
          { price: 2_002.5, size: 10 },
        ],
        bids: [
          { price: 1_999.5, size: 1 },
          { price: 1_997.5, size: 10 },
        ],
      }),
    );
    // 4 of the 5 walk one level, 2.00 away, on each side.
    expect(estimate.buySlippageUsd).toBeCloseTo(8, 10);
    expect(estimate.sellSlippageUsd).toBeCloseTo(8, 10);
    expect(estimate.roundTripSlippageUsd).toBeCloseTo(16, 10);
    expect(estimate.bookDepthSufficient).toBe(true);
  });

  // The whole point of the tool is that a cost it could not read is visible as
  // such. A silent zero here is what a below-cost target looks like from above.
  it("flags a fallback fee rate rather than passing it off as read", () => {
    const estimate = estimateTradingCosts(input({ feeRateSource: "authority_fallback" }));
    expect(estimate.degraded).toBe(true);
    expect(estimate.notes.join(" ")).toContain("fallback");
  });

  it("flags a book too thin to absorb the size", () => {
    const estimate = estimateTradingCosts(
      input({ sizeEth: 50, asks: [{ price: 2_000.5, size: 1 }] }),
    );
    expect(estimate.bookDepthSufficient).toBe(false);
    expect(estimate.degraded).toBe(true);
  });

  it("reports no book at all instead of a zero-cost trade", () => {
    const estimate = estimateTradingCosts(input({ bids: [], asks: [] }));
    expect(estimate.degraded).toBe(true);
    expect(estimate.notes.join(" ")).toContain("no readable book");
    // Fees are still real even with no book to price the rest from.
    expect(estimate.roundTripUsd).toBeCloseTo(2, 10);
  });

  it("prices funding on the notional only when a rate was supplied", () => {
    expect(estimateTradingCosts(input()).fundingCostPer8hUsd).toBeUndefined();
    const funded = estimateTradingCosts(input({ fundingRatePer8h: 0.0001 }));
    expect(funded.fundingCostPer8hUsd).toBeCloseTo(0.2, 10);
  });
});

describe("checkProfitTarget", () => {
  const basis = {
    measuredMoveUsd: 7,
    referencePrice: 2_000,
    positionNotionalUsd: 2_000,
  };

  it("accepts a target that follows from its basis and clears the floor", () => {
    // (7 / 2000) x 2000 = 7.00, and the fee-only floor is 2.00.
    const check = checkProfitTarget({
      targetProfitUsd: 7,
      basis,
      takerFeeBpsPerSide: 5,
    });
    expect(check.rejections).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it("rejects a target with no basis at all", () => {
    const check = checkProfitTarget({
      targetProfitUsd: 7,
      basis: undefined,
      takerFeeBpsPerSide: 5,
    });
    expect(check.rejections).toEqual(["target_basis_missing"]);
    expect(check.messages[0]).toContain("targetProfitBasis");
  });

  it("rejects a target the basis next to it does not produce", () => {
    const check = checkProfitTarget({
      targetProfitUsd: 20,
      basis,
      takerFeeBpsPerSide: 5,
    });
    expect(check.rejections).toEqual(["target_basis_arithmetic_mismatch"]);
  });

  it("tolerates the rounding a harness does when it writes the number down", () => {
    const check = checkProfitTarget({
      targetProfitUsd: 7.2,
      basis,
      takerFeeBpsPerSide: 5,
    });
    expect(check.rejections).toEqual([]);
  });

  // The $1.70 that started all this: derived correctly, and under the ~$2.00 it
  // cost to open and close. It warns rather than rejects until a testnet soak.
  it("warns, without rejecting, when the target does not clear twice its cost", () => {
    const check = checkProfitTarget({
      targetProfitUsd: 1.7,
      basis: { measuredMoveUsd: 1.7, referencePrice: 2_000, positionNotionalUsd: 2_000 },
      takerFeeBpsPerSide: 5,
    });
    expect(check.rejections).toEqual([]);
    expect(check.warnings).toEqual(["target_below_cost_floor"]);
    expect(check.messages[0]).toContain("round-trip cost");
  });

  // Standing down is the answer the guidance asks for when the window is quiet;
  // grading the arithmetic of a stand-down would reject the honest response.
  it("does not grade the arithmetic of a declared stand-down", () => {
    const check = checkProfitTarget({
      targetProfitUsd: 5,
      basis: { ...basis, measuredMoveUsd: 0, insufficientVolatility: true },
      takerFeeBpsPerSide: 5,
    });
    expect(check.rejections).toEqual([]);
  });
});

describe("feeOnlyRoundTripUsd", () => {
  it("is two taker fills and nothing else", () => {
    expect(feeOnlyRoundTripUsd(2_000, 5)).toBeCloseTo(2, 10);
    expect(feeOnlyRoundTripUsd(2_000, 5) * PROFIT_TARGET_COST_MULTIPLE).toBeCloseTo(4, 10);
  });
});

// Plan 27 I4: the quick-trades objective runs on ~$1,000 test wallets, so the
// arithmetic has to close at that equity — a minimum viable target the fee
// floor demands must fit comfortably inside the mandate's risk budget, or
// every "no trade" would be the fees' fault rather than the market's.
describe("quick-trades sizing sanity at $1,000 equity (plan 27 I4)", () => {
  // The POC mandate at $1,000: $20 planned risk per position, $3,000 gross
  // notional cap, 5 bps fallback taker fee per side (authority.ts §10.4).
  const PLANNED_RISK_USD = 20;
  const FALLBACK_TAKER_FEE_BPS = 5;

  it("keeps the fee-floor target well inside the risk budget at 1x capital", () => {
    const roundTripUsd = feeOnlyRoundTripUsd(1_000, FALLBACK_TAKER_FEE_BPS);
    expect(roundTripUsd).toBeCloseTo(1, 10);
    const minimumViableTargetUsd = roundTripUsd * ENTRY_COST_MULTIPLE;
    // $1.30 of target against a $20 risk cap: fees are a fifteenth of the
    // budget, not the reason to stand down.
    expect(minimumViableTargetUsd).toBeCloseTo(1.3, 10);
    expect(minimumViableTargetUsd).toBeLessThanOrEqual(PLANNED_RISK_USD / 5);
  });

  it("stays fee-viable even at the full gross-notional cap", () => {
    const roundTripUsd = feeOnlyRoundTripUsd(3_000, FALLBACK_TAKER_FEE_BPS);
    const minimumViableTargetUsd = roundTripUsd * ENTRY_COST_MULTIPLE;
    // $3.90 at $3,000 notional still clears inside the $20 planned risk, so
    // the sizing constants need no D2-gated adjustment for the small wallet.
    expect(minimumViableTargetUsd).toBeCloseTo(3.9, 10);
    expect(minimumViableTargetUsd).toBeLessThan(PLANNED_RISK_USD);
  });
});
