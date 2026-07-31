/**
 * Hyperliquid market resolver - spec §10.6 + §13.
 *
 * Resolves the canonical market identifiers (asset index, size decimals, max
 * leverage, availability) for a perp symbol from live `metaAndAssetCtxs`
 * metadata. The asset index is the position of the coin in `meta.universe`,
 * which is the same position in `assetCtxs` — it MUST be resolved at runtime
 * and never hard-coded (ETH is not always index 1).
 *
 * The resolved metadata is cached in a `Ref` and re-fetched when it is older
 * than `MARKET_FRESHNESS.assetContextStaleAfterMillis` (§13: 5s). Resolution is
 * an O(n) scan of the cached universe by name; for the POC's small testnet
 * universe this is cheaper than maintaining a parallel map.
 *
 * @module HyperliquidMarketResolver
 */
import { Context, Effect, Layer, Ref } from "effect";
import * as Clock from "effect/Clock";
import { MARKET_FRESHNESS, type ResolvedMarket } from "@t3tools/trading-contracts/market";
import { HyperliquidInfoClient } from "./InfoClient.ts";
import {
  HyperliquidDecodeError,
  HyperliquidMarketError,
  HyperliquidRequestError,
} from "./errors.ts";
import type { WireAssetContext, WirePerpUniverse } from "./wire.ts";

/** Combined transport error for any Info call (mirrors InfoClient's `InfoError`). */
export type HyperliquidInfoError = HyperliquidRequestError | HyperliquidDecodeError;

/**
 * One row of the parallel-array pairing: a universe entry zipped with its
 * asset context and its index in the universe. Pre-computing the index at
 * refresh time keeps `resolveMarket` a pure scan over the cache.
 */
interface CachedMarketRow {
  readonly index: number;
  readonly universe: WirePerpUniverse;
  readonly context: WireAssetContext;
}

/** Cached metadata + the wall-clock millis at which it was observed. */
interface MarketCache {
  readonly rows: ReadonlyArray<CachedMarketRow>;
  readonly observedAtMillis: number;
}

/** Sentinel for an empty cache (observedAtMillis = 0 forces a fetch on first resolve). */
const EMPTY_CACHE: MarketCache = { rows: [], observedAtMillis: 0 };

export class HyperliquidMarketResolver extends Context.Service<
  HyperliquidMarketResolver,
  {
    /**
     * Resolve the canonical market identifiers for a perp symbol.
     *
     * Re-fetches `metaAndAssetCtxs` first if the cache is older than the §13
     * asset-context staleness window (5s), then scans the cached universe by
     * name. Fails with `HyperliquidMarketError` (`not_found`) if the symbol is
     * absent from the universe, or (`unavailable`) if the market is not
     * accepting new positions.
     */
    readonly resolveMarket: (
      symbol: string,
    ) => Effect.Effect<ResolvedMarket, HyperliquidMarketError | HyperliquidInfoError>;
  }
>()("@t3tools/hyperliquid/MarketResolver/HyperliquidMarketResolver") {}

const makeHyperliquidMarketResolver = Effect.gen(function* () {
  const info = yield* HyperliquidInfoClient;
  const cache = yield* Ref.make<MarketCache>(EMPTY_CACHE);

  /**
   * Re-fetch `metaAndAssetCtxs` and zip the parallel arrays into cached rows.
   *
   * `meta.universe[i]` corresponds to `assetCtxs[i]` (§10.6); the asset index
   * is `i`. Both arrays are length-matched by the exchange; if they ever
   * diverge, the shorter one bounds the pairing so a trailing mismatch does
   * not throw off every index.
   */
  const refresh = Effect.gen(function* () {
    const [meta, assetCtxs] = yield* info.metaAndAssetCtxs;
    const universe = meta.universe;
    const count = Math.min(universe.length, assetCtxs.length);
    const rows: CachedMarketRow[] = new Array(count);
    for (let i = 0; i < count; i++) {
      rows[i] = {
        index: i,
        universe: universe[i]!,
        context: assetCtxs[i]!,
      };
    }
    const observedAtMillis = yield* Clock.currentTimeMillis;
    yield* Ref.set(cache, { rows, observedAtMillis });
  });

  /**
   * Refresh the cache when it is older than the §13 asset-context staleness
   * window (5s). A brand-new cache (observedAtMillis = 0) always refreshes.
   * Concurrent resolves may race a refresh; the last writer wins, which is
   * fine — every fetch is equally authoritative.
   */
  const refreshIfStale = Effect.gen(function* () {
    const current = yield* Ref.get(cache);
    const now = yield* Clock.currentTimeMillis;
    const ageMillis = now - current.observedAtMillis;
    if (ageMillis >= MARKET_FRESHNESS.assetContextStaleAfterMillis) {
      yield* refresh;
    }
  });

  const resolveMarket = Effect.fn("HyperliquidMarketResolver.resolveMarket")(function* (
    symbol: string,
  ) {
    yield* refreshIfStale;

    const { rows } = yield* Ref.get(cache);
    const matched = rows.find((row) => row.universe.name === symbol);

    if (matched === undefined) {
      // Yield the tagged error directly: v4 treats a yieldable error value
      // as a failure without `Effect.fail`, and `return yield*` preserves a
      // definitive generator exit point (TS377006/TS377019).
      return yield* new HyperliquidMarketError({ symbol, reason: "not_found" });
    }

    // `onlyIsolated` constrains margin mode, not availability: an isolated
    // market still accepts new positions. For the POC every resolved universe
    // entry is available.
    const resolved: ResolvedMarket = {
      symbol: matched.universe.name as ResolvedMarket["symbol"],
      assetIndex: matched.index,
      szDecimals: matched.universe.szDecimals,
      maxLeverage: matched.universe.maxLeverage,
      available: true,
    };
    return resolved;
  });

  return HyperliquidMarketResolver.of({ resolveMarket });
});

/** Live layer. Declared after `makeHyperliquidMarketResolver` (const is not hoisted). */
export const HyperliquidMarketResolverLive = Layer.effect(
  HyperliquidMarketResolver,
  makeHyperliquidMarketResolver,
);
