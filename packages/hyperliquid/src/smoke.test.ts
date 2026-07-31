/**
 * Live testnet smoke suite — Step 9(b).
 *
 * Two independently gated groups:
 *
 *  - Market reads (public, no credentials): run with
 *    `HYPERLIQUID_TESTNET_LIVE=1 vp run --filter @t3tools/hyperliquid test`.
 *    Covers meta, snapshot, candles for every §13 interval (the snapshot-API
 *    half of the Gate-0 interval proof), the order book, and live WebSocket
 *    subscriptions including every candle interval (the WS half).
 *
 *  - Account reads: additionally need `HYPERLIQUID_TESTNET_MASTER_ADDRESS`
 *    (the §10.6 master-wallet address). Skipped, honestly, until Gate 0's
 *    funded address exists.
 *
 * Uses `it.live` (not `it.effect`): these tests hit the real exchange and need
 * the real clock — a TestClock at epoch 0 would compute nonsense candle
 * windows and never advance the WebSocket timeouts.
 *
 * @module HyperliquidSmoke
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { HyperliquidGateway } from "./Gateway.ts";
import {
  HyperliquidGatewayLive,
  HyperliquidInfoClientLive,
  HyperliquidMarketResolverLive,
  HyperliquidWebSocketClient,
  HyperliquidWebSocketClientLive,
} from "./index.ts";

const MASTER_ADDRESS = process.env.HYPERLIQUID_TESTNET_MASTER_ADDRESS;
const POC_MARKET = process.env.HYPERLIQUID_TESTNET_MARKET ?? "ETH";

const hasMasterAddress = typeof MASTER_ADDRESS === "string" && MASTER_ADDRESS.length > 3;
/** Market reads are public; either opt-in enables them. */
const isLive = process.env.HYPERLIQUID_TESTNET_LIVE === "1" || hasMasterAddress;

const describeMarket = isLive ? describe : describe.skip;
const describeAccount = hasMasterAddress ? describe : describe.skip;

/** The gateway layer wired against the real testnet. Bottom-up: http → info → resolver → gateway. */
const infoWithHttp = HyperliquidInfoClientLive.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer))),
);
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));
const liveGatewayLayer = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

describeMarket("Hyperliquid testnet live smoke — market reads (Step 9b)", () => {
  it.live(
    "resolves the POC market from live metadata (no hard-coded index)",
    () =>
      Effect.gen(function* () {
        const gateway = yield* HyperliquidGateway;
        const resolved = yield* gateway.resolveMarket(POC_MARKET);
        expect(resolved.symbol).toBe(POC_MARKET);
        expect(resolved.assetIndex).toBeGreaterThanOrEqual(0);
        expect(resolved.szDecimals).toBeGreaterThanOrEqual(0);
        expect(resolved.available).toBe(true);
      }).pipe(Effect.provide(liveGatewayLayer)),
    15_000,
  );

  it.live(
    "reads a market snapshot with freshness stamps",
    () =>
      Effect.gen(function* () {
        const gateway = yield* HyperliquidGateway;
        const snap = yield* gateway.getMarketSnapshot(POC_MARKET);
        expect(snap.markPrice).toBeGreaterThan(0);
        expect(snap.freshness.staleAfterMillis).toBe(5_000);
        expect(snap.bestBidOffer.freshness.staleAfterMillis).toBe(2_000);
      }).pipe(Effect.provide(liveGatewayLayer)),
    15_000,
  );

  // Gate-0 interval proof (snapshot API): one test per interval proving
  // testnet serves each directly (no local synthesis, §13).
  for (const [interval, intervalMillis] of [
    ["1m", 60_000],
    ["3m", 180_000],
    ["5m", 300_000],
    ["15m", 900_000],
    ["1h", 3_600_000],
  ] as const) {
    it.live(
      `serves ${interval} candles directly from testnet (§13 no-local-synthesis)`,
      () =>
        Effect.gen(function* () {
          const gateway = yield* HyperliquidGateway;
          const history = yield* gateway.getMarketHistory({
            market: POC_MARKET as never,
            interval,
            maxBars: 30,
          });
          expect(history.candles.length).toBeGreaterThan(0);
          expect(history.candles.length).toBeLessThanOrEqual(500);
          // The exchange answered in this interval, not a synthesised one:
          // bars are exactly one interval apart.
          const first = history.candles[0];
          const second = history.candles[1];
          if (first && second) {
            expect(second.openTime - first.openTime).toBe(intervalMillis);
          }
        }).pipe(Effect.provide(liveGatewayLayer)),
      15_000,
    );
  }

  it.live(
    "reads the order book with ≤20 levels per side",
    () =>
      Effect.gen(function* () {
        const gateway = yield* HyperliquidGateway;
        const book = yield* gateway.getOrderBook(POC_MARKET);
        expect(book.bids.length).toBeLessThanOrEqual(20);
        expect(book.asks.length).toBeLessThanOrEqual(20);
        expect(book.bids[0]?.price).toBeGreaterThan(0);
      }).pipe(Effect.provide(liveGatewayLayer)),
    15_000,
  );

  it.live(
    "delivers live allMids over the WebSocket client",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ws = yield* HyperliquidWebSocketClient;
          const first = yield* ws
            .subscribe({ type: "allMids" })
            .pipe(Stream.take(1), Stream.runCollect);
          expect(first.length).toBe(1);
          expect(first[0]?.channel).toBe("allMids");
        }),
      ).pipe(Effect.provide(HyperliquidWebSocketClientLive), Effect.timeout("25 seconds")),
    30_000,
  );

  // Gate-0 interval proof (WebSocket API): the exchange acks each candle
  // interval and pushes the current bar immediately. All five subscriptions
  // share the `candle` channel, so this also proves the client's
  // per-subscription routing (a 1m bar must not surface on the 1h stream).
  it.live(
    "serves every §13 candle interval over the WebSocket client",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const intervals = ["1m", "3m", "5m", "15m", "1h"] as const;
          const ws = yield* HyperliquidWebSocketClient;
          const deliveries = yield* Effect.forEach(
            intervals,
            (interval) =>
              ws
                .subscribe({ type: "candle", coin: POC_MARKET, interval })
                .pipe(Stream.take(1), Stream.runCollect),
            { concurrency: "unbounded" },
          );
          for (const [index, interval] of intervals.entries()) {
            const delivery = deliveries[index]?.[0];
            expect(delivery?.subscription.interval).toBe(interval);
            // The payload itself names the interval it belongs to.
            const data = delivery?.data as { i?: string } | undefined;
            expect(data?.i).toBe(interval);
          }
        }),
      ).pipe(Effect.provide(HyperliquidWebSocketClientLive), Effect.timeout("40 seconds")),
    45_000,
  );
});

describeAccount("Hyperliquid testnet live smoke — account reads (Step 9b)", () => {
  it.live(
    "reads account state with the master-wallet address (§10.6 identity)",
    () =>
      Effect.gen(function* () {
        const gateway = yield* HyperliquidGateway;
        const snap = yield* gateway.getAccountSnapshot(MASTER_ADDRESS as `0x${string}`);
        expect(snap.address).toBe(MASTER_ADDRESS);
        expect(snap.freshness.staleAfterMillis).toBe(5_000);
      }).pipe(Effect.provide(liveGatewayLayer)),
    15_000,
  );

  it.live(
    "reads the canonical net position for the POC market",
    () =>
      Effect.gen(function* () {
        const gateway = yield* HyperliquidGateway;
        const pos = yield* gateway.getPosition(MASTER_ADDRESS as `0x${string}`, POC_MARKET);
        // Net-zero is valid; just verify the shape resolves.
        expect(typeof pos.size).toBe("number");
      }).pipe(Effect.provide(liveGatewayLayer)),
    15_000,
  );

  it.live(
    "lists open orders keyed by canonical identity",
    () =>
      Effect.gen(function* () {
        const gateway = yield* HyperliquidGateway;
        const orders = yield* gateway.getOpenOrders(MASTER_ADDRESS as `0x${string}`);
        expect(Array.isArray(orders)).toBe(true);
      }).pipe(Effect.provide(liveGatewayLayer)),
    15_000,
  );
});
