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

import { useRef, useState } from "react";

import type { TradingChartCandle } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import {
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  LABEL_GUTTER_WIDTH,
  PLOT_WIDTH,
  computeChartGeometry,
  findLevelAtPrice,
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
  // Quieter than the named levels and quieter than the two EMAs: a condition is
  // a price nothing has happened at yet, and there can be three of them.
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
    ...(timeMarkers === undefined ? {} : { timeMarkers }),
    ...(pastMarkers === undefined ? {} : { pastMarkers }),
  });

  // Too few candles → the parent renders a skeleton / "chart unavailable".
  if (geometry === null) return null;

  const segmentColor = pnlColor(pnlSign);
  // Shade against the entry when there is one. With no entry (a flat, waiting
  // mission) there is no baseline the band would mean anything against, so the
  // line is drawn unshaded rather than filled to an invented level.
  const entryLevelY = geometry.levels.find((level) => level.kind === "entry")?.y ?? null;
  const areaPath = entryLevelY === null ? "" : toAreaPath(geometry.postEntryPoints, entryLevelY);
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
    <div ref={frameRef} className={cn("relative h-full w-full overflow-hidden", className)}>
      {/* The mark's ring animation, declared once for the whole chart. */}
      <style>{`@keyframes mission-mark-pulse { 0%, 100% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); } 50% { opacity: 0.15; transform: translate(-50%, -50%) scale(1.35); } }
@keyframes mission-level-flash { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
.mission-level-flash { animation: mission-level-flash 1.4s ease-out 2 forwards; opacity: 0; }
.mission-marker-slide { transition: transform 500ms cubic-bezier(0.22, 1, 0.36, 1), right 500ms cubic-bezier(0.22, 1, 0.36, 1); }
@media (prefers-reduced-motion: reduce) { .mission-level-flash { animation: none; opacity: 1; } .mission-marker-slide { transition: none; } }`}</style>
      <svg
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        {/* The future gutter's own ground: a faint wash from now to the frame
            edge, so everything standing in it is read as a claim about what
            has not happened rather than as part of the record to its left. */}
        {geometry.nowX < PLOT_WIDTH ? (
          <rect
            x={geometry.nowX}
            y={0}
            width={PLOT_WIDTH - geometry.nowX}
            height={CHART_VIEWBOX_HEIGHT}
            fill="color-mix(in oklab, var(--color-foreground) 4%, transparent)"
            stroke="none"
          />
        ) : null}

        {/* The band between the line and the entry — the trade's P&L, as an
            area. Denser than the old baseline slab was, because it is now a
            thin band around the entry rather than half the frame. */}
        {areaPath !== "" ? (
          <path
            d={areaPath}
            fill={
              pnlSign === "profit"
                ? "color-mix(in oklab, var(--color-profit) 22%, transparent)"
                : pnlSign === "loss"
                  ? "color-mix(in oklab, var(--color-loss) 22%, transparent)"
                  : "color-mix(in oklab, var(--color-muted-foreground) 14%, transparent)"
            }
            stroke="none"
          />
        ) : null}

        {/* The candles. Drawn first, so everything the mission did sits on
            top of them, and drawn quietly: they are the market's texture —
            the wick that took a stop out, the bar that opened at its low —
            not the subject. The subject is still the coloured segment above. */}
        {geometry.bars.map((bar) => {
          // Full strength. At 70% the body was translucent, so the wick drawn
          // underneath it showed through as a dark stripe up the middle of
          // every candle — the bar reading as two shades of its own colour.
          const ink = bar.direction === "up" ? "var(--color-profit)" : "var(--color-loss)";
          // The wick is a rect, not a stroked line. A `non-scaling-stroke`
          // line is one device pixel wide whatever the container does, while
          // the body next to it is stretched by the plot's x scale — so on a
          // wide panel every bar was a fat slab with a hair sticking out of
          // it. Drawn as a rect the two scale together, and the wick stays a
          // fixed fraction of the body at any width.
          const wickHalfWidth = Math.max(0.18, bar.halfWidth * 0.22);
          // Drawn as the two pieces OUTSIDE the body rather than as one rect
          // behind it: nothing then overlaps, so the candle is one flat shape
          // whatever opacity anything above it is composited at.
          const upperWick = Math.max(0, bar.bodyTop - bar.highY);
          const lowerWick = Math.max(0, bar.lowY - bar.bodyBottom);
          return (
            <g key={`bar-${bar.key}`} fill={ink}>
              {upperWick > 0 ? (
                <rect
                  x={bar.x - wickHalfWidth}
                  y={bar.highY}
                  width={wickHalfWidth * 2}
                  height={upperWick}
                />
              ) : null}
              {lowerWick > 0 ? (
                <rect
                  x={bar.x - wickHalfWidth}
                  y={bar.bodyBottom}
                  width={wickHalfWidth * 2}
                  height={lowerWick}
                />
              ) : null}
              <rect
                x={bar.x - bar.halfWidth}
                // A doji has no height, and a zero-height rect draws nothing —
                // give it the thickness of a line so the bar is still there.
                y={bar.bodyTop}
                width={bar.halfWidth * 2}
                height={Math.max(0.75, bar.bodyBottom - bar.bodyTop)}
              />
            </g>
          );
        })}

        {/* The two EMAs — the strategy's entry read, drawn as the two curves it
            is actually made of. Neutral ink on purpose: the cross is a
            relationship between these two lines, and colouring them by
            profit/loss would put them in the same conversation as the trade's
            own shape. The slow one is thinner and quieter; the fast one is what
            crosses. */}
        {geometry.emaLines.map((line) => (
          <polyline
            key={`ema-${line.speed}`}
            points={toPoints(line.points)}
            fill="none"
            stroke={
              line.speed === "fast"
                ? "color-mix(in oklab, var(--color-info) 75%, transparent)"
                : "color-mix(in oklab, var(--color-muted-foreground) 55%, transparent)"
            }
            strokeWidth={line.speed === "fast" ? 1.25 : 1}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Pre-entry segment: muted, the flat part of the line. Suppressed
            once the candles are drawn — the same closes twice, once as a line
            through the bodies, is the noise this chart keeps clearing out. */}
        {geometry.bars.length === 0 && geometry.preEntryPoints.length >= 2 ? (
          <polyline
            points={toPoints(geometry.preEntryPoints)}
            fill="none"
            stroke="color-mix(in oklab, var(--color-muted-foreground) 40%, transparent)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Post-entry segment: the held part, coloured by pnl. With no entry
            it is not a held part at all, just the closes again — so with
            candles drawn it is suppressed exactly like the pre-entry one. */}
        {(geometry.bars.length === 0 || entryLevelY !== null) &&
        geometry.postEntryPoints.length >= 2 ? (
          <polyline
            points={toPoints(geometry.postEntryPoints)}
            fill="none"
            stroke={segmentColor}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* The forming bar: last close → the mark. The one part of the line
            that changes between candle closes, which on a 1m series is 59
            seconds out of every 60. */}
        {geometry.livePoints.length === 2 ? (
          <polyline
            points={toPoints(geometry.livePoints)}
            fill="none"
            stroke={segmentColor}
            strokeWidth={1.5}
            strokeLinecap="round"
            opacity={0.75}
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

      {/* Marker captions. HTML for the same reason the gutter is, and anchored
          by their RIGHT edge to the rule so they grow leftward into the plot
          and can never overflow the frame. */}
      {geometry.timeMarkers.map((marker) =>
        marker.label === "" ? null : (
          <span
            key={`marker-label-${marker.key}`}
            className={cn(
              "mission-marker-slide pointer-events-none absolute top-0.5 whitespace-nowrap pr-1 text-[9px] leading-none",
              marker.tone === "auto" ? "text-muted-foreground" : "text-armed",
            )}
            style={{ right: `${(1 - marker.x / CHART_VIEWBOX_WIDTH) * 100}%` }}
            aria-hidden="true"
          >
            {marker.label}
          </span>
        ),
      )}

      {/* Which two averages those lines are. Four characters each, in their own
          ink, so the pair is identifiable without a legend box. */}
      {geometry.emaLines.length === 2 ? (
        <span
          className="pointer-events-none absolute left-1.5 top-0.5 flex gap-2 text-[9px] leading-none"
          aria-hidden="true"
        >
          {[...geometry.emaLines]
            .sort((left, right) => left.period - right.period)
            .map((line) => (
              <span
                key={`ema-legend-${line.speed}`}
                className="tabular-nums"
                style={{
                  color:
                    line.speed === "fast" ? "var(--color-info)" : "var(--color-muted-foreground)",
                }}
              >
                EMA {line.period} {formatPrice(line.lastValue)}
              </span>
            ))}
        </span>
      ) : null}

      {/* The gutter: HTML, so the glyphs are never stretched by the plot's
          aspect ratio and a long caption can ellipsis instead of overflowing. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 text-[10px] leading-none tabular-nums"
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
                <span className="truncate text-[9px] opacity-70">
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
