/**
 * The armed-coverage floor — the rule that stops a mission going deaf while it
 * holds a position.
 *
 * The session this exists because of: a long open at 1833.9, one downside
 * `candle_close` armed, a `position_update` that correctly never fired because
 * the size never changed, price at 1859.5, and a harness that was never woken
 * to do anything about any of it.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  isDeafWhileHoldingPosition,
  readWatchCoverage,
  WATCH_COVERAGE_FLOOR_MILLIS,
  type MarketWatch,
  type PersistedWatch,
} from "./watch.ts";

const NOW = 1_753_000_000_000;
const MARK = 1_850;

const armed = (
  watch: MarketWatch,
  status: PersistedWatch["status"] = "active",
): PersistedWatch => ({
  id: `watch_${JSON.stringify(watch).length}_${status}`,
  missionId: "mission_1",
  strategyVersion: 1,
  watch,
  status,
  createdAt: NOW,
  updatedAt: NOW,
});

const coverageOf = (watches: ReadonlyArray<PersistedWatch>) =>
  readWatchCoverage({ watches, markPrice: MARK, nowMillis: NOW });

const upside = armed({
  type: "price_cross",
  market: "ETH",
  priceSource: "mark",
  direction: "above",
  price: 1_870,
});
const downside = armed({
  type: "candle_close",
  market: "ETH",
  interval: "1m",
  direction: "below",
  price: 1_830,
});

describe("readWatchCoverage", () => {
  it("reads a level on each side as covering both sides", () => {
    const coverage = coverageOf([upside, downside]);
    assert.isTrue(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });

  it("does not count a level on the wrong side of the mark", () => {
    // "Cross above 1830" armed while price is already 1850 is not upside
    // coverage; it is a condition that was true before it was written.
    const stale = armed({
      type: "price_cross",
      market: "ETH",
      priceSource: "mark",
      direction: "above",
      price: 1_830,
    });
    const coverage = coverageOf([stale, downside]);
    assert.isFalse(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
  });

  it("does not count order or position updates as directional coverage", () => {
    // The observed failure exactly: these are real events, but neither fires
    // for a mark that runs away while the size stays put.
    const coverage = coverageOf([
      downside,
      armed({ type: "order_update", cloid: "0xabc" }),
      armed({ type: "position_update", market: "ETH" }),
    ]);
    assert.isFalse(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
    assert.isTrue(isDeafWhileHoldingPosition(coverage));
  });

  it("ignores watches that are no longer active", () => {
    const coverage = coverageOf([
      { ...upside, status: "superseded" },
      { ...downside, status: "triggered" },
    ]);
    assert.isFalse(coverage.coversUpside);
    assert.isFalse(coverage.coversDownside);
  });

  it("counts a reassessment due inside the floor, and not one beyond it", () => {
    const inside = coverageOf([
      armed({ type: "scheduled_reassessment", runAt: NOW + WATCH_COVERAGE_FLOOR_MILLIS - 1 }),
    ]);
    assert.isTrue(inside.coversByReassessment);
    assert.isFalse(isDeafWhileHoldingPosition(inside));

    const beyond = coverageOf([
      armed({ type: "scheduled_reassessment", runAt: NOW + WATCH_COVERAGE_FLOOR_MILLIS + 1 }),
    ]);
    assert.isFalse(beyond.coversByReassessment);
    assert.isTrue(isDeafWhileHoldingPosition(beyond));
  });
});

describe("isDeafWhileHoldingPosition", () => {
  it("calls a mission with no watches at all deaf", () => {
    assert.isTrue(isDeafWhileHoldingPosition(coverageOf([])));
  });

  it("accepts one side plus a reassessment", () => {
    // The reassessment is the escape hatch: a mission that only wants to watch
    // one direction still gets a turn to reconsider.
    const coverage = coverageOf([
      downside,
      armed({ type: "scheduled_reassessment", runAt: NOW + 60_000 }),
    ]);
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });
});
