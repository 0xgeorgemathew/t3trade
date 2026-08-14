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
  readonly className?: string;
}

/** How tall a past-event tick stands off the bottom edge, in viewBox units. */
const PAST_MARKER_TICK_HEIGHT = 6;

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
  condition_above: 28,
  condition_below: 28,
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
    timeMarkers,
    pastMarkers,
    className,
  } = props;

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

  return (
    <div className={cn("relative h-full w-full", className)}>
      {/* The mark's ring animation, declared once for the whole chart. */}
      <style>{`@keyframes mission-mark-pulse { 0%, 100% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); } 50% { opacity: 0.15; transform: translate(-50%, -50%) scale(1.35); } }
@keyframes mission-level-flash { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
.mission-level-flash { animation: mission-level-flash 1.4s ease-out 2 forwards; opacity: 0; }
@media (prefers-reduced-motion: reduce) { .mission-level-flash { animation: none; opacity: 1; } }`}</style>
      <svg
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
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
          const ink =
            bar.direction === "up"
              ? "color-mix(in oklab, var(--color-profit) 55%, transparent)"
              : "color-mix(in oklab, var(--color-loss) 55%, transparent)";
          return (
            <g key={`bar-${bar.key}`}>
              <line
                x1={bar.x}
                y1={bar.highY}
                x2={bar.x}
                y2={bar.lowY}
                stroke={ink}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <rect
                x={bar.x - bar.halfWidth}
                // A doji has no height, and a zero-height rect draws nothing —
                // give it the thickness of a line so the bar is still there.
                y={bar.bodyTop}
                width={bar.halfWidth * 2}
                height={Math.max(0.75, bar.bodyBottom - bar.bodyTop)}
                fill={ink}
              />
            </g>
          );
        })}

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
            now — where the plan says something will happen next. */}
        {geometry.timeMarkers.map((marker) => (
          <line
            key={`marker-${marker.key}`}
            x1={marker.x}
            y1={0}
            x2={marker.x}
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

        {/* Horizontal price levels. The tags they belong to live in the HTML
            gutter below, so nothing here is text. */}
        {geometry.levels.map((level) => (
          <line
            key={`${level.kind}-${level.price}`}
            x1={0}
            y1={level.y}
            x2={PLOT_WIDTH}
            y2={level.y}
            stroke={levelRuleColor(level.kind)}
            strokeWidth={1}
            strokeDasharray={levelDashArray(level.kind)}
            vectorEffect="non-scaling-stroke"
          />
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
            x2={PLOT_WIDTH}
            y2={flashedLevel.y}
            stroke={levelInkColor(flashedLevel.kind)}
            strokeWidth={2}
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
              "pointer-events-none absolute top-0.5 whitespace-nowrap pr-1 text-[9px] leading-none",
              marker.tone === "auto" ? "text-muted-foreground" : "text-armed",
            )}
            style={{ right: `${(1 - marker.x / CHART_VIEWBOX_WIDTH) * 100}%` }}
            aria-hidden="true"
          >
            {marker.label}
          </span>
        ),
      )}

      {/* The gutter: HTML, so the glyphs are never stretched by the plot's
          aspect ratio and a long caption can ellipsis instead of overflowing. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 text-[10px] leading-none tabular-nums"
        style={{ width: `${gutterPercent}%` }}
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
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
