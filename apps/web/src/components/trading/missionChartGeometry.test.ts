import { describe, expect, it } from "vite-plus/test";

import {
  CHART_VIEWBOX_HEIGHT,
  DOMAIN_PADDING_RATIO,
  MIN_CANDLES_FOR_SVG,
  PLOT_WIDTH,
  computeChartGeometry,
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
} from "./missionChartGeometry";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Five candles spaced 60s apart, closes walking 100→104. */
function fiveWalkingCandles(): ReadonlyArray<{
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}> {
  const base = 1_700_000_000_000;
  return [0, 1, 2, 3, 4].map((i) => ({
    openTime: base + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
  }));
}

describe("computeChartGeometry — minimum candle count", () => {
  it("returns null for zero candles", () => {
    expect(
      computeChartGeometry({
        candles: [],
        entryPrice: null,
        stopPrice: null,
        targetPrice: null,
        liquidationPrice: null,
        entryTime: null,
        markPrice: null,
      }),
    ).toBeNull();
  });

  it("returns null for a single candle", () => {
    expect(
      computeChartGeometry({
        candles: [{ openTime: 1, open: 100, high: 101, low: 99, close: 100 }],
        entryPrice: null,
        stopPrice: null,
        targetPrice: null,
        liquidationPrice: null,
        entryTime: null,
        markPrice: null,
      }),
    ).toBeNull();
  });

  it(`returns geometry for ${MIN_CANDLES_FOR_SVG} candles (the threshold)`, () => {
    const geometry = computeChartGeometry({
      candles: [
        { openTime: 1, open: 100, high: 101, low: 99, close: 100 },
        { openTime: 2, open: 100, high: 102, low: 99, close: 101 },
      ],
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    });
    expect(geometry).not.toBeNull();
  });
});

describe("computeChartGeometry — y-domain", () => {
  it("derives the raw domain from candle highs/lows ∪ levels", () => {
    // highs reach 105 (last candle high = 104, but entry 105 widens it); lows
    // bottom at 95 via the stop. rawMin/rawMax are padded 8% after.
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: 102,
      stopPrice: 95,
      targetPrice: 108,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    // raw span is [95, 108] = 13. pad = 13 * 0.08 = 1.04.
    const rawMin = 95;
    const rawMax = 108;
    const pad = (rawMax - rawMin) * DOMAIN_PADDING_RATIO;
    expect(geometry.domainMin).toBeCloseTo(rawMin - pad, 6);
    expect(geometry.domainMax).toBeCloseTo(rawMax + pad, 6);
  });

  it("pads the domain by exactly 8% of the raw span on each side", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    // candles alone: lows min = 99, highs max = 105. span = 6, pad = 0.48.
    const rawMin = 99;
    const rawMax = 105;
    const span = rawMax - rawMin;
    const pad = span * DOMAIN_PADDING_RATIO;
    expect(geometry.domainMin).toBeCloseTo(rawMin - pad, 6);
    expect(geometry.domainMax).toBeCloseTo(rawMax + pad, 6);
    expect(geometry.domainMin).toBeLessThan(rawMin);
    expect(geometry.domainMax).toBeGreaterThan(rawMax);
  });

  it("invents a small span when the domain is zero-height (no NaN/Infinity)", () => {
    const flatCandles = [0, 1, 2].map((i) => ({
      openTime: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    }));
    const geometry = computeChartGeometry({
      candles: flatCandles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(Number.isFinite(geometry.domainMin)).toBe(true);
    expect(Number.isFinite(geometry.domainMax)).toBe(true);
    expect(geometry.domainMax).toBeGreaterThan(geometry.domainMin);
    // yForPrice must be finite for the price itself.
    expect(Number.isFinite(geometry.yForPrice(100))).toBe(true);
  });
});

describe("computeChartGeometry — pre/post split", () => {
  it("splits the line around entryTime, sharing the boundary point", () => {
    const candles = fiveWalkingCandles();
    // entryTime between candle index 1 (openTime = base + 60_000) and index 2
    // (openTime = base + 120_000): candles 0,1 are pre; 2,3,4 are post. Candle
    // 2 is duplicated into the pre segment so the two-tone line joins up
    // instead of breaking a bar wide at the entry.
    const splitAt = candles[1]!.openTime + 30_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: splitAt,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(3);
    expect(geometry.postEntryPoints).toHaveLength(3);
    expect(geometry.preEntryPoints[2]).toEqual(geometry.postEntryPoints[0]);
  });

  it("puts every point in postEntryPoints when entryTime is null", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(0);
    expect(geometry.postEntryPoints).toHaveLength(5);
  });

  it("puts every point in postEntryPoints when entryTime is before the first candle", () => {
    const candles = fiveWalkingCandles();
    const beforeFirst = candles[0]!.openTime - 1_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: beforeFirst,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(0);
    expect(geometry.postEntryPoints).toHaveLength(5);
  });

  it("puts every point in preEntryPoints when entryTime is after the last candle", () => {
    const candles = fiveWalkingCandles();
    const afterLast = candles[candles.length - 1]!.openTime + 1_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: afterLast,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(5);
    expect(geometry.postEntryPoints).toHaveLength(0);
  });
});

describe("computeChartGeometry — liquidation handling", () => {
  it("excludes a far-away liquidation from the domain and from levels", () => {
    // Without liquidation, the domain is ~[99, 105] padded. A liquidation at
    // 5x the range (e.g. 600) must NOT widen the domain, and must NOT appear in
    // the levels array (out of frame).
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: 600,
      entryTime: null,
      markPrice: null,
    })!;

    // Domain stays bounded by the candle range — liquidation did not push it out.
    expect(geometry.domainMax).toBeLessThan(200);
    expect(geometry.levels.find((level) => level.kind === "liquidation")).toBeUndefined();
  });

  it("includes an in-frame liquidation in levels with inFrame true", () => {
    // A liquidation that falls INSIDE the padded range is drawn.
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: 100,
      entryTime: null,
      markPrice: null,
    })!;

    const liquidation = geometry.levels.find((level) => level.kind === "liquidation");
    expect(liquidation).toBeDefined();
    expect(liquidation?.inFrame).toBe(true);
  });

  it("always includes entry/stop/target levels (they are in-frame by construction)", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: 102,
      stopPrice: 98,
      targetPrice: 106,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    const kinds = geometry.levels.map((level) => level.kind).sort();
    expect(kinds).toEqual(["entry", "stop", "target"]);
    for (const level of geometry.levels) {
      expect(level.inFrame).toBe(true);
    }
  });

  it("skips null entry/stop/target levels entirely", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.levels).toHaveLength(0);
  });
});

describe("computeChartGeometry — mark point", () => {
  it("pins the mark at x = PLOT_WIDTH with y mapped from markPrice", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 100,
    })!;

    expect(geometry.markPoint).not.toBeNull();
    expect(geometry.markPoint?.x).toBe(PLOT_WIDTH);
    expect(geometry.markPoint?.y).toBeCloseTo(geometry.yForPrice(100), 6);
  });

  it("returns null markPoint when markPrice is null", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.markPoint).toBeNull();
  });
});

describe("computeChartGeometry — axis mappings", () => {
  it("maps timeStart → x=0 and timeEnd → x=PLOT_WIDTH", () => {
    const candles = fiveWalkingCandles();
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.xForTime(geometry.timeStart)).toBeCloseTo(0, 6);
    expect(geometry.xForTime(geometry.timeEnd)).toBeCloseTo(PLOT_WIDTH, 6);
  });

  it("inverts yForPrice: a higher price yields a smaller y", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    const low = geometry.yForPrice(99);
    const high = geometry.yForPrice(105);
    expect(high).toBeLessThan(low);
  });

  it("maps domainMin → bottom of viewBox and domainMax → top", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.yForPrice(geometry.domainMin)).toBeCloseTo(CHART_VIEWBOX_HEIGHT, 6);
    expect(geometry.yForPrice(geometry.domainMax)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// deriveTargetPrice
// ---------------------------------------------------------------------------

describe("deriveTargetPrice", () => {
  it("places a long target above the entry (size > 0)", () => {
    // entry 100, profit 50, size 1 → 100 + 50 = 150.
    expect(deriveTargetPrice(100, 50, 1)).toBeCloseTo(150, 6);
  });

  it("places a short target below the entry (size < 0)", () => {
    // entry 100, profit 50, size -1 → 100 - 50 = 50.
    expect(deriveTargetPrice(100, 50, -1)).toBeCloseTo(50, 6);
  });

  it("scales the offset by the size magnitude, not the raw size", () => {
    // entry 100, profit 100, size 2 → 100 + 50 = 150 (offset = 100/|2|).
    expect(deriveTargetPrice(100, 100, 2)).toBeCloseTo(150, 6);
    // short: size -4, profit 200 → offset 50, target 50.
    expect(deriveTargetPrice(100, 200, -4)).toBeCloseTo(50, 6);
  });

  it("returns the entry unchanged for a zero size (no division by zero)", () => {
    expect(deriveTargetPrice(100, 50, 0)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// deriveProgressToTarget
// ---------------------------------------------------------------------------

describe("deriveProgressToTarget", () => {
  it("reports 0 at entry and 100 at target (long)", () => {
    expect(deriveProgressToTarget(100, 100, 150)).toBe(0);
    expect(deriveProgressToTarget(150, 100, 150)).toBe(100);
  });

  it("reports the ratio between entry and target", () => {
    // halfway: (125 - 100) / (150 - 100) = 0.5 → 50.
    expect(deriveProgressToTarget(125, 100, 150)).toBeCloseTo(50, 6);
  });

  it("clamps to 100 when the mark blows past the target", () => {
    expect(deriveProgressToTarget(200, 100, 150)).toBe(100);
  });

  it("clamps to 0 when the mark retraces below entry", () => {
    expect(deriveProgressToTarget(80, 100, 150)).toBe(0);
  });

  it("works for a short: target below entry, profit is mark < entry", () => {
    // short: entry 100, target 50, mark 75 → halfway.
    expect(deriveProgressToTarget(75, 100, 50)).toBeCloseTo(50, 6);
    expect(deriveProgressToTarget(50, 100, 50)).toBe(100);
    // blown past target (mark 25, even lower) → clamped 100.
    expect(deriveProgressToTarget(25, 100, 50)).toBe(100);
    // retraced above entry → clamped 0.
    expect(deriveProgressToTarget(120, 100, 50)).toBe(0);
  });

  it("returns 0 when target === entry (no crash)", () => {
    expect(deriveProgressToTarget(100, 100, 100)).toBe(0);
    expect(deriveProgressToTarget(150, 100, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveEntryFillAtMillis
// ---------------------------------------------------------------------------

describe("deriveEntryFillAtMillis", () => {
  it("finds the newest 'open' fill", () => {
    const fills = [
      { direction: "Open Long", tradedAt: "2026-08-02T10:00:00.000Z" },
      { direction: "Open Long", tradedAt: "2026-08-02T11:00:00.000Z" }, // newest open
      { direction: "Close Long", tradedAt: "2026-08-02T12:00:00.000Z" }, // later, but close
    ];
    // The newest OPEN — not the newest fill overall.
    expect(deriveEntryFillAtMillis(fills)).toBe(Date.parse("2026-08-02T11:00:00.000Z"));
  });

  it("ignores close and reverse fills", () => {
    const fills = [
      { direction: "Close Long", tradedAt: "2026-08-02T10:00:00.000Z" },
      { direction: "Long > Short", tradedAt: "2026-08-02T11:00:00.000Z" }, // reverse
      { direction: "Close Short", tradedAt: "2026-08-02T12:00:00.000Z" },
    ];
    expect(deriveEntryFillAtMillis(fills)).toBeNull();
  });

  it("returns null when there is no open fill", () => {
    expect(deriveEntryFillAtMillis([])).toBeNull();
    expect(
      deriveEntryFillAtMillis([{ direction: "Close Long", tradedAt: "2026-08-02T10:00:00.000Z" }]),
    ).toBeNull();
  });

  it("returns null when fills have no readable direction", () => {
    const fills = [
      { direction: undefined, tradedAt: "2026-08-02T10:00:00.000Z" },
      { direction: "Buy", tradedAt: "2026-08-02T11:00:00.000Z" }, // spot, not an open
    ];
    expect(deriveEntryFillAtMillis(fills)).toBeNull();
  });
});
