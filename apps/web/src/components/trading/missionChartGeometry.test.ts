import { describe, expect, it } from "vite-plus/test";

import {
  CHART_VIEWBOX_HEIGHT,
  DOMAIN_PADDING_RATIO,
  FUTURE_GUTTER_RATIO,
  GUTTER_LABEL_MIN_SEPARATION,
  MAX_DRAWN_CONDITIONS,
  MIN_CANDLES_FOR_SVG,
  PLOT_WIDTH,
  computeChartGeometry,
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
  findLevelAtPrice,
  layoutGutterLabels,
  selectVisibleCandles,
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

// ---------------------------------------------------------------------------
// layoutGutterLabels
// ---------------------------------------------------------------------------

describe("layoutGutterLabels", () => {
  // The reported failure: entry 1,859.43, mark 1,869.25 and a close stop all
  // landed within a few viewBox units and rendered on top of each other.
  it("separates labels that would overlap", () => {
    const laid = layoutGutterLabels([
      { y: 80, priority: 0 },
      { y: 82, priority: 2 },
      { y: 84, priority: 3 },
    ]);

    for (let i = 1; i < laid.length; i += 1) {
      expect(laid[i]!.labelY - laid[i - 1]!.labelY).toBeGreaterThanOrEqual(
        GUTTER_LABEL_MIN_SEPARATION - 1e-9,
      );
    }
  });

  // The tag the operator is reading right now must not be the one that moves.
  it("keeps the highest-priority label on its own level", () => {
    const laid = layoutGutterLabels([
      { y: 80, priority: 0 },
      { y: 82, priority: 5 },
    ]);
    const mark = laid.find((tag) => tag.priority === 0);
    expect(mark?.labelY).toBe(80);
  });

  it("preserves top-to-bottom order", () => {
    const laid = layoutGutterLabels([
      { y: 20, priority: 3 },
      { y: 21, priority: 1 },
      { y: 22, priority: 2 },
      { y: 23, priority: 5 },
    ]);
    const ys = laid.map((tag) => tag.labelY);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("keeps labels inside the frame", () => {
    const laid = layoutGutterLabels([
      { y: 0, priority: 1 },
      { y: 1, priority: 2 },
      { y: CHART_VIEWBOX_HEIGHT, priority: 3 },
      { y: CHART_VIEWBOX_HEIGHT - 1, priority: 4 },
    ]);
    for (const tag of laid) {
      expect(tag.labelY).toBeGreaterThanOrEqual(0);
      expect(tag.labelY).toBeLessThanOrEqual(CHART_VIEWBOX_HEIGHT);
    }
  });

  it("has nothing to lay out for an empty set", () => {
    expect(layoutGutterLabels([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// domain clamping and condition levels
// ---------------------------------------------------------------------------

describe("computeChartGeometry domain sanity", () => {
  const base = 1_700_000_000_000;
  /** Ten candles inside a 2-unit band: the price action a far target used to flatten. */
  const tightCandles = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
    openTime: base + i * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: i % 2 === 0 ? 100.5 : 99.5,
  }));

  const geometryWith = (overrides: {
    readonly targetPrice?: number | null;
    readonly conditions?: ReadonlyArray<{
      readonly price: number;
      readonly direction: "above" | "below";
      readonly met: boolean;
    }>;
  }) =>
    computeChartGeometry({
      candles: tightCandles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: overrides.targetPrice ?? null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 100,
      ...(overrides.conditions === undefined ? {} : { conditions: overrides.conditions }),
    });

  it("does not let a far target flatten the candle series", () => {
    const near = geometryWith({})!;
    const far = geometryWith({ targetPrice: 140 })!;

    // The domain is unchanged: the target is out of reach, so it is not an
    // anchor and the price action keeps its resolution.
    expect(far.domainMin).toBeCloseTo(near.domainMin, 9);
    expect(far.domainMax).toBeCloseTo(near.domainMax, 9);

    const target = far.levels.find((level) => level.kind === "target");
    expect(target?.offScale).toBe("above");
    // Pinned at the top edge, with the true price still on the tag.
    expect(target?.y).toBe(0);
    expect(target?.price).toBe(140);
  });

  it("still anchors a target that is within reach of the candles", () => {
    const geometry = geometryWith({ targetPrice: 102 })!;
    const target = geometry.levels.find((level) => level.kind === "target");
    expect(target?.offScale).toBeNull();
    expect(geometry.domainMax).toBeGreaterThan(102);
  });

  it("draws armed conditions as their own levels, with met state", () => {
    const geometry = geometryWith({
      conditions: [
        { price: 100.8, direction: "above", met: false },
        { price: 99.2, direction: "below", met: true },
      ],
    })!;

    const kinds = geometry.levels.map((level) => level.kind);
    expect(kinds).toContain("condition_above");
    expect(kinds).toContain("condition_below");
    expect(geometry.levels.find((level) => level.kind === "condition_below")?.met).toBe(true);
    expect(geometry.droppedConditions).toBe(0);
  });

  it("draws only the conditions nearest the mark and counts the rest", () => {
    const geometry = geometryWith({
      conditions: [
        { price: 100.1, direction: "above", met: false },
        { price: 100.2, direction: "above", met: false },
        { price: 99.9, direction: "below", met: false },
        { price: 99.8, direction: "below", met: false },
        { price: 130, direction: "above", met: false },
        { price: 70, direction: "below", met: false },
      ],
    })!;

    const drawn = geometry.levels.filter((level) => level.kind.startsWith("condition_"));
    expect(drawn).toHaveLength(MAX_DRAWN_CONDITIONS);
    expect(geometry.droppedConditions).toBe(2);
    // The two far ones are the ones dropped.
    expect(drawn.map((level) => level.price).sort((a, b) => a - b)).toEqual([
      99.8, 99.9, 100.1, 100.2,
    ]);
  });
});

// ---------------------------------------------------------------------------
// gutter tags
// ---------------------------------------------------------------------------

describe("computeChartGeometry gutter tags", () => {
  const base = 1_700_000_000_000;
  const candles = [0, 1, 2, 3].map((i) => ({
    openTime: base + i * 60_000,
    open: 1_860,
    high: 1_872,
    low: 1_856,
    close: 1_865,
  }));

  it("folds a near-identical entry into the mark tag rather than nudging it", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: 1_869.2,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 1_869.25,
    })!;

    const tags = geometry.gutterTags;
    expect(tags.some((tag) => tag.kind === "entry")).toBe(false);
    const mark = tags.find((tag) => tag.kind === "mark");
    expect(mark?.mergedPrice).toBe(1_869.2);
  });

  it("keeps a distinct entry as its own tag", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: 1_857,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 1_871,
    })!;

    expect(geometry.gutterTags.some((tag) => tag.kind === "entry")).toBe(true);
    expect(geometry.gutterTags.find((tag) => tag.kind === "mark")?.mergedPrice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// wall-clock axis
// ---------------------------------------------------------------------------
//
// Without `nowMillis` the axis ends at the last candle, which means the chart
// only moves when a bar closes — on a 1m series, once every sixty seconds, and
// frozen in between. It also puts the mark dot exactly on the final candle at
// the frame's right edge, where a series sliding leftward has nothing to slide
// away from. Both are corrected by passing a clock, and NEITHER may change for
// a caller that does not pass one: the review chart draws a closed window where
// a wall-clock axis would be actively wrong.

describe("computeChartGeometry — wall-clock axis", () => {
  const candles = fiveWalkingCandles();
  const lastOpenTime = candles[candles.length - 1]!.openTime;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("leaves the axis on the last candle without a clock", () => {
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.nowX).toBe(PLOT_WIDTH);
    expect(geometry.timeEnd).toBe(lastOpenTime);
    expect(geometry.xForTime(lastOpenTime)).toBeCloseTo(PLOT_WIDTH, 6);
    expect(geometry.markPoint?.x).toBe(PLOT_WIDTH);
    // No clock, no forming bar: the mark sits on the last candle, so the
    // segment between them would have zero length.
    expect(geometry.livePoints).toEqual([]);
  });

  it("ends the axis at now and reserves the future gutter with a clock", () => {
    const now = lastOpenTime + 30_000;
    const geometry = computeChartGeometry({ ...base, nowMillis: now });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeEnd).toBe(now);
    expect(geometry.nowX).toBeCloseTo(PLOT_WIDTH * (1 - FUTURE_GUTTER_RATIO), 6);
    expect(geometry.xForTime(now)).toBeCloseTo(geometry.nowX, 6);
    expect(geometry.markPoint?.x).toBeCloseTo(geometry.nowX, 6);
    // The last candle is now behind the mark rather than under it.
    expect(geometry.xForTime(lastOpenTime)).toBeLessThan(geometry.nowX);
  });

  it("slides the series left as the clock advances", () => {
    const early = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 10_000 });
    const later = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 40_000 });
    if (early === null || later === null) throw new Error("expected geometry");

    // Same bar, later clock → further left. This is the drift; the candle feed
    // has not moved at all between these two frames.
    expect(later.xForTime(lastOpenTime)).toBeLessThan(early.xForTime(lastOpenTime));
  });

  it("draws the forming bar from the last close to the mark", () => {
    const now = lastOpenTime + 30_000;
    const geometry = computeChartGeometry({ ...base, nowMillis: now });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.livePoints).toHaveLength(2);
    const [from, to] = geometry.livePoints;
    expect(from!.x).toBeCloseTo(geometry.xForTime(lastOpenTime), 6);
    expect(to!.x).toBeCloseTo(geometry.nowX, 6);
    expect(to!.y).toBeCloseTo(geometry.markPoint!.y, 6);
  });

  // A browser clock behind the server's candle stamps would otherwise run the
  // axis backwards and put the last bar past the right edge.
  it("trusts the candles over a clock that lags them", () => {
    const geometry = computeChartGeometry({ ...base, nowMillis: lastOpenTime - 60_000 });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeEnd).toBe(lastOpenTime);
    expect(geometry.xForTime(lastOpenTime)).toBeCloseTo(geometry.nowX, 6);
  });
});

describe("computeChartGeometry — time markers", () => {
  const candles = fiveWalkingCandles();
  const lastOpenTime = candles[candles.length - 1]!.openTime;
  const now = lastOpenTime + 30_000;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
    nowMillis: now,
  } as const;

  it("places a future marker in the gutter, right of now", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [{ key: "reassess", label: "reassess", at: now + 60_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    const marker = geometry.timeMarkers[0]!;
    expect(marker.x).toBeGreaterThan(geometry.nowX);
    expect(marker.x).toBeLessThanOrEqual(PLOT_WIDTH);
    expect(marker.overdue).toBe(false);
  });

  // A reassessment further out than the gutter reaches still belongs on screen:
  // pinned at the far edge says "beyond this frame", drawing it off-canvas says
  // nothing at all.
  it("pins a distant marker at the plot edge rather than dropping it", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [{ key: "reassess", label: "reassess", at: now + 86_400_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers[0]!.x).toBe(PLOT_WIDTH);
  });

  it("marks a passed reassessment as overdue", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [{ key: "reassess", label: "reassess", at: now - 10_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers[0]!.overdue).toBe(true);
    // Clamped forward to now: an overdue event is not in the past of the axis,
    // it is the next thing that should happen.
    expect(geometry.timeMarkers[0]!.x).toBeCloseTo(geometry.nowX, 6);
  });

  it("carries the marker's tone through, defaulting to planned", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [
        { key: "floor", label: "", at: now + 60_000, tone: "auto" as const },
        { key: "reassess", label: "reassess", at: now + 120_000 },
      ],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers.map((marker) => marker.tone)).toEqual(["auto", "planned"]);
  });

  it("ignores markers without a clock to place them against", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 104,
      timeMarkers: [{ key: "reassess", label: "reassess", at: lastOpenTime + 60_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers).toEqual([]);
  });
});

describe("computeChartGeometry — fill markers", () => {
  const candles = fiveWalkingCandles();
  const timeStart = candles[0]!.openTime;
  const lastOpenTime = candles[candles.length - 1]!.openTime;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("places a fill at its own time and price", () => {
    const at = timeStart + 120_000;
    const geometry = computeChartGeometry({
      ...base,
      fills: [{ key: "a", at, price: 102, kind: "open" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    const point = geometry.fillPoints[0]!;
    expect(point.key).toBe("a");
    expect(point.x).toBeCloseTo(geometry.xForTime(at), 6);
    expect(point.y).toBeCloseTo(geometry.yForPrice(102), 6);
    expect(point.kind).toBe("open");
  });

  // A closed position's two fills outlive the position row itself, which is the
  // whole reason they are drawn: the chart is the session's record.
  it("keeps both ends of a position that has already closed", () => {
    const geometry = computeChartGeometry({
      ...base,
      fills: [
        { key: "in", at: timeStart + 60_000, price: 101, kind: "open" },
        { key: "out", at: timeStart + 180_000, price: 103, kind: "close_profit" },
      ],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints.map((p) => p.key)).toEqual(["in", "out"]);
    expect(geometry.fillPoints[0]!.x).toBeLessThan(geometry.fillPoints[1]!.x);
  });

  // Placing it at x=0 would claim it happened at the window's first candle.
  it("drops a fill older than the window rather than pinning it left", () => {
    const geometry = computeChartGeometry({
      ...base,
      fills: [{ key: "ancient", at: timeStart - 600_000, price: 101, kind: "open" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints).toEqual([]);
  });

  it("clamps a fill price outside the domain into the frame", () => {
    const geometry = computeChartGeometry({
      ...base,
      fills: [{ key: "spike", at: lastOpenTime, price: 10_000, kind: "close_loss" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    const point = geometry.fillPoints[0]!;
    expect(point.y).toBe(0);
    expect(point.price).toBe(10_000);
  });

  it("pins a fill newer than the axis at now", () => {
    const geometry = computeChartGeometry({
      ...base,
      nowMillis: lastOpenTime + 30_000,
      fills: [{ key: "just-now", at: lastOpenTime + 120_000, price: 104, kind: "open" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints[0]!.x).toBeCloseTo(geometry.nowX, 6);
  });

  it("draws no markers when none are passed", () => {
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints).toEqual([]);
  });
});

describe("computeChartGeometry — pending order", () => {
  const candles = fiveWalkingCandles();

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("draws a resting buy as its own level kind", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 101.5, side: "buy" },
    });
    if (geometry === null) throw new Error("expected geometry");

    const level = geometry.levels.find((l) => l.kind === "pending_buy");
    expect(level?.price).toBe(101.5);
    expect(level?.inFrame).toBe(true);
  });

  it("draws a resting sell as its own level kind", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 103.5, side: "sell" },
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.levels.some((l) => l.kind === "pending_sell")).toBe(true);
  });

  it("gives the resting order a gutter tag", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 101.5, side: "buy" },
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.gutterTags.some((tag) => tag.kind === "pending_buy")).toBe(true);
  });

  // The order is a price the market is expected to reach, so a window that
  // excluded it would hide the very thing about to happen.
  it("anchors the y-domain on the resting order's price", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 97, side: "buy" },
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.domainMin).toBeLessThan(97);
  });

  it("draws no pending level when there is no resting order", () => {
    const geometry = computeChartGeometry({ ...base, pendingOrder: null });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.levels.some((l) => l.kind.startsWith("pending"))).toBe(false);
  });
});

describe("selectVisibleCandles", () => {
  const series = Array.from({ length: 120 }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    close: 100 + i,
  }));

  it("draws the plain tail when nothing older has to stay in frame", () => {
    const visible = selectVisibleCandles(series, 60, null);
    expect(visible).toHaveLength(60);
    expect(visible[0]!.openTime).toBe(series[60]!.openTime);
  });

  // The fill markers are the session's record; a window that cropped them would
  // be the same as not drawing them.
  it("widens the window to keep an older fill visible", () => {
    const oldFill = series[10]!.openTime;
    const visible = selectVisibleCandles(series, 60, oldFill);

    expect(visible.length).toBeGreaterThan(60);
    expect(visible[0]!.openTime).toBeLessThanOrEqual(oldFill);
  });

  it("never narrows the window for a recent fill", () => {
    const recent = series[110]!.openTime;
    expect(selectVisibleCandles(series, 60, recent)).toHaveLength(60);
  });

  it("gives back everything it has when the fill predates the series", () => {
    const visible = selectVisibleCandles(series, 60, series[0]!.openTime - 600_000);
    expect(visible).toHaveLength(series.length);
  });

  it("keeps the tail when the fill is newer than every bar", () => {
    const visible = selectVisibleCandles(series, 60, series[119]!.openTime + 600_000);
    expect(visible).toHaveLength(60);
  });
});

describe("findLevelAtPrice", () => {
  /** Three drawn levels, of the kinds a mission actually carries at once. */
  const levels = [
    { kind: "entry" as const, price: 1900, y: 80, inFrame: true, offScale: null },
    { kind: "stop" as const, price: 1908.5, y: 20, inFrame: true, offScale: null },
    { kind: "target" as const, price: 1885, y: 150, inFrame: true, offScale: null },
  ];

  it("returns the level a pill's price names", () => {
    expect(findLevelAtPrice(levels, 1908.5)?.kind).toBe("stop");
  });

  it("tolerates the float drift of a price derived twice", () => {
    expect(findLevelAtPrice(levels, 1908.5 + 1e-9)?.kind).toBe("stop");
  });

  it("returns null for a price the chart draws no level at", () => {
    expect(findLevelAtPrice(levels, 1899)).toBeNull();
  });

  it("does not snap a near miss to the closest level", () => {
    // A cent away is a different price, and lighting up the stop here would
    // point the operator at a level they did not click.
    expect(findLevelAtPrice(levels, 1908.51)).toBeNull();
  });

  it("returns null when nothing is drawn at all", () => {
    expect(findLevelAtPrice([], 1900)).toBeNull();
  });
});
