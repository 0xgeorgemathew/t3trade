/**
 * What a round trip costs, and whether a published target clears it.
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
import { ExchangeMarket, Price, UnixMillis } from "./primitives.ts";

/**
 * How many round trips a target has to be worth before the trade is worth
 * taking.
 *
 * One round trip is break-even before slippage and funding; a target at exactly
 * 1x pays the exchange and the harness takes the variance for nothing. Two is
 * the floor the momentum loop is held to — deliberately blunt, because the
 * failure it exists to stop is not a target that is slightly too small.
 */
export const PROFIT_TARGET_COST_MULTIPLE = 2;

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
 */
export const TradingCostEstimate = Schema.Struct({
  market: ExchangeMarket,
  /** Absolute position size the estimate was computed for, in base units. */
  sizeEth: Schema.Number,
  notionalUsd: Schema.Number,
  /** The mark or mid every per-unit figure below is measured against. */
  referencePrice: Price,

  takerFeeBpsPerSide: Schema.Number,
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
  /** How far price must move, per base unit, just to break even. */
  breakEvenPriceMoveUsd: Schema.Number,
  breakEvenPriceMovePercent: Schema.Number,
  /**
   * The smallest profit target worth arming on this size:
   * `PROFIT_TARGET_COST_MULTIPLE x roundTripUsd`, gross, the way `pnl_above`
   * measures it.
   */
  minimumViableTargetUsd: Schema.Number,

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

  if (input.fundingRatePer8h === undefined) {
    notes.push("no funding rate was supplied; holding cost over funding intervals is not included");
  }

  const roundTripUsd = roundTripFeeUsd + roundTripSpreadUsd + roundTripSlippageUsd;
  const breakEvenPriceMoveUsd = size > 0 ? roundTripUsd / size : 0;

  return {
    market: input.market,
    sizeEth: size,
    notionalUsd,
    referencePrice: input.referencePrice > 0 ? input.referencePrice : 1,
    takerFeeBpsPerSide: input.takerFeeBpsPerSide,
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
    breakEvenPriceMoveUsd,
    breakEvenPriceMovePercent:
      input.referencePrice > 0 ? (breakEvenPriceMoveUsd / input.referencePrice) * 100 : 0,
    minimumViableTargetUsd: roundTripUsd * PROFIT_TARGET_COST_MULTIPLE,
    measuredAt: input.measuredAt,
    freshness: input.freshness,
    degraded,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Publish-time validation of a profit target
// ---------------------------------------------------------------------------

/**
 * The fee-only round trip, for a caller with no book in hand.
 *
 * Publish validation runs on a strategy, not on a market read, so this is all
 * it can honestly compute: fees on both fills and nothing else. It is a floor
 * on the floor — the real round trip also pays the spread and the walk — which
 * is the right direction for a gate to err in.
 */
export function feeOnlyRoundTripUsd(notionalUsd: number, takerFeeBpsPerSide: number): number {
  return notionalUsd * (takerFeeBpsPerSide / 10_000) * 2;
}

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
  "target_below_cost_floor",
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
 * Check a published target against the basis that claims to have produced it,
 * and against what the trade costs.
 *
 * Two of the three defects reject. A missing basis means the target has no
 * derivation at all, and an arithmetic mismatch means the derivation next to it
 * does not produce it — in both cases the number the runtime is about to arm a
 * watch at is unexplained.
 *
 * The cost floor only warns. It is the newest of the three rules and the one
 * most likely to be wrong about a real setup (it sees fees but not the spread,
 * and it cannot see the exit the harness actually intends), so it reports
 * itself in-band and lets the publish through until a testnet soak says it can
 * be trusted to reject. That escalation is the point of separating the two
 * lists.
 */
export function checkProfitTarget(input: {
  readonly targetProfitUsd: number;
  readonly basis: ProfitTargetBasisView | undefined;
  readonly takerFeeBpsPerSide: number;
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

  const floor =
    feeOnlyRoundTripUsd(basis.positionNotionalUsd, input.takerFeeBpsPerSide) *
    PROFIT_TARGET_COST_MULTIPLE;
  if (input.targetProfitUsd < floor) {
    warnings.push("target_below_cost_floor");
    messages.push(
      `targetProfitUsd ${input.targetProfitUsd.toFixed(2)} is below ${PROFIT_TARGET_COST_MULTIPLE}x the round-trip cost ` +
        `(${floor.toFixed(2)} on ${basis.positionNotionalUsd} of notional at ${input.takerFeeBpsPerSide} bps/side, before spread and slippage) — ` +
        "the target is gross, so it has to clear the round trip on its own",
    );
  }

  return { rejections, warnings, messages };
}
