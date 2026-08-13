// ---------------------------------------------------------------------------
// MissionReviewChart
// ---------------------------------------------------------------------------
//
// The post-mortem chart on a finished mission's completion card: the price
// series over the span the trade actually occupied, with the entry drawn as a
// level and the exit as a static dot at the right edge.
//
// It is a ONE-SHOT read, not a poll. The window is closed — the mission is
// terminal and its last fill is in the past — so re-reading it would return the
// same bars for as long as the card is mounted.

import type { EnvironmentId, TradingFillView } from "@t3tools/contracts";
import { useMemo } from "react";

import type { ChartInterval } from "~/lib/tradingMarketChartState";
import { useTradingMarketChart } from "~/lib/tradingMarketChartState";
import { Skeleton } from "../ui/skeleton";

import { MissionPriceChart } from "./MissionPriceChart";
import { deriveChartFillMarkers, deriveReviewMarkers } from "./tradingPresentation";

/** Matches the live panel's chart height so the two surfaces read as one. */
const CHART_HEIGHT_CLASS = "h-[168px] w-full";

/**
 * Padding either side of the traded span, as a share of that span.
 *
 * A window of exactly first-fill → last-fill would put the entry hard against
 * the left edge and the exit against the right, with no context for either. A
 * fifth on each side shows the approach and the aftermath.
 */
const WINDOW_PADDING_RATIO = 0.2;

/**
 * The narrowest window worth asking for, in millis.
 *
 * A scalp that opened and closed inside a minute would otherwise request a span
 * shorter than a single bar and get one candle back — too few for the geometry
 * to draw. Fifteen minutes is enough bars at every interval the RPC accepts.
 */
const MIN_WINDOW_MILLIS = 15 * 60 * 1_000;

/**
 * The candle interval that renders a span of `millis` at a readable density.
 *
 * The server caps a chart at 120 bars, so the interval has to widen with the
 * span or the window is silently truncated to its most recent 120 bars — which
 * on a long mission would cut off the entry the chart exists to show. Each
 * threshold is the widest span the previous interval covers in 120 bars.
 */
function intervalForSpan(millis: number): ChartInterval {
  const minutes = millis / 60_000;
  if (minutes <= 120) return "1m";
  if (minutes <= 360) return "3m";
  if (minutes <= 600) return "5m";
  if (minutes <= 1_800) return "15m";
  return "1h";
}

interface MissionReviewChartProps {
  readonly environmentId: EnvironmentId;
  readonly market: string;
  /** ISO timestamps of the first and last fill; null when the mission never traded. */
  readonly firstFillAt: string | null;
  readonly lastFillAt: string | null;
  readonly recentFills: ReadonlyArray<TradingFillView>;
  /** Tints the held segment the way the mission's net result reads. */
  readonly pnlSign: "profit" | "loss" | null;
}

/**
 * The traded span, padded and floored, or null when the mission has no fills to
 * window to (nothing traded, or timestamps that did not parse).
 */
function reviewWindow(
  firstFillAt: string | null,
  lastFillAt: string | null,
): { readonly startTime: number; readonly endTime: number } | null {
  if (firstFillAt === null || lastFillAt === null) return null;

  const first = Date.parse(firstFillAt);
  const last = Date.parse(lastFillAt);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

  const traded = Math.max(last - first, MIN_WINDOW_MILLIS);
  const pad = traded * WINDOW_PADDING_RATIO;
  return { startTime: first - pad, endTime: last + pad };
}

export function MissionReviewChart(props: MissionReviewChartProps) {
  const { environmentId, market, firstFillAt, lastFillAt, recentFills, pnlSign } = props;

  const window = useMemo(
    () => reviewWindow(firstFillAt, lastFillAt) ?? undefined,
    [firstFillAt, lastFillAt],
  );
  const markers = useMemo(() => deriveReviewMarkers(recentFills), [recentFills]);
  // Every fill, not just the entry and the exit: a mission that scaled in twice
  // and out three times is a different trade from one that went in and out once,
  // and the post-mortem is exactly where that difference is worth seeing.
  const fillMarkers = useMemo(() => deriveChartFillMarkers({ recentFills }), [recentFills]);
  const interval = window === undefined ? "1m" : intervalForSpan(window.endTime - window.startTime);

  const chart = useTradingMarketChart(environmentId, market, interval, {
    enabled: window !== undefined,
    ...(window !== undefined ? { window } : {}),
  });

  // A mission with no fills has no trade to review; the figures carry the card.
  if (window === undefined) return null;

  if (chart.data === null && chart.isLoading) {
    return <Skeleton className={CHART_HEIGHT_CLASS} />;
  }
  if (chart.data === null || chart.data.candles.length < 2) {
    return (
      <div className="flex h-[168px] items-center justify-center text-xs text-muted-foreground">
        Review chart unavailable
      </div>
    );
  }

  return (
    <MissionPriceChart
      candles={chart.data.candles}
      entryPrice={markers.entryPrice}
      stopPrice={null}
      targetPrice={null}
      liquidationPrice={null}
      entryTime={firstFillAt === null ? null : Date.parse(firstFillAt)}
      markPrice={markers.exitPrice}
      markMotion="static"
      fills={fillMarkers}
      pnlSign={pnlSign}
      className={CHART_HEIGHT_CLASS}
    />
  );
}
