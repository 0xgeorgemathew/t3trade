/**
 * Table-driven tests for {@link HyperliquidPrecision}.
 *
 * These pin the two exchange contracts the module encodes:
 *
 *  - Size truncation: `0.30001` at szDecimals=4 must become `0.3` (not `0.3000`
 *    with a carry — Hyperliquid truncates size).
 *  - Price rounding to 5 sig figs with trailing-zero stripping: `3750.10`
 *    must become `"3750.1"`, never `"3750.10"` (exchange rejects the latter).
 *
 * Edge cases: `NaN` throws (round/format), `0` is preserved, `Infinity`
 * throws, and `meetsMinimumNotional` defaults to {@link MIN_NOTIONAL_USD}.
 *
 * @module HyperliquidPrecisionTests
 */
import { describe, expect, it } from "vite-plus/test";
import {
  MIN_NOTIONAL_USD,
  formatPrice,
  formatSize,
  meetsMinimumNotional,
  roundToSignificantFigures,
} from "./Precision.ts";

describe("HyperliquidPrecision.roundToSignificantFigures", () => {
  it.each<[input: number, sigFigs: number | undefined, expected: number]>([
    [3750.123456, undefined, 3750.1],
    [3750.123456, 5, 3750.1],
    [0.000123456, 5, 0.00012346],
    [95000.999, 5, 95001],
    [0, 5, 0],
    [123.456789, 5, 123.46],
    [-3750.123, 5, -3750.1],
    [1, 5, 1],
    [9.999999, 5, 10],
  ])("(%d, sigFigs=%s) -> %d", (input, sigFigs, expected) => {
    expect(roundToSignificantFigures(input, sigFigs ?? 5)).toBeCloseTo(expected, 10);
  });

  it("throws on NaN", () => {
    expect(() => roundToSignificantFigures(Number.NaN)).toThrow(RangeError);
  });

  it("throws on Infinity", () => {
    expect(() => roundToSignificantFigures(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => roundToSignificantFigures(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it("throws on a non-positive sigFigs", () => {
    expect(() => roundToSignificantFigures(1, 0)).toThrow(RangeError);
    expect(() => roundToSignificantFigures(1, -1)).toThrow(RangeError);
    expect(() => roundToSignificantFigures(1, 2.5)).toThrow(RangeError);
  });
});

describe("HyperliquidPrecision.formatPrice", () => {
  it.each<[input: number, expected: string]>([
    [3750.0, "3750"],
    // 3750.10 and 3750.1 are the same JS number; both must round-trip to "3750.1".
    [3750.1, "3750.1"],
    [0.0001235, "0.0001235"],
    [123.456789, "123.46"],
    [3750.123456, "3750.1"],
    [0.000123456, "0.00012346"],
    [95000.999, "95001"],
    [0, "0"],
    [1, "1"],
    [-3750.123, "-3750.1"],
  ])("(%d) -> %s", (input, expected) => {
    expect(formatPrice(input)).toBe(expected);
  });

  it("throws on NaN", () => {
    expect(() => formatPrice(Number.NaN)).toThrow(RangeError);
  });

  it("throws on Infinity", () => {
    expect(() => formatPrice(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("HyperliquidPrecision.formatSize", () => {
  it.each<[size: number, szDecimals: number, expected: string]>([
    [0.3, 4, "0.3"],
    [0.30001, 4, "0.3"],
    [1.5, 2, "1.5"],
    [0, 4, "0"],
    [1.2345, 4, "1.2345"],
    [1.234567, 4, "1.2345"],
    [0.001, 3, "0.001"],
    [10.0, 4, "10"],
    [0.99999, 2, "0.99"],
  ])("(size=%d, szDecimals=%d) -> %s", (size, szDecimals, expected) => {
    expect(formatSize(size, szDecimals)).toBe(expected);
  });

  it("truncates rather than rounds (Hyperliquid size semantics)", () => {
    // 0.99999 at szDecimals=2 rounds to 1.00 but truncates to 0.99.
    expect(formatSize(0.99999, 2)).toBe("0.99");
    // 0.30001 at szDecimals=4 rounds to 0.3000 but truncates to 0.3.
    expect(formatSize(0.30001, 4)).toBe("0.3");
  });

  it("handles negative sizes symmetrically", () => {
    expect(formatSize(-0.3, 4)).toBe("-0.3");
    expect(formatSize(-0.30001, 4)).toBe("-0.3");
  });

  it("throws on NaN", () => {
    expect(() => formatSize(Number.NaN, 4)).toThrow(RangeError);
  });

  it("throws on Infinity", () => {
    expect(() => formatSize(Number.POSITIVE_INFINITY, 4)).toThrow(RangeError);
  });

  it("throws on negative szDecimals", () => {
    expect(() => formatSize(1, -1)).toThrow(RangeError);
  });
});

describe("HyperliquidPrecision.meetsMinimumNotional", () => {
  it.each<[size: number, price: number, min: number | undefined, expected: boolean]>([
    [0.3, 3750, undefined, true],
    [0.001, 3750, undefined, false],
    [0.3, 3750, 2000, false],
    [0.3, 3750, 10, true],
    [1, 10, undefined, true],
    [0.999, 10, undefined, false],
    [0, 3750, undefined, false],
  ])("(size=%d, price=%d, min=%s) -> %s", (size, price, min, expected) => {
    expect(meetsMinimumNotional(size, price, min ?? MIN_NOTIONAL_USD)).toBe(expected);
  });

  it("defaults minNotional to MIN_NOTIONAL_USD", () => {
    // notional = 10 = MIN_NOTIONAL_USD → meets threshold (>=).
    expect(meetsMinimumNotional(0.0025, 4000)).toBe(true);
    // just under at default min.
    expect(meetsMinimumNotional(0.0024, 4000)).toBe(false);
  });

  it("returns false for NaN inputs (safe failure)", () => {
    expect(meetsMinimumNotional(Number.NaN, 3750)).toBe(false);
    expect(meetsMinimumNotional(0.3, Number.NaN)).toBe(false);
  });
});

describe("HyperliquidPrecision.MIN_NOTIONAL_USD", () => {
  it("is 10 (the POC testnet floor)", () => {
    expect(MIN_NOTIONAL_USD).toBe(10);
  });
});
