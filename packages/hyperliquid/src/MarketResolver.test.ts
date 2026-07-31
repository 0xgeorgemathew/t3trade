/**
 * Tests for {@link HyperliquidMarketResolver}.
 *
 * These pin the §10.6 rule that the asset index is resolved at runtime from
 * live `metaAndAssetCtxs` metadata — never hard-coded. The fixture deliberately
 * places ETH at index 2 (NOT 1) so a resolver that silently assumed
 * "ETH === index 1" would fail this suite.
 *
 * @module HyperliquidMarketResolverTests
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HyperliquidInfoClient } from "./InfoClient.ts";
import { makeFakeInfoClient } from "./InfoClientTest.ts";
import type { WireMetaAndAssetCtxsResponse } from "./wire.ts";
import { HyperliquidMarketResolver, HyperliquidMarketResolverLive } from "./MarketResolver.ts";

/**
 * Canned `metaAndAssetCtxs` fixture.
 *
 * ETH is at index 2, NOT index 1 — this is the load-bearing detail that proves
 * no hard-coding. BTC sits at 0, SOL at 1, so a resolver that assumed
 * "ETH === 1" would resolve the wrong market. The `assetCtxs` array is
 * length-matched and parallel-indexed to the universe (§10.6).
 */
const FIXTURE: WireMetaAndAssetCtxsResponse = [
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 20 },
      { name: "SOL", szDecimals: 2, maxLeverage: 10 },
      { name: "ETH", szDecimals: 4, maxLeverage: 40 },
      // Delisted markets stay in the universe on the live exchange.
      { name: "MATIC", szDecimals: 1, maxLeverage: 50, isDelisted: true },
    ],
  },
  [
    {
      markPx: "95000.0",
      midPx: "95001.0",
      oraclePx: "94998.0",
      funding: "-0.00005",
      openInterest: "320.1",
      dayNtlVlm: "50000000.0",
      prevDayPx: "94500.0",
    },
    {
      markPx: "180.0",
      midPx: "180.1",
      oraclePx: "179.9",
      funding: "0.00002",
      openInterest: "95000.0",
      dayNtlVlm: "8000000.0",
      prevDayPx: "178.0",
    },
    {
      markPx: "3750.1",
      midPx: "3750.5",
      oraclePx: "3749.0",
      funding: "0.00012",
      openInterest: "12500.5",
      dayNtlVlm: "1200000.0",
      prevDayPx: "3700.0",
    },
    {
      // Dead book on a delisted market: midPx is null on the live exchange.
      markPx: "0.21",
      midPx: null,
      oraclePx: "0.21",
      funding: "0.0",
      openInterest: "0.0",
      dayNtlVlm: "0.0",
      prevDayPx: "0.21",
    },
  ],
];

/** The Live resolver built against a fake InfoClient serving the canned fixture. */
const resolverLayer = Layer.provide(
  HyperliquidMarketResolverLive,
  Layer.succeed(HyperliquidInfoClient, makeFakeInfoClient({ metaAndAssetCtxs: FIXTURE })),
);

describe("HyperliquidMarketResolver.resolveMarket", () => {
  const cases = [
    // ETH at index 2 (NOT 1) — proves the index is resolved from the live
    // universe position, not a hard-coded assumption.
    {
      name: "resolves ETH at its live universe index (2, not 1)",
      symbol: "ETH",
      expectedIndex: 2,
      expectedSzDecimals: 4,
      expectedMaxLeverage: 40,
    },
    {
      name: "resolves BTC at index 0",
      symbol: "BTC",
      expectedIndex: 0,
      expectedSzDecimals: 5,
      expectedMaxLeverage: 20,
    },
    {
      name: "resolves SOL at index 1",
      symbol: "SOL",
      expectedIndex: 1,
      expectedSzDecimals: 2,
      expectedMaxLeverage: 10,
    },
  ] as const;

  for (const testCase of cases) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        const resolver = yield* HyperliquidMarketResolver;
        const resolved = yield* resolver.resolveMarket(testCase.symbol);
        expect(resolved.symbol).toBe(testCase.symbol);
        expect(resolved.assetIndex).toBe(testCase.expectedIndex);
        expect(resolved.szDecimals).toBe(testCase.expectedSzDecimals);
        expect(resolved.maxLeverage).toBe(testCase.expectedMaxLeverage);
        expect(resolved.available).toBe(true);
      }).pipe(Effect.provide(resolverLayer)),
    );
  }

  it.effect("resolves a delisted market as unavailable", () =>
    Effect.gen(function* () {
      const resolver = yield* HyperliquidMarketResolver;
      const resolved = yield* resolver.resolveMarket("MATIC");
      expect(resolved.assetIndex).toBe(3);
      expect(resolved.available).toBe(false);
    }).pipe(Effect.provide(resolverLayer)),
  );

  it.effect("fails with HyperliquidMarketError(not_found) for an unknown symbol", () =>
    Effect.gen(function* () {
      const resolver = yield* HyperliquidMarketResolver;
      const error = yield* resolver.resolveMarket("DOGE").pipe(Effect.flip);
      expect(error._tag).toBe("HyperliquidMarketError");
      if (error._tag === "HyperliquidMarketError") {
        expect(error.symbol).toBe("DOGE");
        expect(error.reason).toBe("not_found");
      }
    }).pipe(Effect.provide(resolverLayer)),
  );

  it.effect("caches metadata and serves the second resolve from cache (no re-fetch)", () => {
    // The §13 freshness window (5s) is well beyond two back-to-back resolves,
    // so the InfoClient must be hit exactly once across both calls.
    let fetches = 0;
    const base = makeFakeInfoClient({ metaAndAssetCtxs: FIXTURE });
    const countingInfoLayer = Layer.succeed(HyperliquidInfoClient, {
      ...base,
      metaAndAssetCtxs: Effect.sync(() => {
        fetches += 1;
        return FIXTURE;
      }),
    });
    return Effect.gen(function* () {
      const resolver = yield* HyperliquidMarketResolver;
      const first = yield* resolver.resolveMarket("ETH");
      const second = yield* resolver.resolveMarket("ETH");
      expect(first.assetIndex).toBe(2);
      expect(second.assetIndex).toBe(2);
      expect(fetches).toBe(1);
    }).pipe(Effect.provide(Layer.provide(HyperliquidMarketResolverLive, countingInfoLayer)));
  });
});
