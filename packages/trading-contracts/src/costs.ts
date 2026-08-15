/**
 * What a round trip costs, and whether a published target follows from its
 * basis.
 *
 * The harness could measure volatility precisely and still publish a target
 * below break-even, because nothing it could read told it what a trade costs.
 * Fees were modeled carefully in loss accounting and in the execution preview,
 * and exposed to the agent nowhere. A $1.70 target on ~$2,000 of notional was
 * the result: arithmetically correct, and under the ~$2.00 it costs to open and
 * close the position.
 *
 * Everything here is pure arithmetic over numbers the caller has already read —
 * the fee rate, the book, the mark. Nothing is modeled, assumed, or annualised,
 * and nothing silently reads zero: a missing fee rate, a book too thin to walk,
 * or an absent funding rate is reported in `notes` and flips `degraded`, so a
 * cost estimate that could not be computed never reads as a cost of nothing.
 *
 * @module TradingCosts
 */
import { Schema } from "effect";
import { FreshnessMeta, OrderBookLevel } from "./market.ts";
import { ACTIVE_TRADING_POLICY } from "./policy.ts";
import { ExchangeMarket, Price, UnixMillis } from "./primitives.ts";

/**
 * How many round trips the target a trade is AIMING at should be worth.
 *
 * Not a gate. It is the rung the basis is written to and the number the
 * management turns argue against — is the profit in hand worth the exit that
 * realises it, and is there enough left on offer to justify extending.
 */
export const PROFIT_TARGET_COST_MULTIPLE = ACTIVE_TRADING_POLICY.momentum.targetCostMultiple;

/** Where the taker fee rate in an estimate came from. */
export const FeeRateSource = Schema.Literals(["hyperliquid_user_fees", "authority_fallback"]);
export type FeeRateSource = typeof FeeRateSource.Type;

/**
 * The cost of opening and closing one position, itemised.
 *
 * The three components do not overlap: fees are charged on notional, the
 * half-spread is what crossing from the mid to the touch costs, and slippage is
 * only what walking the book *past* the touch adds. Summing them is therefore
 * legitimate rather than double-counting the spread.
 *
 * The per-order-type combinations (`roundTripUsd` as taker/taker, plus
 * `roundTripTakerMakerUsd` and `roundTripMakerMakerUsd`) recombine those same
 * components rather than introducing new ones: a maker leg pays its fee at
 * `makerFeeBpsPerSide` and nothing else — it crosses no spread and walks past
 * no touch — so every combination is the sum of its legs' components. The
 * non-overlap invariant is what makes those recombinations as legitimate as the
 * taker/taker total.
 */
export const TradingCostEstimate = Schema.Struct({
  market: ExchangeMarket,
  /** Absolute position size the estimate was computed for, in base units. */
  sizeEth: Schema.Number,
  notionalUsd: Schema.Number,
  /** The mark or mid every per-unit figure below is measured against. */
  referencePrice: Price,

  takerFeeBpsPerSide: Schema.Number,
  /**
   * The maker (resting) fee rate per side the combinations below are priced
   * at. Equals `takerFeeBpsPerSide` when no maker rate was read — `notes`
   * says when that is the case.
   */
  makerFeeBpsPerSide: Schema.Number,
  feeRateSource: FeeRateSource,
  entryFeeUsd: Schema.Number,
  exitFeeUsd: Schema.Number,
  roundTripFeeUsd: Schema.Number,

  /** Half the bid/ask spread, in USD of price. Zero when no book was readable. */
  halfSpreadUsd: Schema.Number,
  /** Crossing the spread twice, in USD on this size. */
  roundTripSpreadUsd: Schema.Number,

  /** What walking the asks past the best offer costs this size, in USD. */
  buySlippageUsd: Schema.Number,
  /** The same on the bid side. */
  sellSlippageUsd: Schema.Number,
  roundTripSlippageUsd: Schema.Number,
  /** False when neither side of the book held enough depth for this size. */
  bookDepthSufficient: Schema.Boolean,

  /** The market's 8-hour funding rate as a decimal fraction, when known. */
  fundingRatePer8h: Schema.optional(Schema.Number),
  /** Positive means a long pays this much per 8 hours on this notional. */
  fundingCostPer8hUsd: Schema.optional(Schema.Number),

  /** Fees + spread + slippage for the whole round trip. */
  roundTripUsd: Schema.Number,
  /**
   * A taker leg and a maker leg: the taker fee plus the maker fee, one spread
   * crossing, and the walk of the taker leg only. The taker leg is priced as
   * the entry (the buy walk) — the two orientations differ only in which
   * side's walk the taker pays, and the trade this prices is an immediate
   * entry resting a patient exit.
   */
  roundTripTakerMakerUsd: Schema.Number,
  /** Both legs resting: two maker fees, no spread crossing, no slippage. */
  roundTripMakerMakerUsd: Schema.Number,
  /** How far price must move, per base unit, just to break even. */
  breakEvenPriceMoveUsd: Schema.Number,
  breakEvenPriceMovePercent: Schema.Number,
  /**
   * The rung the target is aiming at: `PROFIT_TARGET_COST_MULTIPLE x
   * roundTripUsd`. Not a gate — the number to bank at, and to hold an
   * extension against once the position is on.
   */
  preferredTargetUsd: Schema.Number,

  measuredAt: UnixMillis,
  freshness: FreshnessMeta,
  /**
   * True when part of the round trip could not be read and was substituted or
   * left out. Read `notes` for what — and treat the total as a lower bound.
   */
  degraded: Schema.Boolean,
  /**
   * One line per substitution, shortfall, or exclusion. A clean estimate of a
   * position nobody intends to hold across a funding interval still carries the
   * funding note, which is why this is not the same thing as `degraded`.
   */
  notes: Schema.Array(Schema.String),
});
export type TradingCostEstimate = typeof TradingCostEstimate.Type;

/**
 * The one cost line a flat wakeup carries — plan 29 step 3.1.
 *
 * Cost stopped being a gate; it survives as context, and the context has to be
 * bounded: the round trip as USD and as bps of a stated reference notional, and
 * nothing else. The reference notional is the plan's intended entry notional
 * when a plan names one, else the mission's allocated capital — the line always
 * says which it was priced at.
 */
export const TradingCostContext = Schema.Struct({
  /** The notional the round trip was priced at. */
  referenceNotionalUsd: Schema.Number,
  /** The taker/taker round trip at that notional, in USD. */
  roundTripUsd: Schema.Number,
  /** The same cost in basis points of the reference notional. */
  roundTripBps: Schema.Number,
});
export type TradingCostContext = typeof TradingCostContext.Type;

/** Reduce a full estimate to the bounded context line a wakeup carries. */
export function costContextFromEstimate(estimate: TradingCostEstimate): TradingCostContext {
  return {
    referenceNotionalUsd: estimate.notionalUsd,
    roundTripUsd: estimate.roundTripUsd,
    roundTripBps:
      estimate.notionalUsd > 0 ? (estimate.roundTripUsd / estimate.notionalUsd) * 10_000 : 0,
  };
}

/**
 * What walking one side of the book costs beyond its touch price.
 *
 * Levels must arrive in the order the exchange serves them — asks ascending,
 * bids descending — so the first level is the touch. `filled` is how much of
 * `size` the visible depth could actually absorb; a partial fill is reported
 * rather than extrapolated, because the price past the last visible level is
 * not something a book read knows.
 */
export function walkBook(
  levels: ReadonlyArray<OrderBookLevel>,
  size: number,
): { readonly slippageUsd: number; readonly filled: number } {
  const touch = levels[0]?.price;
  if (touch === undefined || size <= 0) return { slippageUsd: 0, filled: 0 };

  let remaining = size;
  let cost = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, level.size);
    cost += taken * Math.abs(level.price - touch);
    remaining -= taken;
  }
  return { slippageUsd: cost, filled: size - remaining };
}

/** What `estimateTradingCosts` needs the caller to have already read. */
export interface CostEstimateInput {
  readonly market: string;
  /** Absolute size to cost, in base units. */
  readonly sizeEth: number;
  /** Mark or mid — the price the estimate is measured against. */
  readonly referencePrice: number;
  readonly takerFeeBpsPerSide: number;
  /**
   * The maker (resting) fee rate per side in bps, when it was read. Absent
   * means no maker rate was available: the maker legs of the combinations are
   * then priced at the taker rate and a note records the assumption, so the
   * number is never mistaken for a read.
   */
  readonly makerFeeBpsPerSide?: number | undefined;
  readonly feeRateSource: FeeRateSource;
  /** Book levels, exchange order (asks ascending, bids descending). */
  readonly bids: ReadonlyArray<OrderBookLevel>;
  readonly asks: ReadonlyArray<OrderBookLevel>;
  /** The market's 8h funding rate as a decimal fraction, when it was readable. */
  readonly fundingRatePer8h?: number | undefined;
  readonly measuredAt: number;
  readonly freshness: FreshnessMeta;
}

/**
 * Cost one round trip on a given size.
 *
 * The exit is priced on the opposite side of the book from the entry, so a
 * round trip walks both: a long pays the ask to open and the bid to close.
 * Which way round it goes does not change the total, which is why the estimate
 * does not take a side.
 */
export function estimateTradingCosts(input: CostEstimateInput): TradingCostEstimate {
  const size = Math.abs(input.sizeEth);
  const notionalUsd = size * input.referencePrice;
  const notes: Array<string> = [];
  // Only a component of the round trip that could not be read degrades the
  // total. Funding is a holding cost outside the round trip, so its absence is
  // worth a note but does not make the number below untrustworthy.
  let degraded = false;

  if (input.feeRateSource === "authority_fallback") {
    degraded = true;
    notes.push(
      `taker fee rate could not be read from the exchange; using the authority's ${input.takerFeeBpsPerSide} bps/side fallback`,
    );
  }

  const feePerSide = notionalUsd * (input.takerFeeBpsPerSide / 10_000);
  const roundTripFeeUsd = feePerSide * 2;
  // A maker rate that was read pays its own bps; one that was not is priced at
  // the taker rate — the pessimistic maker round trip — with a note below.
  const makerFeeBpsPerSide = input.makerFeeBpsPerSide ?? input.takerFeeBpsPerSide;
  const makerFeePerSide = notionalUsd * (makerFeeBpsPerSide / 10_000);

  const bestBid = input.bids[0]?.price;
  const bestAsk = input.asks[0]?.price;
  const halfSpreadUsd =
    bestBid !== undefined && bestAsk !== undefined ? Math.max(0, (bestAsk - bestBid) / 2) : 0;
  if (bestBid === undefined || bestAsk === undefined) {
    degraded = true;
    notes.push("no readable book: spread and slippage are reported as zero, not measured");
  }
  const roundTripSpreadUsd = halfSpreadUsd * size * 2;

  const buy = walkBook(input.asks, size);
  const sell = walkBook(input.bids, size);
  const bookDepthSufficient = buy.filled >= size && sell.filled >= size;
  if (bestBid !== undefined && bestAsk !== undefined && !bookDepthSufficient) {
    degraded = true;
    notes.push(
      `visible book absorbs only ${Math.min(buy.filled, sell.filled)} of ${size}; slippage past the last level is not estimated`,
    );
  }
  const roundTripSlippageUsd = buy.slippageUsd + sell.slippageUsd;

  // Order-type combinations, recomposed from the same non-overlapping
  // components as the taker/taker total: a maker leg pays its fee and nothing
  // else — it crosses no spread and walks past no touch. The taker leg of the
  // mixed combination is the entry, so it pays the buy walk.
  const roundTripTakerMakerUsd =
    feePerSide + makerFeePerSide + halfSpreadUsd * size + buy.slippageUsd;
  const roundTripMakerMakerUsd = makerFeePerSide * 2;

  if (input.fundingRatePer8h === undefined) {
    notes.push("no funding rate was supplied; holding cost over funding intervals is not included");
  }
  if (input.makerFeeBpsPerSide === undefined) {
    notes.push(
      input.feeRateSource === "authority_fallback"
        ? "no maker fee rate was read; the maker combinations are priced at the authority's fallback taker rate"
        : "no maker fee rate was available; the maker combinations are priced at the taker rate",
    );
  }
  notes.push(
    "a maker side pays no spread crossing or walk past the touch; the taker/maker and maker/maker totals reprice only the fee",
  );

  const roundTripUsd = roundTripFeeUsd + roundTripSpreadUsd + roundTripSlippageUsd;
  const breakEvenPriceMoveUsd = size > 0 ? roundTripUsd / size : 0;

  return {
    market: input.market,
    sizeEth: size,
    notionalUsd,
    referencePrice: input.referencePrice > 0 ? input.referencePrice : 1,
    takerFeeBpsPerSide: input.takerFeeBpsPerSide,
    makerFeeBpsPerSide,
    feeRateSource: input.feeRateSource,
    entryFeeUsd: feePerSide,
    exitFeeUsd: feePerSide,
    roundTripFeeUsd,
    halfSpreadUsd,
    roundTripSpreadUsd,
    buySlippageUsd: buy.slippageUsd,
    sellSlippageUsd: sell.slippageUsd,
    roundTripSlippageUsd,
    bookDepthSufficient,
    ...(input.fundingRatePer8h === undefined
      ? {}
      : {
          fundingRatePer8h: input.fundingRatePer8h,
          fundingCostPer8hUsd: input.fundingRatePer8h * notionalUsd,
        }),
    roundTripUsd,
    roundTripTakerMakerUsd,
    roundTripMakerMakerUsd,
    breakEvenPriceMoveUsd,
    breakEvenPriceMovePercent:
      input.referencePrice > 0 ? (breakEvenPriceMoveUsd / input.referencePrice) * 100 : 0,
    preferredTargetUsd: roundTripUsd * PROFIT_TARGET_COST_MULTIPLE,
    measuredAt: input.measuredAt,
    freshness: input.freshness,
    degraded,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Sizing a position to the target it is being taken for
// ---------------------------------------------------------------------------

/**
 * The share of notional one round trip costs, as a fraction.
 *
 * Fees on both fills plus crossing the spread twice. Slippage past the touch is
 * deliberately absent: it is the one component that does not scale with
 * notional, so folding it in here would make the fraction a function of the
 * size it is used to compute. The caller holds the full
 * {@link TradingCostEstimate} when it wants the whole number.
 */
export function roundTripCostFractionOfNotional(input: {
  readonly takerFeeBpsPerSide: number;
  readonly halfSpreadUsd: number;
  readonly referencePrice: number;
}): number {
  const fees = (input.takerFeeBpsPerSide / 10_000) * 2;
  const spread = input.referencePrice > 0 ? (input.halfSpreadUsd / input.referencePrice) * 2 : 0;
  return fees + spread;
}

/** What {@link notionalForProfitTarget} concluded, and why. */
export interface TargetNotional {
  /**
   * The notional this target needs, in USD. Null when no notional can pay it:
   * the expected move does not clear the round-trip cost, so the position is a
   * fee-generator at every size.
   */
  readonly notionalUsd: number | null;
  /** The expected move as a fraction of price, before costs. */
  readonly moveFraction: number;
  /** What is left of that move after the round trip — the fraction that pays. */
  readonly netFraction: number;
  readonly reason: string;
}

/**
 * The notional a profit target needs, given the move expected and what the
 * round trip costs.
 *
 * The target is a USD figure and the move is a percentage, so the notional is
 * what converts one into the other — and because the round trip is also a
 * percentage of notional, the two are solved together:
 *
 *   notional x (move% - roundTrip%) = targetProfitUsd
 *
 * That is the whole arithmetic behind "use a higher notional so the trade can
 * absorb its costs and still reach the target". Sizing the position DOWN does
 * not make a target cheaper to reach — it makes it unreachable, because the
 * costs shrink with the notional but the target does not.
 *
 * This is a sizing input, never a veto. A null result says this target cannot
 * be funded at any size, which is information for the turn that set the target;
 * nothing here refuses a trade.
 */
export function notionalForProfitTarget(input: {
  readonly targetProfitUsd: number;
  /** The move the plan expects to capture, in USD of price. */
  readonly expectedPriceMoveUsd: number;
  readonly referencePrice: number;
  /** From {@link roundTripCostFractionOfNotional}. */
  readonly costFractionOfNotional: number;
}): TargetNotional {
  const moveFraction =
    input.referencePrice > 0 ? Math.abs(input.expectedPriceMoveUsd) / input.referencePrice : 0;
  const netFraction = moveFraction - input.costFractionOfNotional;

  if (!(input.targetProfitUsd > 0)) {
    return {
      notionalUsd: null,
      moveFraction,
      netFraction,
      reason: "no positive profit target to size against",
    };
  }
  if (!(netFraction > 0)) {
    return {
      notionalUsd: null,
      moveFraction,
      netFraction,
      reason:
        `the expected ${(moveFraction * 100).toFixed(3)}% move does not clear the ` +
        `${(input.costFractionOfNotional * 100).toFixed(3)}% round trip, so no notional pays this target`,
    };
  }

  const notionalUsd = input.targetProfitUsd / netFraction;
  return {
    notionalUsd,
    moveFraction,
    netFraction,
    reason:
      `${input.targetProfitUsd.toFixed(2)} USD of target over a ${(netFraction * 100).toFixed(3)}% ` +
      `net move (${(moveFraction * 100).toFixed(3)}% gross less a ${(input.costFractionOfNotional * 100).toFixed(3)}% ` +
      `round trip) needs ${notionalUsd.toFixed(2)} USD of notional`,
  };
}

/**
 * The notional a plan's published target needs, from the numbers the caller
 * has already read: the fee rate, the half spread, and the price both are
 * measured against.
 *
 * This is the one composition of {@link notionalForProfitTarget} and
 * {@link roundTripCostFractionOfNotional} — both the quote path and the
 * market-structure cost read size through it, so the two cannot drift into
 * answering the same question two different ways.
 */
export function targetNotionalForPlan(input: {
  readonly targetProfitUsd: number;
  /** The move the plan expects to capture, in USD of price. */
  readonly expectedPriceMoveUsd: number;
  readonly referencePrice: number;
  readonly takerFeeBpsPerSide: number;
  readonly halfSpreadUsd: number;
}): TargetNotional {
  return notionalForProfitTarget({
    targetProfitUsd: input.targetProfitUsd,
    expectedPriceMoveUsd: input.expectedPriceMoveUsd,
    referencePrice: input.referencePrice,
    costFractionOfNotional: roundTripCostFractionOfNotional({
      takerFeeBpsPerSide: input.takerFeeBpsPerSide,
      halfSpreadUsd: input.halfSpreadUsd,
      referencePrice: input.referencePrice,
    }),
  });
}

/**
 * What a cost read should be priced at when the mission holds a plan with a
 * live target, and what capped it.
 */
export interface PlanCostSizing {
  /**
   * The notional to price the estimate at, or null when no notional pays the
   * plan's target — the caller then keeps its own fallback size.
   */
  readonly notionalUsd: number | null;
  /** The target arithmetic, uncapped, for the caller's reporting. */
  readonly target: TargetNotional;
}

/**
 * The notional a cost read should be priced at for a plan with a live target
 * (plan 29 step 2.6, plan 28 defect 5).
 *
 * The market-structure read used to price its estimate at the mission's
 * approved ceiling, which on a thin book walks the worst fill the mission
 * could possibly take and then priced every candidate's cost against it. When
 * the current plan publishes a target with a basis, the size the mission would
 * actually take is the notional that target needs — bounded by the same
 * notional ceilings `deriveFeasibleSize` caps a real entry with, plus the
 * approved capital the fallback prices at, so a plan-sized estimate is never
 * larger than the ceiling behaviour it replaces.
 *
 * The stop-dependent ceilings (planned loss, loss budget) are deliberately
 * absent: a structure read happens before any entry has a stop, so the
 * notional ceilings are the honest bound it can know. Slippage past the touch
 * is still priced in full at the size returned — the estimate is what changes
 * with size, not the arithmetic.
 */
export function notionalToPricePlanCosts(input: {
  readonly targetProfitUsd: number;
  readonly expectedPriceMoveUsd: number;
  readonly referencePrice: number;
  readonly takerFeeBpsPerSide: number;
  readonly halfSpreadUsd: number;
  readonly allocatedCapitalUsd: number;
  readonly maximumLeverage: number;
  readonly maximumGrossNotionalUsd: number;
  /** The exchange's minimum trade; a target below it could never be taken. */
  readonly minimumNotionalUsd: number;
}): PlanCostSizing {
  const target = targetNotionalForPlan(input);
  if (target.notionalUsd === null) return { notionalUsd: null, target };

  // `deriveFeasibleSize` expresses the leverage ceiling as margin x leverage;
  // allocated capital is included so the plan-sized notional can only ever
  // shrink the estimate relative to pricing at the ceiling, never grow it.
  const ceiling = Math.min(
    input.allocatedCapitalUsd,
    input.maximumLeverage * input.allocatedCapitalUsd,
    input.maximumGrossNotionalUsd,
  );
  // At least the exchange minimum — a target that needs less than the
  // smallest legal trade would otherwise price the gate at a round trip no
  // entry could take. Never above the ceiling, even when the minimum is the
  // larger of the two: above the approved risk is not a size, it is a defect.
  return {
    notionalUsd: Math.min(Math.max(target.notionalUsd, input.minimumNotionalUsd), ceiling),
    target,
  };
}

// ---------------------------------------------------------------------------
// Publish-time validation of a profit target
// ---------------------------------------------------------------------------

/**
 * How far the published target may sit from the arithmetic its basis claims
 * produced it, as a fraction.
 *
 * Wide enough for the rounding a harness does when it writes "about $7"; far
 * too narrow for a target that came from somewhere other than the measurement
 * next to it.
 */
export const TARGET_BASIS_TOLERANCE = 0.05;

/** Why a published profit target failed validation. */
export const ProfitTargetDefect = Schema.Literals([
  "target_basis_missing",
  "target_basis_arithmetic_mismatch",
]);
export type ProfitTargetDefect = typeof ProfitTargetDefect.Type;

/** The basis fields validation reads. Structurally a `ProfitTargetBasis`. */
export interface ProfitTargetBasisView {
  readonly measuredMoveUsd: number;
  readonly referencePrice: number;
  readonly positionNotionalUsd: number;
  readonly insufficientVolatility?: boolean | undefined;
}

export interface ProfitTargetCheck {
  /** Defects that must stop the publish. */
  readonly rejections: ReadonlyArray<ProfitTargetDefect>;
  /** Defects reported back in-band but allowed through. */
  readonly warnings: ReadonlyArray<ProfitTargetDefect>;
  /** One human-readable line per defect, in the order they appear above. */
  readonly messages: ReadonlyArray<string>;
}

/**
 * Check a published target against the basis that claims to have produced it.
 *
 * Both defects reject. A missing basis means the target has no derivation at
 * all, and an arithmetic mismatch means the derivation next to it does not
 * produce it — in both cases the number the runtime is about to arm a watch at
 * is unexplained.
 *
 * What a trade costs is deliberately not graded here: cost is context the
 * wakeup and the structure read carry, not a publish gate (plan 29 step 3.1).
 */
export function checkProfitTarget(input: {
  readonly targetProfitUsd: number;
  readonly basis: ProfitTargetBasisView | undefined;
}): ProfitTargetCheck {
  const rejections: Array<ProfitTargetDefect> = [];
  const warnings: Array<ProfitTargetDefect> = [];
  const messages: Array<string> = [];

  if (input.basis === undefined) {
    rejections.push("target_basis_missing");
    messages.push(
      "protection.targetProfitBasis is required: publish the measurement, timeframe, lookback, hold, and notional the target was derived from",
    );
    return { rejections, warnings, messages };
  }

  const basis = input.basis;

  // A harness that stood down published the field to say so, not to derive a
  // number from it — grading its arithmetic would reject the honest answer.
  if (basis.insufficientVolatility !== true && basis.referencePrice > 0) {
    const implied = (basis.measuredMoveUsd / basis.referencePrice) * basis.positionNotionalUsd;
    const drift = Math.abs(input.targetProfitUsd - implied);
    if (implied > 0 && drift > implied * TARGET_BASIS_TOLERANCE) {
      rejections.push("target_basis_arithmetic_mismatch");
      messages.push(
        `targetProfitUsd ${input.targetProfitUsd.toFixed(2)} does not follow from the basis: ` +
          `(measuredMoveUsd ${basis.measuredMoveUsd} / referencePrice ${basis.referencePrice}) x notional ` +
          `${basis.positionNotionalUsd} = ${implied.toFixed(2)}`,
      );
    }
  }

  return { rejections, warnings, messages };
}
