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

import type { TradingChartCandle } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import {
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  PLOT_WIDTH,
  computeChartGeometry,
  type ChartLevelKind,
  type ChartPoint,
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
  readonly className?: string;
}

/** Map a level kind to its SVG stroke colour (CSS vars, the chart idiom). */
function levelStrokeColor(kind: ChartLevelKind): string {
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
  });

  // Too few candles → the parent renders a skeleton / "chart unavailable".
  if (geometry === null) return null;

  const segmentColor = pnlColor(pnlSign);
  const areaPath = toAreaPath(geometry.postEntryPoints);

  return (
    <svg
      viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("h-full w-full", className)}
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

      {/* Horizontal price levels + right-edge price tags. */}
      {geometry.levels.map((level) => {
        const stroke = levelStrokeColor(level.kind);
        const dashed = level.kind !== "entry";
        return (
          <g key={level.kind}>
            <line
              x1={0}
              y1={level.y}
              x2={PLOT_WIDTH}
              y2={level.y}
              stroke={stroke}
              strokeWidth={1}
              strokeDasharray={dashed ? "4 3" : undefined}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={PLOT_WIDTH + 6}
              y={level.y}
              fill={stroke}
              fontSize={10}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {formatPrice(level.price)}
            </text>
          </g>
        );
      })}

      {/* Mark dot: the one moving thing. Pinned at the right edge of the plot. */}
      {geometry.markPoint !== null ? (
        <g>
          <circle
            cx={geometry.markPoint.x}
            cy={geometry.markPoint.y}
            r={3}
            fill={segmentColor}
            style={{ animation: "mission-mark-pulse 1.6s ease-in-out infinite" }}
          />
          {markPrice !== null ? (
            <text
              x={PLOT_WIDTH + 6}
              y={geometry.markPoint.y}
              fill={segmentColor}
              fontSize={10}
              textAnchor="start"
              dominantBaseline="middle"
              fontWeight={600}
            >
              {formatPrice(markPrice)}
            </text>
          ) : null}
        </g>
      ) : null}
    </svg>
  );
}
