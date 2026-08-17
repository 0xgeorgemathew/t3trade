import { assert, describe, it } from "@effect/vitest";

import type { MarketCandle } from "./market.ts";
import { analyseMarketStructure, compareCandidates } from "./marketStructure.ts";
import { measureVolatility } from "./volatility.ts";
import {
  PRICE_SCALE_DIGITS,
  RATIO_DIGITS,
  roundCostContext,
  roundMarketStructure,
  roundNamedFields,
  roundObservedVolatility,
  toSignificantDigits,
} from "./precision.ts";

/**
 * A window that oscillates while drifting up — enough structure to measure.
 *
 * Prices are on a two-decimal tick, as an exchange serves them: the point of
 * the sweep below is that every LONG number in a read model is a derived one,
 * and a fixture with irrational closes would hide that behind its own noise.
 */
const tick = (value: number): number => Math.round(value * 100) / 100;

const candles = (count: number): ReadonlyArray<MarketCandle> =>
  Array.from({ length: count }, (_, index) => {
    const base = tick(1900 + index * 0.37 + Math.sin(index / 3) * 7.3);
    return {
      openTime: index * 60_000,
      closeTime: index * 60_000 + 59_999,
      open: base,
      high: tick(base + 1.23),
      low: tick(base - 1.11),
      close: tick(base + 0.33),
      volume: tick(13.7 + index / 7),
    };
  });

/** Every number reachable in an encoded value, with the path that names it. */
const numbersIn = (value: unknown, path: string = ""): ReadonlyArray<[string, number]> => {
  if (typeof value === "number") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item) => numbersIn(item, `${path}[]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, part]) => numbersIn(part, `${path}.${key}`));
  }
  return [];
};

/**
 * The widest a number in a read model may be. A millisecond timestamp is 13
 * figures and rides through untouched; a raw IEEE ratio is 16 or 17, so this
 * catches anything the rounders missed without asserting on the timestamps.
 */
const MAX_ENCODED_DIGITS = 13;

describe("toSignificantDigits", () => {
  it("keeps the stated figures whatever the scale", () => {
    assert.strictEqual(toSignificantDigits(0.436_363_636_363_636_4, RATIO_DIGITS), 0.436);
    assert.strictEqual(toSignificantDigits(2.478_571_428_571_428_6, PRICE_SCALE_DIGITS), 2.47857);
    // A market priced under a penny keeps six real figures, not two decimals.
    assert.strictEqual(toSignificantDigits(0.007_534_216_7, PRICE_SCALE_DIGITS), 0.00753422);
    assert.strictEqual(toSignificantDigits(-1.234_567_89, RATIO_DIGITS), -1.23);
  });

  it("passes zero and non-finite values through", () => {
    assert.strictEqual(toSignificantDigits(0, RATIO_DIGITS), 0);
    assert.isNaN(toSignificantDigits(Number.NaN, RATIO_DIGITS));
    assert.strictEqual(toSignificantDigits(Number.POSITIVE_INFINITY, RATIO_DIGITS), Infinity);
  });
});

describe("roundNamedFields", () => {
  it("rounds only what the map names", () => {
    const rounded = roundNamedFields(
      { score: 0.123_456_789, price: 1899.123_456_789, note: "left alone" },
      { score: RATIO_DIGITS },
    );
    assert.strictEqual(rounded.score, 0.123);
    assert.strictEqual(rounded.price, 1899.123_456_789);
    assert.strictEqual(rounded.note, "left alone");
  });

  it("leaves an absent optional field absent", () => {
    const rounded = roundNamedFields<{ score: number; margin?: number }>(
      { score: 0.5 },
      { score: RATIO_DIGITS, margin: RATIO_DIGITS },
    );
    assert.isFalse("margin" in rounded);
  });
});

describe("roundMarketStructure", () => {
  const structure = analyseMarketStructure({
    market: "ETH",
    measuredAt: 1_755_400_000_000,
    frames: [
      { interval: "1m", candles: candles(120) },
      { interval: "5m", candles: candles(90) },
    ],
  });
  const priced = { ...structure, candidates: compareCandidates(structure, null) };
  const rounded = roundMarketStructure(priced);

  it("leaves no number at full IEEE precision", () => {
    for (const [path, value] of numbersIn(rounded)) {
      assert.strictEqual(
        value,
        toSignificantDigits(value, MAX_ENCODED_DIGITS),
        `${path} = ${value} is still full precision`,
      );
    }
  });

  it("keeps the levels a watch would be armed at exact", () => {
    const frame = priced.timeframes[0];
    const roundedFrame = rounded.timeframes[0];
    assert.isDefined(frame);
    assert.isDefined(roundedFrame);
    assert.strictEqual(roundedFrame?.referencePrice, frame?.referencePrice);
    assert.strictEqual(roundedFrame?.swingHighPrice, frame?.swingHighPrice);
    assert.strictEqual(roundedFrame?.swingLowPrice, frame?.swingLowPrice);
    assert.deepStrictEqual(
      rounded.setups.map((setup) => setup.level),
      priced.setups.map((setup) => setup.level),
    );
  });

  it("changes no verdict, only the figures behind it", () => {
    assert.strictEqual(rounded.regime.classification, priced.regime.classification);
    assert.strictEqual(rounded.alignment.direction, priced.alignment.direction);
    assert.deepStrictEqual(rounded.regime.evidence, priced.regime.evidence);
    assert.strictEqual(rounded.setups.length, priced.setups.length);
  });

  it("stays within a percent of the number it replaced", () => {
    const frame = priced.timeframes[0];
    const roundedFrame = rounded.timeframes[0];
    assert.isDefined(frame);
    assert.isDefined(roundedFrame);
    assert.approximately(roundedFrame?.atrUsd ?? 0, frame?.atrUsd ?? 0, (frame?.atrUsd ?? 0) / 100);
    assert.approximately(roundedFrame?.directionScore ?? 0, frame?.directionScore ?? 0, 0.001);
  });

  it("encodes measurably smaller", () => {
    assert.isBelow(JSON.stringify(rounded).length, JSON.stringify(priced).length);
  });
});

describe("roundObservedVolatility", () => {
  const measured = measureVolatility({
    market: "ETH",
    interval: "1m",
    candles: candles(120),
    measuredAt: 1_755_400_000_000,
  });
  const rounded = roundObservedVolatility(measured);

  it("keeps the window's own high and low exact", () => {
    assert.strictEqual(rounded.swingHighUsd, measured.swingHighUsd);
    assert.strictEqual(rounded.swingLowUsd, measured.swingLowUsd);
    assert.strictEqual(rounded.referencePrice, measured.referencePrice);
  });

  it("rounds the horizon quantiles", () => {
    const horizon = rounded.horizons[0];
    assert.isDefined(horizon);
    for (const [path, value] of numbersIn(horizon)) {
      assert.strictEqual(value, toSignificantDigits(value, MAX_ENCODED_DIGITS), path);
    }
  });
});

describe("roundCostContext", () => {
  it("rounds the round trip and its bps", () => {
    const rounded = roundCostContext({
      referenceNotionalUsd: 1000.123_456_789,
      roundTripUsd: 1.234_567_891_23,
      roundTripBps: 12.345_678_9,
    });
    assert.strictEqual(rounded.roundTripUsd, 1.23457);
    assert.strictEqual(rounded.roundTripBps, 12.3);
  });
});
