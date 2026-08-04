/**
 * TradingMarketPrice — the live mark price the read surfaces quote.
 *
 * The position snapshot carries a mark price only while a position is open: the
 * reconciler clears it the moment the mission goes flat (§18.2). So a waiting
 * mission — the state a mission spends most of its life in — had no price
 * anywhere in its projection, and the strip could say what it was waiting for
 * without saying where the market actually was.
 *
 * This reads the mark straight from the exchange, which is the only source that
 * is true when nothing is held. The read is cached for a couple of seconds
 * because the mission snapshot is polled every three: without the window every
 * open workspace would put its own pair of Hyperliquid calls on the wire on
 * every poll, for a number that has barely moved.
 *
 * A failed read yields `null`, never a stale or invented price. A price the
 * exchange did not just confirm is worse than no price at all on a surface an
 * operator makes exit decisions from.
 *
 * @module TradingMarketPrice
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { HyperliquidGateway } from "@t3tools/hyperliquid";

export interface TradingMarketPriceShape {
  /** The market's mark price, or null when the exchange read failed. */
  readonly markPrice: (market: string) => Effect.Effect<number | null>;
}

export class TradingMarketPrice extends Context.Service<
  TradingMarketPrice,
  TradingMarketPriceShape
>()("t3/trading/TradingMarketPrice") {}

/**
 * How long a mark price is served from memory before the exchange is asked
 * again. Shorter than the 3s projection poll, so a polling client still sees a
 * fresh price each time, and long enough that several clients polling at once
 * share one read.
 */
const CACHE_WINDOW_MS = 2_000;

interface CachedPrice {
  readonly price: number;
  readonly readAt: number;
}

export const makeTradingMarketPrice = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;
  const cache = yield* Ref.make(new Map<string, CachedPrice>());

  const markPrice = (market: string): Effect.Effect<number | null> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(market);
      if (cached !== undefined && now - cached.readAt < CACHE_WINDOW_MS) return cached.price;

      const snapshot = yield* gateway.getMarketSnapshot(market).pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("trading mark price read failed", { market, cause }),
        ),
        Effect.orElseSucceed(() => null),
      );
      if (snapshot === null) return null;

      const price = snapshot.markPrice;
      yield* Ref.update(cache, (entries) => new Map(entries).set(market, { price, readAt: now }));
      return price;
    });

  return TradingMarketPrice.of({ markPrice });
});

export const TradingMarketPriceLive = Layer.effect(TradingMarketPrice, makeTradingMarketPrice);
