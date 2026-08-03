/**
 * Maps a harness order intent into a Hyperliquid wire order - spec §15.3, §15.4.
 *
 * Marketable IOC pricing (§15.4): a buy IOC limit is the fresh best ask plus
 * allowed slippage; a sell IOC limit is the fresh best bid minus slippage. The
 * limit is never derived from a stale mark price — execution-critical stale
 * BBO blocks submission.
 *
 * Precision (§15.3): size is truncated to `szDecimals`, price is normalised to
 * 5 significant figures with trailing zeros stripped, and the exchange minimum
 * notional is verified before the order leaves this module.
 *
 * @module HyperliquidOrderMapper
 */
import { Effect, Schema } from "effect";

import { formatPrice, formatSize, meetsMinimumNotional, MIN_NOTIONAL_USD } from "./Precision.ts";
import type { MarketBestBidOffer } from "@t3tools/trading-contracts/market";
import { MARKET_FRESHNESS } from "@t3tools/trading-contracts/market";
import type { TradingOrderIntent, TradingWireOrder } from "@t3tools/trading-contracts/execution";
import { deriveCloid } from "./Cloid.ts";

/** The order mapper rejected the intent before any signing. */
export class HyperliquidOrderMapperError extends Schema.TaggedErrorClass<HyperliquidOrderMapperError>()(
  "HyperliquidOrderMapperError",
  {
    reason: Schema.Literals([
      "stale_bbo",
      "missing_best_ask",
      "missing_best_bid",
      "below_min_notional",
      "non_positive_size",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `HyperliquidOrderMapperError(${this.reason})`;
  }
}

/** Inputs the mapper needs beyond the intent itself. */
export interface OrderMappingInput {
  /** The harness request. */
  readonly intent: TradingOrderIntent;
  /** Fresh top-of-book for the market (§15.4). */
  readonly bbo: MarketBestBidOffer;
  /** Size decimals for the market, from resolved metadata (§15.3). */
  readonly szDecimals: number;
  /** Allowed slippage in basis points for marketable IOC pricing. */
  readonly allowedSlippageBps: number;
  /** Current time in ms, to test BBO freshness against §13's 2s window. */
  readonly nowMs: number;
}

const bps = (basisPoints: number): number => basisPoints / 10_000;

/**
 * Assert the BBO is fresh enough to price a marketable IOC (§13: 2s). A stale
 * BBO blocks submission — the limit must cross, and a stale mark cannot
 * guarantee that.
 */
function assertBboFresh(
  bbo: MarketBestBidOffer,
  nowMs: number,
): Effect.Effect<void, HyperliquidOrderMapperError> {
  const age = nowMs - bbo.freshness.observedAt;
  if (age > MARKET_FRESHNESS.bboStaleAfterMillis) {
    return new HyperliquidOrderMapperError({
      reason: "stale_bbo",
      detail: `bbo aged ${age}ms past the ${MARKET_FRESHNESS.bboStaleAfterMillis}ms window`,
    });
  }
  return Effect.void;
}

/**
 * Derive the marketable IOC limit price from a fresh BBO (§15.4).
 *
 * Buy = best ask + slippage (so the limit crosses the ask and fills).
 * Sell = best bid - slippage (so the limit crosses the bid and fills).
 */
function deriveIocLimitPrice(
  side: TradingOrderIntent["side"],
  bbo: MarketBestBidOffer,
  allowedSlippageBps: number,
): Effect.Effect<number, HyperliquidOrderMapperError> {
  if (side === "buy") {
    if (bbo.askPrice === undefined) {
      return new HyperliquidOrderMapperError({ reason: "missing_best_ask" });
    }
    return Effect.succeed(bbo.askPrice * (1 + bps(allowedSlippageBps)));
  }
  if (bbo.bidPrice === undefined) {
    return new HyperliquidOrderMapperError({ reason: "missing_best_bid" });
  }
  return Effect.succeed(bbo.bidPrice * (1 - bps(allowedSlippageBps)));
}

/**
 * Map an intent to a wire order ready for signing.
 *
 * For `marketable_ioc` the limit price is derived from the fresh BBO ±
 * slippage (§15.4). For `resting_limit` the harness-supplied `limitPrice`
 * is used as-is and the order rests as GTC. In both cases size is truncated
 * to `szDecimals`, price is normalised, and the exchange minimum notional is
 * enforced before the order leaves.
 */
export const mapOrder = (
  input: OrderMappingInput,
): Effect.Effect<TradingWireOrder, HyperliquidOrderMapperError> =>
  Effect.gen(function* () {
    const { intent, bbo, szDecimals, allowedSlippageBps, nowMs } = input;

    if (intent.size <= 0) {
      return yield* new HyperliquidOrderMapperError({ reason: "non_positive_size" });
    }

    // Choose time-in-force + limit price by preference.
    const isIoc = intent.orderPreference === "marketable_ioc";
    if (isIoc) {
      yield* assertBboFresh(bbo, nowMs);
    }
    const rawLimit = isIoc
      ? yield* deriveIocLimitPrice(intent.side, bbo, allowedSlippageBps)
      : intent.limitPrice;

    const limitPriceStr = formatPrice(rawLimit);
    const sizeStr = formatSize(intent.size, szDecimals);
    const parsedSize = Number.parseFloat(sizeStr);

    if (!meetsMinimumNotional(parsedSize, rawLimit, MIN_NOTIONAL_USD)) {
      return yield* new HyperliquidOrderMapperError({
        reason: "below_min_notional",
        detail: `size ${sizeStr} × price ${limitPriceStr} < $${MIN_NOTIONAL_USD}`,
      });
    }

    const cloid = deriveCloid({
      missionId: intent.missionId,
      strategyVersion: intent.strategyVersion,
      executionSequence: intent.executionSequence,
      actionType: intent.actionType,
    });

    return yield* Effect.succeed({
      cloid,
      coin: intent.market,
      side: intent.side,
      limitPrice: limitPriceStr,
      size: sizeStr,
      timeInForce: isIoc ? "ioc" : ("gtc" as const),
      reduceOnly: intent.reduceOnly,
    } as TradingWireOrder);
  });

/**
 * Build the Hyperliquid `order` action payload (insertion-order keys) for the
 * wire order. The action hash depends on key order, so this is the single
 * source of truth for the field sequence the signer msgpacks.
 *
 * `assetIndex` is the runtime-resolved ETH universe index (§15.3) — never
 * copied into source. The caller resolves it from live metadata and passes it
 * in so a testnet metadata change cannot silently break signing.
 */
export function buildOrderAction(
  order: TradingWireOrder,
  assetIndex: number,
): Record<string, unknown> {
  return {
    type: "order",
    orders: [
      {
        a: assetIndex,
        b: order.side === "buy",
        p: order.limitPrice,
        s: order.size,
        r: order.reduceOnly,
        t: { limit: { tif: order.timeInForce === "ioc" ? "Ioc" : "Gtc" } },
        // Hyperliquid order-wire uses "c" for the client order id inside an
        // order leg (verified against hyperliquid-python-sdk's
        // order_request_to_order_wire). The cancel-by-cloid action's top-level
        // leg uses "cloid"; the order leg uses "c".
        //
        // Getting this wrong fails silently rather than loudly: an unrecognised
        // key still msgpacks, so the signature verifies and the order is
        // accepted — the exchange simply never registers the cloid. The
        // original Gate E fill was stored with `cloid: null` under the old key
        // while every status read "ok". The cost lands later: `cancelByCloid`
        // has nothing to address, and no cloid comes back to reconcile a fill.
        c: order.cloid,
      },
    ],
    grouping: "na",
  };
}

// ---------------------------------------------------------------------------
// §17 · Protective (reduce-only trigger) orders
// ---------------------------------------------------------------------------

/**
 * A reduce-only stop, normalised for the wire.
 *
 * `triggerPrice` is where the exchange arms the stop; `limitPrice` is the
 * price the resulting order is willing to fill at once armed. They are
 * different numbers on purpose: a stop-market that cannot cross is not
 * protection, so the limit is pushed past the trigger in the losing direction
 * by `PROTECTION_FILL_SLIPPAGE_BPS`.
 */
export interface ProtectiveStopOrder {
  readonly cloid: string;
  readonly coin: string;
  /** The side that REDUCES the position: sell protects a long, buy a short. */
  readonly side: TradingOrderIntent["side"];
  readonly triggerPrice: string;
  readonly limitPrice: string;
  readonly size: string;
}

/**
 * How far past the trigger the protective order's limit is placed, so a
 * triggered stop actually crosses instead of resting unfilled at the exact
 * trigger price.
 */
export const PROTECTION_FILL_SLIPPAGE_BPS = 100;

/** Inputs for sizing a reduce-only stop against a canonical position. */
export interface ProtectiveStopInput {
  readonly cloid: string;
  readonly coin: string;
  /** Signed canonical position size; positive long, negative short. */
  readonly positionSize: number;
  readonly stopPrice: number;
  readonly szDecimals: number;
}

/**
 * Size a reduce-only stop to a canonical position (§17.2 step 6, §17.4).
 *
 * The size comes from the position the exchange reports, never from the size
 * that was requested — a partial fill and a scale-in both make those two
 * numbers differ, and protecting the requested size is exactly the failure
 * §17.3 and §17.4 exist to prevent.
 */
export const mapProtectiveStop = (
  input: ProtectiveStopInput,
): Effect.Effect<ProtectiveStopOrder, HyperliquidOrderMapperError> =>
  Effect.gen(function* () {
    const size = Math.abs(input.positionSize);
    if (size <= 0) {
      return yield* new HyperliquidOrderMapperError({
        reason: "non_positive_size",
        detail: "cannot place protection for a flat position",
      });
    }
    const isLong = input.positionSize > 0;
    // The reducing side is the opposite of the position's direction.
    const side = isLong ? ("sell" as const) : ("buy" as const);
    // Push the fill limit past the trigger in the direction the stop is
    // running away from, so the triggered order crosses.
    const rawLimit = isLong
      ? input.stopPrice * (1 - bps(PROTECTION_FILL_SLIPPAGE_BPS))
      : input.stopPrice * (1 + bps(PROTECTION_FILL_SLIPPAGE_BPS));

    return {
      cloid: input.cloid,
      coin: input.coin,
      side,
      triggerPrice: formatPrice(input.stopPrice),
      limitPrice: formatPrice(rawLimit),
      size: formatSize(size, input.szDecimals),
    } satisfies ProtectiveStopOrder;
  });

/** One protective-order leg, in the exchange's insertion-order key sequence. */
function protectiveLeg(stop: ProtectiveStopOrder, assetIndex: number): Record<string, unknown> {
  return {
    a: assetIndex,
    b: stop.side === "buy",
    p: stop.limitPrice,
    s: stop.size,
    r: true,
    t: {
      trigger: {
        isMarket: true,
        triggerPx: stop.triggerPrice,
        tpsl: "sl",
      },
    },
    c: stop.cloid,
  };
}

/**
 * Build a grouped `normalTpsl` action: one entry parent plus one linked
 * reduce-only stop child (§17.2 step 3).
 *
 * The grouping is an optimisation and a linkage mechanism, never the safety
 * mechanism (§17.1). Submitting this does not mean the child is live: while
 * the parent is unfilled or partially filled the child may be untriggered, and
 * cancelling a partial parent cancels it outright. Every caller must still
 * inspect each per-order status and then confirm protection from canonical
 * state.
 */
export function buildGroupedEntryWithStopAction(
  entry: TradingWireOrder,
  stop: ProtectiveStopOrder,
  assetIndex: number,
): Record<string, unknown> {
  return {
    type: "order",
    orders: [
      {
        a: assetIndex,
        b: entry.side === "buy",
        p: entry.limitPrice,
        s: entry.size,
        r: entry.reduceOnly,
        t: { limit: { tif: entry.timeInForce === "ioc" ? "Ioc" : "Gtc" } },
        c: entry.cloid,
      },
      protectiveLeg(stop, assetIndex),
    ],
    grouping: "normalTpsl",
  };
}

/**
 * Build a standalone, explicitly sized reduce-only stop (§17.2 step 6).
 *
 * This is the independent protection the reconciliation path places when the
 * canonical position is larger than the confirmed protected size — after a
 * partial fill, after a scale-in, or after a parent cancellation took its
 * children with it. Grouping is `na`: it is nobody's child, which is the whole
 * point. It survives the parent.
 */
export function buildProtectiveStopAction(
  stop: ProtectiveStopOrder,
  assetIndex: number,
): Record<string, unknown> {
  return {
    type: "order",
    orders: [protectiveLeg(stop, assetIndex)],
    grouping: "na",
  };
}

/**
 * Build the Hyperliquid `cancelByCloid` action payload (insertion-order keys).
 *
 * Per the Hyperliquid exchange-endpoint spec, the action carries a top-level
 * `type: "cancelByCloid"` and each cancel leg is keyed by the numeric
 * `asset` index (the same ETH-universe index `buildOrderAction` threads as
 * `a`), not by the coin symbol. The action hash depends on key order, so
 * this is the single source of truth for the field sequence the signer
 * msgpacks — mirroring `buildOrderAction`.
 *
 * `assetIndex` is runtime-resolved from live metadata by the caller, never
 * copied into source.
 */
export function buildCancelByCloidAction(
  assetIndex: number,
  cloid: string,
): Record<string, unknown> {
  return {
    type: "cancelByCloid",
    cancels: [{ asset: assetIndex, cloid }],
  };
}
