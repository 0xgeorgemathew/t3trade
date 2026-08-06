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

/**
 * How far from the candle window's midpoint a level may sit and still anchor
 * the y-domain, as a multiple of the candle range.
 *
 * A 20x target can sit far enough away that including it squashes an hour of
 * 1m price action into a band a few pixels tall — the chart then "does not
 * scale", which is exactly the complaint. Beyond this reach the level is
 * excluded from the domain and pinned at the frame edge with a chevron
 * instead, the same idiom the clamped mark dot already uses.
 */
export const DOMAIN_LEVEL_REACH_RATIO = 1.5;

/** Minimum vertical gap between two gutter tags, in viewBox units. */
export const GUTTER_LABEL_MIN_SEPARATION = 14;

/**
 * Below this gap the entry tag is folded into the mark tag rather than nudged
 * away from it. Two tags 3 units apart reading 1,869.25 and 1,859.43 are two
 * numbers fighting; `1,869.25 (entry 1,859.43)` is one fact.
 */
export const GUTTER_LABEL_MERGE_DISTANCE = 6;

/** How many armed condition levels the chart draws before it says "+N more". */
export const MAX_DRAWN_CONDITIONS = 4;

/** A point in viewBox space. */
export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Which of the chart's prices a horizontal level represents.
 *
 * The two `condition_*` kinds are the armed watches a flat mission is waiting
 * on — the levels that decide whether it enters at all. They were invisible
 * before the panel drew a chart pre-position, which made "waiting" look like
 * "idle".
 */
export type ChartLevelKind =
  | "entry"
  | "stop"
  | "target"
  | "liquidation"
  | "condition_above"
  | "condition_below";

/** A horizontal price level drawn across the plot. */
export interface ChartLevel {
  readonly kind: ChartLevelKind;
  readonly price: number;
  /** ViewBox y position, clamped into the frame when `offScale` is set. */
  readonly y: number;
  /** Whether this price falls inside the padded y-domain. */
  readonly inFrame: boolean;
  /**
   * Which edge the level is pinned to when it sits outside the domain.
   *
   * A stop or target far enough away to flatten the candle series is excluded
   * from the domain and drawn at the edge with a chevron, rather than dragged
   * into the domain and taking the price action's resolution with it.
   */
  readonly offScale: "above" | "below" | null;
  /** Whether an armed condition's predicate is already satisfied. */
  readonly met?: boolean;
}

/** One armed price condition the chart draws as a level. */
export interface ChartCondition {
  readonly price: number;
  readonly direction: "above" | "below";
  readonly met: boolean;
}

/**
 * A right-gutter price tag, after collision resolution.
 *
 * `y` is where the level actually sits; `labelY` is where its tag is drawn.
 * When they differ the renderer draws a leader line between them, so a nudged
 * tag still points at its own level.
 */
export interface GutterTag {
  readonly key: string;
  readonly kind: ChartLevelKind | "mark";
  readonly y: number;
  readonly labelY: number;
  readonly price: number;
  readonly offScale: "above" | "below" | null;
  readonly met?: boolean;
  /** Set when the entry tag merged into the mark tag; the entry price. */
  readonly mergedPrice?: number;
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
  /** Every right-gutter price tag, already resolved against collisions. */
  readonly gutterTags: ReadonlyArray<GutterTag>;
  /** Armed conditions the chart did not draw, so the panel can say how many. */
  readonly droppedConditions: number;
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
  /**
   * Armed price conditions, drawn while the mission is flat and waiting. The
   * four nearest the mark are drawn; the rest are counted in
   * `droppedConditions` for the panel to report as text.
   */
  readonly conditions?: ReadonlyArray<ChartCondition>;
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

/** Hold a value inside `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The candle window's own range, before any level is considered.
 *
 * Everything else about the y-domain is decided against this: a level within
 * reach of it joins the domain, a level beyond it is pinned at an edge.
 */
function candleBounds(candles: ReadonlyArray<{ readonly high: number; readonly low: number }>): {
  readonly min: number;
  readonly max: number;
} {
  let min = candles[0]!.low;
  let max = candles[0]!.high;
  for (const candle of candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  return { min, max };
}

/**
 * The levels near enough to the price action to anchor the domain.
 *
 * Liquidation is never an anchor (at 20x it is always far), and neither is the
 * mark (it is polled far more often than the candles). Everything else joins
 * only while it sits within `DOMAIN_LEVEL_REACH_RATIO` candle-ranges of the
 * window's midpoint.
 */
function collectDomainAnchors(
  candles: ReadonlyArray<{ readonly high: number; readonly low: number }>,
  candidates: ReadonlyArray<number>,
): number[] {
  const bounds = candleBounds(candles);
  const anchors: number[] = [bounds.min, bounds.max];
  const mid = (bounds.min + bounds.max) / 2;
  // A dead-flat window has no range to scale by; fall back to a tenth of a
  // percent of the price so "near" still means something.
  const range = bounds.max - bounds.min || Math.max(1, Math.abs(mid) * 0.001);
  const reach = range * DOMAIN_LEVEL_REACH_RATIO;
  for (const price of candidates) {
    if (Math.abs(price - mid) <= reach) anchors.push(price);
  }
  return anchors;
}

/** Hold a set of gutter tags apart, without letting them leave the frame. */
export function layoutGutterLabels<T extends { readonly y: number; readonly priority: number }>(
  labels: ReadonlyArray<T>,
): ReadonlyArray<T & { readonly labelY: number }> {
  if (labels.length === 0) return [];

  // Top to bottom, with the more important tag first among ties: the sweep
  // below preserves this order, so tags never cross their own levels.
  const placed = labels
    .map((label) => ({ ...label, labelY: label.y }))
    .sort((a, b) => a.y - b.y || a.priority - b.priority);

  // Push apart, letting the lower-priority tag of each too-close pair do the
  // moving. A handful of passes settles any realistic set; the clamping sweeps
  // below guarantee the invariant regardless.
  for (let pass = 0; pass < placed.length + 1; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length - 1; i += 1) {
      const above = placed[i]!;
      const below = placed[i + 1]!;
      const deficit = GUTTER_LABEL_MIN_SEPARATION - (below.labelY - above.labelY);
      if (deficit <= 0) continue;
      moved = true;
      if (above.priority < below.priority) {
        below.labelY += deficit;
      } else if (below.priority < above.priority) {
        above.labelY -= deficit;
      } else {
        above.labelY -= deficit / 2;
        below.labelY += deficit / 2;
      }
    }
    if (!moved) break;
  }

  // Two sweeps close the loop: forward pushes everything below the top edge
  // apart, backward pulls everything above the bottom edge back in.
  for (const tag of placed) {
    tag.labelY = clamp(tag.labelY, 0, CHART_VIEWBOX_HEIGHT);
  }
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1]!;
    const current = placed[i]!;
    current.labelY = Math.max(current.labelY, previous.labelY + GUTTER_LABEL_MIN_SEPARATION);
  }
  for (let i = placed.length - 2; i >= 0; i -= 1) {
    const next = placed[i + 1]!;
    const current = placed[i]!;
    current.labelY = Math.min(
      current.labelY,
      Math.min(next.labelY - GUTTER_LABEL_MIN_SEPARATION, CHART_VIEWBOX_HEIGHT),
    );
  }

  return placed;
}

/**
 * Which tag wins when two would overlap. Lower is more important.
 *
 * The mark is what the operator is reading right now; the entry is what every
 * other number is measured from. A condition is the least urgent of the set —
 * it is a level nothing has reached yet.
 */
const GUTTER_PRIORITY: Record<ChartLevelKind | "mark", number> = {
  mark: 0,
  entry: 1,
  stop: 2,
  target: 3,
  liquidation: 4,
  condition_above: 5,
  condition_below: 5,
};

/**
 * Build the gutter tags for a set of levels plus the mark, resolving overlaps.
 *
 * The entry/mark merge is handled before the layout runs: two tags a few units
 * apart reading nearly the same price are one fact, not two, and nudging them
 * apart only makes the chart look like it has more levels than it has.
 */
function buildGutterTags(
  levels: ReadonlyArray<ChartLevel>,
  markPoint: ChartPoint | null,
  markPrice: number | null,
): GutterTag[] {
  const entry = levels.find((level) => level.kind === "entry") ?? null;
  const mergeEntry =
    entry !== null &&
    markPoint !== null &&
    markPrice !== null &&
    Math.abs(entry.y - markPoint.y) < GUTTER_LABEL_MERGE_DISTANCE;

  const candidates: Array<{
    readonly key: string;
    readonly kind: ChartLevelKind | "mark";
    readonly y: number;
    readonly price: number;
    readonly offScale: "above" | "below" | null;
    readonly met?: boolean;
    readonly mergedPrice?: number;
    readonly priority: number;
  }> = [];

  if (markPoint !== null && markPrice !== null) {
    candidates.push({
      key: "mark",
      kind: "mark",
      y: markPoint.y,
      price: markPrice,
      offScale: null,
      ...(mergeEntry && entry !== null ? { mergedPrice: entry.price } : {}),
      priority: GUTTER_PRIORITY.mark,
    });
  }

  levels.forEach((level, index) => {
    if (mergeEntry && level.kind === "entry") return;
    candidates.push({
      key: `${level.kind}-${index}`,
      kind: level.kind,
      y: level.y,
      price: level.price,
      offScale: level.offScale,
      ...(level.met === undefined ? {} : { met: level.met }),
      priority: GUTTER_PRIORITY[level.kind],
    });
  });

  return layoutGutterLabels(candidates).map(({ priority: _priority, ...tag }) => tag);
}

/** Build the level list, pinning anything outside the domain to an edge. */
function buildLevels(input: {
  readonly yForPrice: (p: number) => number;
  readonly domainMin: number;
  readonly domainMax: number;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  readonly conditions: ReadonlyArray<ChartCondition>;
}): ChartLevel[] {
  const levels: ChartLevel[] = [];

  const pushLevel = (kind: ChartLevelKind, price: number, met?: boolean): void => {
    const offScale: "above" | "below" | null =
      price > input.domainMax ? "above" : price < input.domainMin ? "below" : null;
    levels.push({
      kind,
      price,
      // Pinned at the edge when off-scale, so the line and its tag stay on
      // screen and the chevron says which way the real price lies.
      y:
        offScale === "above"
          ? 0
          : offScale === "below"
            ? CHART_VIEWBOX_HEIGHT
            : input.yForPrice(price),
      inFrame: offScale === null,
      offScale,
      ...(met === undefined ? {} : { met }),
    });
  };

  if (input.entryPrice !== null) pushLevel("entry", input.entryPrice);
  if (input.stopPrice !== null) pushLevel("stop", input.stopPrice);
  if (input.targetPrice !== null) pushLevel("target", input.targetPrice);

  // Liquidation is the exception: it is never a domain anchor, and a
  // liquidation 10% away on a 20x book is noise rather than a level, so it is
  // drawn only when it happens to fall inside the frame.
  if (input.liquidationPrice !== null) {
    const inFrame =
      input.liquidationPrice >= input.domainMin && input.liquidationPrice <= input.domainMax;
    if (inFrame) pushLevel("liquidation", input.liquidationPrice);
  }

  for (const condition of input.conditions) {
    pushLevel(
      condition.direction === "above" ? "condition_above" : "condition_below",
      condition.price,
      condition.met,
    );
  }

  return levels;
}

/**
 * The armed conditions worth drawing: the four nearest the mark.
 *
 * A mission can arm a dozen levels across several republishes. Drawing them
 * all turns the plot into a ladder and hides the price line inside it, so the
 * near ones are drawn and the rest are counted.
 */
function selectConditions(
  conditions: ReadonlyArray<ChartCondition>,
  markPrice: number | null,
): { readonly drawn: ReadonlyArray<ChartCondition>; readonly dropped: number } {
  if (conditions.length <= MAX_DRAWN_CONDITIONS) return { drawn: conditions, dropped: 0 };
  const reference = markPrice ?? conditions[0]!.price;
  const nearest = [...conditions].sort(
    (a, b) => Math.abs(a.price - reference) - Math.abs(b.price - reference),
  );
  return {
    drawn: nearest.slice(0, MAX_DRAWN_CONDITIONS),
    dropped: conditions.length - MAX_DRAWN_CONDITIONS,
  };
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

  const { drawn: conditions, dropped: droppedConditions } = selectConditions(
    input.conditions ?? [],
    markPrice,
  );

  // --- y-domain: candle range ∪ the levels near enough to it, padded. ------
  const anchors = collectDomainAnchors(candles, [
    ...(entryPrice === null ? [] : [entryPrice]),
    ...(stopPrice === null ? [] : [stopPrice]),
    ...(targetPrice === null ? [] : [targetPrice]),
    ...conditions.map((condition) => condition.price),
  ]);
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
      // The first post-entry point also closes the pre-entry segment. Without
      // the shared boundary the two polylines stop and start a whole bar apart
      // and the line visibly breaks at the entry.
      if (postEntryPoints.length === 0 && preEntryPoints.length > 0) {
        preEntryPoints.push(point);
      }
      postEntryPoints.push(point);
    }
  }

  // --- levels --------------------------------------------------------------
  const levels = buildLevels({
    yForPrice,
    domainMin,
    domainMax,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    conditions,
  });

  // --- mark point: pinned at the right edge of the plot. -------------------
  //
  // The mark is deliberately not a domain anchor (see `collectDomainAnchors`),
  // and it is polled far more often than the candles are — so a fast move puts
  // it outside the padded range. Clamp the dot's y into the plot rather than
  // letting it and its price tag render off-canvas; the tag still reads the
  // true price, so a pinned dot means "off the top/bottom of this frame".
  const markPoint: ChartPoint | null =
    markPrice !== null
      ? { x: PLOT_WIDTH, y: clamp(yForPrice(markPrice), 0, CHART_VIEWBOX_HEIGHT) }
      : null;

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
    gutterTags: buildGutterTags(levels, markPoint, markPrice),
    droppedConditions,
  };
}
