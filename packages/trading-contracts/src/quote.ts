/**
 * Executable entry quotes — the server-owned half of an execution.
 *
 * `trading_execute` used to ask the harness for the whole identity of an order:
 * the strategy version, the authority version, the harness run that owns the
 * decision lease, a monotonic `executionSequence`, a limit price that crosses,
 * a size within four separate ceilings, and precision the exchange accepts.
 * None of those are things a language model is in a position to know, and every
 * one of them is a refusal if it is wrong — so a correct read of the market
 * routinely died on the way to an order.
 *
 * A quote inverts that. The harness names what it wants in the vocabulary it
 * actually has — a market, a side, a stop, and optionally a size — and the
 * server derives everything else from state it already owns, checks the result
 * against the same preview it would run at execution time, and hands back a
 * short-lived token. Executing is then one field.
 *
 * A quote is not an order and reserves nothing. It expires, and an expired one
 * is refused with an instruction to re-quote rather than filled at a price that
 * has moved.
 *
 * @module TradingQuote
 */
import { Schema } from "effect";
import { TradingOrderSide } from "./execution.ts";
import { Price, TradingId, TradingMarket, UnixMillis, UsdAmount } from "./primitives.ts";
import { MomentumOrderPreference } from "./strategy.ts";

export const TRADING_QUOTE_ENTRY_TOOL = "trading_quote_entry";

/**
 * How long a quote stays executable.
 *
 * Long enough for the harness to read the quote, decide, and call execute in
 * the same turn; short enough that the BBO the limit price was derived from is
 * still recognisably the market. The preview's own BBO freshness window is two
 * seconds and is re-checked at execution, so this bound is about the harness's
 * turn, not about pricing safety.
 */
export const QUOTE_VALIDITY_MILLIS = 90_000;

/** The two position-increasing actions a quote can be taken for. */
export const QuotableActionType = Schema.Literals(["open", "scale_in"]);
export type QuotableActionType = typeof QuotableActionType.Type;

/**
 * Which ceiling decided the size, when the size is not the one that was asked
 * for.
 *
 * `requested` means nothing bound — the harness got the size it named. The
 * others are the four authority/budget limits and the two hard failures, and
 * naming which one bound is the difference between "ask for less" and "this
 * mission cannot trade right now".
 */
export const QuoteSizeConstraint = Schema.Literals([
  "requested",
  "gross_notional",
  "leverage",
  "planned_loss_ceiling",
  "loss_budget",
  "below_exchange_minimum",
  "stop_on_wrong_side",
]);
export type QuoteSizeConstraint = typeof QuoteSizeConstraint.Type;

export const TradingQuoteEntryInput = Schema.Struct({
  /** Optional — omit to act on the mission this session is bound to. */
  missionId: Schema.optional(TradingId),
  market: TradingMarket,
  side: TradingOrderSide,
  /** Reduce-only trigger price on the losing side of the entry. */
  stopPrice: Price,
  /**
   * The size to quote, in base units. Omit and the server quotes the largest
   * size every ceiling allows — which is usually not the size to trade, but is
   * always the honest upper bound to size down from.
   */
  sizeEth: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** The same request in USD of notional, converted at the quoted entry price. */
  notionalUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Defaults to `open`. */
  actionType: Schema.optional(QuotableActionType),
  /** Defaults to `marketable_ioc`. */
  orderPreference: Schema.optional(MomentumOrderPreference),
}).check(
  Schema.makeFilter(
    (input) =>
      input.sizeEth === undefined ||
      input.notionalUsd === undefined ||
      "Give either sizeEth or notionalUsd, not both.",
  ),
);
export type TradingQuoteEntryInput = typeof TradingQuoteEntryInput.Type;

/**
 * An entry the server has priced, sized, and already run the preview over.
 *
 * Everything here is server-derived. The harness supplies none of it back at
 * execution time — `quoteId` alone is the order.
 */
export const ExecutableQuote = Schema.Struct({
  quoteId: TradingId,
  quotedAt: UnixMillis,
  expiresAt: UnixMillis,

  missionId: TradingId,
  market: TradingMarket,
  side: TradingOrderSide,
  actionType: QuotableActionType,
  orderPreference: MomentumOrderPreference,

  /** The versions and lease this quote was cut against; execution re-checks them. */
  strategyVersion: Schema.Number,
  authorityVersion: Schema.Number,
  harnessRunId: TradingId,
  /** The server's next sequence for this mission. A retry reuses it; a new quote gets the next. */
  executionSequence: Schema.Number,

  /** Size in base units, already truncated to the market's `szDecimals`. */
  size: Schema.Number,
  /** The size the harness asked for, before any ceiling bound it. */
  requestedSize: Schema.Number,
  /** Which ceiling produced `size`. `requested` means none did. */
  constrainedBy: QuoteSizeConstraint,
  notionalUsd: UsdAmount,

  /** Derived from the live BBO — for `marketable_ioc`, a price that crosses. */
  limitPrice: Price,
  bestBid: Price,
  bestAsk: Price,
  stopPrice: Price,
  plannedLossAtStopUsd: UsdAmount,
  /** Planned loss plus both taker fees plus the stop-slippage reserve. */
  reservedRiskUsd: UsdAmount,
  /** Round-trip cost at this size, so the target can be held against it. */
  estimatedRoundTripCostUsd: UsdAmount,
});
export type ExecutableQuote = typeof ExecutableQuote.Type;

export const TradingQuoteEntryResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("quoted"),
    quote: ExecutableQuote,
    /**
     * Things true of this quote that do not stop it being executed — a size
     * smaller than the one asked for, most often. The refusal below is for
     * quotes that cannot exist at all.
     */
    warnings: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    /**
     * The §16.3 preview item that refused it, or a `QuoteSizeConstraint` when
     * no size clears the ceilings. Carried as a string because the checklist is
     * the server's, and one name for the rule is better than two lists free to
     * disagree.
     */
    reason: Schema.String,
    detail: Schema.String,
    /**
     * The largest size that would have cleared, when a smaller one would.
     * Absent when the refusal is not about size at all.
     */
    feasibleSize: Schema.optional(Schema.Number),
  }),
]);
export type TradingQuoteEntryResult = typeof TradingQuoteEntryResult.Type;

// ---------------------------------------------------------------------------
// Sizing — pure arithmetic, so the ceilings are testable without an exchange
// ---------------------------------------------------------------------------

export interface QuoteSizingInput {
  readonly side: "buy" | "sell";
  /** The price the entry would be filled at. */
  readonly entryPrice: number;
  readonly stopPrice: number;
  /** Size in base units the harness asked for. Omit to take the largest feasible. */
  readonly requestedSize?: number | undefined;
  /** Base-unit precision the exchange accepts for this market. */
  readonly szDecimals: number;
  /** Gross notional already open on this mission. */
  readonly existingNotionalUsd: number;
  readonly allocatedCapitalUsd: number;
  readonly maximumLeverage: number;
  readonly maximumGrossNotionalUsd: number;
  readonly maximumPlannedRiskPerPositionUsd: number;
  readonly remainingCumulativeLossUsd: number;
  readonly takerFeeBpsPerSide: number;
  readonly stopSlippageReserveBps: number;
  readonly minimumNotionalUsd: number;
}

export interface QuoteSizing {
  readonly size: number;
  readonly requestedSize: number;
  readonly notionalUsd: number;
  readonly plannedLossAtStopUsd: number;
  readonly reservedRiskUsd: number;
  readonly constrainedBy: QuoteSizeConstraint;
  /** False when no size clears; `constrainedBy` says which rule made it so. */
  readonly feasible: boolean;
  readonly detail: string;
}

/** Truncate toward zero at the exchange's base-unit precision. */
function truncateSize(size: number, szDecimals: number): number {
  const factor = 10 ** Math.max(0, Math.trunc(szDecimals));
  return Math.floor(size * factor) / factor;
}

/**
 * The largest size that clears every ceiling, and which one bound it.
 *
 * The four ceilings are the same ones preview items 12–15 test, expressed as
 * sizes instead of as verdicts, so a quote proposes the trade the mission is
 * actually allowed to take rather than refusing the one it asked for. The
 * caller passes the ceilings in; nothing here reads configuration.
 */
export function deriveFeasibleSize(input: QuoteSizingInput): QuoteSizing {
  const stopDistance = Math.abs(input.entryPrice - input.stopPrice);
  const stopIsOnLosingSide =
    input.side === "buy" ? input.stopPrice < input.entryPrice : input.stopPrice > input.entryPrice;

  if (!stopIsOnLosingSide || stopDistance <= 0) {
    return {
      size: 0,
      requestedSize: input.requestedSize ?? 0,
      notionalUsd: 0,
      plannedLossAtStopUsd: 0,
      reservedRiskUsd: 0,
      constrainedBy: "stop_on_wrong_side",
      feasible: false,
      detail:
        `a ${input.side} entry at ${input.entryPrice} needs its stop ` +
        `${input.side === "buy" ? "below" : "above"} that price; got ${input.stopPrice}`,
    };
  }

  // Every ceiling as a size in base units. The smallest one wins.
  const notionalHeadroom = (ceiling: number): number =>
    Math.max(0, ceiling - input.existingNotionalUsd) / input.entryPrice;
  const feeAndSlip = (2 * input.takerFeeBpsPerSide + input.stopSlippageReserveBps) / 10_000;
  const reservedRiskPerUnit = stopDistance + input.entryPrice * feeAndSlip;

  const caps: ReadonlyArray<{ readonly by: QuoteSizeConstraint; readonly size: number }> = [
    { by: "gross_notional", size: notionalHeadroom(input.maximumGrossNotionalUsd) },
    {
      by: "leverage",
      size: notionalHeadroom(input.maximumLeverage * input.allocatedCapitalUsd),
    },
    {
      by: "planned_loss_ceiling",
      size: input.maximumPlannedRiskPerPositionUsd / stopDistance,
    },
    {
      by: "loss_budget",
      // Preview item 15 reserves the stop loss plus the certain round-trip
      // fees and the stop-slippage reserve. Size against that same whole
      // reservation so a budget-bound quote clears its own preview.
      size: Math.max(0, input.remainingCumulativeLossUsd) / reservedRiskPerUnit,
    },
  ];

  const binding = caps.reduce((tightest, cap) => (cap.size < tightest.size ? cap : tightest));
  const requestedSize = input.requestedSize ?? binding.size;
  const allowed = Math.min(requestedSize, binding.size);
  const size = truncateSize(allowed, input.szDecimals);

  const notionalUsd = size * input.entryPrice;
  const plannedLossAtStopUsd = size * stopDistance;
  const reservedRiskUsd = plannedLossAtStopUsd + notionalUsd * feeAndSlip;

  // `requested` only when the harness's own number survived; otherwise name the
  // rule that cut it, so "ask for less" and "this mission cannot trade" read
  // differently.
  const constrainedBy: QuoteSizeConstraint =
    input.requestedSize === undefined || allowed < input.requestedSize ? binding.by : "requested";

  if (notionalUsd < input.minimumNotionalUsd) {
    return {
      size,
      requestedSize,
      notionalUsd,
      plannedLossAtStopUsd,
      reservedRiskUsd,
      constrainedBy: "below_exchange_minimum",
      feasible: false,
      detail:
        `the largest size ${binding.by} allows is ${size} ($${notionalUsd.toFixed(2)} notional), ` +
        `below the $${input.minimumNotionalUsd} exchange minimum`,
    };
  }

  return {
    size,
    requestedSize,
    notionalUsd,
    plannedLossAtStopUsd,
    reservedRiskUsd,
    constrainedBy,
    feasible: true,
    detail:
      constrainedBy === "requested"
        ? `size ${size} clears every ceiling`
        : `size ${size} is what ${constrainedBy} allows` +
          (input.requestedSize === undefined ? "" : ` of the ${input.requestedSize} requested`),
  };
}

/**
 * The limit price to quote from a live book.
 *
 * `marketable_ioc` has to cross, so it takes the far side plus the slippage
 * allowance the executor itself uses; `resting_limit` sits at the near side.
 * The server prices this rather than the harness because a limit that does not
 * cross is refused at preview and reads to a model as "the market refused".
 */
export function deriveQuoteLimitPrice(input: {
  readonly side: "buy" | "sell";
  readonly orderPreference: "marketable_ioc" | "resting_limit";
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly slippageBps: number;
}): number {
  const allowance = 1 + input.slippageBps / 10_000;
  if (input.orderPreference === "resting_limit") {
    return input.side === "buy" ? input.bestBid : input.bestAsk;
  }
  return input.side === "buy" ? input.bestAsk * allowance : input.bestBid / allowance;
}
