/**
 * Gateway read-path tests — Step 4.
 *
 * Proves the wire→domain mapping, the §13 500-bar clamp, the master-wallet
 * identity rule, and that every read carries a freshness stamp. Uses the
 * in-process fake Info client (canned payloads in the recorded-fixture wire
 * shapes) so no network is involved; the live smoke suite (Step 9) proves the
 * same paths against the real testnet.
 *
 * @module HyperliquidGatewayTests
 */
import { Effect, Layer, Schema } from "effect";
import * as Clock from "effect/Clock";
import { AgentNetPosition } from "@t3tools/trading-contracts/account-snapshot";
import { describe, expect, it } from "@effect/vitest";
import { HyperliquidGateway } from "./Gateway.ts";
import { HyperliquidGatewayLive } from "./Gateway.ts";
import { HyperliquidMarketResolverLive } from "./MarketResolver.ts";
import { HyperliquidInfoClient } from "./InfoClient.ts";
import { makeFakeInfoClient } from "./InfoClientTest.ts";
import type { WireCandle, WireCandleSnapshotRequest } from "./wire.ts";

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
      markPx: "95000.0",
      midPx: "95001.0",
      oraclePx: "94998.0",
      funding: "-0.00005",
      openInterest: "320.1",
      dayNtlVlm: "50000000.0",
      prevDayPx: "94500.0",
    },
    {
      // Dead book: the live exchange sends midPx: null for such markets.
      markPx: "150.0",
      midPx: null,
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

/** A wire candle in the exchange's object shape, one minute wide. */
const wireCandle = (openTime: number): WireCandle => ({
  t: openTime,
  T: openTime + 59_999,
  s: "ETH",
  i: "1m",
  o: "3740.0",
  c: "3750.0",
  h: "3755.0",
  l: "3735.0",
  v: "100.0",
  n: 12,
});

const FIXTURE_BOOK = {
  coin: "ETH",
  levels: [[{ px: "3750.1", sz: "1.2", n: 3 }], [{ px: "3750.9", sz: "1.8", n: 2 }]],
  time: 1_753_000_000_000,
} as const;

const FIXTURE_CLEARINGHOUSE = {
  marginSummary: { accountValue: "1000.0", totalMarginUsed: "250.0" },
  withdrawable: "750.0",
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
} as const;

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

describe("HyperliquidGateway.resolveMarket", () => {
  it.effect("resolves ETH at its live universe index (2, not 1)", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const resolved = yield* gateway.resolveMarket("ETH");
      expect(resolved.assetIndex).toBe(2);
      expect(resolved.szDecimals).toBe(4);
      expect(resolved.maxLeverage).toBe(40);
    }).pipe(Effect.provide(gatewayLayerWith({ metaAndAssetCtxs: FIXTURE_META_AND_CTX }))),
  );
});

describe("HyperliquidGateway.getMarketSnapshot", () => {
  it.effect("maps wire asset context + BBO into the domain snapshot with freshness", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const snap = yield* gateway.getMarketSnapshot("ETH");
      expect(snap.markPrice).toBe(3750.1);
      expect(snap.midPrice).toBe(3750.5);
      expect(snap.bestBidOffer.bidPrice).toBe(3750.1);
      expect(snap.bestBidOffer.askPrice).toBe(3750.9);
      // 24h change derived from prevDayPx 3700 → mark 3750.1.
      expect(snap.change24hPercent).toBeCloseTo(1.351, 1);
      // Freshness: asset context aged at 5s, BBO at 2s.
      expect(snap.freshness.staleAfterMillis).toBe(5_000);
      expect(snap.bestBidOffer.freshness.staleAfterMillis).toBe(2_000);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          l2Book: () => FIXTURE_BOOK,
        }),
      ),
    ),
  );

  it.effect("falls back to mark when the exchange sends midPx: null", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const snap = yield* gateway.getMarketSnapshot("SOL");
      expect(snap.markPrice).toBe(150);
      expect(snap.midPrice).toBe(150);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          l2Book: () => ({ ...FIXTURE_BOOK, coin: "SOL" }),
        }),
      ),
    ),
  );
});

describe("HyperliquidGateway.getMarketHistory", () => {
  it.effect("clamps to the §13 500-bar cap, keeping the MOST RECENT bars", () => {
    // Canned response with 600 one-minute candles, oldest → newest.
    const base = 1_753_000_000_000;
    const manyCandles = Array.from({ length: 600 }, (_, i) => wireCandle(base + i * 60_000));
    return Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const history = yield* gateway.getMarketHistory({ market: "ETH", interval: "1m" });
      expect(history.candles.length).toBe(500);
      // The 100 OLDEST bars were trimmed, not the newest.
      expect(history.candles[0]?.openTime).toBe(base + 100 * 60_000);
      expect(history.candles[499]?.openTime).toBe(base + 599 * 60_000);
      // t/T map to open/close time (T, not t, is the close).
      expect(history.candles[0]?.closeTime).toBe(base + 100 * 60_000 + 59_999);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          candleSnapshot: () => manyCandles,
        }),
      ),
    );
  });

  it.effect("honours a caller-requested cap smaller than 500", () => {
    const candles = Array.from({ length: 50 }, (_, i) =>
      wireCandle(1_753_000_000_000 + i * 60_000),
    );
    return Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const history = yield* gateway.getMarketHistory({
        market: "ETH",
        interval: "1m",
        maxBars: 10,
      });
      expect(history.candles.length).toBe(10);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          candleSnapshot: () => candles,
        }),
      ),
    );
  });

  it.effect("supplies the exchange-required startTime when the caller omits it", () => {
    // The exchange rejects a candleSnapshot request without startTime, so the
    // gateway must default it to the most-recent window: interval × cap.
    let received: WireCandleSnapshotRequest | undefined;
    return Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis;
      const gateway = yield* HyperliquidGateway;
      yield* gateway.getMarketHistory({ market: "ETH", interval: "1m", maxBars: 10 });
      const after = yield* Clock.currentTimeMillis;
      // 10 one-minute bars back from the gateway's clock read.
      expect(received?.startTime).toBeGreaterThanOrEqual(before - 10 * 60_000);
      expect(received?.startTime).toBeLessThanOrEqual(after - 10 * 60_000);
      expect(received?.endTime).toBeUndefined();
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          candleSnapshot: (req) => {
            received = req;
            return [];
          },
        }),
      ),
    );
  });

  it.effect("marks the most-recent FINALISED close, excluding the in-progress bar", () =>
    // Three closed bars, then the currently-forming bar (its close time is in
    // the future). §13: a finalised close is processed at most once, so the
    // in-progress bar must not be reported as finalised. The fake derives
    // "now" from the gateway's own defaulted startTime (observedAt − 4 bars),
    // so the test needs no clock of its own.
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const history = yield* gateway.getMarketHistory({
        market: "ETH",
        interval: "1m",
        maxBars: 4,
      });
      expect(history.candles.length).toBe(4);
      // The last bar's close (its T) is in the future; the finalised close is
      // the previous bar's T.
      expect(history.finalisedClose).toBe(history.candles[2]?.closeTime);
      expect(history.finalisedClose).not.toBe(history.candles[3]?.closeTime);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          candleSnapshot: (req) => {
            const now = req.startTime + 4 * 60_000;
            return [
              wireCandle(now - 3 * 60_000),
              wireCandle(now - 2 * 60_000),
              wireCandle(now - 60_000),
              wireCandle(now),
            ];
          },
        }),
      ),
    ),
  );
});

describe("HyperliquidGateway.getAccountSnapshot", () => {
  it.effect("maps clearinghouse state into the account snapshot keyed by the master address", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const snap = yield* gateway.getAccountSnapshot(MASTER_ADDRESS);
      expect(snap.address).toBe(MASTER_ADDRESS);
      expect(snap.accountValue).toBe(1000);
      expect(snap.withdrawable).toBe(750);
      expect(snap.positions[0]?.market).toBe("ETH");
      // §13: account state freshness is 5s.
      expect(snap.freshness.staleAfterMillis).toBe(5_000);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          clearinghouseState: () => FIXTURE_CLEARINGHOUSE,
        }),
      ),
    ),
  );

  it.effect("rejects an empty master address (§10.6 identity rule)", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const error = yield* gateway.getAccountSnapshot("0x" as `0x${string}`).pipe(Effect.flip);
      expect(error._tag).toBe("HyperliquidIdentityError");
    }).pipe(Effect.provide(gatewayLayerWith({ metaAndAssetCtxs: FIXTURE_META_AND_CTX }))),
  );
});

describe("HyperliquidGateway.getPosition", () => {
  it.effect("returns a flat zero position when the asset has no open position", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const pos = yield* gateway.getPosition(MASTER_ADDRESS, "ETH");
      expect(pos.size).toBe(0);
      expect(pos.market).toBe("ETH");
      // A flat account has no entry price. Reporting one — `0` in particular —
      // fails to encode against `Price`, which is what made every
      // `trading_get_position` call throw at the tool boundary while flat.
      expect(pos.entryPrice).toBeUndefined();
      expect(() => Schema.encodeUnknownSync(AgentNetPosition)(pos)).not.toThrow();
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          clearinghouseState: () => ({
            marginSummary: { accountValue: "1000.0", totalMarginUsed: "0" },
            withdrawable: "1000.0",
            assetPositions: [],
          }),
        }),
      ),
    ),
  );

  it.effect("returns the signed net position for an open long", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const pos = yield* gateway.getPosition(MASTER_ADDRESS, "ETH");
      expect(pos.size).toBe(0.3);
      expect(pos.entryPrice).toBe(3718.4);
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          clearinghouseState: () => FIXTURE_CLEARINGHOUSE,
        }),
      ),
    ),
  );
});

describe("HyperliquidGateway.getOpenOrders", () => {
  it.effect("normalises B/A sides and maps sz/origSz to remaining/original size", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const orders = yield* gateway.getOpenOrders(MASTER_ADDRESS);
      expect(orders[0]?.side).toBe("buy");
      expect(orders[0]?.size).toBe(0.3);
      expect(orders[0]?.remainingSize).toBe(0.2);
      expect(orders[0]?.createdAt).toBe(1_753_000_000_000);
      expect(orders[1]?.side).toBe("sell");
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          frontendOpenOrders: () => [
            {
              coin: "ETH",
              side: "B",
              limitPx: "3700.0",
              sz: "0.2",
              oid: 1,
              timestamp: 1_753_000_000_000,
              origSz: "0.3",
            },
            {
              coin: "ETH",
              side: "A",
              limitPx: "3800.0",
              sz: "0.3",
              oid: 2,
              timestamp: 1_753_000_000_000,
              origSz: "0.3",
            },
          ],
        }),
      ),
    ),
  );

  it.effect("carries the trigger + reduce-only detail protection is confirmed from", () =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const orders = yield* gateway.getOpenOrders(MASTER_ADDRESS);

      const stop = orders[0]!;
      expect(stop.reduceOnly).toBe(true);
      expect(stop.isTrigger).toBe(true);
      expect(stop.triggerPrice).toBe(2_950);
      expect(stop.orderType).toBe("Stop Market");
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          frontendOpenOrders: () => [
            {
              coin: "ETH",
              side: "A",
              limitPx: "2920.5",
              sz: "0.2",
              oid: 7,
              timestamp: 1_753_000_000_000,
              origSz: "0.2",
              isTrigger: true,
              triggerPx: "2950.0",
              triggerCondition: "Below 2950.0",
              reduceOnly: true,
              orderType: "Stop Market",
            },
          ],
        }),
      ),
    ),
  );

  it.effect("reads a row that omits the protective flags as unprotective", () =>
    Effect.gen(function* () {
      // An order the exchange did not describe must never be counted toward
      // protected size — the default has to fail closed (§17.2 step 7).
      const gateway = yield* HyperliquidGateway;
      const orders = yield* gateway.getOpenOrders(MASTER_ADDRESS);

      expect(orders[0]?.reduceOnly).toBe(false);
      expect(orders[0]?.isTrigger).toBe(false);
      expect(orders[0]?.triggerPrice).toBeUndefined();
    }).pipe(
      Effect.provide(
        gatewayLayerWith({
          metaAndAssetCtxs: FIXTURE_META_AND_CTX,
          frontendOpenOrders: () => [
            {
              coin: "ETH",
              side: "A",
              limitPx: "3800.0",
              sz: "0.3",
              oid: 2,
              timestamp: 1_753_000_000_000,
              origSz: "0.3",
              // A non-trigger order reports "0.0" here, which is not a price.
              triggerPx: "0.0",
            },
          ],
        }),
      ),
    ),
  );
});
