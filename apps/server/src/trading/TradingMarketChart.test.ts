/**
 * TradingMarketChart unit tests.
 *
 * The contract this service owns is the cache window and the "either read fails
 * yields null, nothing cached" rule — both rest on the gateway read pair and the
 * `Clock.currentTimeMillis` TTL, so the tests drive a stub gateway and a
 * `TestClock`. The view-mapping case also pins the candle/field projection.
 *
 * Each case provides its own `TradingMarketChartLive` so the in-memory `Ref`
 * cache starts empty per test (a shared layer would leak cache state across
 * cases, defeating the cache-window assertions).
 */
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type {
  AgentMarketSnapshot,
  MarketCandle,
  MarketHistory,
} from "@t3tools/trading-contracts/market";

import { TradingMarketChart, TradingMarketChartLive } from "./TradingMarketChart.ts";

const freshness = {
  observedAt: 1_700_000_000_000,
  source: "info_api",
  staleAfterMillis: 2_000,
} as const;

const snapshot: AgentMarketSnapshot = {
  market: "ETH",
  markPrice: 2_000,
  midPrice: 2_000,
  oraclePrice: 2_000,
  fundingRate8h: 0.0001,
  openInterest: 1_000,
  dayVolumeUsd: 1_000_000,
  bestBidOffer: { bidPrice: 1_999.5, bidSize: 10, askPrice: 2_000.5, askSize: 10, freshness },
  freshness,
  change24hPercent: 0.5,
};

const candle = (openTime: number, close: number): MarketCandle => ({
  openTime,
  closeTime: openTime + 60_000,
  open: close - 1,
  close,
  high: close + 1,
  low: close - 2,
  volume: 100,
  trades: 50,
});

const history: MarketHistory = {
  market: "ETH",
  interval: "1m",
  candles: [candle(1_000, 2_000), candle(61_000, 2_010)],
  freshness,
};

const unusedRead = () => Effect.die("not used by TradingMarketChart tests");

/**
 * Mutable stubs so a case can flip either read to a failure, and counters so a
 * case can assert how many gateway reads actually happened. Reset at the top of
 * each case before the service is built.
 */
let snapshotRead: Effect.Effect<AgentMarketSnapshot, string> = Effect.succeed(snapshot);
let historyRead: Effect.Effect<MarketHistory, string> = Effect.succeed(history);
let snapshotCalls = 0;
let historyCalls = 0;

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: unusedRead,
  getMarketSnapshot: () => {
    snapshotCalls += 1;
    return snapshotRead;
  },
  getMarketHistory: () => {
    historyCalls += 1;
    return historyRead;
  },
  getOrderBook: unusedRead,
  getAccountSnapshot: unusedRead,
  getPosition: unusedRead,
  getOpenOrders: unusedRead,
  getTakerFeeRateBps: unusedRead,
} as unknown as (typeof HyperliquidGateway)["Service"]);

/** The real chart layer on the stub gateway, plus the TestClock the TTL reads. */
const testLayer = () =>
  Effect.provide(
    Layer.merge(TradingMarketChartLive.pipe(Layer.provide(stubGateway)), TestClock.layer()),
  );

it.effect("serves a cached view to concurrent reads without re-reading the gateway", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    const first = yield* chart.read("ETH", "1m", 100);
    const second = yield* chart.read("ETH", "1m", 100);

    assert.notEqual(first, null);
    assert.equal(second, first);
    assert.equal(snapshotCalls, 1);
    assert.equal(historyCalls, 1);
  }).pipe(testLayer()),
);

it.effect("re-reads after the cache window elapses", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    yield* chart.read("ETH", "1m", 100);
    // 6s > 5s TTL: the cache window has closed, so the next read hits the gateway.
    yield* TestClock.adjust(Duration.seconds(6));
    yield* chart.read("ETH", "1m", 100);

    assert.equal(snapshotCalls, 2);
    assert.equal(historyCalls, 2);
  }).pipe(testLayer()),
);

it.effect("yields null and leaves the cache empty when the snapshot read fails", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.fail("snapshot unreachable");
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    const first = yield* chart.read("ETH", "1m", 100);
    assert.equal(first, null);

    // Nothing was cached: a second call (same tick) hits the gateway again.
    const second = yield* chart.read("ETH", "1m", 100);
    assert.equal(second, null);
    assert.isAtLeast(snapshotCalls, 2);
  }).pipe(testLayer()),
);

it.effect("yields null and leaves the cache empty when the history read fails", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.fail("history unreachable");
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    const first = yield* chart.read("ETH", "1m", 100);
    assert.equal(first, null);

    const second = yield* chart.read("ETH", "1m", 100);
    assert.equal(second, null);
    assert.isAtLeast(historyCalls, 2);
  }).pipe(testLayer()),
);

it.effect("maps the gateway pair into the view, dropping closeTime/volume/trades", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    const chart = yield* TradingMarketChart;

    const view = yield* chart.read("ETH", "1m", 100);
    assert.notEqual(view, null);
    if (view === null) return;

    assert.equal(view.market, "ETH");
    assert.equal(view.interval, "1m");
    assert.equal(view.candles.length, 2);
    // closeTime/volume/trades are dropped by the projection.
    assert.deepEqual(view.candles[0], {
      openTime: 1_000,
      open: 1_999,
      high: 2_001,
      low: 1_998,
      close: 2_000,
    });
    assert.deepEqual(view.candles[1], {
      openTime: 61_000,
      open: 2_009,
      high: 2_011,
      low: 2_008,
      close: 2_010,
    });

    // Header figures lifted straight off the snapshot.
    assert.equal(view.markPrice, 2_000);
    assert.equal(view.change24hPercent, 0.5);
    assert.equal(view.fundingRate8h, 0.0001);
    assert.equal(view.openInterest, 1_000);
    assert.equal(view.dayVolumeUsd, 1_000_000);

    // observedAt is the gateway's UnixMillis freshness stamp, rendered as ISO-8601.
    assert.equal(view.observedAt, DateTime.formatIso(DateTime.makeUnsafe(freshness.observedAt)));
  }).pipe(testLayer()),
);
