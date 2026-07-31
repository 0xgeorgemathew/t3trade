/**
 * Live testnet smoke suite — Step 9(b).
 *
 * Env-gated: skipped unless `HYPERLIQUID_TESTNET_MASTER_ADDRESS` is set. Covers
 * every read path against the real testnet: meta, snapshot, candles (every
 * interval), order book, account state, position, open orders. Produces the
 * Gate-0 interval proof (one fixture per interval proving testnet serves each
 * directly).
 *
 * Run with:
 *   HYPERLIQUID_TESTNET_MASTER_ADDRESS=0x... vp test run packages/hyperliquid/src/smoke.ts
 *
 * @module HyperliquidSmoke
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";

import { HyperliquidGateway } from "./Gateway.ts";
import {
  HyperliquidGatewayLive,
  HyperliquidInfoClientLive,
  HyperliquidMarketResolverLive,
} from "./index.ts";

const MASTER_ADDRESS = process.env.HYPERLIQUID_TESTNET_MASTER_ADDRESS;
const POC_MARKET = process.env.HYPERLIQUID_TESTNET_MARKET ?? "ETH";

const isLive = typeof MASTER_ADDRESS === "string" && MASTER_ADDRESS.length > 3;
const describeOrSkip = isLive ? describe : describe.skip;

/** The gateway layer wired against the real testnet. Bottom-up: http → info → resolver → gateway. */
const infoWithHttp = HyperliquidInfoClientLive.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer))),
);
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));
const liveGatewayLayer = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

const run = <A, E>(effect: Effect.Effect<A, E, HyperliquidGateway>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(liveGatewayLayer)));

describeOrSkip("Hyperliquid testnet live smoke (Step 9b)", () => {
  it("resolves the POC market from live metadata (no hard-coded index)", async () => {
    const resolved = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.resolveMarket(POC_MARKET)),
    );
    expect(resolved.symbol).toBe(POC_MARKET);
    expect(resolved.assetIndex).toBeGreaterThanOrEqual(0);
    expect(resolved.szDecimals).toBeGreaterThanOrEqual(0);
  });

  it("reads a market snapshot with freshness stamps", async () => {
    const snap = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getMarketSnapshot(POC_MARKET)),
    );
    expect(snap.markPrice).toBeGreaterThan(0);
    expect(snap.freshness.staleAfterMillis).toBe(5_000);
    expect(snap.bestBidOffer.freshness.staleAfterMillis).toBe(2_000);
  });

  // Gate-0 interval proof: one test per interval proving testnet serves each
  // directly (no local synthesis, §13).
  for (const interval of ["1m", "3m", "5m", "15m", "1h"] as const) {
    it(`serves ${interval} candles directly from testnet (§13 no-local-synthesis)`, async () => {
      const history = await run(
        Effect.andThen(HyperliquidGateway, (g) =>
          g.getMarketHistory({ market: POC_MARKET as never, interval }),
        ),
      );
      expect(history.candles.length).toBeGreaterThan(0);
      expect(history.candles.length).toBeLessThanOrEqual(500);
    });
  }

  it("reads the order book with ≤20 levels per side", async () => {
    const book = await run(Effect.andThen(HyperliquidGateway, (g) => g.getOrderBook(POC_MARKET)));
    expect(book.bids.length).toBeLessThanOrEqual(20);
    expect(book.asks.length).toBeLessThanOrEqual(20);
  });

  it("reads account state with the master-wallet address (§10.6 identity)", async () => {
    const snap = await run(
      Effect.andThen(HyperliquidGateway, (g) =>
        g.getAccountSnapshot(MASTER_ADDRESS as `0x${string}`),
      ),
    );
    expect(snap.address).toBe(MASTER_ADDRESS);
    expect(snap.freshness.staleAfterMillis).toBe(5_000);
  });

  it("reads the canonical net position for the POC market", async () => {
    const pos = await run(
      Effect.andThen(HyperliquidGateway, (g) =>
        g.getPosition(MASTER_ADDRESS as `0x${string}`, POC_MARKET),
      ),
    );
    // Net-zero is valid; just verify the shape resolves.
    expect(typeof pos.size).toBe("number");
  });

  it("lists open orders keyed by canonical identity", async () => {
    const orders = await run(
      Effect.andThen(HyperliquidGateway, (g) => g.getOpenOrders(MASTER_ADDRESS as `0x${string}`)),
    );
    expect(Array.isArray(orders)).toBe(true);
  });
});
