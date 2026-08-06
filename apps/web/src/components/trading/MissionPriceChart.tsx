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
  type ChartCondition,
  type ChartLevelKind,
  type ChartPoint,
  type GutterTag,
} from "./missionChartGeometry";
import { formatPrice } from "./tradingPresentation";

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
  readonly className?: string;
}

/** Map a level kind to its stroke/text colour (CSS vars, the chart idiom). */
function levelStrokeColor(kind: ChartLevelKind | "mark"): string {
  switch (kind) {
    case "entry":
      // Entry is the reference, not a warning: a thin solid foreground line.
      return "color-mix(in oklab, var(--color-foreground) 40%, transparent)";
    case "stop":
      return "var(--color-loss)";
    case "target":
      return "var(--color-profit)";
    case "liquidation":
      return "var(--color-destructive)";
    case "condition_above":
    case "condition_below":
      // Armed, not active: the same amber the mission chrome uses for "waiting".
      return "var(--color-armed)";
    case "mark":
      return "var(--color-foreground)";
  }
}

/** The glyph that opens a gutter tag, or an empty string when it carries none. */
function tagGlyph(tag: GutterTag): string {
  if (tag.kind === "condition_above") return tag.met === true ? "✓ ▲" : "○ ▲";
  if (tag.kind === "condition_below") return tag.met === true ? "✓ ▼" : "○ ▼";
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
    case "condition_above":
      return "close above";
    case "condition_below":
      return "close below";
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
 * The closed fill path under the post-entry segment: the polyline down to the
 * baseline (y = CHART_VIEWBOX_HEIGHT) and back to the first point's x. Empty
 * string when there are fewer than two points (no area to fill).
 */
function toAreaPath(points: ReadonlyArray<ChartPoint>): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const segments = points.map((point) => `L ${point.x} ${point.y}`);
  // Move to the first point's x at the baseline, line up to the first point,
  // then across the top of the area, down to the baseline, and close.
  return `M ${first.x} ${CHART_VIEWBOX_HEIGHT} L ${first.x} ${first.y} ${segments.slice(1).join(" ")} L ${last.x} ${CHART_VIEWBOX_HEIGHT} Z`;
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
  });

  // Too few candles → the parent renders a skeleton / "chart unavailable".
  if (geometry === null) return null;

  const segmentColor = pnlColor(pnlSign);
  const areaPath = toAreaPath(geometry.postEntryPoints);
  // The gutter overlay is positioned in percentages of the same viewBox the SVG
  // uses, so the two stay in register at any container size.
  const gutterPercent = (LABEL_GUTTER_WIDTH / CHART_VIEWBOX_WIDTH) * 100;

  return (
    <div className={cn("relative h-full w-full", className)}>
      <svg
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <style>{`@keyframes mission-mark-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }`}</style>

        {/* Fill under the post-entry segment — the trade's shape, low opacity. */}
        {areaPath !== "" ? (
          <path
            d={areaPath}
            fill={
              pnlSign === "profit"
                ? "color-mix(in oklab, var(--color-profit) 12%, transparent)"
                : pnlSign === "loss"
                  ? "color-mix(in oklab, var(--color-loss) 12%, transparent)"
                  : "color-mix(in oklab, var(--color-muted-foreground) 8%, transparent)"
            }
            stroke="none"
          />
        ) : null}

        {/* Pre-entry segment: muted, the flat part of the line. */}
        {geometry.preEntryPoints.length >= 2 ? (
          <polyline
            points={toPoints(geometry.preEntryPoints)}
            fill="none"
            stroke="color-mix(in oklab, var(--color-muted-foreground) 40%, transparent)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Post-entry segment: the held part, coloured by pnl. */}
        {geometry.postEntryPoints.length >= 2 ? (
          <polyline
            points={toPoints(geometry.postEntryPoints)}
            fill="none"
            stroke={segmentColor}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* Horizontal price levels. The tags they belong to live in the HTML
            gutter below, so nothing here is text. */}
        {geometry.levels.map((level) => (
          <line
            key={`${level.kind}-${level.price}`}
            x1={0}
            y1={level.y}
            x2={PLOT_WIDTH}
            y2={level.y}
            stroke={levelStrokeColor(level.kind)}
            strokeWidth={1}
            strokeDasharray={level.kind === "entry" ? undefined : "4 3"}
            vectorEffect="non-scaling-stroke"
          />
        ))}

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
              stroke={levelStrokeColor(tag.kind)}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.5}
            />
          ))}

        {/* Mark dot: the one moving thing. Pinned at the right edge of the plot. */}
        {geometry.markPoint !== null ? (
          <circle
            cx={geometry.markPoint.x}
            cy={geometry.markPoint.y}
            r={3}
            fill={segmentColor}
            style={
              markMotion === "live"
                ? { animation: "mission-mark-pulse 1.6s ease-in-out infinite" }
                : undefined
            }
          />
        ) : null}
      </svg>

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
            <span
              key={tag.key}
              className="absolute left-1.5 flex max-w-full -translate-y-1/2 items-baseline gap-1 truncate"
              style={{
                top: `${(tag.labelY / CHART_VIEWBOX_HEIGHT) * 100}%`,
                color: tag.kind === "mark" ? segmentColor : levelStrokeColor(tag.kind),
                fontWeight: tag.kind === "mark" ? 600 : 400,
              }}
            >
              {glyph === "" ? null : <span>{glyph}</span>}
              <span>{formatPrice(tag.price)}</span>
              {tag.offScale === null ? null : <span>{tag.offScale === "above" ? "↑" : "↓"}</span>}
              {caption === "" ? null : (
                <span className="truncate opacity-70">
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
