import { assert, describe, it } from "@effect/vitest";

import type { OrderBook, OrderBookLevel } from "./market.ts";
import { BOOK_IMBALANCE_LEVELS, readBookImbalance, readMicrostructure } from "./microstructure.ts";

const level = (price: number, size: number): OrderBookLevel => ({ price, size });

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

describe("readMicrostructure", () => {
  it("costs only the fields the missing read would have filled", () => {
    assert.isNull(readMicrostructure({ orderBook: null }));
  });

  it("carries the book reading when the book was read", () => {
    const reading = readMicrostructure({
      orderBook: book({ bids: [level(100, 30)], asks: [level(100, 10)] }),
    });
    assert.strictEqual(reading?.bookImbalance?.imbalance, 0.5);
  });
});
