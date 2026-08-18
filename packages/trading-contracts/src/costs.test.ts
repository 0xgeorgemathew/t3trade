import { describe, expect, it } from "@effect/vitest";

import {
  costContextFromEstimate,
  estimateTradingCosts,
  notionalForProfitTarget,
  roundTripCostFractionOfNotional,
  targetNotionalForPlan,
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
    // The rung the trade aims at is 2 round trips; nothing gates on cost any
    // more (plan 29 step 3.1).
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

  it("recombines the components per order type when the maker rate differs", () => {
    const estimate = estimateTradingCosts(input({ takerFeeBpsPerSide: 5, makerFeeBpsPerSide: 1 }));

    expect(estimate.makerFeeBpsPerSide).toBe(1);
    // Maker/maker is two maker fees and nothing else: 2,000 x 1 bps x 2.
    expect(estimate.roundTripMakerMakerUsd).toBeCloseTo(0.4, 10);
    // Taker/maker is one taker fee (1.00) + one maker fee (0.20) + one crossing
    // of the 0.50 half spread; the size sits on the touch so no leg walks.
    expect(estimate.roundTripTakerMakerUsd).toBeCloseTo(1.7, 10);
    // The taker/taker total is untouched by the maker rate.
    expect(estimate.roundTripUsd).toBeCloseTo(3, 10);
    expect(estimate.notes.join(" ")).toContain("maker side pays no spread crossing");
    expect(estimate.degraded).toBe(false);
  });

  it("prices the taker leg of the mixed combination as the entry walk", () => {
    const estimate = estimateTradingCosts(
      input({
        sizeEth: 5,
        takerFeeBpsPerSide: 5,
        makerFeeBpsPerSide: 1,
        // Only the ask side is thin: the entry walk pays 8.00 where an exit
        // walk would pay nothing — pinning which leg carries the walk.
        asks: [
          { price: 2_000.5, size: 1 },
          { price: 2_002.5, size: 10 },
        ],
        bids: [{ price: 1_999.5, size: 10 }],
      }),
    );

    // 5 ETH @ 2,000 = 10,000 notional: 5.00 of taker fee + 1.00 of maker fee
    // + 2.50 of spread crossed once + the 8.00 entry walk.
    expect(estimate.roundTripTakerMakerUsd).toBeCloseTo(16.5, 10);
    expect(estimate.roundTripMakerMakerUsd).toBeCloseTo(2, 10);
    expect(estimate.buySlippageUsd).toBeCloseTo(8, 10);
    expect(estimate.sellSlippageUsd).toBe(0);
  });

  it("prices the maker combinations at the taker rate when no maker rate was given", () => {
    const estimate = estimateTradingCosts(input());

    expect(estimate.makerFeeBpsPerSide).toBe(5);
    expect(estimate.roundTripMakerMakerUsd).toBeCloseTo(2, 10);
    expect(estimate.roundTripTakerMakerUsd).toBeCloseTo(2.5, 10);
    // The assumption is recorded, and degrades nothing: the taker/taker total
    // it sits next to was measured, not substituted.
    expect(estimate.notes.join(" ")).toContain("priced at the taker rate");
    expect(estimate.degraded).toBe(false);
  });

  // The whole point of the tool is that a cost it could not read is visible as
  // such. A silent zero here is what a below-cost target looks like from above.
  it("flags a fallback fee rate rather than passing it off as read", () => {
    const estimate = estimateTradingCosts(input({ feeRateSource: "authority_fallback" }));
    expect(estimate.degraded).toBe(true);
    expect(estimate.notes.join(" ")).toContain("fallback");
    // The authority names one (taker) rate, so the maker combinations price at
    // it too — and say so, rather than passing the fallback off as a read.
    expect(estimate.makerFeeBpsPerSide).toBe(5);
    expect(estimate.notes.join(" ")).toContain("authority's fallback taker rate");
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

// The fee-only round trip, priced by hand: two taker fills and nothing else.
const feeOnlyRoundTripUsd = (notionalUsd: number, takerFeeBpsPerSide: number): number =>
  notionalUsd * (takerFeeBpsPerSide / 10_000) * 2;

// Plan 27 I4: the quick-trades objective runs on ~$1,000 test wallets, so the
// arithmetic has to close at that equity — the round trip itself must fit
// comfortably inside the mandate's risk budget, or every trade starts a
// fifteenth of the way to its stop.
describe("quick-trades sizing sanity at $1,000 equity (plan 27 I4)", () => {
  // The POC mandate at $1,000: $20 planned risk per position, $3,000 gross
  // notional cap, 5 bps fallback taker fee per side (authority.ts §10.4).
  const PLANNED_RISK_USD = 20;
  const FALLBACK_TAKER_FEE_BPS = 5;

  it("keeps the fee-only round trip well inside the risk budget at 1x capital", () => {
    const roundTripUsd = feeOnlyRoundTripUsd(1_000, FALLBACK_TAKER_FEE_BPS);
    expect(roundTripUsd).toBeCloseTo(1, 10);
    // $1.00 of fees against a $20 risk cap: fees are a twentieth of the
    // budget, not the reason to stand down.
    expect(roundTripUsd).toBeLessThanOrEqual(PLANNED_RISK_USD / 5);
  });

  it("stays fee-viable even at the full gross-notional cap", () => {
    const roundTripUsd = feeOnlyRoundTripUsd(3_000, FALLBACK_TAKER_FEE_BPS);
    expect(roundTripUsd).toBeCloseTo(3, 10);
    expect(roundTripUsd).toBeLessThan(PLANNED_RISK_USD);
  });
});

// The one-line context a flat wakeup carries (plan 29 step 3.1): USD and bps
// at a stated reference notional, plus the rung a target must clear — and
// nothing else.
describe("costContextFromEstimate", () => {
  it("reduces an estimate to the bounded line", () => {
    const estimate = estimateTradingCosts(input());
    const context = costContextFromEstimate(estimate);

    expect(context.referenceNotionalUsd).toBe(2_000);
    expect(context.roundTripUsd).toBeCloseTo(3, 10);
    // 3 USD on 2,000 of notional is 15 bps.
    expect(context.roundTripBps).toBeCloseTo(15, 10);
    // The rung a target must clear: twice the round trip, carried here because
    // the flat turn is the one that sets targets and has no `positionCosts`.
    expect(context.preferredTargetUsd).toBeCloseTo(6, 10);
    expect(Object.keys(context).sort()).toEqual([
      "preferredTargetUsd",
      "referenceNotionalUsd",
      "roundTripBps",
      "roundTripUsd",
    ]);
  });
});

describe("sizing a position to the target it is taken for", () => {
  const costFraction = roundTripCostFractionOfNotional({
    takerFeeBpsPerSide: 5,
    halfSpreadUsd: 0.1,
    referencePrice: 2_000,
  });

  it("prices the round trip as a share of notional, fees plus both crossings", () => {
    // 2 x 5bps = 0.1%, plus 2 x $0.10 on a $2,000 price = 0.01%.
    expect(costFraction).toBeCloseTo(0.001 + 0.0001, 10);
  });

  it("charges the maker fee and one crossing when the exit rests", () => {
    // Step 2.5 made the take-profit a resting order. Costing it as a second
    // taker fill overstates the round trip, shrinks the divisor the size is
    // solved through, and demands a bigger position for a target the trade
    // would have reached anyway.
    const maker = roundTripCostFractionOfNotional({
      takerFeeBpsPerSide: 4.5,
      makerFeeBpsPerSide: 1.5,
      halfSpreadUsd: 0.15,
      referencePrice: 3_000,
      exitIsMaker: true,
    });
    // 4.5 + 1.5 bps of fee, plus one 0.5 bp crossing.
    expect(maker).toBeCloseTo(0.00065, 10);

    const taker = roundTripCostFractionOfNotional({
      takerFeeBpsPerSide: 4.5,
      halfSpreadUsd: 0.15,
      referencePrice: 3_000,
    });
    expect(taker).toBeCloseTo(0.001, 10);

    // On a 30 bps expected move that is a $12,766 position rather than
    // $15,000 — 17% smaller, for the same target.
    const sizedMaker = notionalForProfitTarget({
      targetProfitUsd: 30,
      expectedPriceMoveUsd: 9,
      referencePrice: 3_000,
      costFractionOfNotional: maker,
    });
    expect(sizedMaker.notionalUsd).toBeCloseTo(12_765.96, 1);
  });

  it("prices a resting exit at the taker rate when no maker rate was read", () => {
    // The pessimistic maker, same convention as `estimateTradingCosts`.
    expect(
      roundTripCostFractionOfNotional({
        takerFeeBpsPerSide: 4.5,
        halfSpreadUsd: 0,
        referencePrice: 3_000,
        exitIsMaker: true,
      }),
    ).toBeCloseTo(0.0009, 10);
  });

  it("returns the notional that pays the target after the round trip", () => {
    const sized = notionalForProfitTarget({
      targetProfitUsd: 20,
      expectedPriceMoveUsd: 10,
      referencePrice: 2_000,
      costFractionOfNotional: costFraction,
    });

    // A $10 move on a $2,000 price is 0.5%; less the 0.11% round trip, each
    // dollar of notional keeps 0.39%, so $20 of target needs ~$5,128.
    expect(sized.moveFraction).toBeCloseTo(0.005, 10);
    expect(sized.netFraction).toBeCloseTo(0.0039, 10);
    expect(sized.notionalUsd).toBeCloseTo(20 / 0.0039, 6);
  });

  it("needs MORE notional as the target rises, never less", () => {
    const at = (targetProfitUsd: number): number =>
      notionalForProfitTarget({
        targetProfitUsd,
        expectedPriceMoveUsd: 10,
        referencePrice: 2_000,
        costFractionOfNotional: costFraction,
      }).notionalUsd ?? 0;

    expect(at(40)).toBeGreaterThan(at(20));
  });

  it("says no notional pays a target when the move cannot clear the costs", () => {
    const sized = notionalForProfitTarget({
      targetProfitUsd: 20,
      // 0.05% of price, under the 0.11% round trip.
      expectedPriceMoveUsd: 1,
      referencePrice: 2_000,
      costFractionOfNotional: costFraction,
    });

    expect(sized.notionalUsd).toBeNull();
    expect(sized.netFraction).toBeLessThan(0);
    expect(sized.reason).toContain("no notional pays this target");
  });

  it("is what targetNotionalForPlan composes, so the sizing and gating paths share it", () => {
    // The quote path and the market-structure cost read both size through
    // targetNotionalForPlan; pinning it to the manual composition here is
    // what keeps the two from drifting apart on what a target needs.
    expect(
      targetNotionalForPlan({
        targetProfitUsd: 20,
        expectedPriceMoveUsd: 10,
        referencePrice: 2_000,
        takerFeeBpsPerSide: 5,
        halfSpreadUsd: 0.1,
      }),
    ).toEqual(
      notionalForProfitTarget({
        targetProfitUsd: 20,
        expectedPriceMoveUsd: 10,
        referencePrice: 2_000,
        costFractionOfNotional: costFraction,
      }),
    );
  });
});

// Plan 28 defect 5: the sizing path and the gating path were answering the
// same question two different ways — the fraction excludes slippage, the
// estimate includes it. The agreement is on fees + spread exactly.
describe("the sizing fraction and the estimate agree (plan 28 defect 5)", () => {
  it("covers exactly fees plus spread at the same notional", () => {
    // A book thin enough to walk, so the estimate's total carries a real
    // slippage component the fraction cannot see — the agreement has to hold
    // anyway, on the two components the fraction claims to cover.
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
    expect(estimate.roundTripSlippageUsd).toBeGreaterThan(0);

    const fraction = roundTripCostFractionOfNotional({
      takerFeeBpsPerSide: estimate.takerFeeBpsPerSide,
      halfSpreadUsd: estimate.halfSpreadUsd,
      referencePrice: estimate.referencePrice,
    });

    // The fraction deliberately excludes slippage: it is the one round-trip
    // component that does not scale with notional, so folding it in would
    // make the fraction a function of the very size it exists to compute.
    // What must hold is that at the same notional it covers the fees and the
    // spread exactly, and nothing else.
    expect(fraction * estimate.notionalUsd).toBeCloseTo(
      estimate.roundTripFeeUsd + estimate.roundTripSpreadUsd,
      10,
    );
  });
});
