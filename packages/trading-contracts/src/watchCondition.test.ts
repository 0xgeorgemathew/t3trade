/**
 * The one condition union (plan 29 step 6.3).
 *
 * The property that matters is not that each branch maps somewhere — it is
 * that the mapping covers every persisted predicate and loses nothing on the
 * way back, because `MarketWatch` is still what the evaluator reads and what
 * every row in `trading_watches` already holds.
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  isWatchRefusal,
  toMarketWatch,
  toWatchCondition,
  WatchCondition,
  type MarketWatch,
} from "./watch.ts";

const decode = Schema.decodeUnknownSync(WatchCondition);

/** One of every persisted predicate, so the inverse is exercised exhaustively. */
const EVERY_WATCH: ReadonlyArray<MarketWatch> = [
  { type: "price_cross", market: "ETH", priceSource: "mark", direction: "above", price: 1899 },
  { type: "price_cross", market: "BTC", priceSource: "mid", direction: "below", price: 61_000 },
  { type: "candle_close", market: "ETH", interval: "15m", direction: "above", price: 1899 },
  { type: "order_update", cloid: "0xabc" },
  { type: "position_update", market: "ETH" },
  { type: "scheduled_reassessment", runAt: 1_700_000_000_000 },
  { type: "pnl_above", market: "ETH", valueUsd: 12 },
  { type: "pnl_below", market: "ETH", valueUsd: -6 },
  { type: "pnl_below", market: "ETH", valueUsd: 3 },
  { type: "pnl_giveback", market: "ETH", drawdownUsd: 4 },
  {
    type: "metric_threshold",
    market: "ETH",
    metric: "funding_rate_8h",
    direction: "below",
    value: -0.0001,
  },
  {
    type: "metric_threshold",
    market: "ETH",
    metric: "day_volume_usd",
    direction: "above",
    value: 900_000_000,
  },
  {
    type: "metric_threshold",
    market: "ETH",
    metric: "volume_ratio",
    direction: "above",
    value: 2,
    interval: "1m",
  },
];

describe("the condition the model writes", () => {
  it("round-trips every persisted predicate through the union unchanged", () => {
    for (const watch of EVERY_WATCH) {
      const back = toMarketWatch(toWatchCondition(watch));
      assert.isFalse(isWatchRefusal(back), `${watch.type} refused its own condition`);
      assert.deepEqual(back, watch, `${watch.type} did not survive the round trip`);
    }
  });

  it("accepts what it reads back as a valid condition", () => {
    for (const watch of EVERY_WATCH) {
      assert.doesNotThrow(() => decode(toWatchCondition(watch)));
    }
  });

  // The two defaults, and the reason they are safe: neither can be the wrong
  // answer to a question the model did not ask.
  it("reads a bare level as a touch on the mark", () => {
    const armed = toMarketWatch(
      decode({ kind: "price", market: "ETH", direction: "above", price: 1899 }),
    );
    assert.deepEqual(armed, {
      type: "price_cross",
      market: "ETH",
      priceSource: "mark",
      direction: "above",
      price: 1899,
    });
  });

  // The default it deliberately does not apply. A guessed timeframe here is a
  // 1h breakout armed on a 1m wick.
  it("refuses a close-confirmed level with no interval rather than guessing one", () => {
    const refused = toMarketWatch(
      decode({ kind: "price", market: "ETH", direction: "above", price: 1899, confirm: "close" }),
    );
    assert.isTrue(isWatchRefusal(refused));
    assert.equal(isWatchRefusal(refused) ? refused.code : "", "close_needs_interval");
  });

  // A volume ratio is measured on a bar series; a metric condition that names
  // none gets the runtime's own default interval, the same 1m every other
  // cadence in the system assumes.
  it("defaults a volume-ratio condition to the 1m bar series", () => {
    const armed = toMarketWatch(
      decode({
        kind: "metric",
        market: "ETH",
        metric: "volume_ratio",
        direction: "above",
        value: 2,
      }),
    );
    assert.deepEqual(armed, {
      type: "metric_threshold",
      market: "ETH",
      metric: "volume_ratio",
      direction: "above",
      value: 2,
      interval: "1m",
    });
  });

  // The snapshot metrics carry no bar series, and none is invented for them.
  it("arms a snapshot metric without inventing an interval", () => {
    const armed = toMarketWatch(
      decode({
        kind: "metric",
        market: "ETH",
        metric: "spread_bps",
        direction: "above",
        value: 5,
      }),
    );
    assert.deepEqual(armed, {
      type: "metric_threshold",
      market: "ETH",
      metric: "spread_bps",
      direction: "above",
      value: 5,
    });
  });

  it("refuses a profit line that is not a profit", () => {
    for (const valueUsd of [0, -3]) {
      const refused = toMarketWatch(
        decode({ kind: "pnl", market: "ETH", direction: "above", valueUsd }),
      );
      assert.isTrue(isWatchRefusal(refused), `${valueUsd} should not arm as a target`);
    }
    // The same number below the line is a give-back floor, and legal.
    const giveback = decode({ kind: "pnl", market: "ETH", direction: "below", valueUsd: 3 });
    assert.isFalse(isWatchRefusal(toMarketWatch(giveback)));
  });

  it("keys a fill off the order when given one, and the position otherwise", () => {
    assert.deepEqual(toMarketWatch(decode({ kind: "fill", cloid: "0xabc" })), {
      type: "order_update",
      cloid: "0xabc",
    });
    assert.deepEqual(toMarketWatch(decode({ kind: "fill", market: "ETH" })), {
      type: "position_update",
      market: "ETH",
    });
    const refused = toMarketWatch(decode({ kind: "fill" }));
    assert.isTrue(isWatchRefusal(refused));
    assert.equal(isWatchRefusal(refused) ? refused.code : "", "fill_needs_order_or_market");
  });

  it("carries a cloid and a market together as the order watch", () => {
    // Naming both is not ambiguous: the order is the more specific of the two.
    assert.deepEqual(toMarketWatch(decode({ kind: "fill", cloid: "0xabc", market: "ETH" })), {
      type: "order_update",
      cloid: "0xabc",
    });
  });
});
