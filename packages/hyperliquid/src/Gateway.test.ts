/**
 * Gateway read-path tests — Step 4.
 *
 * Proves the wire→domain mapping, the §13 500-bar clamp, the master-wallet
 * identity rule, and that every read carries a freshness stamp. Uses the
 * in-process fake Info client so no network is involved; the live smoke suite
 * (Step 9) proves the same shapes against the real testnet.
 *
 * @module HyperliquidGatewayTests
 */
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { HyperliquidGateway } from "./Gateway.ts";
import { HyperliquidGatewayLive } from "./Gateway.ts";
import { HyperliquidMarketResolverLive } from "./MarketResolver.ts";
import { HyperliquidInfoClient } from "./InfoClient.ts";
import { makeFakeInfoClient } from "./InfoClientTest.ts";

/**
 * A canned testnet universe. ETH sits at index 2 (not 1) to keep proving the
 * no-hardcode rule end-to-end through the gateway.
 */
const FIXTURE_META_AND_CTX = [
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 20 },
      { name: "SOL", szDecimals: 2, maxLeverage: 10 },
      { name: "ETH", szDecimals: 4, maxLeverage: 40 },
    ],
  },
  [
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
      markPx: "150.0",
      midPx: "150.1",
      oraclePx: "149.9",
      funding: "-0.00005",
      openInterest: "320000.0",
      dayNtlVlm: "8000000.0",
      prevDayPx: "148.0",
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
  ],
] as const;

const MASTER_ADDRESS = "0xabc123def456" as `0x${string}`;

/**
 * Wire the gateway against the fake Info client with canned responses.
 *
 * Both the gateway and the resolver consume `HyperliquidInfoClient`; the fake
 * layer satisfies both, so the resulting layer has no remaining requirements.
 */
function gatewayLayerWith(overrides: Parameters<typeof makeFakeInfoClient>[0]) {
  const fakeInfo = Layer.succeed(HyperliquidInfoClient, makeFakeInfoClient(overrides));
  return Layer.provide(
    HyperliquidGatewayLive,
    Layer.merge(fakeInfo, Layer.provide(HyperliquidMarketResolverLive, fakeInfo)),
  );
}

const run = <A, E>(
  effect: Effect.Effect<A, E, HyperliquidGateway>,
  layer: Layer.Layer<HyperliquidGateway>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("HyperliquidGateway.resolveMarket", () => {
  it("resolves ETH at its live universe index (2, not 1)", async () => {
    const layer = gatewayLayerWith({ metaAndAssetCtxs: FIXTURE_META_AND_CTX });
    const resolved = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.resolveMarket("ETH")),
      layer,
    );
    expect(resolved.assetIndex).toBe(2);
    expect(resolved.szDecimals).toBe(4);
    expect(resolved.maxLeverage).toBe(40);
  });
});

describe("HyperliquidGateway.getMarketSnapshot", () => {
  it("maps wire asset context + BBO into the domain snapshot with freshness", async () => {
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      l2Book: () => ({
        coin: "ETH",
        levels: [[["3750.1", "1.2"]], [["3750.9", "1.8"]]],
        time: 1_753_000_000_000,
      }),
    });
    const snap = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getMarketSnapshot("ETH")),
      layer,
    );
    expect(snap.markPrice).toBe(3750.1);
    expect(snap.bestBidOffer.bidPrice).toBe(3750.1);
    expect(snap.bestBidOffer.askPrice).toBe(3750.9);
    // 24h change derived from prevDayPx 3700 → mark 3750.1.
    expect(snap.change24hPercent).toBeCloseTo(1.351, 1);
    // Freshness: asset context aged at 5s, BBO at 2s.
    expect(snap.freshness.staleAfterMillis).toBe(5_000);
    expect(snap.bestBidOffer.freshness.staleAfterMillis).toBe(2_000);
  });
});

describe("HyperliquidGateway.getMarketHistory", () => {
  it("clamps the response to the §13 500-bar cap", async () => {
    // Canned response with 600 candles; the gateway must trim to 500.
    const manyCandles = Array.from({ length: 600 }, (_, i) => [
      1_753_000_000_000 + i * 60_000,
      "3740.0",
      "3755.0",
      "3735.0",
      "3750.0",
      "100.0",
    ]) as ReadonlyArray<[number, string, string, string, string, string]>;
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      candleSnapshot: () => manyCandles as never,
    });
    const history = await run(
      Effect.andThen(HyperliquidGateway, (g) =>
        g.getMarketHistory({ market: "ETH", interval: "1m" }),
      ),
      layer,
    );
    expect(history.candles.length).toBe(500);
    expect(history.finalisedClose).toBe(history.candles[499]?.closeTime);
  });

  it("honours a caller-requested cap smaller than 500", async () => {
    const candles = Array.from({ length: 50 }, (_, i) => [
      1_753_000_000_000 + i * 60_000,
      "3740.0",
      "3755.0",
      "3735.0",
      "3750.0",
      "100.0",
    ]) as ReadonlyArray<[number, string, string, string, string, string]>;
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      candleSnapshot: () => candles as never,
    });
    const history = await run(
      Effect.andThen(HyperliquidGateway, (g) =>
        g.getMarketHistory({ market: "ETH", interval: "1m", maxBars: 10 }),
      ),
      layer,
    );
    expect(history.candles.length).toBe(10);
  });
});

describe("HyperliquidGateway.getAccountSnapshot", () => {
  it("maps clearinghouse state into the account snapshot keyed by the master address", async () => {
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      clearinghouseState: () => ({
        marginSummary: { accountValue: "1000.0", totalMarginUsed: "250.0", withdrawable: "750.0" },
        assetPositions: [
          {
            position: {
              coin: "ETH",
              szi: "0.3",
              entryPx: "3718.4",
              unrealizedPnl: "9.5",
              cumulativeFunding: "-0.4",
              marginUsed: "250.0",
            },
          },
        ],
      }),
    });
    const snap = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getAccountSnapshot(MASTER_ADDRESS)),
      layer,
    );
    expect(snap.address).toBe(MASTER_ADDRESS);
    expect(snap.accountValue).toBe(1000);
    expect(snap.positions[0]?.market).toBe("ETH");
    // §13: account state freshness is 5s.
    expect(snap.freshness.staleAfterMillis).toBe(5_000);
  });

  it("rejects an empty master address (§10.6 identity rule)", async () => {
    const layer = gatewayLayerWith({ metaAndAssetCtxs: FIXTURE_META_AND_CTX });
    await expect(
      run(
        Effect.andThen(HyperliquidGateway, (g) => g.getAccountSnapshot("0x" as `0x${string}`)),
        layer,
      ),
    ).rejects.toThrow();
  });
});

describe("HyperliquidGateway.getPosition", () => {
  it("returns a flat zero position when the asset has no open position", async () => {
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      clearinghouseState: () => ({
        marginSummary: { accountValue: "1000.0", totalMarginUsed: "0", withdrawable: "1000.0" },
        assetPositions: [],
      }),
    });
    const pos = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getPosition(MASTER_ADDRESS, "ETH")),
      layer,
    );
    expect(pos.size).toBe(0);
    expect(pos.market).toBe("ETH");
  });

  it("returns the signed net position for an open long", async () => {
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      clearinghouseState: () => ({
        marginSummary: { accountValue: "1000.0", totalMarginUsed: "250.0", withdrawable: "750.0" },
        assetPositions: [
          {
            position: {
              coin: "ETH",
              szi: "0.3",
              entryPx: "3718.4",
              unrealizedPnl: "9.5",
              cumulativeFunding: "-0.4",
              marginUsed: "250.0",
            },
          },
        ],
      }),
    });
    const pos = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getPosition(MASTER_ADDRESS, "ETH")),
      layer,
    );
    expect(pos.size).toBe(0.3);
    expect(pos.entryPrice).toBe(3718.4);
  });
});

describe("HyperliquidGateway.getOpenOrders", () => {
  it("normalises B/A side literals to buy/sell", async () => {
    const layer = gatewayLayerWith({
      metaAndAssetCtxs: FIXTURE_META_AND_CTX,
      openOrders: () => [
        {
          coin: "ETH",
          side: "B",
          limitPx: "3700.0",
          sz: "0.3",
          oid: 1,
          orderState: { status: "open", timestamp: 1_753_000_000_000 },
        },
        {
          coin: "ETH",
          side: "A",
          limitPx: "3800.0",
          sz: "0.3",
          oid: 2,
          orderState: { status: "open", timestamp: 1_753_000_000_000 },
        },
      ],
    });
    const orders = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getOpenOrders(MASTER_ADDRESS)),
      layer,
    );
    expect(orders[0]?.side).toBe("buy");
    expect(orders[1]?.side).toBe("sell");
  });
});
