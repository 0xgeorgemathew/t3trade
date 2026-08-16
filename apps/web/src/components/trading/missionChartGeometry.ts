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

import {
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  exponentialMovingAverage,
} from "@t3tools/trading-contracts";

import { readFillLifecycle, type ChartFillKind, type ChartFillMarker } from "./tradingPresentation";

/**
 * ViewBox units reserved at the right edge for price tags.
 *
 * 15% of the frame rather than 12%: a tag is a price over a caption, and at
 * 12% the caption of a condition ("close above") was the thing that got
 * ellipsised away on a half-width panel — leaving the level's price with no
 * statement of what the level was.
 */
export const LABEL_GUTTER_WIDTH = 150;
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

/**
 * Minimum vertical gap between two gutter tags, in viewBox units.
 *
 * A tag is two lines — the price, and the word that says which level it is —
 * so the gap has to clear both or the caption of one tag sits under the price
 * of the next. 18 of 160 is a ninth of the plot's height, which is about two
 * lines of 10px text on the panel heights this chart is rendered at.
 */
export const GUTTER_LABEL_MIN_SEPARATION = 18;

/**
 * Below this gap the entry tag is folded into the mark tag rather than nudged
 * away from it. Two tags 3 units apart reading 1,869.25 and 1,859.43 are two
 * numbers fighting; `1,869.25 (entry 1,859.43)` is one fact.
 */
export const GUTTER_LABEL_MERGE_DISTANCE = 6;

/**
 * How far inside the frame a gutter tag's centre is held, in viewBox units.
 *
 * A tag is drawn centred on its `labelY` and is two lines tall, so a tag
 * centred on the frame edge puts half of itself outside the chart — over the
 * schedule pills below it, or the header above. Nine units is a little over
 * one line at the heights this chart renders at.
 */
export const GUTTER_LABEL_EDGE_INSET = 9;

/** How many armed condition levels the chart draws before it says "+N more". */
export const MAX_DRAWN_CONDITIONS = 3;

/**
 * How close two armed conditions have to be to become one drawn level, as a
 * fraction of the candle window's own range.
 *
 * A plan that raises its stop twice leaves three watches within a few tenths of
 * a percent of each other — 1,876.00, 1,875.90, 1,875.66 on a window whose bars
 * span twenty dollars. Drawn as three levels they are three rules the eye
 * cannot separate, three gutter tags all captioned "below", and (because the
 * tag layout holds tags apart) three labels no longer next to the rules they
 * name. At this distance they are one line on the price axis, and the chart
 * says so: the nearest price, plus how many watches sit on it.
 */
export const CONDITION_CLUSTER_RANGE_RATIO = 0.03;

/**
 * The share of the plot held empty to the right of "now", as a fraction.
 *
 * Only used when the caller passes `nowMillis` (the live panel does; the
 * post-mortem review chart does not — a closed trade has no future). Two things
 * need this space. The mark dot was pinned hard against the frame edge, where
 * a series sliding leftward is invisible because there is nothing for it to
 * slide away from. And a scheduled reassessment is a point in time *ahead* of
 * the last candle, so without a future there is nowhere on the x axis to draw
 * it.
 */
export const FUTURE_GUTTER_RATIO = 0.12;

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
  | "condition_below"
  | "pending_buy"
  | "pending_sell";

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
  /**
   * Where this level's rule stops on the x axis, in viewBox units.
   *
   * Everything up to {@link ChartGeometry.nowX} is what the level has been;
   * everything past it is a projection, drawn in the hypothetical register.
   * A named level (entry, stop, target) projects to the frame's right edge —
   * it holds until something moves it. An armed *trigger* does not: the plan
   * that armed it goes stale at its reassessment, so its projection stops
   * there, and `futureEndX === nowX` on a plan already past it. Equal to
   * `nowX` without a clock, which is what keeps the review chart's rules
   * exactly as long as they were.
   */
  readonly futureEndX: number;
  /** Whether an armed condition's predicate is already satisfied. */
  readonly met?: boolean;
  /**
   * How many armed watches this one condition level stands for.
   *
   * Above 1 the level is a cluster — see {@link CONDITION_CLUSTER_RANGE_RATIO}
   * — and its `price` is the nearest of them to the mark, the one the market
   * would reach first.
   */
  readonly count?: number;
}

/**
 * The drawn level at a given price, or null when the chart draws none there.
 *
 * This is what turns a click on an "Up next" pill into a highlight: the pill
 * carries the price, the chart carries the levels, and this is the join. The
 * pill's price and the level's price come from the same projection field but
 * travel through different arithmetic — a PnL watch is divided back into a
 * price on both paths — so they are compared with a relative tolerance rather
 * than for equality.
 *
 * Nothing is snapped to a merely *nearest* level: the strip can name a level
 * the chart's domain does not reach, and lighting up the closest rule instead
 * would point the operator at the wrong price.
 */
export function findLevelAtPrice(
  levels: ReadonlyArray<ChartLevel>,
  price: number,
): ChartLevel | null {
  const tolerance = Math.max(Math.abs(price), 1) * 1e-6;
  for (const level of levels) {
    if (Math.abs(level.price - price) <= tolerance) return level;
  }
  return null;
}

/** One armed price condition the chart draws as a level. */
export interface ChartCondition {
  readonly price: number;
  readonly direction: "above" | "below";
  readonly met: boolean;
  /** Set by clustering; how many watches this entry stands for. @see ChartLevel.count */
  readonly count?: number;
}

/** One placed fill: where on the plot the mission traded, and what it was. */
export interface ChartFillPoint {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly price: number;
  readonly kind: ChartFillKind;
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
  /** How many armed watches the tag's level stands for. @see ChartLevel.count */
  readonly count?: number;
}

/**
 * One candle, placed — the market's own texture behind the trade's shape.
 *
 * The chart drew closes only, which is a defensible line chart and not what
 * the same minute looks like on the exchange: a bar that opened at the low and
 * closed at the high reads identically to one that drifted, and the wick that
 * took a stop out is not on screen at all. `bodyTop`/`bodyBottom` are already
 * ordered for a rect, and `halfWidth` is half the bar's own pitch, so the
 * renderer needs no arithmetic of its own.
 */
export interface ChartBar {
  readonly key: number;
  /** ViewBox x of the bar's centre. */
  readonly x: number;
  /** Half the spacing between two bars, capped — see `BAR_MAX_HALF_WIDTH`. */
  readonly halfWidth: number;
  readonly highY: number;
  readonly lowY: number;
  readonly bodyTop: number;
  readonly bodyBottom: number;
  /** Close at or above open is `up`. Doji resolve to `up`, as exchanges do. */
  readonly direction: "up" | "down";
}

/**
 * One of the two moving averages the EMA-cross strategy trades, placed.
 *
 * Both are drawn whenever the window is long enough to carry them, whatever the
 * mission is doing: the cross of a fast average through a slow one is the
 * strategy's entry read, and a chart that shows the entry level without the two
 * curves that produced it is asking the operator to take the setup on faith.
 * The arithmetic is the strategy's own — `exponentialMovingAverage` from the
 * contracts package, at {@link EMA_FAST_PERIOD}/{@link EMA_SLOW_PERIOD} — so
 * the line on screen cannot drift from the line the gate reads.
 */
export interface ChartEmaLine {
  readonly speed: "fast" | "slow";
  readonly period: number;
  readonly points: ReadonlyArray<ChartPoint>;
  /** The average's newest value, in price. */
  readonly lastValue: number;
}

/**
 * Widest a candle body is drawn, in viewBox units.
 *
 * A short window (a mission two bars old) would otherwise draw two slabs
 * hundreds of units wide. The cap keeps a sparse chart reading as a sparse
 * chart rather than as a bar chart of two values.
 */
export const BAR_MAX_HALF_WIDTH = 6;

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
  /** Epoch millis mapped to {@link nowX} — `nowMillis`, or the last candle. */
  readonly timeEnd: number;
  /**
   * The x of "now": where the mark sits and the future gutter begins.
   *
   * Equal to `plotWidth` unless the caller passed `nowMillis`, which is what
   * keeps the review chart's geometry byte-identical to what it was.
   */
  readonly nowX: number;
  readonly xForTime: (t: number) => number;
  readonly yForPrice: (p: number) => number;
  /**
   * Every candle in the window, placed. Empty when no candle carries an
   * `open` — a body drawn from a guessed open is a bar that did not happen.
   */
  readonly bars: ReadonlyArray<ChartBar>;
  /** The fast and slow EMAs, or empty when the window is too short for both. */
  readonly emaLines: ReadonlyArray<ChartEmaLine>;
  /** Closes before the entry time — the flat part of the line. */
  readonly preEntryPoints: ReadonlyArray<ChartPoint>;
  /** Closes from entry time onward — the held part of the line. */
  readonly postEntryPoints: ReadonlyArray<ChartPoint>;
  /**
   * The forming bar: last close → the live mark. Two points, or empty.
   *
   * This is the only part of the chart that moves between candle closes, and
   * on a 1m series that is 59 seconds out of every 60. Without it the mark dot
   * floats unattached in the future gutter and the line just stops short of it.
   */
  readonly livePoints: ReadonlyArray<ChartPoint>;
  readonly levels: ReadonlyArray<ChartLevel>;
  /**
   * Every fill that falls inside the drawn window, placed on the axis.
   *
   * The chart's record of the session's activity: each open and each close the
   * mission has made, at the price and moment it happened. Fills older than the
   * first candle are dropped rather than pinned to the left edge — a marker at
   * a time it did not happen is worse than no marker.
   */
  readonly fillPoints: ReadonlyArray<ChartFillPoint>;
  /** Pinned at {@link nowX}; null when markPrice is null. */
  readonly markPoint: ChartPoint | null;
  /** Every right-gutter price tag, already resolved against collisions. */
  readonly gutterTags: ReadonlyArray<GutterTag>;
  /** Scheduled future events, placed on the x axis in the future gutter. */
  readonly timeMarkers: ReadonlyArray<ChartTimeMarker>;
  /** Events that already happened, placed inside the drawn window. */
  readonly pastMarkers: ReadonlyArray<ChartPastMarker>;
  /** Armed conditions the chart did not draw, so the panel can say how many. */
  readonly droppedConditions: number;
}

/** A future moment the plan is committed to, drawn as a vertical rule. */
export interface ChartTimeMarker {
  readonly key: string;
  readonly label: string;
  /** Epoch millis the marker sits at. */
  readonly at: number;
  /** ViewBox x, clamped into the future gutter. */
  readonly x: number;
  /** True when the moment has passed but the event has not fired yet. */
  readonly overdue: boolean;
  /**
   * Who put this moment on the axis: the runtime's staleness floor (`auto`) or
   * the plan itself. Carried through untouched — the geometry has no opinion on
   * it, the renderer draws the two differently. Defaults to `planned` so a
   * caller that does not distinguish them gets the pre-existing treatment.
   */
  readonly tone: ChartTimeMarkerTone;
}

/** @see ChartTimeMarker.tone */
export type ChartTimeMarkerTone = "auto" | "planned";

/** How many past ticks the axis holds before it stops drawing them. */
export const MAX_DRAWN_PAST_MARKERS = 20;

/**
 * Something that already happened, placed on the time axis — plan 24 §4.2.
 *
 * The mirror of {@link ChartTimeMarker}: that one stands in the future gutter
 * for a moment the plan is committed to, this one stands in the drawn window
 * for a moment that has been. A wake, a publish, a stop move — the chart is
 * then a record of the mission's turns and not only of its price.
 */
export interface ChartPastMarker {
  readonly key: string;
  readonly kind: string;
  /** Epoch millis the event happened at. */
  readonly at: number;
  /** ViewBox x, inside the drawn window. */
  readonly x: number;
  /** A wake's cause, for colour-coding by trigger class. */
  readonly cause?: string;
  /** True when the run this marker stands for did not complete. */
  readonly failed?: boolean;
}

/** Input shape for {@link computeChartGeometry}. */
export interface ComputeChartGeometryInput {
  // `open` is optional so a series that carries only closes still draws its
  // line; the candle bodies are simply left out of `bars` for those.
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
  /**
   * The mission's fills, drawn as markers on the axis.
   *
   * This is how a closed position stays on the chart: its open and its close are
   * two points in the series, and they remain there after the position itself is
   * gone. Only the ones inside the drawn window survive `computeChartGeometry`.
   */
  readonly fills?: ReadonlyArray<ChartFillMarker>;
  /**
   * An order the agent has committed to but the book has not filled — the
   * "I will enter long at X" the plan just announced, as a level rather than as
   * a sentence somewhere else on the screen.
   */
  readonly pendingOrder?: { readonly price: number; readonly side: "buy" | "sell" } | null;
  /**
   * Wall-clock now, in epoch millis. Turns the x axis into a clock.
   *
   * Omitted, the axis ends at the last candle's openTime — which means the
   * chart only moves when a bar closes, so a 1m series is frozen for 59 seconds
   * at a time and the mark dot sits on top of the final candle. Supplied, the
   * axis ends at `now`, the series slides continuously, and the space between
   * the last close and the mark is the bar currently forming.
   *
   * The review chart must NOT pass this: its window is closed, and its "mark"
   * is an exit that happened, not a price that is moving.
   */
  readonly nowMillis?: number;
  /**
   * When the armed entry triggers stop being the plan the mission is running,
   * in epoch millis — the plan's own `reassess` horizon.
   *
   * The trigger rules are projected into the future gutter only this far. A
   * level drawn all the way to the frame edge claims the mission will still be
   * watching it then, and an untriggered plan stops being the plan at its
   * reassessment. Omitted (or without `nowMillis`), triggers project like every
   * other level.
   */
  readonly triggerExpiryAt?: number;
  /** Future moments to mark on the axis. Ignored without `nowMillis`. */
  readonly timeMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly at: number;
    readonly tone?: ChartTimeMarkerTone;
  }>;
  /**
   * Moments that have already happened, newest-first as the projection sends
   * them. Placed inside the drawn window; anything older than the first candle
   * is dropped rather than pinned to the left edge, for the same reason an old
   * fill is.
   */
  readonly pastMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly at: number;
    readonly cause?: string | undefined;
    readonly failed?: boolean | undefined;
  }>;
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

/**
 * The tail of a fetched series to draw, widened to keep a moment in frame.
 *
 * The live chart draws fewer bars than it fetches, for resolution. That crops
 * history, and history is where the session's earlier fills are — an entry from
 * ninety minutes ago would fall off a sixty-bar window and take its marker with
 * it, which is precisely the record the markers exist to keep. So the window
 * starts at `VISIBLE_BARS` and widens, up to everything fetched, until the
 * earliest moment that must stay visible is inside it.
 *
 * `earliestNeeded` of null (no fills yet) leaves the plain tail.
 */
export function selectVisibleCandles<T extends { readonly openTime: number }>(
  candles: ReadonlyArray<T>,
  visibleBars: number,
  earliestNeeded: number | null,
): ReadonlyArray<T> {
  const tailStart = Math.max(0, candles.length - visibleBars);
  if (earliestNeeded === null) return candles.slice(tailStart);

  // The bar the moment falls in, minus one for a little approach context.
  let index = candles.findIndex((candle) => candle.openTime >= earliestNeeded);
  if (index < 0) index = candles.length - 1;
  const wanted = Math.max(0, index - 1);

  return candles.slice(Math.min(tailStart, wanted));
}

/**
 * The series' own bar interval, as the median gap between consecutive opens.
 *
 * The median rather than the mean, and rather than the first gap: a feed with
 * one missing bar has a gap of two intervals in it, and either of the other two
 * readings would take that hole for the pitch of the whole series. Falls back
 * to one minute when there is nothing to measure — the interval every mission
 * defaults to.
 */
export function medianBarInterval(candles: ReadonlyArray<{ readonly openTime: number }>): number {
  const gaps: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const gap = candles[index]!.openTime - candles[index - 1]!.openTime;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 60_000;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)]!;
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
 * The smallest share of the plot's height the candles are allowed to occupy.
 *
 * `DOMAIN_LEVEL_REACH_RATIO` bounds each level individually, which is not the
 * same as bounding what they do together: a stop above the window and a target
 * below it can each be "within reach" and still, between them, flatten an hour
 * of price action into a band a few pixels tall — which is the chart that
 * reads as broken. This is the floor that stops it. A level that would push
 * the candles below it is dropped from the domain and pinned at the frame edge
 * with a chevron, the same idiom a far target already gets.
 */
export const MIN_CANDLE_DOMAIN_SHARE = 0.45;

/**
 * The levels near enough to the price action to anchor the domain.
 *
 * Liquidation is never an anchor (at 20x it is always far), and neither is the
 * mark (it is polled far more often than the candles). Everything else joins
 * only while it sits within `DOMAIN_LEVEL_REACH_RATIO` candle-ranges of the
 * window's midpoint AND leaves the candles at least
 * {@link MIN_CANDLE_DOMAIN_SHARE} of the resulting domain. Nearest first, so
 * the levels closest to the price action are the ones that keep their place.
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

  let min = bounds.min;
  let max = bounds.max;
  const nearestFirst = [...candidates].sort(
    (left, right) => Math.abs(left - mid) - Math.abs(right - mid),
  );
  for (const price of nearestFirst) {
    if (Math.abs(price - mid) > reach) continue;
    const nextMin = Math.min(min, price);
    const nextMax = Math.max(max, price);
    const span = nextMax - nextMin;
    if (span > 0 && range / span < MIN_CANDLE_DOMAIN_SHARE) continue;
    min = nextMin;
    max = nextMax;
    anchors.push(price);
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
  // apart, backward pulls everything above the bottom edge back in. Both stop
  // an inset short of the frame rather than at it: a tag is centred on its
  // `labelY` and is two lines tall, so one placed exactly on the bottom edge
  // hung its caption over whatever the panel drew underneath the chart — which
  // is where the schedule pills sit.
  const top = GUTTER_LABEL_EDGE_INSET;
  const bottom = CHART_VIEWBOX_HEIGHT - GUTTER_LABEL_EDGE_INSET;
  for (const tag of placed) {
    tag.labelY = clamp(tag.labelY, top, bottom);
  }
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1]!;
    const current = placed[i]!;
    current.labelY = Math.max(current.labelY, previous.labelY + GUTTER_LABEL_MIN_SEPARATION);
  }
  // The forward sweep can push the bottom tag past the edge, and the backward
  // sweep below starts at the second-to-last — so the last one has to be
  // pulled in first or it is the one tag nothing ever bounds.
  const last = placed[placed.length - 1];
  if (last !== undefined) last.labelY = Math.min(last.labelY, bottom);
  for (let i = placed.length - 2; i >= 0; i -= 1) {
    const next = placed[i + 1]!;
    const current = placed[i]!;
    current.labelY = Math.min(
      current.labelY,
      Math.min(next.labelY - GUTTER_LABEL_MIN_SEPARATION, bottom),
    );
  }
  // The backward sweep can only pull upward, so the last clamp is the one that
  // guarantees the top edge as well.
  for (const tag of placed) {
    tag.labelY = Math.max(tag.labelY, top);
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
  // A pending order outranks the conditions: it is the one level something is
  // already committed to, rather than a level that would cause a decision.
  pending_buy: 4,
  pending_sell: 4,
  liquidation: 5,
  condition_above: 6,
  condition_below: 6,
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
    readonly count?: number;
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
      ...(level.count === undefined ? {} : { count: level.count }),
      priority: GUTTER_PRIORITY[level.kind],
    });
  });

  return layoutGutterLabels(candidates).map(({ priority: _priority, ...tag }) => tag);
}

/**
 * Place one exponential moving average across the window.
 *
 * Returns null below two points: a one-point average is a dot, and the pair is
 * only meaningful drawn together, so the caller drops both when either is
 * missing. The series starts `period - 1` bars in (that is where the seed
 * average completes), so it is aligned to the tail of the candle array.
 */
function buildEmaLine(input: {
  readonly candles: ReadonlyArray<{ readonly openTime: number; readonly close: number }>;
  readonly period: number;
  readonly speed: "fast" | "slow";
  readonly xForTime: (t: number) => number;
  readonly yForPrice: (p: number) => number;
}): ChartEmaLine | null {
  const series = exponentialMovingAverage(
    input.candles.map((candle) => candle.close),
    input.period,
  );
  if (series.length < 2) return null;

  const offset = input.candles.length - series.length;
  const points = series.map((value, index) => ({
    x: input.xForTime(input.candles[offset + index]!.openTime),
    y: input.yForPrice(value),
  }));
  return {
    speed: input.speed,
    period: input.period,
    points,
    lastValue: series[series.length - 1]!,
  };
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
  readonly pendingOrder: { readonly price: number; readonly side: "buy" | "sell" } | null;
  /** Where a named level's projection ends — the frame's right edge. */
  readonly levelEndX: number;
  /** Where an armed trigger's projection ends. @see ChartLevel.futureEndX */
  readonly triggerEndX: number;
}): ChartLevel[] {
  const levels: ChartLevel[] = [];

  const pushLevel = (kind: ChartLevelKind, price: number, met?: boolean, count?: number): void => {
    const offScale: "above" | "below" | null =
      price > input.domainMax ? "above" : price < input.domainMin ? "below" : null;
    const isTrigger = kind === "condition_above" || kind === "condition_below";
    levels.push({
      kind,
      price,
      futureEndX: isTrigger ? input.triggerEndX : input.levelEndX,
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
      ...(count === undefined || count <= 1 ? {} : { count }),
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

  // An armed condition sitting on a level the chart has already named is that
  // level, not a second one. A profit-target watch resolves to exactly the
  // target price and a stop-proximity watch to the stop, so drawing both put
  // two rules and two identical gutter tags at one price — "1,858.43 target"
  // with "1,858.43 below" written across it. The named level wins: it says
  // what the price IS, which is the more useful of the two statements.
  const named = levels.map((level) => level.price);
  const alreadyNamed = (price: number): boolean =>
    named.some((existing) => Math.abs(existing - price) <= Math.max(Math.abs(price), 1) * 1e-6);

  for (const condition of input.conditions) {
    if (alreadyNamed(condition.price)) continue;
    pushLevel(
      condition.direction === "above" ? "condition_above" : "condition_below",
      condition.price,
      condition.met,
      condition.count,
    );
  }

  if (input.pendingOrder !== null) {
    pushLevel(
      input.pendingOrder.side === "buy" ? "pending_buy" : "pending_sell",
      input.pendingOrder.price,
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
function selectConditions(input: {
  readonly conditions: ReadonlyArray<ChartCondition>;
  readonly markPrice: number | null;
  readonly candleRange: number;
}): { readonly drawn: ReadonlyArray<ChartCondition>; readonly dropped: number } {
  const reference = input.markPrice ?? input.conditions[0]?.price ?? 0;
  const unique = clusterConditions(
    dedupeConditions(input.conditions),
    input.candleRange * CONDITION_CLUSTER_RANGE_RATIO,
    reference,
  );
  if (unique.length <= MAX_DRAWN_CONDITIONS) return { drawn: unique, dropped: 0 };
  const nearest = [...unique].sort(
    (a, b) => Math.abs(a.price - reference) - Math.abs(b.price - reference),
  );
  // A dropped cluster takes every watch in it with it, so the count the panel
  // reports is watches, not levels.
  const dropped = nearest
    .slice(MAX_DRAWN_CONDITIONS)
    .reduce((total, condition) => total + (condition.count ?? 1), 0);
  return { drawn: nearest.slice(0, MAX_DRAWN_CONDITIONS), dropped };
}

/**
 * Fold conditions closer together than `tolerance` into one drawn level.
 *
 * Clusters only within a direction: an "above" and a "below" watch at the same
 * price are two opposite statements about it, and merging them would lose the
 * one thing the level says. The representative is the member nearest
 * `reference` (the mark) — the price the market reaches first, which is the one
 * worth reading off the axis — and `met` is the OR, as it is in
 * {@link dedupeConditions}.
 */
export function clusterConditions(
  conditions: ReadonlyArray<ChartCondition>,
  tolerance: number,
  reference: number,
): ReadonlyArray<ChartCondition> {
  if (tolerance <= 0) return conditions;

  const clusters: Array<{ direction: "above" | "below"; members: ChartCondition[] }> = [];
  for (const condition of [...conditions].sort((a, b) => a.price - b.price)) {
    const open = clusters[clusters.length - 1];
    const joins =
      open !== undefined &&
      open.direction === condition.direction &&
      condition.price - open.members[open.members.length - 1]!.price <= tolerance;
    if (joins) {
      open.members.push(condition);
    } else {
      clusters.push({ direction: condition.direction, members: [condition] });
    }
  }

  return clusters.map((cluster) => {
    const nearest = cluster.members.reduce((best, member) =>
      Math.abs(member.price - reference) < Math.abs(best.price - reference) ? member : best,
    );
    return {
      price: nearest.price,
      direction: cluster.direction,
      met: cluster.members.some((member) => member.met),
      count: cluster.members.reduce((total, member) => total + (member.count ?? 1), 0),
    };
  });
}

/**
 * One rule per price and direction, however many watches point at it.
 *
 * A plan that arms both a `price_cross` and a `candle_close` at the same level
 * — which the doctrine asks for at a trigger it wants confirmed — produced two
 * identical rules and two identical gutter tags stacked on top of each other,
 * reading as two levels when the mission is watching one. The checklist below
 * the chart still lists both, because there the difference between a touch and
 * a close is the point; on a price axis it has no y of its own.
 *
 * `met` is the OR: if any watch at the price has fired, the level has been
 * reached.
 */
export function dedupeConditions(
  conditions: ReadonlyArray<ChartCondition>,
): ReadonlyArray<ChartCondition> {
  const byLevel = new Map<string, ChartCondition>();
  for (const condition of conditions) {
    const key = `${condition.direction}:${condition.price}`;
    const existing = byLevel.get(key);
    if (existing === undefined) {
      byLevel.set(key, condition);
      continue;
    }
    if (condition.met && !existing.met) byLevel.set(key, condition);
  }
  return [...byLevel.values()];
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

  const bounds = candleBounds(candles);
  const { drawn: conditions, dropped: droppedConditions } = selectConditions({
    conditions: input.conditions ?? [],
    markPrice,
    candleRange: bounds.max - bounds.min,
  });

  // --- y-domain: candle range ∪ the levels near enough to it, padded. ------
  const pendingOrder = input.pendingOrder ?? null;
  const anchors = collectDomainAnchors(candles, [
    ...(entryPrice === null ? [] : [entryPrice]),
    ...(stopPrice === null ? [] : [stopPrice]),
    ...(targetPrice === null ? [] : [targetPrice]),
    ...conditions.map((condition) => condition.price),
    // A resting order sits at a price the market is expected to reach, so it is
    // an anchor on the same terms as the levels above it.
    ...(pendingOrder === null ? [] : [pendingOrder.price]),
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

  // --- x-domain: first candle openTime .. now (or the last candle). --------
  //
  // `nowX` is where the axis's end lands. With a clock it stops short of the
  // plot's right edge, leaving the future gutter empty; without one it is the
  // right edge, which is the behaviour the review chart depends on.
  const timeStart = candles[0]!.openTime;
  const lastCandleTime = candles[candles.length - 1]!.openTime;
  const hasClock = input.nowMillis !== undefined;
  // A clock behind the last bar would run the axis backwards. Trust the data
  // over the browser's clock when they disagree.
  const timeEnd = hasClock ? Math.max(input.nowMillis!, lastCandleTime) : lastCandleTime;
  const nowX = hasClock ? PLOT_WIDTH * (1 - FUTURE_GUTTER_RATIO) : PLOT_WIDTH;

  // The axis scale, in viewBox units per millisecond.
  //
  // With a clock it is a CONSTANT — the window is a fixed number of bar
  // intervals wide, anchored at `now` — and that is the whole fix for a series
  // that "moved oddly" while the price ticked. Fitting `timeStart..now` to the
  // plot instead made the span grow with every passing second and shrink again
  // the moment a bar closed, so between two candles the whole series crept
  // rightward and squashed by ~1.7%, then snapped back. Nothing in the data
  // moved; the ruler did. Held constant, every bar slides left at one steady
  // rate, the pitch never changes, and a new candle arriving is not an event
  // the geometry can see.
  //
  // Without a clock (the review chart) the old fit-to-window mapping is kept
  // exactly: that window is closed, so it has nothing to slide.
  const barIntervalMillis = medianBarInterval(candles);
  const visibleSpan = hasClock ? barIntervalMillis * candles.length : timeEnd - timeStart;
  const pixelsPerMilli = visibleSpan > 0 ? nowX / visibleSpan : 0;

  const xForTime = (t: number): number => nowX - (timeEnd - t) * pixelsPerMilli;

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

  // --- candles: the market's own texture, under everything else. -----------
  //
  // Drawn from the bars' own pitch rather than from the interval, so a feed
  // with a gap in it does not stretch one body across the hole. A candle
  // without an `open` is skipped rather than bodied from the previous close:
  // the fallback is a convention, and a chart that invents one is no longer
  // the same picture as the exchange's.
  // One interval's worth of the axis, not the window divided by the bar count:
  // with a constant scale the two are the same on an even series, and on one
  // with a hole in it only this reading keeps every body the same width.
  const barPitch = barIntervalMillis * pixelsPerMilli;
  const halfWidth = Math.max(0.5, Math.min(BAR_MAX_HALF_WIDTH, (barPitch * 0.72) / 2));
  const bars: ChartBar[] = [];
  for (const candle of candles) {
    if (candle.open === undefined) continue;
    // A bar that has slid off the left edge is dropped rather than drawn
    // half-outside the frame.
    if (xForTime(candle.openTime) < -halfWidth) continue;
    const openY = yForPrice(candle.open);
    const closeY = yForPrice(candle.close);
    bars.push({
      key: candle.openTime,
      x: xForTime(candle.openTime),
      halfWidth,
      highY: yForPrice(candle.high),
      lowY: yForPrice(candle.low),
      bodyTop: Math.min(openY, closeY),
      bodyBottom: Math.max(openY, closeY),
      direction: candle.close >= candle.open ? "up" : "down",
    });
  }

  // --- the two moving averages: the EMA strategy's own read. ---------------
  // Both or neither — a fast average alone says nothing about a cross.
  const emaFast = buildEmaLine({
    candles,
    period: EMA_FAST_PERIOD,
    speed: "fast",
    xForTime,
    yForPrice,
  });
  const emaSlow = buildEmaLine({
    candles,
    period: EMA_SLOW_PERIOD,
    speed: "slow",
    xForTime,
    yForPrice,
  });
  const emaLines: ReadonlyArray<ChartEmaLine> =
    emaFast === null || emaSlow === null ? [] : [emaSlow, emaFast];

  // --- levels --------------------------------------------------------------
  //
  // Without a clock there is no future gutter to project into, so every rule
  // ends at `nowX` — which is the plot's right edge, exactly where the review
  // chart has always drawn them.
  const levelEndX = hasClock ? PLOT_WIDTH : nowX;
  const triggerEndX =
    hasClock && input.triggerExpiryAt !== undefined
      ? clamp(xForTime(input.triggerExpiryAt), nowX, PLOT_WIDTH)
      : levelEndX;
  const levels = buildLevels({
    yForPrice,
    domainMin,
    domainMax,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    conditions,
    pendingOrder,
    levelEndX,
    triggerEndX,
  });

  // --- fills: the session's activity, placed on the axis. ------------------
  // A fill before the window's first candle has no honest x, so it is dropped;
  // one after `timeEnd` (a fill landing between the mission poll and the clock
  // tick) is pinned at now. The y is clamped for the same reason the mark's is.
  const fillPoints: ChartFillPoint[] = [];
  for (const fill of input.fills ?? []) {
    if (fill.at < timeStart) continue;
    fillPoints.push({
      key: fill.key,
      x: clamp(xForTime(fill.at), 0, nowX),
      y: clamp(yForPrice(fill.price), 0, CHART_VIEWBOX_HEIGHT),
      price: fill.price,
      kind: fill.kind,
    });
  }

  // --- mark point: pinned at the right edge of the plot. -------------------
  //
  // The mark is deliberately not a domain anchor (see `collectDomainAnchors`),
  // and it is polled far more often than the candles are — so a fast move puts
  // it outside the padded range. Clamp the dot's y into the plot rather than
  // letting it and its price tag render off-canvas; the tag still reads the
  // true price, so a pinned dot means "off the top/bottom of this frame".
  const markPoint: ChartPoint | null =
    markPrice !== null
      ? { x: nowX, y: clamp(yForPrice(markPrice), 0, CHART_VIEWBOX_HEIGHT) }
      : null;

  // --- the forming bar: last close → the mark. -----------------------------
  // Only with a clock: without one the mark sits exactly on the last candle
  // and this segment would have zero length.
  const lastPoint =
    postEntryPoints[postEntryPoints.length - 1] ??
    preEntryPoints[preEntryPoints.length - 1] ??
    null;
  const livePoints: ReadonlyArray<ChartPoint> =
    hasClock && markPoint !== null && lastPoint !== null ? [lastPoint, markPoint] : [];

  // --- future markers, placed in the gutter to the right of now. -----------
  const timeMarkers: ChartTimeMarker[] = hasClock
    ? (input.timeMarkers ?? []).map((marker) => ({
        key: marker.key,
        label: marker.label,
        at: marker.at,
        // Clamped to the plot's right edge: a reassessment further out than
        // the gutter reaches still belongs on screen, pinned at the far edge,
        // rather than drawn off-canvas or silently dropped.
        x: clamp(xForTime(marker.at), nowX, PLOT_WIDTH),
        overdue: marker.at <= timeEnd,
        tone: marker.tone ?? "planned",
      }))
    : [];

  // --- past markers: the mission's own turns, on the same axis. ------------
  // Only the ones inside the drawn window: an event before the first candle has
  // no honest x, and the cap keeps a mission that woke two hundred times from
  // fencing its own price line in. Newest-first in, so the cap drops the oldest.
  const pastMarkers: ChartPastMarker[] = [];
  for (const marker of input.pastMarkers ?? []) {
    if (pastMarkers.length >= MAX_DRAWN_PAST_MARKERS) break;
    if (marker.at < timeStart || marker.at > timeEnd) continue;
    pastMarkers.push({
      key: marker.key,
      kind: marker.kind,
      at: marker.at,
      x: clamp(xForTime(marker.at), 0, nowX),
      ...(marker.cause === undefined ? {} : { cause: marker.cause }),
      ...(marker.failed === undefined ? {} : { failed: marker.failed }),
    });
  }

  return {
    viewBoxWidth: CHART_VIEWBOX_WIDTH,
    viewBoxHeight: CHART_VIEWBOX_HEIGHT,
    plotWidth: PLOT_WIDTH,
    labelGutterWidth: LABEL_GUTTER_WIDTH,
    domainMin,
    domainMax,
    timeStart,
    timeEnd,
    nowX,
    xForTime,
    yForPrice,
    bars,
    emaLines,
    preEntryPoints,
    postEntryPoints,
    livePoints,
    levels,
    fillPoints,
    markPoint,
    gutterTags: buildGutterTags(levels, markPoint, markPrice),
    timeMarkers,
    pastMarkers,
    droppedConditions,
  };
}
