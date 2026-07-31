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
    orders: [
      {
        a: assetIndex,
        b: order.side === "buy",
        p: order.limitPrice,
        s: order.size,
        r: order.reduceOnly,
        t: { limit: { tif: order.timeInForce === "ioc" ? "Ioc" : "Gtc" } },
        cloid: order.cloid,
      },
    ],
    grouping: "na",
  };
}

/**
 * Build the Hyperliquid `cancel` action payload for a cloid-keyed order.
 */
export function buildCancelByCloidAction(coin: string, cloid: string): Record<string, unknown> {
  return {
    cancels: [{ coin, cloid }],
  };
}
