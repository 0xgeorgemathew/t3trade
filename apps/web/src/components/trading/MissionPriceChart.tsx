// ---------------------------------------------------------------------------
// MissionPriceChart
// ---------------------------------------------------------------------------
//
// The pure-props SVG renderer for one mission's price line. No state, no
// effects, no data fetching — it draws exactly what its props say, derived
// through `computeChartGeometry`.
//
// Visual idea: the shape of the trade you are in is the only saturated thing
// on screen. The pre-entry line is muted, the levels are thin/dashed, and the
// post-entry segment + its fill carry the profit/loss colour. The mark dot is
// the one moving thing, and it pulses on opacity (GPU-cheap, no layout).
//
// That idea is why the level rules are drawn at a fraction of their colour and
// their gutter tags at near full: a rule spans the whole plot, so a stop drawn
// in solid loss-red was the loudest thing on a chart whose subject is the price.
// The rule says where; the tag says what.
//
// Everything the mission has done or committed to is here, so the chart is the
// activity log and not just a price: the fills as circles (filled for an open,
// hollow for a close, tinted by what the close realised), a resting order as a
// dotted level, the armed conditions as dashed ones, and a scheduled
// reassessment as a rule standing in the future gutter.
//
// The plot stretches (`preserveAspectRatio="none"`), which is right for a price
// line and wrong for text — glyphs stretched with the container width was the
// "distorted labels" complaint. So the gutter is HTML positioned over the SVG
// rather than `<text>` inside it: undistorted at any width, and it gets
// ellipsis and wrapping for free.

import { useEffect, useId, useRef, useState } from "react";

import type { TradingChartCandle } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import {
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  FUTURE_GUTTER_RATIO,
  LABEL_GUTTER_WIDTH,
  PLOT_WIDTH,
  computeChartGeometry,
  findLevelAtPrice,
  medianBarInterval,
  type ChartCondition,
  type ChartLevelKind,
  type ChartPoint,
  type GutterTag,
} from "./missionChartGeometry";
import { formatPrice, type ChartFillKind, type ChartFillMarker } from "./tradingPresentation";

interface MissionPriceChartProps {
  readonly candles: ReadonlyArray<TradingChartCandle>;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  /** Epoch millis; splits the line into pre/post segments. */
  readonly entryTime: number | null;
  readonly markPrice: number | null;
  /** Colours the post-entry segment + fill. Null while flat (no position). */
  readonly pnlSign: "profit" | "loss" | null;
  /**
   * Whether the mark dot pulses. `live` is the default — the dot is the one
   * moving thing on a running chart. `static` is the review chart, where the
   * dot is the exit marker of a trade that is over and nothing is moving.
   */
  readonly markMotion?: "live" | "static";
  /**
   * Armed price conditions to draw while the mission is flat. These are what a
   * waiting mission is waiting for; without them the pre-position chart shows
   * a price line and no reason to be looking at it.
   */
  readonly conditions?: ReadonlyArray<ChartCondition>;
  /**
   * Every fill the mission has made, drawn as a circle on the axis.
   *
   * This is what keeps a session's earlier positions on screen after they are
   * closed: the position row is gone, but the two circles that were its open
   * and its close stay where they happened.
   */
  readonly fills?: ReadonlyArray<ChartFillMarker>;
  /** A committed-but-unfilled order, drawn as a dotted level at its limit. */
  readonly pendingOrder?: { readonly price: number; readonly side: "buy" | "sell" } | null;
  /**
   * Wall-clock now. Passing it turns the x axis into a clock: the series slides
   * continuously instead of stepping once per bar, the mark moves off the frame
   * edge into a reserved future gutter, and the space between the last close
   * and the mark becomes the forming bar.
   *
   * The review chart leaves this out — its window is closed and its mark is an
   * exit that already happened.
   */
  readonly nowMillis?: number;
  /**
   * When the armed entry triggers stop being the plan the mission is running,
   * in epoch millis. Bounds how far their rules are projected into the future
   * gutter. Ignored without `nowMillis`.
   */
  readonly triggerExpiryAt?: number;
  /**
   * A level to call attention to, set by clicking its pill in the "Up next"
   * strip. The `nonce` is what makes a second click on the same pill flash
   * again: the overlay is keyed by it, so React remounts the element and the
   * CSS animation restarts. A price with no drawn level flashes nothing —
   * the strip may name a level the chart's domain does not reach, and an
   * invented rule there would be a lie about where it sits.
   */
  readonly flash?: { readonly price: number; readonly nonce: number } | null;
  /**
   * The plan's best current estimate of where price is headed: a dotted path
   * from the live mark to `{price}` at `{atMillis}`, drawn in the future
   * gutter's hypothetical register. Where the model thinks the market goes —
   * the armed conditions around it are what it does about being wrong.
   */
  readonly projection?: { readonly price: number; readonly atMillis: number } | null;
  /** Future moments to stand in the gutter. Ignored without `nowMillis`. */
  readonly timeMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly at: number;
    readonly tone?: "auto" | "planned";
  }>;
  /** Moments that already happened, newest first. Ignored without `nowMillis`. */
  readonly pastMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly at: number;
    readonly cause?: string | undefined;
    readonly failed?: boolean | undefined;
  }>;
  /**
   * Which levels the operator may drag, and what to do when they let go.
   *
   * A drag is a `plan()` revision — the same eight authored fields the model
   * publishes, with one leaf replaced — so the chart's job here is narrow: turn
   * a pointer into a price and hand it over. It holds no plan of its own and
   * decides nothing about whether the revision is allowed.
   */
  readonly draggableKinds?: ReadonlyArray<ChartLevelKind>;
  readonly onLevelDragEnd?: (kind: ChartLevelKind, price: number) => void;
  /**
   * A level the exchange refused to move, drawn twice.
   *
   * The rule stays where the stop actually rests, and the price the plan now
   * states is drawn in the hypothetical register the future gutter uses — which
   * is exactly what that register is for: a claim about a level, not a record
   * of one. Without this the panel would draw the dragged price as fact while
   * the position sat behind a different stop.
   */
  readonly refusedLevel?: {
    readonly kind: ChartLevelKind;
    readonly planPrice: number;
    readonly detail: string;
  } | null;
  /**
   * Signed position size, used only for the live risk readout under the
   * pointer while a stop is being dragged. Null while flat — there is no
   * planned loss without a position, and inventing one would be a number the
   * operator could act on.
   */
  readonly positionSize?: number | null;
  readonly className?: string;
}

/** How tall a past-event tick stands off the bottom edge, in viewBox units. */
const PAST_MARKER_TICK_HEIGHT = 6;

// The hypothetical register — how anything drawn to the right of `now` is
// distinguished from the record to its left. Thinner than the rule it
// continues, dashed whatever the rule's own pattern was (a solid entry line
// running into the gutter claims the entry is a fact out there too), and at
// three quarters strength. All three together, because any one alone reads as a
// different level rather than as the same level projected.
const HYPOTHETICAL_STROKE_WIDTH = 0.75;
const HYPOTHETICAL_DASH_ARRAY = "2 5";
const HYPOTHETICAL_OPACITY = 0.75;

/**
 * The colour of a past-event tick, by what the event was — plan 24 §4.1.
 *
 * The reading the rug is for is the *mix*: a run of muted ticks is the
 * staleness floor waking a mission that had nothing to decide, an amber one is
 * a level the market actually reached. A failed run is drawn in loss-red
 * because it is a turn the mission was owed and did not get.
 */
function pastMarkerColor(marker: {
  readonly kind: string;
  readonly cause?: string | undefined;
  readonly failed?: boolean | undefined;
}): string {
  if (marker.failed === true) return "var(--color-loss)";
  if (marker.kind === "stop_adjusted") return "var(--color-loss)";
  if (marker.kind === "strategy_published") return "var(--color-foreground)";
  // A note is the model talking, not the market moving. Drawing it in the
  // amber a triggered wake uses would put a level on the rug that never
  // existed.
  if (marker.kind === "journal") return "var(--color-muted-foreground)";
  // A wake the market caused is the one worth seeing; a scheduled one is the
  // backstop, and the rug should read as quieter where the clock did the work.
  return marker.cause === "scheduled_reassessment"
    ? "var(--color-muted-foreground)"
    : "var(--color-armed)";
}

/**
 * The base colour of a level, before the rule/ink split below.
 *
 * `armed` is the chrome's "committed but not yet happened" amber, and both the
 * conditions and a resting order are exactly that.
 */
function levelBaseColor(kind: ChartLevelKind | "mark"): string {
  switch (kind) {
    case "entry":
    case "mark":
      return "var(--color-foreground)";
    case "stop":
      return "var(--color-loss)";
    case "target":
      return "var(--color-profit)";
    case "liquidation":
      return "var(--color-destructive)";
    case "condition_above":
    case "condition_below":
    case "pending_buy":
    case "pending_sell":
      return "var(--color-armed)";
  }
}

/**
 * How strongly each level's *rule* is drawn, as a percentage of its colour.
 *
 * A rule spans the whole plot, so at full saturation it competes with the price
 * line for the eye — a stop drawn in solid loss-red was the loudest thing on a
 * chart whose subject is the price. These are deliberately low: the rule says
 * where, the gutter tag (drawn at `INK_MIX`) says what.
 */
const RULE_MIX: Record<ChartLevelKind, number> = {
  entry: 34,
  stop: 28,
  target: 34,
  liquidation: 30,
  // Quieter than the named levels: a condition is a price nothing has happened
  // at yet, and there can be three of them.
  condition_above: 22,
  condition_below: 22,
  // A resting order is about to become a position; it earns a little more.
  pending_buy: 45,
  pending_sell: 45,
};

/** Gutter tags are text and must stay legible, so they are near full strength. */
const INK_MIX = 85;

/** The stroke a level's horizontal rule is drawn with. */
function levelRuleColor(kind: ChartLevelKind): string {
  return `color-mix(in oklab, ${levelBaseColor(kind)} ${RULE_MIX[kind]}%, transparent)`;
}

/** The colour a level's gutter tag is written in. */
function levelInkColor(kind: ChartLevelKind | "mark"): string {
  if (kind === "mark") return "var(--color-foreground)";
  return `color-mix(in oklab, ${levelBaseColor(kind)} ${INK_MIX}%, transparent)`;
}

/** The dash pattern that tells one level kind from another at a glance. */
function levelDashArray(kind: ChartLevelKind): string | undefined {
  switch (kind) {
    case "entry":
      // The reference every other figure is measured from: the one solid rule.
      return undefined;
    case "pending_buy":
    case "pending_sell":
      // Dotted: nothing has happened at this price yet.
      return "1 4";
    case "condition_above":
    case "condition_below":
      return "2 4";
    default:
      return "5 4";
  }
}

/** The glyph that opens a gutter tag, or an empty string when it carries none. */
function tagGlyph(tag: GutterTag): string {
  if (tag.kind === "condition_above") return tag.met === true ? "✓ ▲" : "○ ▲";
  if (tag.kind === "condition_below") return tag.met === true ? "✓ ▼" : "○ ▼";
  if (tag.kind === "pending_buy") return "▲";
  if (tag.kind === "pending_sell") return "▼";
  return "";
}

/** The short word that says which price a tag is, under the number. */
function tagCaption(tag: GutterTag): string {
  switch (tag.kind) {
    case "mark":
      return tag.mergedPrice === undefined ? "" : `entry ${formatPrice(tag.mergedPrice)}`;
    case "entry":
      return "entry";
    case "stop":
      return "stop";
    case "target":
      return "target";
    case "liquidation":
      return "liq";
    // Not "close above": a condition here is a `price_cross` as often as a
    // `candle_close` and the geometry does not carry which, so the caption
    // said "close" about levels that fire on a touch. The direction is the
    // part that is always true — and at five characters it is the part that
    // still fits in the gutter on a half-width panel.
    case "condition_above":
      return "above";
    case "condition_below":
      return "below";
    case "pending_buy":
      return "buying";
    case "pending_sell":
      return "selling";
  }
}

/** The circle that marks one fill: filled for an open, hollow for a close. */
function fillMarkerStyle(kind: ChartFillKind): {
  readonly color: string;
  readonly filled: boolean;
} {
  switch (kind) {
    case "open":
      // An open is where the exposure came from — the same ink as the entry
      // rule it created, and solid, because it is a thing that has happened.
      return { color: "var(--color-foreground)", filled: true };
    case "close_profit":
      return { color: "var(--color-profit)", filled: false };
    case "close_loss":
      return { color: "var(--color-loss)", filled: false };
    case "close_flat":
    case "unknown":
      return { color: "var(--color-muted-foreground)", filled: false };
  }
}

/** Post-entry segment + fill colour, driven by which way the trade is running. */
/**
 * Round prices to rule the plot with, inside a domain.
 *
 * The step is the largest of 1, 2, 2.5 or 5 times a power of ten that still
 * leaves at least three lines in the frame — so a $2 range gets $0.50 rules and
 * a $200 range gets $50 ones, and the numbers on them are always numbers a
 * person would say out loud.
 */
function gridPricesFor(min: number, max: number, targetLines: number): ReadonlyArray<number> {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [];
  const rough = span / targetLines;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((size) => size >= rough) ??
    10 * magnitude;
  const lines: number[] = [];
  for (let price = Math.ceil(min / step) * step; price <= max; price += step) {
    // Re-rounded: repeated addition of 0.25 drifts into 1869.7500000000002,
    // which prints as a price nobody chose.
    lines.push(Number(price.toFixed(6)));
  }
  return lines;
}

/**
 * The price line's stroke width, in CSS pixels (the stroke does not scale with
 * the plot, so this is a real width and not a viewBox unit).
 *
 * 2.25 rather than 1.5. The plot stretches to fill a 700×440 card and a 1.5px
 * line across that much glass reads as a hairline diagram; the subject of this
 * card is the price, and the subject should be the boldest mark on it.
 */
const LINE_WIDTH = 2.25;

function pnlColor(sign: "profit" | "loss" | null): string {
  if (sign === "profit") return "var(--color-profit)";
  if (sign === "loss") return "var(--color-loss)";
  return "var(--color-muted-foreground)";
}

/** Turn a list of points into the `points` attribute of a `<polyline>`/`<polygon>`. */
function toPoints(points: ReadonlyArray<ChartPoint>): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

/**
 * The band between the post-entry line and the entry price.
 *
 * The baseline is the ENTRY level, not the bottom of the frame. Closing the
 * path at `y = CHART_VIEWBOX_HEIGHT` shaded "distance from the price to the
 * bottom of an arbitrary viewport", which is not a quantity — and because the
 * frame bottom is far from the price action, it painted a saturated slab across
 * the lower half of the chart the instant a fill landed. Against the entry the
 * shaded height is the distance the trade has travelled from its own entry:
 * that is the P&L, it is symmetric above and below, and it starts at nothing
 * and grows, so a one-minute-old trade looks like a one-minute-old trade.
 *
 * Empty string below two points — there is no area in a single sample.
 */
function toAreaPath(points: ReadonlyArray<ChartPoint>, baselineY: number): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const segments = points.map((point) => `L ${point.x} ${point.y}`);
  // Up from the baseline at the first point's x, across the line, then back
  // down to the baseline and close.
  return `M ${first.x} ${baselineY} L ${first.x} ${first.y} ${segments.slice(1).join(" ")} L ${last.x} ${baselineY} Z`;
}

export function MissionPriceChart(props: MissionPriceChartProps) {
  const {
    candles,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    entryTime,
    markPrice,
    pnlSign,
    markMotion = "live",
    conditions,
    fills,
    pendingOrder,
    flash,
    nowMillis,
    triggerExpiryAt,
    projection,
    timeMarkers,
    pastMarkers,
    draggableKinds,
    onLevelDragEnd,
    refusedLevel,
    positionSize,
    className,
  } = props;
  const [drag, setDrag] = useState<{
    readonly kind: ChartLevelKind;
    readonly price: number;
  } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // The draw-in dash is stripped once the intro has played. Left on, the
  // polyline keeps `stroke-dasharray: 1` against a `pathLength` that
  // re-normalises every time the points change — and on a line that updates
  // four times a second the dash boundary lands short of the path end often
  // enough that the tail of the line visibly drops out. The class exists for
  // one animation; after it, the line is just a line.
  const [introDone, setIntroDone] = useState(false);
  const drawClass = introDone ? undefined : "mission-line-draw";
  // The crosshair: where the pointer is reading the series, Stocks-style.
  const [hover, setHover] = useState<{
    readonly x: number;
    readonly y: number;
    readonly price: number;
    readonly at: number;
    /** True when the sample is the live mark, not a candle close. */
    readonly isMark: boolean;
  } | null>(null);

  const geometry = computeChartGeometry({
    candles,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    entryTime,
    markPrice,
    ...(conditions === undefined ? {} : { conditions }),
    ...(fills === undefined ? {} : { fills }),
    ...(pendingOrder === undefined ? {} : { pendingOrder }),
    ...(nowMillis === undefined ? {} : { nowMillis }),
    ...(triggerExpiryAt === undefined ? {} : { triggerExpiryAt }),
    ...(projection === undefined ? {} : { projection }),
    ...(timeMarkers === undefined ? {} : { timeMarkers }),
    ...(pastMarkers === undefined ? {} : { pastMarkers }),
  });

  // Too few candles → the parent renders a skeleton / "chart unavailable".
  if (geometry === null) return null;

  // Unique per mounted chart: two of these on one screen (the live panel and a
  // review) would otherwise share one `<linearGradient id>` and the second
  // would paint with the first's colour.
  // Stripped to word characters: React's generated ids carry punctuation that
  // is legal in an `id` attribute and illegal inside `url(#…)`.
  const gradientId = `mission-chart-${useId().replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;

  // While flat there is no P&L to tint by, so the line takes the window's own
  // direction — up over the hour is green, down is red — which is the rule the
  // Stocks app draws by and the one a glance already expects. While exposed the
  // trade's own result wins: what the position is doing outranks what the hour
  // did.
  const windowRise =
    candles.length >= 2 ? candles[candles.length - 1]!.close - candles[0]!.close : 0;
  const lineColor =
    pnlSign !== null
      ? pnlColor(pnlSign)
      : windowRise < 0
        ? "var(--color-loss)"
        : "var(--color-profit)";
  const segmentColor = lineColor;
  // One fill, from the whole line down to the floor of the frame, fading out as
  // it falls. The band that used to shade the line against the entry is gone:
  // two washes on one plot — a P&L band and a ground gradient — is the
  // "discoloration" that made the plot read as blocks of tinted paper rather
  // than as a lit line. The entry keeps its own dashed rule, which is exactly
  // what the Stocks app does with the previous close.
  const areaPath = toAreaPath(
    [...geometry.preEntryPoints, ...geometry.postEntryPoints],
    CHART_VIEWBOX_HEIGHT,
  );
  const gridPrices = gridPricesFor(geometry.domainMin, geometry.domainMax, 4);

  // One bar's width on the axis, and the slide that plays when a new one lands.
  //
  // Inside a bar the record holds still and only the live edge advances — a
  // third of a pixel a second, which is true motion but not motion anyone can
  // see. The visible event is the close: the window steps left by exactly one
  // bar, and rather than teleporting there, the series starts one pitch to the
  // right and travels into place. Once a minute the whole pane moves, in the
  // direction time runs, for about the length of a breath.
  const barPitch =
    candles.length > 0 ? (PLOT_WIDTH * (1 - FUTURE_GUTTER_RATIO)) / candles.length : 0;
  const lastBarAt = candles[candles.length - 1]?.openTime ?? 0;
  const [slideOffset, setSlideOffset] = useState(0);
  const lastBarRef = useRef(lastBarAt);
  useEffect(() => {
    if (lastBarRef.current === lastBarAt) return;
    lastBarRef.current = lastBarAt;
    setSlideOffset(barPitch);
    // Two frames: the first commits the offset, the second releases it with a
    // transition to animate against. One frame and the browser coalesces both
    // into the end state, which is a teleport with extra steps.
    const first = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSlideOffset(0));
    });
    return () => cancelAnimationFrame(first);
  }, [lastBarAt, barPitch]);
  // The gutter overlay is positioned in percentages of the same viewBox the SVG
  // uses, so the two stay in register at any container size.
  const gutterPercent = (LABEL_GUTTER_WIDTH / CHART_VIEWBOX_WIDTH) * 100;
  const flashedLevel =
    flash === undefined || flash === null ? null : findLevelAtPrice(geometry.levels, flash.price);

  // Pointer y → price, through the same padded domain the geometry drew with,
  // so the level lands where the pointer is rather than near it. Clamped to the
  // domain: a drag that leaves the frame states a price the chart cannot show,
  // and the operator would be publishing a level they cannot see.
  const priceAtClientY = (clientY: number): number | null => {
    const frame = frameRef.current;
    if (frame === null) return null;
    const box = frame.getBoundingClientRect();
    if (box.height <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    const price = geometry.domainMax - ratio * (geometry.domainMax - geometry.domainMin);
    // Rounded, because this price is published: it goes into the plan document,
    // into the journal note the model reads, and onto the exchange. A pointer
    // gives fifteen significant figures and a stop at 1863.5774749999998 is a
    // number no one chose. Two decimals at ETH scale, four below a dollar, so a
    // cheap market keeps the resolution its ticks actually have.
    const decimals = Math.abs(price) >= 1 ? 2 : 4;
    return Number(price.toFixed(decimals));
  };

  // Pointer x → the nearest plotted close, for the hover crosshair. The plot
  // is a linear clock, so the mapping is one division and a nearest-neighbour
  // scan over at most ~120 points. Nothing right of `now` is hoverable — the
  // future gutter holds claims, not samples.
  const hoverAtClient = (clientX: number): void => {
    const frame = frameRef.current;
    if (frame === null) return;
    const box = frame.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const viewX = ((clientX - box.left) / box.width) * CHART_VIEWBOX_WIDTH;
    if (viewX > geometry.nowX + 4) {
      setHover(null);
      return;
    }
    // A plotted point is a candle's CLOSE, so it is labeled with the close
    // time (open + one interval), not the open. Labeled by the open, the point
    // just left of "now" read a minute stale, and the mark truncated to the
    // same minute as the bar it was closing — two points, one time.
    const interval = medianBarInterval(candles);
    let best: { x: number; y: number; price: number; at: number; isMark: boolean } | null = null;
    for (const candle of candles) {
      const x = geometry.xForTime(candle.openTime);
      if (x < 0) continue;
      if (best === null || Math.abs(x - viewX) < Math.abs(best.x - viewX)) {
        // A forming bar's close is in the future; the clock caps the label at
        // the newest moment that has actually happened.
        const closedAt =
          nowMillis === undefined
            ? candle.openTime + interval
            : Math.min(candle.openTime + interval, nowMillis);
        best = {
          x,
          y: geometry.yForPrice(candle.close),
          price: candle.close,
          at: closedAt,
          isMark: false,
        };
      }
    }
    // The live mark is a sample too — the newest one. Without it the crosshair
    // could never read past the last CLOSED candle, so "now" (the minute
    // currently forming) was unreachable and the readout stopped a minute in
    // the past.
    if (geometry.markPoint !== null && markPrice !== null && nowMillis !== undefined) {
      const mark = geometry.markPoint;
      if (best === null || Math.abs(mark.x - viewX) < Math.abs(best.x - viewX)) {
        best = { x: mark.x, y: mark.y, price: markPrice, at: nowMillis, isMark: true };
      }
    }
    // Vertical position is ignored entirely — Stocks reads the series wherever
    // the finger is, and demanding the pointer be ON the line makes the
    // crosshair flicker.
    setHover(best);
  };

  const draggable = draggableKinds ?? [];
  const isDraggable = (kind: ChartLevelKind) =>
    onLevelDragEnd !== undefined && draggable.includes(kind);

  const startDrag = (kind: ChartLevelKind, event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const price = priceAtClientY(event.clientY);
    if (price !== null) setDrag({ kind, price });
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (drag === null) return;
    const price = priceAtClientY(event.clientY);
    if (price !== null) setDrag({ kind: drag.kind, price });
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (drag === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    onLevelDragEnd?.(drag.kind, drag.price);
  };

  // What the dragged stop would plan to lose, live under the pointer. Only for
  // a stop, and only with a position and an entry to measure from: every other
  // combination has no dollar answer and a zero would read as one.
  const dragRiskUsd =
    drag !== null && drag.kind === "stop" && entryPrice !== null && (positionSize ?? 0) !== 0
      ? Math.abs(entryPrice - drag.price) * Math.abs(positionSize ?? 0)
      : null;

  // A refused stop is very often outside the drawn domain — the whole reason it
  // was refused is that it is further from the entry than the approved
  // envelope allows. Drawn at its true y it would be off the frame entirely
  // and the operator would see no second level at all, which reads as "the
  // drag did nothing". So it is pinned to the edge it went off, the same
  // treatment `ChartLevel.offScale` gives a stop the domain excluded.
  const refusedY =
    refusedLevel === undefined || refusedLevel === null
      ? null
      : Math.min(CHART_VIEWBOX_HEIGHT - 3, Math.max(3, geometry.yForPrice(refusedLevel.planPrice)));

  return (
    // `overflow-hidden`: the gutter tags and the mark dot are HTML positioned
    // in percentages of the viewBox, so anything the geometry places near an
    // edge would otherwise be drawn over the bands above and below the chart.
    <div
      ref={frameRef}
      className={cn("relative h-full w-full overflow-hidden", className)}
      // The crosshair follows the pointer whenever nothing is being dragged.
      // The grab strips capture their own pointer during a drag, so the frame
      // sees no moves then; the guard is for the pathological overlap.
      onPointerMove={(event) => {
        if (drag === null) hoverAtClient(event.clientX);
      }}
      onPointerLeave={() => setHover(null)}
    >
      {/* The mark's ring animation, declared once for the whole chart. */}
      <style>{`@keyframes mission-mark-pulse { 0%, 100% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); } 50% { opacity: 0.15; transform: translate(-50%, -50%) scale(1.35); } }
@keyframes mission-level-flash { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
.mission-level-flash { animation: mission-level-flash 1.4s ease-out 2 forwards; opacity: 0; }
.mission-marker-slide { transition: transform 500ms cubic-bezier(0.22, 1, 0.36, 1), right 500ms cubic-bezier(0.22, 1, 0.36, 1); }
/* The line draws itself, left to right, once. A pathLength of 1 normalises
   every polyline to a unit length, so one keyframe serves each segment
   whatever its real length. */
@keyframes mission-line-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.mission-line-draw { stroke-dasharray: 1; animation: mission-line-draw 1100ms cubic-bezier(0.33, 1, 0.68, 1) both; }
/* And the plot settles into place behind it, moving the same way. Six units of
   a 1000-unit viewBox — enough to register as motion, too little to read as a
   slide. */
@keyframes mission-plot-settle { from { transform: translateX(-6px); opacity: 0.4; } to { transform: none; opacity: 1; } }
.mission-plot-settle { animation: mission-plot-settle 1100ms cubic-bezier(0.33, 1, 0.68, 1) both; }
@media (prefers-reduced-motion: reduce) { .mission-level-flash { animation: none; opacity: 1; } .mission-marker-slide { transition: none; } .mission-line-draw { stroke-dasharray: none; animation: none; } .mission-plot-settle { animation: none; } }`}</style>
      <svg
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <defs>
          {/* The Stocks app's one piece of shading: the line's own colour
              poured down to the floor and fading as it goes. It reads as
              light under the line rather than as a filled region, which is
              why it can be bright at the top without competing with the
              stroke. */}
          <linearGradient id={`${gradientId}-under`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
            <stop offset="45%" stopColor={lineColor} stopOpacity={0.07} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* The price grid. Four rules at round numbers across the domain, which
            is the frame the Stocks app reads its line against — without them a
            price line is a shape with no scale, and every wiggle looks the same
            size whether the market moved a dollar or twenty. */}
        {gridPrices.map((price) => (
          <line
            key={`grid-${price}`}
            x1={0}
            y1={geometry.yForPrice(price)}
            x2={PLOT_WIDTH}
            y2={geometry.yForPrice(price)}
            stroke="color-mix(in oklab, var(--color-foreground) 7%, transparent)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* The future gutter's ground. Barely there now: at 4% it was a grey
            block pasted over the right third of the plot, and the eye read it
            as a different material rather than as the same plot after now.
            The hairline at `now` does the separating; the wash only tints. */}
        {geometry.nowX < PLOT_WIDTH ? (
          <rect
            x={geometry.nowX}
            y={0}
            width={PLOT_WIDTH - geometry.nowX}
            height={CHART_VIEWBOX_HEIGHT}
            fill="color-mix(in oklab, var(--color-foreground) 1.5%, transparent)"
            stroke="none"
          />
        ) : null}
        {geometry.nowX < PLOT_WIDTH ? (
          <line
            x1={geometry.nowX}
            y1={0}
            x2={geometry.nowX}
            y2={CHART_VIEWBOX_HEIGHT}
            stroke="color-mix(in oklab, var(--color-foreground) 14%, transparent)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* The series, as one moving object: the fill and all three line
            segments travel together when a bar closes. */}
        <g
          style={{
            transform: `translateX(${slideOffset}px)`,
            transition:
              slideOffset === 0 ? "transform 700ms cubic-bezier(0.33, 1, 0.68, 1)" : "none",
          }}
        >
          {areaPath !== "" ? (
            <path
              className="mission-plot-settle"
              d={areaPath}
              fill={`url(#${gradientId}-under)`}
              stroke="none"
            />
          ) : null}

          {/* The candle bars are gone: the chart is a line chart now — the
            price is one continuous close line, which is the faithful shape of
            "where has price been" without the texture of every bar competing
            with the levels drawn over it. The geometry still computes bars;
            nothing here reads them. */}

          {/* The two EMAs are not drawn. Three curves in one frame — price, fast,
            slow — read as three subjects, and the two that were meant to be a
            quiet backdrop were the two the eye followed, because they are the
            smooth ones. The chart's subject is the price and the levels the
            plan drew across it. `geometry.emaLines` is still computed and still
            tested; putting the pair back is this block and the legend below it. */}

          {/* Pre-entry segment. Held at three quarters of the line's colour
            rather than in grey: the hour before the fill is the same price
            series, and draining it to muted grey was what made the chart look
            like two different instruments spliced at the entry. */}
          {geometry.preEntryPoints.length >= 2 ? (
            <polyline
              className={drawClass}
              onAnimationEnd={() => setIntroDone(true)}
              pathLength={1}
              points={toPoints(geometry.preEntryPoints)}
              fill="none"
              stroke={lineColor}
              strokeWidth={LINE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={pnlSign === null ? 1 : 0.55}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* Post-entry segment: the held part, at full strength. */}
          {geometry.postEntryPoints.length >= 2 ? (
            <polyline
              className={drawClass}
              onAnimationEnd={() => setIntroDone(true)}
              pathLength={1}
              points={toPoints(geometry.postEntryPoints)}
              fill="none"
              stroke={segmentColor}
              strokeWidth={LINE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* The forming bar: last close → the mark. The one part of the line
            that changes between candle closes, which on a 1m series is 59
            seconds out of every 60 — so it is the segment that carries the
            left-to-right progress, and it is drawn at full strength. */}
          {geometry.livePoints.length === 2 ? (
            <polyline
              points={toPoints(geometry.livePoints)}
              fill="none"
              stroke={segmentColor}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </g>

        {/* The projection: where the model currently thinks price is going,
            as a dotted path from the mark into the future gutter. The info
            ink, not profit/loss — it is a read, not a result — and the
            hypothetical dash, because everything right of now is a claim. */}
        {geometry.projectionPoints.length === 2 ? (
          <polyline
            data-testid="mission-chart-projection"
            points={toPoints(geometry.projectionPoints)}
            fill="none"
            // Muted deliberately: the projection is the model's read, not the
            // record, and it is on screen at all times — at full ink it would
            // compete with the one saturated shape, the price.
            stroke="color-mix(in oklab, var(--color-info) 55%, transparent)"
            strokeWidth={1.25}
            strokeDasharray="1 5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Scheduled future events, standing in the gutter to the right of
            now — where the plan says something will happen next.

            Drawn at x=0 and translated, so the moment can be TRANSITIONED
            rather than redrawn. A reassessment is a relative condition: every
            wake re-arms it, and the moment it stands for jumps minutes further
            out in a single projection update. Drawn as a new x each time, the
            rule vanished from one place and appeared in another, which reads as
            two rules rather than as one that reset. Eased, it slides right, and
            the reset is the thing you see. */}
        {geometry.timeMarkers.map((marker) => (
          <line
            key={`marker-${marker.key}`}
            className="mission-marker-slide"
            transform={`translate(${marker.x} 0)`}
            x1={0}
            y1={0}
            x2={0}
            y2={CHART_VIEWBOX_HEIGHT}
            stroke={marker.tone === "auto" ? "var(--color-muted-foreground)" : "var(--color-armed)"}
            strokeWidth={1}
            // A floor rearming itself is a finer, sparser tick than a moment the
            // plan chose to be woken for.
            strokeDasharray={marker.tone === "auto" ? "1 5" : "3 4"}
            opacity={marker.overdue ? 0.9 : marker.tone === "auto" ? 0.3 : 0.45}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* The mission's own turns, as a rug of ticks along the bottom edge.
            Full-height rules here would fence the price line in behind twenty
            verticals; a rug says "these are the moments" without competing with
            the one saturated shape on screen. */}
        {geometry.pastMarkers.map((marker) => (
          <line
            key={`past-${marker.key}`}
            x1={marker.x}
            y1={CHART_VIEWBOX_HEIGHT - PAST_MARKER_TICK_HEIGHT}
            x2={marker.x}
            y2={CHART_VIEWBOX_HEIGHT}
            stroke={pastMarkerColor(marker)}
            strokeWidth={1}
            opacity={marker.failed === true ? 0.9 : 0.55}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Horizontal price levels, in two registers. Up to `nowX` the rule is
            the record — this price has been the stop, the target, the level
            being watched. Past it the same rule is a projection, so it is
            drawn thinner, dashed and at half strength, and a trigger's
            projection stops at the reassessment that ends its plan rather than
            running to the frame edge. The tags they belong to live in the HTML
            gutter below, so nothing here is text. */}
        {geometry.levels.map((level) => (
          <g key={`${level.kind}-${level.price}`}>
            <line
              x1={0}
              y1={level.y}
              x2={geometry.nowX}
              y2={level.y}
              stroke={levelRuleColor(level.kind)}
              strokeWidth={1}
              strokeDasharray={levelDashArray(level.kind)}
              vectorEffect="non-scaling-stroke"
            />
            {level.futureEndX > geometry.nowX ? (
              <line
                x1={geometry.nowX}
                y1={level.y}
                x2={level.futureEndX}
                y2={level.y}
                stroke={levelRuleColor(level.kind)}
                strokeWidth={HYPOTHETICAL_STROKE_WIDTH}
                strokeDasharray={HYPOTHETICAL_DASH_ARRAY}
                opacity={HYPOTHETICAL_OPACITY}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </g>
        ))}

        {/* The flashed level: the same rule, drawn once more in its own ink and
            keyed by the click that asked for it, so the animation restarts on
            every click rather than only the first. */}
        {flashedLevel === null ? null : (
          <line
            key={`flash-${flash?.nonce ?? 0}`}
            data-testid="mission-chart-flash"
            className="mission-level-flash"
            x1={0}
            y1={flashedLevel.y}
            // Stops at now, like the rule it is highlighting: a flash running
            // into the gutter would be the one saturated thing in it.
            x2={geometry.nowX}
            y2={flashedLevel.y}
            stroke={levelInkColor(flashedLevel.kind)}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* The refused level's plan price, in the hypothetical register. The
            rule above stays where the stop actually rests; this is what the
            plan now says, drawn as the claim it is. */}
        {refusedY === null || refusedLevel === null || refusedLevel === undefined ? null : (
          <line
            data-testid="mission-chart-refused-plan"
            x1={0}
            y1={refusedY}
            x2={PLOT_WIDTH}
            y2={refusedY}
            stroke={levelRuleColor(refusedLevel.kind)}
            strokeWidth={HYPOTHETICAL_STROKE_WIDTH}
            strokeDasharray={HYPOTHETICAL_DASH_ARRAY}
            opacity={HYPOTHETICAL_OPACITY}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* The level under the pointer, while it is being dragged. Full ink,
            because this one IS a statement the operator is making right now. */}
        {drag === null ? null : (
          <line
            data-testid="mission-chart-drag-rule"
            x1={0}
            y1={geometry.yForPrice(drag.price)}
            x2={PLOT_WIDTH}
            y2={geometry.yForPrice(drag.price)}
            stroke={levelInkColor(drag.kind)}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Leader lines: a tag nudged off its own level still points at it. */}
        {geometry.gutterTags
          .filter((tag) => Math.abs(tag.labelY - tag.y) > 0.5)
          .map((tag) => (
            <line
              key={`leader-${tag.key}`}
              x1={PLOT_WIDTH}
              y1={tag.y}
              x2={PLOT_WIDTH + 6}
              y2={tag.labelY}
              stroke={tag.kind === "mark" ? segmentColor : levelRuleColor(tag.kind)}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.6}
            />
          ))}
      </svg>

      {/* The grab strips. HTML rather than SVG because a stretched plot makes
          a thin SVG hit area unusably narrow at some widths and enormous at
          others; a percentage-positioned strip is the same eight pixels tall
          whatever the panel does. They sit over the plot only — the gutter is
          text and must stay selectable. */}
      {geometry.levels
        .filter((level) => isDraggable(level.kind) && level.inFrame)
        .map((level) => (
          <div
            key={`grab-${level.kind}-${level.price}`}
            data-testid={`mission-chart-grab-${level.kind}`}
            role="slider"
            tabIndex={-1}
            aria-label={`${level.kind} price`}
            aria-valuenow={level.price}
            className="absolute h-[9px] -translate-y-1/2 cursor-ns-resize touch-none"
            style={{
              left: 0,
              width: `${(PLOT_WIDTH / CHART_VIEWBOX_WIDTH) * 100}%`,
              top: `${(level.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
            }}
            onPointerDown={(event) => startDrag(level.kind, event)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}

      {/* The dragged price, and what it would plan to lose. Follows the
          pointer, because a readout the operator has to look away to read is a
          readout they will not read while dragging. */}
      {drag === null ? null : (
        <span
          data-testid="mission-chart-drag-readout"
          // Left, not right: the gutter on the right is where the level tags
          // live, and a readout over them covers the very prices the operator
          // is dragging relative to.
          className="pointer-events-none absolute left-1 -translate-y-1/2 rounded-sm bg-background/90 px-1 py-0.5 font-mono text-[10.5px] tabular-nums"
          style={{
            top: `${(geometry.yForPrice(drag.price) / CHART_VIEWBOX_HEIGHT) * 100}%`,
            color: levelInkColor(drag.kind),
          }}
        >
          {formatPrice(drag.price)}
          {dragRiskUsd === null ? "" : ` · risk $${dragRiskUsd.toFixed(2)}`}
        </span>
      )}

      {/* Fill markers and the mark dot are HTML, not SVG, for the same reason
          the gutter is: the plot stretches (`preserveAspectRatio="none"`), so an
          SVG circle drawn in it comes out an ellipse whose eccentricity depends
          on the container width. Positioned in percentages of the same viewBox,
          they stay in register with the plot at any size and stay round. */}
      {geometry.fillPoints.map((fill) => {
        const style = fillMarkerStyle(fill.kind);
        return (
          <span
            key={`fill-${fill.key}`}
            className="pointer-events-none absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]"
            style={{
              left: `${(fill.x / CHART_VIEWBOX_WIDTH) * 100}%`,
              top: `${(fill.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
              borderColor: style.color,
              backgroundColor: style.filled ? style.color : "transparent",
            }}
            aria-hidden="true"
          />
        );
      })}

      {/* The mark: a solid dot inside a pulsing ring. The ring is what carries
          the motion, so the dot itself stays a crisp, readable point. */}
      {geometry.markPoint !== null ? (
        <span
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${(geometry.markPoint.x / CHART_VIEWBOX_WIDTH) * 100}%`,
            top: `${(geometry.markPoint.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
          }}
          aria-hidden="true"
        >
          {markMotion === "live" ? (
            <span
              // The translate lives in the keyframes, not in a class: the
              // animation drives `transform`, so a utility that also set it
              // would simply be overwritten on the first frame.
              className="absolute left-1/2 top-1/2 size-[14px] rounded-full border"
              style={{
                borderColor: segmentColor,
                animation: "mission-mark-pulse 1.6s ease-in-out infinite",
              }}
            />
          ) : null}
          <span
            className="block size-[7px] rounded-full"
            style={{ backgroundColor: segmentColor }}
          />
        </span>
      ) : null}

      {/* The projection's endpoint: a hollow ring in the info ink, where the
          read expects price to be. Hollow, because nothing has happened there
          — the solid dot on this chart is reserved for the mark. */}
      {geometry.projectionPoints.length === 2 ? (
        <span
          data-testid="mission-chart-projection-end"
          className="pointer-events-none absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]"
          style={{
            left: `${((geometry.projectionPoints[1]?.x ?? 0) / CHART_VIEWBOX_WIDTH) * 100}%`,
            top: `${((geometry.projectionPoints[1]?.y ?? 0) / CHART_VIEWBOX_HEIGHT) * 100}%`,
            borderColor: "var(--color-info)",
            backgroundColor: "transparent",
          }}
          aria-hidden="true"
        />
      ) : null}

      {/* Marker captions. HTML for the same reason the gutter is, and anchored
          by their RIGHT edge to the rule so they grow leftward into the plot
          and can never overflow the frame. */}
      {geometry.timeMarkers.map((marker) =>
        marker.label === "" ? null : (
          <span
            key={`marker-label-${marker.key}`}
            className={cn(
              "mission-marker-slide pointer-events-none absolute top-1 whitespace-nowrap pr-1.5 text-[10.5px] leading-none",
              marker.tone === "auto" ? "text-muted-foreground" : "text-armed",
            )}
            style={{ right: `${(1 - marker.x / CHART_VIEWBOX_WIDTH) * 100}%` }}
            aria-hidden="true"
          >
            {marker.label}
          </span>
        ),
      )}

      {/* The EMA legend went with the lines it named. A legend for a series
          that is not drawn is two more prices to read in the corner of a chart
          whose top-left is otherwise empty ground. */}

      {/* The grid's own prices, sitting just above their rules at the left of
          the plot. The Stocks app puts this scale on the right; here the right
          is the level gutter — entry, stop, target, the mark — and a price
          scale interleaved with those would be two columns of numbers meaning
          different things. The left of the plot is empty ground. */}
      {gridPrices.map((price) => (
        <span
          key={`grid-label-${price}`}
          className="pointer-events-none absolute left-1.5 -translate-y-full pb-0.5 font-mono text-[10px] leading-none tabular-nums text-muted-foreground/60"
          style={{ top: `${(geometry.yForPrice(price) / CHART_VIEWBOX_HEIGHT) * 100}%` }}
          aria-hidden="true"
        >
          {formatPrice(price)}
        </span>
      ))}

      {/* The hover crosshair — the Stocks-app read. A hairline at the sampled
          moment, a dot on the line, and the price/time pair floating above,
          all HTML so nothing stretches. It reads the record only; the future
          gutter is claims, and claims have no sample to read. */}
      {hover === null ? null : (
        <>
          <span
            data-testid="mission-chart-crosshair"
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25"
            style={{ left: `${(hover.x / CHART_VIEWBOX_WIDTH) * 100}%` }}
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-background"
            style={{
              left: `${(hover.x / CHART_VIEWBOX_WIDTH) * 100}%`,
              top: `${(hover.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
              borderColor: segmentColor,
            }}
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute top-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-background/90 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-foreground"
            style={{
              // Clamped in from both edges so the readout never leaves the
              // frame at either end of the series.
              left: `clamp(3rem, ${(hover.x / CHART_VIEWBOX_WIDTH) * 100}%, calc(100% - 3rem))`,
            }}
            aria-hidden="true"
          >
            {formatPrice(hover.price)}
            <span className="text-muted-foreground">
              {" · "}
              {/* Seconds only on the live sample: candle closes land on the
                  minute, but "now" is inside one, and without the seconds the
                  mark read as the same moment as the bar it is closing. */}
              {new Date(hover.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                ...(hover.isMark ? { second: "2-digit" as const } : {}),
              })}
            </span>
          </span>
        </>
      )}

      {/* The gutter: HTML, so the glyphs are never stretched by the plot's
          aspect ratio and a long caption can ellipsis instead of overflowing. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 text-[11.5px] leading-none tabular-nums"
        // Step 8.7. The gutter was a flat 15% of the frame, which is ~56px on a
        // 375px phone — narrower than "○ ▲ 1,873.5" — so every tag clipped to
        // "1,8" and the panel stopped answering what is protecting you and at
        // what price. A floor in real pixels is what makes the tag legible at
        // any width; it eats into the right end of the plot, which is the
        // future gutter and is empty by construction.
        style={{ width: `max(${gutterPercent}%, 4.5rem)` }}
        aria-hidden="true"
      >
        {geometry.gutterTags.map((tag) => {
          const caption = tagCaption(tag);
          const glyph = tagGlyph(tag);
          return (
            // Price and caption stack rather than sharing a line. On a narrow
            // panel the gutter is ~70px, and "3421.50 close above" on one line
            // truncated to "3421.50 clo…" — the half of the tag that says WHAT
            // the level is was the half being hidden.
            <span
              key={tag.key}
              className="absolute left-1.5 right-0.5 flex -translate-y-1/2 flex-col leading-[1.15]"
              style={{
                top: `${(tag.labelY / CHART_VIEWBOX_HEIGHT) * 100}%`,
                color: tag.kind === "mark" ? segmentColor : levelInkColor(tag.kind),
                fontWeight: tag.kind === "mark" ? 600 : 400,
              }}
            >
              <span className="flex items-baseline gap-1 whitespace-nowrap">
                {glyph === "" ? null : <span>{glyph}</span>}
                <span>{formatPrice(tag.price)}</span>
                {tag.offScale === null ? null : <span>{tag.offScale === "above" ? "↑" : "↓"}</span>}
              </span>
              {caption === "" ? null : (
                <span className="truncate text-[10px] opacity-80">
                  {tag.kind === "mark" ? `(${caption})` : caption}
                  {/* A cluster says how many watches it stands for, so folding
                      three near-identical levels into one rule hides no armed
                      condition — it only stops drawing three of them. */}
                  {tag.count === undefined ? "" : ` ×${tag.count}`}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
