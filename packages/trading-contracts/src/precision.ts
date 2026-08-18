/**
 * How precisely a derived number rides back to the model — plan 33 fix A.
 *
 * Every measurement in this package is IEEE arithmetic over candles, so a ratio
 * comes out as `0.4363636363636364` and an ATR as `2.4785714285714286`. Eighteen
 * characters to say "about 0.44" and "about 2.48", on hundreds of fields, on
 * every look and every wake. Nothing downstream reads past the third or fourth
 * figure — the model does not, and no runtime check does either.
 *
 * The rounding is deliberately NOT a pass over the encoded JSON. A blind pass
 * would round prices, sizes, timestamps and ids too, and those are exact facts:
 * a level to arm a watch at, a size to send to the exchange, a millisecond to
 * compare against. So each read model names the fields it derives and the
 * precision each one is worth, and anything it does not name rides through
 * untouched. A field that is forgotten stays exact, which is the safe direction
 * to be wrong in.
 *
 * Significant figures rather than decimal places, because these markets are not
 * all priced alike: two decimals is cents on ETH and the whole number on a
 * market that trades at 0.0075.
 *
 * @module TradingPrecision
 */
import type { TradingCostContext, TradingCostEstimate } from "./costs.ts";
import type {
  CandidateSetup,
  MarketStructure,
  SetupRejection,
  StrategyCandidate,
  TimeframeReading,
} from "./marketStructure.ts";
import type { MarketMicrostructure } from "./microstructure.ts";
import type { MoveQuantiles, ObservedVolatility } from "./volatility.ts";

/**
 * Significant figures a derived price-scale value keeps — an ATR, a distance,
 * a fee, a leg size.
 *
 * Six is the cent on a five-figure market and still six real figures on a
 * market priced under a penny.
 */
export const PRICE_SCALE_DIGITS = 6;

/**
 * Significant figures a score, ratio, percentage, or bps reading keeps.
 *
 * Three: `0.436`, `61.7%`, `4.28 bps`. Nothing reads a directional score to the
 * fourth figure, and a threshold that turned on one would be a threshold with
 * no meaning behind it.
 */
export const RATIO_DIGITS = 3;

/** One number at the stated figures. Zero and non-finite values pass through. */
export function toSignificantDigits(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(digits));
}

/**
 * Round the named fields of a record and nothing else.
 *
 * The map is the allowlist: a field it does not name is copied verbatim, and so
 * is a named field that is absent or is not a number. Absence is preserved
 * rather than filled with a zero — an optional reading that was not measured
 * must not come back as one that measured zero.
 */
export function roundNamedFields<T extends object>(
  value: T,
  digits: Readonly<Record<string, number>>,
): T {
  const rounded: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [field, places] of Object.entries(digits)) {
    const current = rounded[field];
    if (typeof current === "number") rounded[field] = toSignificantDigits(current, places);
  }
  return rounded as T;
}

// ---------------------------------------------------------------------------
// Market structure
// ---------------------------------------------------------------------------

/**
 * The derived fields of one timeframe reading.
 *
 * `referencePrice`, `swingHighPrice` and `swingLowPrice` are absent on purpose:
 * they are levels a watch gets armed at, and an armed level has to be the level
 * the market actually printed.
 */
const TIMEFRAME_DIGITS: Readonly<Record<string, number>> = {
  directionScore: RATIO_DIGITS,
  recentDirectionScore: RATIO_DIGITS,
  atrUsd: PRICE_SCALE_DIGITS,
  atrPercent: RATIO_DIGITS,
  atrExpansionRatio: RATIO_DIGITS,
  pullbackDepthUsd: PRICE_SCALE_DIGITS,
  pullbackPercentOfImpulse: RATIO_DIGITS,
  distanceToSwingHighUsd: PRICE_SCALE_DIGITS,
  distanceToSwingLowUsd: PRICE_SCALE_DIGITS,
  positionInRangePercent: RATIO_DIGITS,
  rangeStabilityPercent: RATIO_DIGITS,
  swingHighDriftUsd: PRICE_SCALE_DIGITS,
  swingLowDriftUsd: PRICE_SCALE_DIGITS,
  excursionSymmetryRatio: RATIO_DIGITS,
};

/** The travel of the last leg. Its two pivot prices stay exact. */
const IMPULSE_DIGITS: Readonly<Record<string, number>> = {
  sizeUsd: PRICE_SCALE_DIGITS,
  sizePercent: RATIO_DIGITS,
};

/** The EMA pair. Both averages are derived, so both round. */
const EMA_DIGITS: Readonly<Record<string, number>> = {
  fastUsd: PRICE_SCALE_DIGITS,
  slowUsd: PRICE_SCALE_DIGITS,
  spreadUsd: PRICE_SCALE_DIGITS,
  spreadPercent: RATIO_DIGITS,
  separationAtr: RATIO_DIGITS,
};

const RSI_DIGITS: Readonly<Record<string, number>> = { value: RATIO_DIGITS };

const roundRejections = (
  rejections: ReadonlyArray<SetupRejection>,
): ReadonlyArray<SetupRejection> =>
  rejections.map((rejection) => ({
    ...rejection,
    margin: toSignificantDigits(rejection.margin, RATIO_DIGITS),
  }));

export function roundTimeframeReading(frame: TimeframeReading): TimeframeReading {
  return {
    ...roundNamedFields(frame, TIMEFRAME_DIGITS),
    ...(frame.lastImpulse === undefined
      ? {}
      : { lastImpulse: roundNamedFields(frame.lastImpulse, IMPULSE_DIGITS) }),
    ...(frame.ema === undefined ? {} : { ema: roundNamedFields(frame.ema, EMA_DIGITS) }),
    ...(frame.rsi === undefined ? {} : { rsi: roundNamedFields(frame.rsi, RSI_DIGITS) }),
  };
}

/** A scored setup. `level` is the trigger price and stays exact. */
function roundCandidateSetup(setup: CandidateSetup): CandidateSetup {
  return {
    ...roundNamedFields(setup, { score: RATIO_DIGITS }),
    ...(setup.rejectedBy === undefined ? {} : { rejectedBy: roundRejections(setup.rejectedBy) }),
  };
}

const CANDIDATE_DIGITS: Readonly<Record<string, number>> = {
  score: RATIO_DIGITS,
  distanceToTriggerUsd: PRICE_SCALE_DIGITS,
  availableMoveUsd: PRICE_SCALE_DIGITS,
  costMultiple: RATIO_DIGITS,
};

function roundStrategyCandidate(candidate: StrategyCandidate): StrategyCandidate {
  return {
    ...roundNamedFields(candidate, CANDIDATE_DIGITS),
    ...(candidate.rejectedBy === undefined
      ? {}
      : { rejectedBy: roundRejections(candidate.rejectedBy) }),
  };
}

/** The whole structure read at the precision it is worth encoding at. */
export function roundMarketStructure(structure: MarketStructure): MarketStructure {
  return {
    ...structure,
    timeframes: structure.timeframes.map(roundTimeframeReading),
    alignment: roundNamedFields(structure.alignment, { score: RATIO_DIGITS }),
    setups: structure.setups.map(roundCandidateSetup),
    ...(structure.candidates === undefined
      ? {}
      : { candidates: structure.candidates.map(roundStrategyCandidate) }),
  };
}

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

/**
 * `swingHighUsd` and `swingLowUsd` are the window's own high and low — the
 * boundaries a range scalp arms at — so they stay exact alongside
 * `referencePrice`.
 */
const VOLATILITY_DIGITS: Readonly<Record<string, number>> = {
  atrUsd: PRICE_SCALE_DIGITS,
  atrPercent: RATIO_DIGITS,
  realizedVolatilityPercentPerBar: RATIO_DIGITS,
  swingRangeUsd: PRICE_SCALE_DIGITS,
  swingRangePercent: RATIO_DIGITS,
  positionInRangePercent: RATIO_DIGITS,
  excursionSymmetryRatio: RATIO_DIGITS,
};

const QUANTILE_DIGITS: Readonly<Record<string, number>> = {
  p25: PRICE_SCALE_DIGITS,
  p50: PRICE_SCALE_DIGITS,
  p75: PRICE_SCALE_DIGITS,
};

const roundQuantiles = (quantiles: MoveQuantiles): MoveQuantiles =>
  roundNamedFields(quantiles, QUANTILE_DIGITS);

export function roundObservedVolatility(volatility: ObservedVolatility): ObservedVolatility {
  return {
    ...roundNamedFields(volatility, VOLATILITY_DIGITS),
    horizons: volatility.horizons.map((horizon) => ({
      ...horizon,
      favourableUpUsd: roundQuantiles(horizon.favourableUpUsd),
      favourableDownUsd: roundQuantiles(horizon.favourableDownUsd),
    })),
  };
}

// ---------------------------------------------------------------------------
// Microstructure
// ---------------------------------------------------------------------------

const BOOK_IMBALANCE_DIGITS: Readonly<Record<string, number>> = {
  bidDepthUsd: PRICE_SCALE_DIGITS,
  askDepthUsd: PRICE_SCALE_DIGITS,
  imbalance: RATIO_DIGITS,
};

const AGGRESSOR_FLOW_DIGITS: Readonly<Record<string, number>> = {
  buyShare: RATIO_DIGITS,
  volume: PRICE_SCALE_DIGITS,
};

const LIQUIDITY_DIGITS: Readonly<Record<string, number>> = {
  spreadBps: RATIO_DIGITS,
  nearDepthUsd: PRICE_SCALE_DIGITS,
  spreadBpsChange: RATIO_DIGITS,
  depthChangePercent: RATIO_DIGITS,
  sinceSeconds: RATIO_DIGITS,
};

const POSITIONING_DIGITS: Readonly<Record<string, number>> = {
  openInterestChangePercent: RATIO_DIGITS,
  priceChangePercent: RATIO_DIGITS,
  sinceSeconds: RATIO_DIGITS,
};

const VOLATILITY_RATIO_DIGITS: Readonly<Record<string, number>> = {
  ratio: RATIO_DIGITS,
  shortPercent: RATIO_DIGITS,
  longPercent: RATIO_DIGITS,
};

/** VWAP is an average the runtime computed, not a level the market printed. */
const VWAP_DIGITS: Readonly<Record<string, number>> = {
  priceUsd: PRICE_SCALE_DIGITS,
  distanceBps: RATIO_DIGITS,
};

export function roundMicrostructure(readings: MarketMicrostructure): MarketMicrostructure {
  return {
    ...(readings.bookImbalance === undefined
      ? {}
      : { bookImbalance: roundNamedFields(readings.bookImbalance, BOOK_IMBALANCE_DIGITS) }),
    ...(readings.aggressorFlow === undefined
      ? {}
      : { aggressorFlow: roundNamedFields(readings.aggressorFlow, AGGRESSOR_FLOW_DIGITS) }),
    ...(readings.liquidity === undefined
      ? {}
      : { liquidity: roundNamedFields(readings.liquidity, LIQUIDITY_DIGITS) }),
    ...(readings.positioning === undefined
      ? {}
      : { positioning: roundNamedFields(readings.positioning, POSITIONING_DIGITS) }),
    ...(readings.volatilityRatio === undefined
      ? {}
      : { volatilityRatio: roundNamedFields(readings.volatilityRatio, VOLATILITY_RATIO_DIGITS) }),
    ...(readings.vwap === undefined ? {} : { vwap: roundNamedFields(readings.vwap, VWAP_DIGITS) }),
  };
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/**
 * `sizeEth` and `referencePrice` stay exact: the size is what an order would
 * carry and the reference price is the mark every figure below it was measured
 * against.
 */
const COST_ESTIMATE_DIGITS: Readonly<Record<string, number>> = {
  notionalUsd: PRICE_SCALE_DIGITS,
  takerFeeBpsPerSide: RATIO_DIGITS,
  makerFeeBpsPerSide: RATIO_DIGITS,
  entryFeeUsd: PRICE_SCALE_DIGITS,
  exitFeeUsd: PRICE_SCALE_DIGITS,
  roundTripFeeUsd: PRICE_SCALE_DIGITS,
  halfSpreadUsd: PRICE_SCALE_DIGITS,
  roundTripSpreadUsd: PRICE_SCALE_DIGITS,
  buySlippageUsd: PRICE_SCALE_DIGITS,
  sellSlippageUsd: PRICE_SCALE_DIGITS,
  roundTripSlippageUsd: PRICE_SCALE_DIGITS,
  fundingRatePer8h: RATIO_DIGITS,
  fundingCostPer8hUsd: PRICE_SCALE_DIGITS,
  roundTripUsd: PRICE_SCALE_DIGITS,
  roundTripTakerMakerUsd: PRICE_SCALE_DIGITS,
  roundTripMakerMakerUsd: PRICE_SCALE_DIGITS,
  breakEvenPriceMoveUsd: PRICE_SCALE_DIGITS,
  breakEvenPriceMovePercent: RATIO_DIGITS,
  preferredTargetUsd: PRICE_SCALE_DIGITS,
};

export function roundCostEstimate(estimate: TradingCostEstimate): TradingCostEstimate {
  return roundNamedFields(estimate, COST_ESTIMATE_DIGITS);
}

const COST_CONTEXT_DIGITS: Readonly<Record<string, number>> = {
  referenceNotionalUsd: PRICE_SCALE_DIGITS,
  roundTripUsd: PRICE_SCALE_DIGITS,
  roundTripBps: RATIO_DIGITS,
  preferredTargetUsd: PRICE_SCALE_DIGITS,
};

export function roundCostContext(context: TradingCostContext): TradingCostContext {
  return roundNamedFields(context, COST_CONTEXT_DIGITS);
}
