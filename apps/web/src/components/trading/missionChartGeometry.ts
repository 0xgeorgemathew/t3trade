// ---------------------------------------------------------------------------
// missionChartGeometry
// ---------------------------------------------------------------------------
//
// The pure math behind the mission price chart. NO React, NO DOM — every
// function here is unit-testable and deterministic, turning the projection's
// candles + prices into the viewBox coordinates the SVG renderer draws.
//
// The chart's "one visual idea": the shape of the trade you are in is the only
// saturated thing on screen. Everything else — the pre-entry line, the level
// rules — is there to frame that shape, and the geometry below computes those
// frames from the projection alone (never from UI state).

import { readFillLifecycle } from "./tradingPresentation";

/** ViewBox units reserved at the right edge for price tags. */
export const LABEL_GUTTER_WIDTH = 120;
export const CHART_VIEWBOX_WIDTH = 1000;
export const CHART_VIEWBOX_HEIGHT = 160;
/** The drawable plot area: viewBox minus the right-edge price-tag gutter. */
export const PLOT_WIDTH = CHART_VIEWBOX_WIDTH - LABEL_GUTTER_WIDTH; // 880
/** Padding above/below the y-domain, as a fraction of the span. */
export const DOMAIN_PADDING_RATIO = 0.08;
/** Fewer candles than this and there is no chart to draw. */
export const MIN_CANDLES_FOR_SVG = 2;

/** A point in viewBox space. */
export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/** Which of the trade's prices a horizontal level represents. */
export type ChartLevelKind = "entry" | "stop" | "target" | "liquidation";

/** A horizontal price level drawn across the plot. */
export interface ChartLevel {
  readonly kind: ChartLevelKind;
  readonly price: number;
  /** ViewBox y position. */
  readonly y: number;
  /** Whether this price falls inside the padded y-domain. */
  readonly inFrame: boolean;
}

/**
 * Everything the SVG renderer needs, derived once from candles + prices.
 *
 * The functions (`xForTime`, `yForPrice`) are closed over the domain so the
 * renderer can map without re-deriving bounds per pixel.
 */
export interface ChartGeometry {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly plotWidth: number;
  readonly labelGutterWidth: number;
  /** Padded lower bound of the y-domain. */
  readonly domainMin: number;
  /** Padded upper bound of the y-domain. */
  readonly domainMax: number;
  /** Epoch millis of the first candle's openTime. */
  readonly timeStart: number;
  /** Epoch millis of the last candle's openTime. */
  readonly timeEnd: number;
  readonly xForTime: (t: number) => number;
  readonly yForPrice: (p: number) => number;
  /** Closes before the entry time — the flat part of the line. */
  readonly preEntryPoints: ReadonlyArray<ChartPoint>;
  /** Closes from entry time onward — the held part of the line. */
  readonly postEntryPoints: ReadonlyArray<ChartPoint>;
  readonly levels: ReadonlyArray<ChartLevel>;
  /** Pinned at the right edge of the plot area; null when markPrice is null. */
  readonly markPoint: ChartPoint | null;
}

/** Input shape for {@link computeChartGeometry}. */
export interface ComputeChartGeometryInput {
  // `open` is accepted (so a `TradingChartCandle` can be passed verbatim) but
  // unused: the chart draws closes, not the full OHLC body.
  readonly candles: ReadonlyArray<{
    readonly openTime: number;
    readonly open?: number;
    readonly close: number;
    readonly high: number;
    readonly low: number;
  }>;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  /** Epoch millis; splits the line into pre/post segments. */
  readonly entryTime: number | null;
  readonly markPrice: number | null;
}

/**
 * Derive the target price from the strategy's planned profit and the size.
 *
 * Long (size > 0): target sits ABOVE entry — entry + profit/|size|.
 * Short (size < 0): target sits BELOW entry — entry - profit/|size|.
 * The sign of `size` decides direction; `targetProfitUsd` is always a
 * magnitude.
 */
export function deriveTargetPrice(
  entryPrice: number,
  targetProfitUsd: number,
  size: number,
): number {
  const magnitude = Math.abs(size);
  // A zero size has no target to point at; return the entry as a no-op rather
  // than dividing by zero.
  if (magnitude === 0) return entryPrice;
  const offset = targetProfitUsd / magnitude;
  return size > 0 ? entryPrice + offset : entryPrice - offset;
}

/**
 * Progress of the live mark toward the target, 0-100.
 *
 * The single formula works for BOTH directions: a short's target < entry, so
 * when the short is profitable both numerator (mark - entry) and denominator
 * (target - entry) are negative and the ratio is positive. Clamped to [0, 100]
 * so a retraced or blown-past target reads as the endpoint, not beyond it.
 *
 * Returns 0 when `target === entry` (no distance to cover — division by zero
 * guard) — the chart's "you have arrived" reading already lives elsewhere.
 */
export function deriveProgressToTarget(mark: number, entry: number, target: number): number {
  if (target === entry) return 0;
  const ratio = ((mark - entry) / (target - entry)) * 100;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, ratio));
}

/**
 * Find the entry fill's timestamp, for the hold-time display.
 *
 * Looks for the NEWEST fill whose `readFillLifecycle(direction)?.action ===
 * "open"` and returns its `tradedAt` as epoch millis. Reversals and closes do
 * not count — the hold clock starts at the open that established the current
 * exposure. Null when no open fill qualifies or when every fill's direction is
 * unreadable.
 */
export function deriveEntryFillAtMillis(
  fills: ReadonlyArray<{ readonly direction?: string | undefined; readonly tradedAt: string }>,
): number | null {
  let newest: number | null = null;
  for (const fill of fills) {
    const lifecycle = readFillLifecycle(fill.direction);
    if (lifecycle === null || lifecycle.action !== "open") continue;
    const ms = Date.parse(fill.tradedAt);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) {
      newest = ms;
    }
  }
  return newest;
}

/** Numeric levels that should anchor the y-domain (candles ∪ entry/stop/target). */
function collectDomainAnchors(
  candles: ReadonlyArray<{ readonly open?: number; readonly high: number; readonly low: number }>,
  entryPrice: number | null,
  stopPrice: number | null,
  targetPrice: number | null,
): number[] {
  const anchors: number[] = [];
  for (const candle of candles) {
    anchors.push(candle.high, candle.low);
  }
  // Liquidation is deliberately EXCLUDED: at 20x it sits far enough away that
  // including it flattens the price action into a band. It is drawn only when
  // it happens to land inside the padded domain (see buildLevels).
  if (entryPrice !== null) anchors.push(entryPrice);
  if (stopPrice !== null) anchors.push(stopPrice);
  if (targetPrice !== null) anchors.push(targetPrice);
  return anchors;
}

/** Build the level list, skipping liquidation when it is out of frame. */
function buildLevels(
  yForPrice: (p: number) => number,
  domainMin: number,
  domainMax: number,
  entryPrice: number | null,
  stopPrice: number | null,
  targetPrice: number | null,
  liquidationPrice: number | null,
): ChartLevel[] {
  const levels: ChartLevel[] = [];

  const pushLevel = (kind: ChartLevelKind, price: number): void => {
    const inFrame = price >= domainMin && price <= domainMax;
    levels.push({ kind, price, y: yForPrice(price), inFrame });
  };

  // Entry/stop/target always participate in the domain (see collectDomainAnchors),
  // so they are always in frame and always drawn.
  if (entryPrice !== null) pushLevel("entry", entryPrice);
  if (stopPrice !== null) pushLevel("stop", stopPrice);
  if (targetPrice !== null) pushLevel("target", targetPrice);

  // Liquidation is the exception: it is NOT in the domain, so only draw it when
  // it happens to fall inside the padded range. Otherwise skip entirely — a
  // liquidation 10% away on a 20x book is noise on a price chart.
  if (liquidationPrice !== null) {
    const inFrame = liquidationPrice >= domainMin && liquidationPrice <= domainMax;
    if (inFrame) {
      levels.push({
        kind: "liquidation",
        price: liquidationPrice,
        y: yForPrice(liquidationPrice),
        inFrame: true,
      });
    }
  }

  return levels;
}

/**
 * Compute the full geometry for the chart, or `null` when there are too few
 * candles to draw anything.
 *
 * The domain is candle highs/lows ∪ {entry, stop, target}, padded 8%. The mark
 * is pinned at the right edge of the plot area regardless of its timestamp
 * (the mark is "now", and "now" is the right edge of a time series).
 */
export function computeChartGeometry(input: ComputeChartGeometryInput): ChartGeometry | null {
  const { candles, entryPrice, stopPrice, targetPrice, liquidationPrice, entryTime, markPrice } =
    input;

  if (candles.length < MIN_CANDLES_FOR_SVG) return null;

  // --- y-domain: candle range ∪ trade levels, padded. ----------------------
  const anchors = collectDomainAnchors(candles, entryPrice, stopPrice, targetPrice);
  let rawMin = anchors[0]!;
  let rawMax = anchors[0]!;
  for (const value of anchors) {
    if (value < rawMin) rawMin = value;
    if (value > rawMax) rawMax = value;
  }

  // A zero-height domain (flat market, single price) would collapse the chart
  // to a line and divide by zero in yForPrice. Invent a small span around it:
  // 0.1% of the price, or 1 unit when the price is ~0.
  let domainSpan = rawMax - rawMin;
  if (domainSpan === 0) {
    domainSpan = Math.max(1, Math.abs(rawMax) * 0.001);
  }
  const pad = domainSpan * DOMAIN_PADDING_RATIO;
  const domainMin = rawMin - pad;
  const domainMax = rawMax + pad;
  const paddedSpan = domainMax - domainMin;

  // --- x-domain: first candle openTime .. last candle openTime. ------------
  const timeStart = candles[0]!.openTime;
  const timeEnd = candles[candles.length - 1]!.openTime;
  const timeSpan = timeEnd - timeStart;

  const xForTime = (t: number): number => {
    if (timeSpan <= 0) return 0;
    return ((t - timeStart) / timeSpan) * PLOT_WIDTH;
  };

  // Inverted: higher price → smaller y → top of SVG.
  const yForPrice = (p: number): number => {
    const ratio = (p - domainMin) / paddedSpan;
    return CHART_VIEWBOX_HEIGHT - ratio * CHART_VIEWBOX_HEIGHT;
  };

  // --- pre/post split around entryTime. ------------------------------------
  // Candles with openTime < entryTime are pre-entry (flat, muted); from entry
  // onward they are post-entry (held, coloured by pnl). A null or pre-history
  // entryTime puts everything in post (the whole line is "held"); a post-history
  // entryTime puts everything in pre.
  const splitTime = entryTime;
  const preEntryPoints: ChartPoint[] = [];
  const postEntryPoints: ChartPoint[] = [];
  for (const candle of candles) {
    const point: ChartPoint = { x: xForTime(candle.openTime), y: yForPrice(candle.close) };
    if (splitTime !== null && candle.openTime < splitTime) {
      preEntryPoints.push(point);
    } else {
      postEntryPoints.push(point);
    }
  }

  // --- levels --------------------------------------------------------------
  const levels = buildLevels(
    yForPrice,
    domainMin,
    domainMax,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
  );

  // --- mark point: pinned at the right edge of the plot. -------------------
  const markPoint: ChartPoint | null =
    markPrice !== null ? { x: PLOT_WIDTH, y: yForPrice(markPrice) } : null;

  return {
    viewBoxWidth: CHART_VIEWBOX_WIDTH,
    viewBoxHeight: CHART_VIEWBOX_HEIGHT,
    plotWidth: PLOT_WIDTH,
    labelGutterWidth: LABEL_GUTTER_WIDTH,
    domainMin,
    domainMax,
    timeStart,
    timeEnd,
    xForTime,
    yForPrice,
    preEntryPoints,
    postEntryPoints,
    levels,
    markPoint,
  };
}
