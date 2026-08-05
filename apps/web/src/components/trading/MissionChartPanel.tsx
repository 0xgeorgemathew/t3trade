// ---------------------------------------------------------------------------
// MissionChartPanel
// ---------------------------------------------------------------------------
//
// The sticky position chart dock (Step 3 of plan 21). Mounted between the
// header banners and the timeline, it is the centrepiece of an open position:
// the shape of the trade you are in, with its levels and its mark, alongside
// the live P&L and the research snapshot that framed the entry.
//
// It renders ONLY while a position is open (`mission.position !== null &&
// position.size !== 0`). Before an entry there is no trade to draw; after a
// close the snapshot row is left behind with size zeroed, and drawing a chart
// for that row would be a chart of a trade that is no longer there.
//
// Everything the panel shows is read from the projection. The chart feed
// (`useTradingMarketChart`, 15s poll) supplies candles + funding/OI/volume;
// the mission poll (3s) supplies the freshest mark via `mission.marketPrice`,
// so the pill and the chart can never show two different marks. No figure is
// invented: a missing denominator omits a figure rather than guessing.

import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingMarketChartView,
} from "@t3tools/contracts";
import { ChevronDown, ChevronUp, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { ChartInterval } from "~/lib/tradingMarketChartState";
import { useTradingMarketChart } from "~/lib/tradingMarketChartState";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

import { MissionPriceChart } from "./MissionPriceChart";
import {
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
} from "./missionChartGeometry";
import {
  deriveEffectiveLeverage,
  formatDuration,
  formatLeverage,
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  hyperliquidTradeUrl,
} from "./tradingPresentation";

/**
 * Module-level collapse state, keyed by mission id.
 *
 * The plan requires per-mission collapse: collapsing mission A must not
 * collapse mission B. A single record at module scope keeps each mission's
 * toggle independent without forcing the call site to pass a `key`. The
 * default is expanded — a fresh position-open is the moment the chart earns
 * its space.
 */
const collapsedMissions: Record<string, boolean> = {};

/** Expanded chart area height, in pixels. */
const CHART_HEIGHT_CLASS = "h-[168px] w-full";
/** Collapsed summary row height, in pixels. */
const COLLAPSED_ROW_HEIGHT_PX = 32;

export function MissionChartPanel({
  mission,
  environmentId,
}: {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
}): ReactNode {
  // --- Visibility gate: render only while a position is open. ---------------
  const position = mission.position;
  if (position === null || position.size === 0) return null;

  return (
    <MissionChartPanelInner mission={mission} environmentId={environmentId} position={position} />
  );
}

/**
 * The inner panel, split out so the visibility gate above can early-return
 * before any hooks run. Once `position` is non-null this mounts and stays
 * mounted for the life of the open position.
 */
function MissionChartPanelInner({
  mission,
  environmentId,
  position,
}: {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
  readonly position: NonNullable<OrchestrationTradingMission["position"]>;
}): ReactNode {
  // --- Collapse state, per mission id. --------------------------------------
  const [collapsed, setCollapsed] = useState<boolean>(collapsedMissions[mission.id] ?? false);
  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      collapsedMissions[mission.id] = next;
      return next;
    });
  };

  // --- Hold-time ticker: re-renders the "held Nm Ns" span once a second. ----
  // A 1s text update is not a continuously repainting animation (no GPU work),
  // so it does not fall under the no-peg-the-GPU rule. The interval is cleared
  // on unmount.
  const [, setNowTick] = useState<number>(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // --- Derivations from the projection. -------------------------------------
  const direction = position.size > 0 ? "long" : "short";
  const isLong = position.size > 0;
  const pnlToneClass = position.unrealisedPnl >= 0 ? "text-profit" : "text-loss";

  // Leverage: prefer the exchange's mission-level setting, fall back to the
  // notional-over-margin reading. Same precedence as MissionThreadCards.
  const leverage = mission.leverage ?? deriveEffectiveLeverage(position) ?? null;
  const leverageLabel = leverage === null ? null : formatLeverage(leverage);

  // ROI: unrealised over margin. Omit when the denominator is zero (no margin
  // to measure a return against — inventing a figure would be a lie).
  const roiPercent =
    position.marginUsed > 0 ? (position.unrealisedPnl / position.marginUsed) * 100 : null;

  // Mark price: the 3s mission poll is fresher than the 15s candle feed, so it
  // wins. Falling back to the position snapshot's mark keeps the figure present
  // when the exchange read failed but the position is still known.
  const markPrice = mission.marketPrice ?? position.markPrice ?? null;

  // Target price: needs entry, strategy, and the planned profit, all present.
  // Omit the target-derived figures entirely when any is missing rather than
  // guessing.
  const entryPrice = position.entryPrice ?? null;
  const strategy = mission.strategy;
  const protection = strategy?.protection;
  const stopPrice = protection?.stopPrice ?? null;
  const targetProfitUsd = protection?.targetProfitUsd ?? null;
  const targetPrice =
    entryPrice !== null && targetProfitUsd !== null
      ? deriveTargetPrice(entryPrice, targetProfitUsd, position.size)
      : null;
  const progressPercent =
    markPrice !== null && entryPrice !== null && targetPrice !== null
      ? deriveProgressToTarget(markPrice, entryPrice, targetPrice)
      : null;

  // Entry time: the newest "open" fill, falling back to the result's firstFill.
  const entryMillis = deriveEntryFillAtMillis(mission.recentFills);
  const resolvedEntryMillis =
    entryMillis ??
    (mission.result.firstFillAt === null ? null : Date.parse(mission.result.firstFillAt));
  const holdLabel =
    resolvedEntryMillis === null || Number.isNaN(resolvedEntryMillis)
      ? null
      : formatDuration(Date.now() - resolvedEntryMillis);

  // Exchange link. Absent when the account id names no network — a wrong venue
  // is worse than no link.
  const exchangeUrl = hyperliquidTradeUrl(mission.market, mission.tradingAccountId);

  // --- Chart feed. ----------------------------------------------------------
  // Interval from the strategy's primary timeframe; the union matches
  // ChartInterval exactly. Default 1m when no strategy/timeframe is published.
  const timeframe = strategy?.timeframes?.[0];
  const interval: ChartInterval = timeframe ?? "1m";
  const chart = useTradingMarketChart(environmentId, mission.market, interval, {
    enabled: true,
  });
  const data = chart.data;

  // pnlSign drives the post-entry segment + fill colour. The chart's own mark
  // comes from `markPrice` above (mission poll), NOT from data.markPrice.
  const pnlSign: "profit" | "loss" | null = position.unrealisedPnl >= 0 ? "profit" : "loss";
  const liquidationPrice = position.liquidationPrice ?? null;

  // --- Collapsed: just the 32px summary row. --------------------------------
  if (collapsed) {
    return (
      <div data-testid="mission-chart-panel" className="border-b border-border bg-card/40">
        <CollapsedRow
          market={mission.market}
          leverageLabel={leverageLabel}
          direction={direction}
          pnlLabel={formatSignedUsd(position.unrealisedPnl)}
          pnlToneClass={pnlToneClass}
          progressPercent={progressPercent}
          onExpand={toggleCollapsed}
        />
      </div>
    );
  }

  // --- Expanded: chart slot (one of four states), then assemble. ------------
  const chartSlot = renderChartSlot({
    data,
    isLoading: chart.isLoading,
    error: chart.error,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    entryTime: entryMillis,
    markPrice,
    pnlSign,
  });

  return (
    <div data-testid="mission-chart-panel" className="border-b border-border bg-card/40">
      {/* Header row: the live P&L line, always visible while expanded. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs sm:px-4">
        <SideChip
          market={mission.market}
          leverageLabel={leverageLabel}
          direction={direction}
          isLong={isLong}
        />
        <span className={cn("tabular-nums font-medium", pnlToneClass)}>
          {formatSignedUsd(position.unrealisedPnl)}
        </span>
        {roiPercent === null ? null : (
          <span className={cn("tabular-nums", pnlToneClass)}>
            {formatSignedPercent(roiPercent)}
          </span>
        )}
        {progressPercent === null ? null : (
          <span className="tabular-nums text-muted-foreground">
            {Math.round(progressPercent)}% to target
          </span>
        )}
        {holdLabel === null ? null : (
          <span className="tabular-nums text-muted-foreground">held {holdLabel}</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {exchangeUrl === null ? null : (
            <a
              href={exchangeUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              open on hyperliquid
              <ExternalLinkIcon className="size-3" aria-hidden />
            </a>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Collapse chart"
            className="text-muted-foreground hover:text-foreground"
          >
            <ChevronUp className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>

      <div className="border-t border-border/40">{chartSlot}</div>

      {/* Footer: the research snapshot, one compact line. */}
      <FooterRow data={data} />
    </div>
  );
}

/**
 * The chart area, in its four explicit states. Loading and <2-candle states
 * never show a flat line at zero — the first reads as "data is coming", the
 * second as "too little to draw yet".
 */
function renderChartSlot(input: {
  readonly data: TradingMarketChartView | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  readonly entryTime: number | null;
  readonly markPrice: number | null;
  readonly pnlSign: "profit" | "loss" | null;
}): ReactNode {
  const { data, isLoading, error } = input;

  if (data === null && isLoading) {
    // 1. Loading: a skeleton line, never a flat line at zero.
    return <Skeleton className={CHART_HEIGHT_CLASS} />;
  }
  if (data === null && error !== null) {
    // 2. Failure: P&L still shows in the header; the chart says why it is blank.
    return (
      <div className={cn("flex items-center justify-center text-xs text-muted-foreground")}>
        Chart unavailable
      </div>
    );
  }
  if (data !== null && data.candles.length < 2) {
    // 3. Fewer than two candles: MissionPriceChart would return null anyway.
    return (
      <div className={cn("flex items-center justify-center text-xs text-muted-foreground")}>
        Building chart…
      </div>
    );
  }
  if (data !== null) {
    // 4. Happy path.
    return (
      <MissionPriceChart
        candles={data.candles}
        entryPrice={input.entryPrice}
        stopPrice={input.stopPrice}
        targetPrice={input.targetPrice}
        liquidationPrice={input.liquidationPrice}
        entryTime={input.entryTime}
        markPrice={input.markPrice}
        pnlSign={input.pnlSign}
        className={CHART_HEIGHT_CLASS}
      />
    );
  }
  // Defensive: data === null with no loading and no error — treat as loading.
  return <Skeleton className={CHART_HEIGHT_CLASS} />;
}

/** The expanded header's side label chip, tinted by the exposure direction. */
function SideChip({
  market,
  leverageLabel,
  direction,
  isLong,
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly direction: "long" | "short";
  readonly isLong: boolean;
}): ReactNode {
  const tone = isLong
    ? "border-profit/40 bg-profit/10 text-profit"
    : "border-loss/40 bg-loss/10 text-loss";
  const leverageTag =
    leverageLabel === null ? null : (
      <span className="rounded-sm bg-current/15 px-1 tabular-nums">{leverageLabel}</span>
    );
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-px text-[11px] font-medium",
        tone,
      )}
    >
      <span>{market}</span>
      {leverageTag}
      <span>{direction === "long" ? "Long" : "Short"}</span>
    </span>
  );
}

/** The collapsed summary row: one line at 32px, with a chevron to expand. */
function CollapsedRow({
  market,
  leverageLabel,
  direction,
  pnlLabel,
  pnlToneClass,
  progressPercent,
  onExpand,
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly direction: "long" | "short";
  readonly pnlLabel: string;
  readonly pnlToneClass: string;
  readonly progressPercent: number | null;
  readonly onExpand: () => void;
}): ReactNode {
  const leveragePart = leverageLabel === null ? "" : ` ${leverageLabel}`;
  const directionPart = direction === "long" ? "Long" : "Short";
  const progressPart =
    progressPercent === null ? null : ` · ${Math.round(progressPercent)}% to target`;
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand chart"
      data-testid="mission-chart-panel-collapsed"
      className="flex w-full items-center gap-2 px-3 text-xs tabular-nums text-muted-foreground sm:px-4"
      style={{ height: COLLAPSED_ROW_HEIGHT_PX }}
    >
      <span className="text-foreground">
        {market}
        {leveragePart} {directionPart}
      </span>
      <span className={cn("font-medium", pnlToneClass)}>{pnlLabel}</span>
      {progressPart === null ? null : <span>{progressPart}</span>}
      <span className="ml-auto">
        <ChevronDown className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}

/**
 * The footer's research snapshot, compacted to one line. Omitted to a bare
 * spacer when the chart feed has no data (the figures would be stale or
 * absent); the `text-[11px] tabular-nums text-muted-foreground` matches the
 * Card meta style from MissionThreadPanel.
 */
function FooterRow({ data }: { readonly data: TradingMarketChartView | null }): ReactNode {
  if (data === null) {
    // Keep the row's border so expanding/collapsing doesn't reflow.
    return <div className="h-6 border-t border-border/40" />;
  }
  const changeTone =
    data.change24hPercent > 0
      ? "text-profit"
      : data.change24hPercent < 0
        ? "text-loss"
        : "text-muted-foreground";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/40 px-3 py-1 text-[11px] tabular-nums text-muted-foreground sm:px-4">
      <span>
        Funding <span className="text-foreground">{data.fundingRate8h}%</span>/8h
      </span>
      <span>
        OI <span className="text-foreground">{formatUsd(data.openInterest)}</span>
      </span>
      <span>
        24h vol <span className="text-foreground">{formatUsd(data.dayVolumeUsd)}</span>
      </span>
      <span className={changeTone}>24h {formatSignedPercent(data.change24hPercent)}</span>
    </div>
  );
}
