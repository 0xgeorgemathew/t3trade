/**
 * TradingCostEstimator unit tests.
 *
 * The arithmetic is tested in `packages/trading-contracts/src/costs.test.ts`;
 * what is under test here is the three reads the service wires into it — the
 * fee rate (and its fallback), the book, and the mark that converts a notional
 * request into a size the book can be walked for.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HyperliquidGateway, type UserFeeRatesBps } from "@t3tools/hyperliquid/Gateway";
import type { AgentMarketSnapshot, OrderBook } from "@t3tools/trading-contracts/market";

import { TradingCostEstimator, TradingCostEstimatorLive } from "./TradingCostEstimator.ts";

const MASTER = "0x000000000000000000000000000000000000beef" as const;

const freshness = { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 } as const;

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

const book: OrderBook = {
  market: "ETH",
  bids: [
    { price: 1_999.5, size: 10 },
    { price: 1_999, size: 10 },
  ],
  asks: [
    { price: 2_000.5, size: 10 },
    { price: 2_001, size: 10 },
  ],
  bestBidOffer: snapshot.bestBidOffer,
  freshness,
};

const unusedRead = () => Effect.die("not used by TradingCostEstimator tests");

/** Mutable so a case can make the fee read fail or drop the maker rate. */
let feeRead: Effect.Effect<UserFeeRatesBps, string> = Effect.succeed({
  takerFeeBps: 4.5,
  makerFeeBps: 1,
  observedAt: 1_000,
  makerRateSource: "hyperliquid_user_fees",
});

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: unusedRead,
  getMarketSnapshot: () => Effect.succeed(snapshot),
  getMarketHistory: unusedRead,
  getOrderBook: () => Effect.succeed(book),
  getAccountSnapshot: unusedRead,
  getPosition: unusedRead,
  getOpenOrders: unusedRead,
  getUserFeeRatesBps: () => feeRead,
} as unknown as (typeof HyperliquidGateway)["Service"]);

const layer = it.layer(TradingCostEstimatorLive.pipe(Layer.provideMerge(stubGateway)));

layer("TradingCostEstimator", (it) => {
  it.effect("prices a round trip from the wallet's own fee rate and the live book", () =>
    Effect.gen(function* () {
      feeRead = Effect.succeed({
        takerFeeBps: 4.5,
        makerFeeBps: 1,
        observedAt: 1_000,
        makerRateSource: "hyperliquid_user_fees",
      });
      const estimator = yield* TradingCostEstimator;

      const estimate = yield* estimator.estimate({
        market: "ETH",
        masterAddress: MASTER,
        sizeEth: 1,
        fallbackTakerFeeBpsPerSide: 5,
      });

      assert.equal(estimate.takerFeeBpsPerSide, 4.5);
      assert.equal(estimate.feeRateSource, "hyperliquid_user_fees");
      assert.equal(estimate.notionalUsd, 2_000);
      // 2,000 x 4.5 bps x 2 fills = 1.80, plus 1.00 of spread crossed twice.
      assert.closeTo(estimate.roundTripFeeUsd, 1.8, 1e-9);
      assert.closeTo(estimate.roundTripSpreadUsd, 1, 1e-9);
      assert.closeTo(estimate.roundTripUsd, 2.8, 1e-9);
      assert.closeTo(estimate.preferredTargetUsd, 5.6, 1e-9);
      assert.equal(estimate.degraded, false);
    }),
  );

  // The fee read is a network call of its own. Failing the whole estimate on it
  // sends the harness back to guessing, which is the failure this tool exists
  // to fix — so it degrades, loudly, on the same rate the preview would use.
  it.effect("falls back to the authority's rate, and says it did", () =>
    Effect.gen(function* () {
      feeRead = Effect.fail("userFees unreachable");
      const estimator = yield* TradingCostEstimator;

      const estimate = yield* estimator.estimate({
        market: "ETH",
        masterAddress: MASTER,
        sizeEth: 1,
        fallbackTakerFeeBpsPerSide: 5,
      });

      assert.equal(estimate.takerFeeBpsPerSide, 5);
      assert.equal(estimate.feeRateSource, "authority_fallback");
      assert.equal(estimate.degraded, true);
      assert.match(estimate.notes[0] ?? "", /fallback/);
      // The authority names one (taker) rate, so the maker combinations price
      // at it too — and the estimate says so rather than passing it off as read.
      assert.equal(estimate.makerFeeBpsPerSide, 5);
      assert.match(estimate.notes.join(" "), /authority's fallback taker rate/);
      feeRead = Effect.succeed({
        takerFeeBps: 4.5,
        makerFeeBps: 1,
        observedAt: 1_000,
        makerRateSource: "hyperliquid_user_fees",
      });
    }),
  );

  it.effect("carries the maker rate through to the per-combination round trips", () =>
    Effect.gen(function* () {
      feeRead = Effect.succeed({
        takerFeeBps: 4.5,
        makerFeeBps: 1,
        observedAt: 1_000,
        makerRateSource: "hyperliquid_user_fees",
      });
      const estimator = yield* TradingCostEstimator;

      const estimate = yield* estimator.estimate({
        market: "ETH",
        masterAddress: MASTER,
        sizeEth: 1,
        fallbackTakerFeeBpsPerSide: 5,
      });

      assert.equal(estimate.makerFeeBpsPerSide, 1);
      // Taker/maker: 0.90 of taker fee + 0.20 of maker fee + 0.50 of spread
      // crossed once. A maker leg pays no crossing, and this size sits on the
      // touch, so there is no walk on either leg.
      assert.closeTo(estimate.roundTripTakerMakerUsd, 1.6, 1e-9);
      // Maker/maker: two maker fees and nothing else.
      assert.closeTo(estimate.roundTripMakerMakerUsd, 0.4, 1e-9);
      assert.equal(estimate.degraded, false);
    }),
  );

  it.effect("prices the maker combinations at the taker rate when the exchange served none", () =>
    Effect.gen(function* () {
      feeRead = Effect.succeed({
        takerFeeBps: 4.5,
        makerFeeBps: 4.5,
        observedAt: 1_000,
        makerRateSource: "assumed_equal_to_taker",
      });
      const estimator = yield* TradingCostEstimator;

      const estimate = yield* estimator.estimate({
        market: "ETH",
        masterAddress: MASTER,
        sizeEth: 1,
        fallbackTakerFeeBpsPerSide: 5,
      });

      // The taker rate was genuinely read, so the source stays the exchange and
      // only the maker substitution is recorded.
      assert.equal(estimate.makerFeeBpsPerSide, 4.5);
      assert.equal(estimate.feeRateSource, "hyperliquid_user_fees");
      assert.equal(estimate.degraded, false);
      assert.match(estimate.notes.join(" "), /maker combinations are priced at the taker rate/);
    }),
  );

  it.effect("converts a notional request to a size at the current mark", () =>
    Effect.gen(function* () {
      const estimator = yield* TradingCostEstimator;

      const estimate = yield* estimator.estimate({
        market: "ETH",
        masterAddress: MASTER,
        notionalUsd: 4_000,
        fallbackTakerFeeBpsPerSide: 5,
      });

      assert.equal(estimate.sizeEth, 2);
      assert.equal(estimate.notionalUsd, 4_000);
    }),
  );

  it.effect("carries the market's funding rate onto the notional", () =>
    Effect.gen(function* () {
      const estimator = yield* TradingCostEstimator;

      const estimate = yield* estimator.estimate({
        market: "ETH",
        masterAddress: MASTER,
        sizeEth: 1,
        fallbackTakerFeeBpsPerSide: 5,
      });

      assert.equal(estimate.fundingRatePer8h, 0.0001);
      assert.closeTo(estimate.fundingCostPer8hUsd ?? 0, 0.2, 1e-9);
    }),
  );
});
