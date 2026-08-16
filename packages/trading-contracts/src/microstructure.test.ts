import { assert, describe, it } from "@effect/vitest";

import type { MarketCandle, OrderBook, OrderBookLevel } from "./market.ts";
import {
  AGGRESSOR_FLOW_BARS,
  BOOK_IMBALANCE_LEVELS,
  readAggressorFlow,
  readBookImbalance,
  readLiquidity,
  readMicrostructure,
  sampleFromObservation,
  type MarketSample,
} from "./microstructure.ts";

const level = (price: number, size: number): OrderBookLevel => ({ price, size });

/** One bar, named by the four numbers the estimate actually reads. */
const bar = (input: {
  readonly low: number;
  readonly high: number;
  readonly close: number;
  readonly volume: number;
}): MarketCandle => ({
  openTime: 0,
  closeTime: 0,
  open: input.low,
  close: input.close,
  high: input.high,
  low: input.low,
  volume: input.volume,
});

const book = (input: {
  readonly bids: ReadonlyArray<OrderBookLevel>;
  readonly asks: ReadonlyArray<OrderBookLevel>;
}): OrderBook => ({
  market: "ETH",
  bids: input.bids,
  asks: input.asks,
  bestBidOffer: {
    ...(input.bids[0] === undefined
      ? {}
      : { bidPrice: input.bids[0].price, bidSize: input.bids[0].size }),
    ...(input.asks[0] === undefined
      ? {}
      : { askPrice: input.asks[0].price, askSize: input.asks[0].size }),
    freshness: { observedAt: 1_000, staleAfterMillis: 2_000, source: "info_api" },
  },
  freshness: { observedAt: 1_000, staleAfterMillis: 2_000, source: "info_api" },
});

describe("readBookImbalance", () => {
  it("reports zero for a book carrying equal notional a side", () => {
    const reading = readBookImbalance(book({ bids: [level(100, 10)], asks: [level(100, 10)] }), 1);
    assert.strictEqual(reading?.imbalance, 0);
  });

  it("weighs notional, not size — the spread tilts a size-symmetric book", () => {
    // Ten a side, but the ask sits higher, so more USD rests there. Depth is a
    // question about money, and the number says so.
    const reading = readBookImbalance(book({ bids: [level(100, 10)], asks: [level(110, 10)] }), 1);
    assert.isBelow(reading?.imbalance ?? 0, 0);
  });

  it("is positive when the bid carries more notional", () => {
    const reading = readBookImbalance(book({ bids: [level(100, 30)], asks: [level(100, 10)] }), 1);
    assert.deepStrictEqual(reading, {
      bidDepthUsd: 3_000,
      askDepthUsd: 1_000,
      imbalance: 0.5,
      levels: 1,
    });
  });

  it("sums only the measured levels", () => {
    const deep = Array.from({ length: 20 }, (_, index) => level(100 - index, 1));
    const reading = readBookImbalance(book({ bids: deep, asks: deep }), 2);
    // Two levels a side: 100 + 99 of notional on each.
    assert.strictEqual(reading?.bidDepthUsd, 199);
    assert.strictEqual(reading?.levels, 2);
  });

  it("counts the levels the book actually served, not the ones asked for", () => {
    const reading = readBookImbalance(
      book({ bids: [level(100, 1), level(99, 1)], asks: [level(101, 1)] }),
      BOOK_IMBALANCE_LEVELS,
    );
    assert.strictEqual(reading?.levels, 1);
  });

  it("reports nothing for a one-sided book rather than perfect conviction", () => {
    assert.isNull(readBookImbalance(book({ bids: [level(100, 10)], asks: [] })));
    assert.isNull(readBookImbalance(book({ bids: [], asks: [] })));
  });

  it("reports nothing when every served level is zero-sized", () => {
    assert.isNull(readBookImbalance(book({ bids: [level(100, 0)], asks: [level(101, 0)] })));
  });
});

describe("readAggressorFlow", () => {
  it("reads 1 when every bar closed on its high", () => {
    const reading = readAggressorFlow([
      bar({ low: 100, high: 110, close: 110, volume: 5 }),
      bar({ low: 105, high: 115, close: 115, volume: 5 }),
    ]);
    assert.strictEqual(reading?.buyShare, 1);
    assert.strictEqual(reading?.volume, 10);
    assert.strictEqual(reading?.bars, 2);
    assert.strictEqual(reading?.basis, "bar_close_location");
  });

  it("reads 0 when every bar closed on its low", () => {
    const reading = readAggressorFlow([bar({ low: 100, high: 110, close: 100, volume: 3 })]);
    assert.strictEqual(reading?.buyShare, 0);
  });

  it("weights each bar's split by that bar's volume", () => {
    // A heavy bar closing on its high against a light one closing on its low.
    const reading = readAggressorFlow([
      bar({ low: 100, high: 110, close: 110, volume: 9 }),
      bar({ low: 100, high: 110, close: 100, volume: 1 }),
    ]);
    assert.strictEqual(reading?.buyShare, 0.9);
  });

  it("splits a rangeless bar down the middle rather than guessing", () => {
    const reading = readAggressorFlow([bar({ low: 100, high: 100, close: 100, volume: 4 })]);
    assert.strictEqual(reading?.buyShare, 0.5);
  });

  it("reads only the window, newest bars first to fall inside it", () => {
    const old = Array.from({ length: 40 }, () =>
      bar({ low: 100, high: 110, close: 100, volume: 1 }),
    );
    const recent = Array.from({ length: AGGRESSOR_FLOW_BARS }, () =>
      bar({ low: 100, high: 110, close: 110, volume: 1 }),
    );
    const reading = readAggressorFlow([...old, ...recent]);
    assert.strictEqual(reading?.buyShare, 1);
    assert.strictEqual(reading?.bars, AGGRESSOR_FLOW_BARS);
  });

  it("reports nothing for a tape with no volume on it", () => {
    assert.isNull(readAggressorFlow([]));
    assert.isNull(readAggressorFlow([bar({ low: 100, high: 110, close: 105, volume: 0 })]));
  });
});

describe("readLiquidity", () => {
  const twoSided = book({ bids: [level(99.9, 10)], asks: [level(100.1, 10)] });

  it("prices the spread in basis points off the mid", () => {
    const reading = readLiquidity({ orderBook: twoSided, observedAt: 10_000, previous: null });
    // 0.2 wide on a mid of 100 is 20 bps.
    assert.closeTo(reading?.spreadBps ?? 0, 20, 1e-9);
  });

  it("counts only what rests within ten bps of the mid", () => {
    // The mid is 100. The far bid sits 100 bps below and must not be counted.
    const reading = readLiquidity({
      orderBook: book({
        bids: [level(99.99, 1), level(99, 1_000)],
        asks: [level(100.01, 1)],
      }),
      observedAt: 10_000,
      previous: null,
    });
    assert.closeTo(reading?.nearDepthUsd ?? 0, 99.99 + 100.01, 1e-9);
  });

  it("reports no change when there is nothing to compare against", () => {
    const reading = readLiquidity({ orderBook: twoSided, observedAt: 10_000, previous: null });
    // Absent, not zero: "unchanged" and "no predecessor" are different facts.
    assert.isUndefined(reading?.depthChangePercent);
    assert.isUndefined(reading?.spreadBpsChange);
    assert.isUndefined(reading?.sinceSeconds);
  });

  it("reports a thinning book against the previous sample", () => {
    const previous: MarketSample = {
      markPrice: 100,
      spreadBps: 10,
      nearDepthUsd: 4_000,
      observedAt: 40_000,
    };
    const reading = readLiquidity({ orderBook: twoSided, observedAt: 100_000, previous });
    // 2000 of depth against 4000: half of it went.
    assert.closeTo(reading?.depthChangePercent ?? 0, -50, 1e-9);
    // 20 bps wide against 10: the spread doubled while the book emptied.
    assert.closeTo(reading?.spreadBpsChange ?? 0, 10, 1e-9);
    assert.strictEqual(reading?.sinceSeconds, 60);
  });

  it("refuses a predecessor that is not older than this observation", () => {
    const reading = readLiquidity({
      orderBook: twoSided,
      observedAt: 10_000,
      previous: { markPrice: 100, spreadBps: 10, nearDepthUsd: 4_000, observedAt: 10_000 },
    });
    assert.isUndefined(reading?.depthChangePercent);
  });

  it("reports nothing without a two-sided top of book", () => {
    assert.isNull(
      readLiquidity({
        orderBook: book({ bids: [level(99.9, 10)], asks: [] }),
        observedAt: 10_000,
        previous: null,
      }),
    );
  });
});

describe("sampleFromObservation", () => {
  it("carries forward exactly what the next observation compares against", () => {
    const microstructure = readMicrostructure({
      orderBook: book({ bids: [level(99.9, 10)], asks: [level(100.1, 10)] }),
      candles: [],
      observedAt: 10_000,
      previousSample: null,
    });
    const sample = sampleFromObservation({
      markPrice: 100,
      observedAt: 10_000,
      microstructure,
      openInterest: 55,
    });
    assert.strictEqual(sample.nearDepthUsd, microstructure?.liquidity?.nearDepthUsd);
    assert.strictEqual(sample.spreadBps, microstructure?.liquidity?.spreadBps);
    assert.strictEqual(sample.openInterest, 55);
    assert.strictEqual(sample.observedAt, 10_000);
  });

  it("leaves the book fields off when there was no book to read", () => {
    const sample = sampleFromObservation({
      markPrice: 100,
      observedAt: 10_000,
      microstructure: null,
      openInterest: undefined,
    });
    assert.deepStrictEqual(sample, { markPrice: 100, observedAt: 10_000 });
  });
});

describe("readMicrostructure", () => {
  it("costs only the fields the missing read would have filled", () => {
    assert.isNull(
      readMicrostructure({ orderBook: null, candles: [], observedAt: 0, previousSample: null }),
    );
  });

  it("carries the book reading when the book was read", () => {
    const reading = readMicrostructure({
      orderBook: book({ bids: [level(100, 30)], asks: [level(100, 10)] }),
      candles: [],
      observedAt: 10_000,
      previousSample: null,
    });
    assert.strictEqual(reading?.bookImbalance?.imbalance, 0.5);
    // The tape had nothing to split; the book reading survives it alone.
    assert.isUndefined(reading?.aggressorFlow);
  });
});
