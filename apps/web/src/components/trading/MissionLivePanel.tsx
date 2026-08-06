// ---------------------------------------------------------------------------
// MissionLivePanel
// ---------------------------------------------------------------------------
//
// The one pinned trading surface above the timeline. It replaces three separate
// ones — the position-gated chart dock, the plan card, and the armed-conditions
// card — which used to stack as three boxes saying overlapping things, each
// consuming timeline height whether or not it was the thing the operator was
// looking at.
//
// Four explicit states, driven purely by the projection:
//
//   planning  no strategy yet          → one line, "Analysing the market…"
//   armed     strategy, flat, watching → chart + condition levels + plan summary
//   live      position open            → chart + entry/stop/target + P&L header
//   complete  mission finished         → the net result, until the row is deleted
//
// The chart is the same in `armed` and `live`: the gate used to be "a position
// exists", which meant a mission spent its whole waiting phase showing nothing
// at all — and waiting is most of a mission's life. The levels change (armed
// draws what it is waiting for, live draws what it is holding against), the
// feed does not.
//
// Everything here is read from the projection. The chart feed
// (`useTradingMarketChart`, 15s poll) supplies candles + funding/OI/volume; the
// mission poll (3s) supplies the freshest mark via `mission.marketPrice`, so the
// pill and the chart can never show two different marks. No figure is invented:
// a missing denominator omits a figure rather than guessing.

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
  MAX_DRAWN_CONDITIONS,
} from "./missionChartGeometry";
import {
  deriveChartConditions,
  deriveEffectiveLeverage,
  deriveStrategyPlan,
  deriveWatchConditions,
  formatDuration,
  formatLeverage,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  hyperliquidTradeUrl,
  isMissionComplete,
  type StrategyPlan,
  type WatchConditionRow,
} from "./tradingPresentation";

/**
 * Module-level collapse state, keyed by mission id.
 *
 * Collapsing mission A must not collapse mission B, and the toggle must survive
 * a remount from the 3s poll. A record at module scope gives both without
 * forcing the call site to pass a `key`. The default is expanded — the panel is
 * the reason the thread is on screen.
 */
const collapsedMissions: Record<string, boolean> = {};

/** Expanded chart area height. */
const CHART_HEIGHT_CLASS = "h-[168px] w-full";
/** Collapsed summary row height, in pixels. */
const COLLAPSED_ROW_HEIGHT_PX = 32;

/** Which of the four surfaces the projection says to render. */
type PanelState = "planning" | "armed" | "live" | "complete";

function readPanelState(mission: OrchestrationTradingMission): PanelState {
  if (isMissionComplete(mission.status)) return "complete";
  // A closed position leaves its snapshot row behind with size zeroed, so this
  // is gated on exposure rather than on the row existing.
  if (mission.position !== null && mission.position.size !== 0) return "live";
  return mission.strategy === null ? "planning" : "armed";
}

export function MissionLivePanel({
  mission,
  environmentId,
}: {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
}): ReactNode {
  const state = readPanelState(mission);

  // --- Collapse state, per mission id. --------------------------------------
  const [collapsed, setCollapsed] = useState<boolean>(collapsedMissions[mission.id] ?? false);
  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      collapsedMissions[mission.id] = next;
      return next;
    });
  };

  // --- Ticker: re-renders the hold clock and the reassessment countdown. ----
  // A 1s text update is not a continuously repainting animation (no GPU work),
  // so it does not fall under the no-peg-the-GPU rule.
  const [, setNowTick] = useState<number>(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // --- Derivations from the projection. -------------------------------------
  const position =
    mission.position !== null && mission.position.size !== 0 ? mission.position : null;
  const strategy = mission.strategy;
  const plan = deriveStrategyPlan(mission);
  const protection = strategy?.protection;

  // Mark price: the 3s mission poll is fresher than the 15s candle feed, so it
  // wins. Falling back to the position snapshot's mark keeps the figure present
  // when the exchange read failed but the position is still known.
  const markPrice = mission.marketPrice ?? position?.markPrice ?? null;

  const entryPrice = position?.entryPrice ?? null;
  const stopPrice = protection?.stopPrice ?? null;
  const targetProfitUsd = protection?.targetProfitUsd ?? null;
  const targetPrice =
    entryPrice !== null && targetProfitUsd !== null && position !== null
      ? deriveTargetPrice(entryPrice, targetProfitUsd, position.size)
      : null;
  const progressPercent =
    markPrice !== null && entryPrice !== null && targetPrice !== null
      ? deriveProgressToTarget(markPrice, entryPrice, targetPrice)
      : null;

  const entryMillis = deriveEntryFillAtMillis(mission.recentFills);
  const resolvedEntryMillis =
    entryMillis ??
    (mission.result.firstFillAt === null ? null : Date.parse(mission.result.firstFillAt));
  const holdLabel =
    resolvedEntryMillis === null || Number.isNaN(resolvedEntryMillis)
      ? null
      : formatDuration(Date.now() - resolvedEntryMillis);

  const exchangeUrl = hyperliquidTradeUrl(mission.market, mission.tradingAccountId);

  // --- Chart feed. ----------------------------------------------------------
  // Live and armed both draw candles; planning has nothing to draw them against
  // yet, and complete is reported by the summary card in the timeline, so
  // neither puts a poll on the wire.
  const wantsChart = state === "armed" || state === "live";
  const interval: ChartInterval = strategy?.timeframes?.[0] ?? "1m";
  const chart = useTradingMarketChart(environmentId, mission.market, interval, {
    enabled: wantsChart,
  });

  // --- Armed-state derivations. ---------------------------------------------
  const armed = state === "armed" ? deriveWatchConditions(mission) : null;
  const chartConditions = state === "armed" ? deriveChartConditions(mission) : [];
  const droppedConditions = Math.max(0, chartConditions.length - MAX_DRAWN_CONDITIONS);

  const pnlSign: "profit" | "loss" | null =
    position === null ? null : position.unrealisedPnl >= 0 ? "profit" : "loss";
  const pnlToneClass =
    position !== null && position.unrealisedPnl < 0 ? "text-loss" : "text-profit";
  const leverage =
    mission.leverage ?? (position === null ? null : deriveEffectiveLeverage(position));
  const roiPercent =
    position !== null && position.marginUsed > 0
      ? (position.unrealisedPnl / position.marginUsed) * 100
      : null;

  // --- planning: one line, no chart. ----------------------------------------
  if (state === "planning") {
    return (
      <div
        data-testid="mission-live-panel"
        data-panel-state="planning"
        className="flex items-center gap-2 border-b border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground sm:px-4"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-armed" aria-hidden />
        <span>Analysing the market…</span>
        <span className="ml-auto text-foreground">{mission.market}</span>
      </div>
    );
  }

  // --- complete: the result, one line. --------------------------------------
  // The full review — the post-mortem chart and the fee/PnL breakdown — is the
  // completion summary card in the timeline. Repeating it here would put two
  // charts of the same finished trade on one screen for the few seconds before
  // the mission row is deleted.
  if (state === "complete") {
    const net = mission.result.realizedPnlUsd - mission.result.feesPaidUsd;
    return (
      <div
        data-testid="mission-live-panel"
        data-panel-state="complete"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card/40 px-3 py-2 text-xs sm:px-4"
      >
        <span className="text-foreground">{mission.market} finished</span>
        <span className={cn("font-medium tabular-nums", net >= 0 ? "text-profit" : "text-loss")}>
          {formatSignedUsd(net)} net
        </span>
        <span className="tabular-nums text-muted-foreground">
          {mission.result.fillCount} fill{mission.result.fillCount === 1 ? "" : "s"} ·{" "}
          {formatUsd(mission.result.feesPaidUsd)} fees
        </span>
      </div>
    );
  }

  // --- collapsed: the 32px summary row. -------------------------------------
  if (collapsed) {
    return (
      <div
        data-testid="mission-live-panel"
        data-panel-state={state}
        className="border-b border-border bg-card/40"
      >
        <CollapsedRow
          market={mission.market}
          leverageLabel={leverage === null ? null : formatLeverage(leverage)}
          summary={
            position === null
              ? describeArmedSummary(armed)
              : `${position.size > 0 ? "Long" : "Short"} · ${formatSignedUsd(position.unrealisedPnl)}`
          }
          summaryToneClass={position === null ? "text-muted-foreground" : pnlToneClass}
          progressPercent={progressPercent}
          onExpand={toggleCollapsed}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="mission-live-panel"
      data-panel-state={state}
      className="border-b border-border bg-card/40"
    >
      {/* Header: what the mission is doing, and the numbers that go with it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs sm:px-4">
        {position === null ? (
          <ArmedHeader
            market={mission.market}
            plan={plan}
            maximumLeverage={mission.authority.maximumLeverage}
            nextReassessmentAt={armed?.nextReassessmentAt ?? null}
          />
        ) : (
          <>
            <SideChip
              market={mission.market}
              leverageLabel={leverage === null ? null : formatLeverage(leverage)}
              isLong={position.size > 0}
            />
            <span className={cn("font-medium tabular-nums", pnlToneClass)}>
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
          </>
        )}
        <span className="ml-auto flex items-center gap-3">
          {chart.stale ? (
            <span className="text-muted-foreground" title="The last exchange read failed">
              delayed
            </span>
          ) : null}
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

      <div className="border-t border-border/40">
        <ChartSlot
          data={chart.data}
          isLoading={chart.isLoading}
          error={chart.error}
          entryPrice={entryPrice}
          stopPrice={stopPrice}
          targetPrice={targetPrice}
          liquidationPrice={position?.liquidationPrice ?? null}
          entryTime={entryMillis}
          markPrice={markPrice}
          pnlSign={pnlSign}
          conditions={chartConditions}
        />
      </div>

      {/* The full checklist, below the chart. The chart draws the four price
          levels nearest the mark; these rows are the exact set, including the
          watches that have no y on a price chart. */}
      {armed === null || armed.rows.length === 0 ? null : (
        <div className="divide-y divide-border/40 border-t border-border/40">
          {armed.rows.map((row) => (
            <ConditionRow key={row.id} row={row} />
          ))}
          {droppedConditions > 0 ? (
            <p className="px-3 py-1 text-[11px] text-muted-foreground sm:px-4">
              +{droppedConditions} more level{droppedConditions === 1 ? "" : "s"} armed, off the
              chart
            </p>
          ) : null}
        </div>
      )}

      {/* The whole published plan, one disclosure away. It used to be a card in
          the timeline, where it consumed height on every scroll whether or not
          anyone was reading it. */}
      {plan === null ? null : <PlanDisclosure plan={plan} />}

      <FooterRow data={chart.data} />
    </div>
  );
}

/** What a collapsed armed mission says in one clause. */
function describeArmedSummary(armed: { readonly rows: ReadonlyArray<unknown> } | null): string {
  if (armed === null || armed.rows.length === 0) return "Waiting";
  return `Waiting on ${armed.rows.length} condition${armed.rows.length === 1 ? "" : "s"}`;
}

/**
 * The armed header: what the plan intends, in the plainest terms it has.
 *
 * Leverage reads `up to 20x` rather than a number, because nothing is levered
 * yet — the figure is the authority's ceiling, not a position's setting.
 */
function ArmedHeader({
  market,
  plan,
  maximumLeverage,
  nextReassessmentAt,
}: {
  readonly market: string;
  readonly plan: StrategyPlan | null;
  readonly maximumLeverage: number;
  readonly nextReassessmentAt: number | null;
}): ReactNode {
  const countdown = formatReassessmentCountdown(nextReassessmentAt);
  return (
    <>
      <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-armed/40 bg-armed/10 px-2 py-px text-[11px] font-medium text-armed">
        <span>{market}</span>
        <span>Waiting</span>
      </span>
      {plan?.thesis == null ? null : (
        <span className="min-w-0 max-w-[36ch] truncate text-foreground" title={plan.thesis}>
          {plan.thesis}
        </span>
      )}
      {plan?.initialSizeUsd == null ? null : (
        <span className="tabular-nums text-muted-foreground">
          size {formatUsd(plan.initialSizeUsd)}
        </span>
      )}
      {plan?.maxLossUsd == null ? null : (
        <span className="tabular-nums text-muted-foreground">
          max loss {formatUsd(plan.maxLossUsd)}
        </span>
      )}
      <span className="tabular-nums text-muted-foreground">
        up to {formatLeverage(maximumLeverage)}
      </span>
      {countdown === null ? null : (
        <span className="tabular-nums text-muted-foreground">{countdown}</span>
      )}
    </>
  );
}

/**
 * The chart area, in its four explicit states. Loading and <2-candle states
 * never show a flat line at zero — the first reads as "data is coming", the
 * second as "too little to draw yet".
 */
function ChartSlot(props: {
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
  readonly conditions: ReadonlyArray<{
    readonly price: number;
    readonly direction: "above" | "below";
    readonly met: boolean;
  }>;
}): ReactNode {
  const { data, isLoading, error } = props;

  if (data === null && isLoading) {
    return <Skeleton className={CHART_HEIGHT_CLASS} />;
  }
  if (data === null && error !== null) {
    return (
      <div
        className={cn(
          CHART_HEIGHT_CLASS,
          "flex items-center justify-center text-xs text-muted-foreground",
        )}
      >
        Chart unavailable
      </div>
    );
  }
  if (data !== null && data.candles.length < 2) {
    return (
      <div
        className={cn(
          CHART_HEIGHT_CLASS,
          "flex items-center justify-center text-xs text-muted-foreground",
        )}
      >
        Building chart…
      </div>
    );
  }
  if (data !== null) {
    return (
      <MissionPriceChart
        candles={data.candles}
        entryPrice={props.entryPrice}
        stopPrice={props.stopPrice}
        targetPrice={props.targetPrice}
        liquidationPrice={props.liquidationPrice}
        entryTime={props.entryTime}
        markPrice={props.markPrice}
        pnlSign={props.pnlSign}
        conditions={props.conditions}
        className={CHART_HEIGHT_CLASS}
      />
    );
  }
  return <Skeleton className={CHART_HEIGHT_CLASS} />;
}

/** One row of the checklist: glyph, description, observed vs threshold. */
function ConditionRow({ row }: { readonly row: WatchConditionRow }): ReactNode {
  const glyph = row.met ? (
    <span className="text-profit" aria-label="condition met">
      ✓
    </span>
  ) : (
    <span className="text-muted-foreground" aria-label="condition waiting">
      ○
    </span>
  );

  // The observed value's format depends on the predicate it measures against.
  // A PnL watch reads a signed dollar figure; a price watch reads a market
  // price. The threshold follows the same rule, so a row that compares the two
  // never mixes a dollar value with a raw number.
  const isPnlRow = row.description.includes("PnL");
  const observed =
    row.observedValue === null
      ? "—"
      : isPnlRow
        ? formatSignedUsd(row.observedValue)
        : formatPrice(row.observedValue);
  const threshold =
    row.thresholdValue === null
      ? null
      : isPnlRow
        ? formatSignedUsd(row.thresholdValue)
        : formatPrice(row.thresholdValue);

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs sm:px-4">
      <span className="w-4 flex-none text-center">{glyph}</span>
      <span className="text-foreground">{row.description}</span>
      <span className="ml-auto flex items-baseline gap-2 tabular-nums">
        <span className={row.met ? "text-profit" : "text-foreground"}>{observed}</span>
        {threshold === null ? null : <span className="text-muted-foreground">/ {threshold}</span>}
        {row.met ? null : <span className="text-[11px] text-muted-foreground">← waiting</span>}
      </span>
    </div>
  );
}

/**
 * The header countdown to the next scheduled reassessment.
 *
 * "reassess in 2m" while one is armed and in the future; "reassess due" the
 * moment it has passed; null (the slot disappears) when none is armed.
 */
function formatReassessmentCountdown(nextReassessmentAt: number | null): string | null {
  if (nextReassessmentAt === null) return null;
  const remaining = nextReassessmentAt - Date.now();
  if (remaining <= 0) return "reassess due";
  return `reassess in ${formatDuration(remaining)}`;
}

/** Everything the published plan says, behind one disclosure. */
function PlanDisclosure({ plan }: { readonly plan: StrategyPlan }): ReactNode {
  return (
    <details className="border-t border-border/40 px-3 py-2 text-xs sm:px-4">
      <summary className="cursor-pointer select-none text-muted-foreground">
        View full plan · v{plan.version} · {plan.modeLabel}
      </summary>
      <div className="mt-2 space-y-1">
        {plan.thesis === null ? null : <PlanField label="Thesis" value={plan.thesis} />}
        {plan.regime === null ? null : <PlanField label="Regime" value={plan.regime} />}
        {plan.entryTriggers.length === 0 ? null : (
          <PlanField label="Entry trigger" value={plan.entryTriggers.join("; ")} />
        )}
        {plan.orderType === null ? null : <PlanField label="Order type" value={plan.orderType} />}
        {plan.initialSizeUsd === null ? null : (
          <PlanField label="Initial size" value={formatUsd(plan.initialSizeUsd)} />
        )}
        {plan.stopSummary === null ? null : <PlanField label="Stop" value={plan.stopSummary} />}
        <PlanField label="Target" value={formatUsd(plan.targetUsd)} />
        {plan.maxLossUsd === null ? null : (
          <PlanField label="Max loss" value={formatUsd(plan.maxLossUsd)} />
        )}
        <PlanField
          label="Scaling"
          value={`Scale-in ${plan.scaleInAllowed ? "allowed" : "not allowed"} · Partial exit ${
            plan.partialReductionAllowed ? "allowed" : "not allowed"
          }`}
        />
        {plan.invalidation.length === 0 ? null : (
          <PlanField label="Invalidation" value={plan.invalidation.join("; ")} />
        )}
        {plan.targetRationale === null ? null : (
          <PlanField label="Why this target" value={plan.targetRationale} />
        )}
        {plan.basis === null ? null : (
          <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-muted-foreground">
            {plan.basis.measurement === null ? null : (
              <span>
                Measurement{" "}
                <span className="tabular-nums text-foreground">{plan.basis.measurement}</span>
              </span>
            )}
            {plan.basis.lookback === null ? null : (
              <span>
                Lookback <span className="tabular-nums text-foreground">{plan.basis.lookback}</span>
              </span>
            )}
            {plan.basis.hold === null ? null : (
              <span>
                Hold <span className="tabular-nums text-foreground">{plan.basis.hold}</span>
              </span>
            )}
            {plan.basis.hitRate === null ? null : (
              <span>
                Hit rate <span className="tabular-nums text-foreground">{plan.basis.hitRate}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function PlanField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="w-24 flex-none text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{value}</span>
    </div>
  );
}

/** The live header's side chip, tinted by the exposure direction. */
function SideChip({
  market,
  leverageLabel,
  isLong,
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly isLong: boolean;
}): ReactNode {
  const tone = isLong
    ? "border-profit/40 bg-profit/10 text-profit"
    : "border-loss/40 bg-loss/10 text-loss";
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-px text-[11px] font-medium",
        tone,
      )}
    >
      <span>{market}</span>
      {leverageLabel === null ? null : (
        <span className="rounded-sm bg-current/15 px-1 tabular-nums">{leverageLabel}</span>
      )}
      <span>{isLong ? "Long" : "Short"}</span>
    </span>
  );
}

/** The collapsed summary row: one line at 32px, with a chevron to expand. */
function CollapsedRow({
  market,
  leverageLabel,
  summary,
  summaryToneClass,
  progressPercent,
  onExpand,
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly summary: string;
  readonly summaryToneClass: string;
  readonly progressPercent: number | null;
  readonly onExpand: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand chart"
      data-testid="mission-live-panel-collapsed"
      className="flex w-full items-center gap-2 px-3 text-xs tabular-nums text-muted-foreground sm:px-4"
      style={{ height: COLLAPSED_ROW_HEIGHT_PX }}
    >
      <span className="text-foreground">
        {market}
        {leverageLabel === null ? "" : ` ${leverageLabel}`}
      </span>
      <span className={cn("font-medium", summaryToneClass)}>{summary}</span>
      {progressPercent === null ? null : <span>· {Math.round(progressPercent)}% to target</span>}
      <span className="ml-auto">
        <ChevronDown className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}

/**
 * The footer's research snapshot, compacted to one line.
 *
 * Two of the figures need converting before they match their labels.
 * `fundingRate8h` is a rate, not a percentage (0.000125 is 0.0125%/8h), and
 * `openInterest` is in base units of the market, so a dollar figure is the mark
 * price times the size.
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
        Funding <span className="text-foreground">{(data.fundingRate8h * 100).toFixed(4)}%</span>/8h
      </span>
      <span>
        OI <span className="text-foreground">{formatUsd(data.openInterest * data.markPrice)}</span>
      </span>
      <span>
        24h vol <span className="text-foreground">{formatUsd(data.dayVolumeUsd)}</span>
      </span>
      <span className={changeTone}>24h {formatSignedPercent(data.change24hPercent)}</span>
    </div>
  );
}
