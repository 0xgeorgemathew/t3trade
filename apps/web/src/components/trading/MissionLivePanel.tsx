// ---------------------------------------------------------------------------
// MissionLivePanel
// ---------------------------------------------------------------------------
//
// The one pinned trading surface, docked directly above the composer. It
// replaces four separate ones — the position-gated chart dock, the plan card,
// the armed-conditions card, and the timeline's position card — which used to
// stack as boxes saying overlapping things, each consuming timeline height
// whether or not it was the thing the operator was looking at.
//
// Four explicit states, driven purely by the projection:
//
//   planning  no strategy yet          → one line, "Analysing the market…"
//   armed     strategy, flat, watching → chart + condition levels + plan summary
//   live      position open            → the same, plus P&L and the held figures
//   complete  mission finished         → the net result, until the row is deleted
//
// It is the same pane of glass as the composer it sits on — same surface tint,
// blur, saturation and hairline outline — because two stacked surfaces with
// different materials read as two objects, and this is one control strip.
//
// One rule holds the density down: a number appears exactly once. P&L, ROI and
// progress-to-target are header figures, so the position strip at the foot does
// not repeat them; the entry price is on the chart and in the strip but nowhere
// else on screen.
//
// `armed` and `live` draw the same surface. The chart's gate used to be "a
// position exists", which meant a mission spent its whole waiting phase showing
// nothing at all — and waiting is most of a mission's life. The plan's levels
// used to be gated the other way, on `armed`, so they all vanished the instant
// a fill landed. Both gates are gone: the levels change (armed draws what it is
// waiting for, live draws what it is holding against, and a PnL watch resolves
// to a price once there is an exposure to divide by), the surface does not.
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
  selectVisibleCandles,
  MAX_DRAWN_CONDITIONS,
} from "./missionChartGeometry";
import {
  deriveChartConditions,
  deriveChartFillMarkers,
  deriveChartPastMarkers,
  deriveChartTimeMarkers,
  deriveEffectiveLeverage,
  deriveNextReassessmentAt,
  deriveStrategyPlan,
  deriveUpNextItems,
  deriveWatchConditions,
  describeDelayedRead,
  formatDuration,
  formatLeverage,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
  formatSize,
  formatUsd,
  hyperliquidTradeUrl,
  isMissionComplete,
  type ChartFillMarker,
  type ChartPastMarkerInput,
  type ChartTimeMarkerInput,
  type StrategyPlan,
  type UpNextItem,
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

/**
 * How many condition rows the checklist shows before it says "+N more".
 *
 * The panel is pinned above the composer, so its height is taken directly out
 * of the conversation. A mission that has republished a few times can hold a
 * dozen watches, and the twelfth is never the one being read.
 */
const MAX_CONDITION_ROWS = 4;

/**
 * How many schedule pills the strip shows before it says "+N more".
 *
 * The strip is a single centered row directly above the composer. Six pills is
 * what fits one line on a narrow workspace, and the seventh-nearest event is
 * not the one anyone is reading.
 */
const MAX_UP_NEXT_PILLS = 6;

/**
 * How long a clicked level stays lit.
 *
 * Long enough to survive the eye travelling from the pill up to the chart, and
 * short enough that the highlight is over before the next 3s mission poll — a
 * rule that outlived the click would read as chart state rather than as an
 * answer to a question the operator asked.
 */
const FLASH_DURATION_MILLIS = 2_800;

/**
 * How many of the fetched bars the live chart draws.
 *
 * The RPC serves 120 (`maxBars` in `ws.ts`), which on a 1m series is two hours
 * — wide enough that an hour-old trade is a twentieth of the frame and a minute
 * of drift is a few pixels. Sixty bars is the hour that a 1m mission is
 * actually operating on: twice the price resolution, and twice the rate the
 * series slides left.
 */
const VISIBLE_BARS = 60;

/** The panel sits above the composer, so it is a card with its own edges rather
 *  than a band bolted to the header. */
const PANEL_BOX_CLASS = "mission-panel-glass overflow-hidden rounded-xl border";

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

  // --- Ticker: the panel's clock. -------------------------------------------
  //
  // Drives the hold time, the reassessment countdown, the staleness chip, and
  // — since the chart's x axis is now wall-clock — the leftward drift of the
  // series. One timer for all of it, at 1Hz: a text update and a ~120-point SVG
  // re-render, no animation loop and no GPU work, so this stays inside the
  // no-peg-the-GPU rule the same way it did when it only moved text.
  const [nowMillis, setNowMillis] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMillis(Date.now()), 1_000);
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
  // The stop is a property of an exposure, not of the plan that intends one.
  // `strategy.protection` survives the position that it protected — it is still
  // on the mission after the close, and often after the next republish — so
  // drawing it unconditionally left a stop rule hanging on the chart across a
  // flat mission, at a price nothing was protecting any more.
  const stopPrice = position === null ? null : (protection?.stopPrice ?? null);
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
      : formatDuration(nowMillis - resolvedEntryMillis);

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

  // --- What the plan is watching, in either state. --------------------------
  //
  // None of this used to survive the fill: the checklist and the chart levels
  // were gated on `armed`, so the moment a position opened every level the plan
  // was watching — invalidations, scale-ins, PnL floors — vanished from the
  // surface, leaving only entry/stop/target. Those are the levels that matter
  // most while exposed, so they are drawn in both states now.
  const watches = deriveWatchConditions(mission);
  const pnlBasis =
    position !== null && position.entryPrice !== undefined
      ? { entryPrice: position.entryPrice, size: position.size }
      : null;
  const chartConditions = deriveChartConditions(mission, pnlBasis);
  const droppedConditions = Math.max(0, chartConditions.length - MAX_DRAWN_CONDITIONS);

  // Every fill the session has made, as circles on the axis. A position that
  // opened and closed an hour ago has no row on the projection any more, but its
  // two fills are still here — so the chart, not the scrollback, is where the
  // session's whole activity is read.
  const fillMarkers = deriveChartFillMarkers(mission);

  // The order the agent has committed to but the book has not filled. This is
  // the "I will enter long at X" the plan announces, drawn where it will happen
  // rather than described in a card somewhere else on the screen.
  const inFlight = mission.inFlightExecution;
  const pendingOrder =
    inFlight === null ? null : { price: inFlight.limitPrice, side: inFlight.side };

  // The next reassessment, as a mark on the axis rather than only as a
  // countdown in the header — "3m from now" is a moment, and the chart has an
  // axis of moments.
  const nextReassessmentAt = deriveNextReassessmentAt(mission);

  // The whole schedule, not just its nearest item. The header's countdown is
  // one reassessment; this is every future event the projection carries.
  const upNext = deriveUpNextItems(mission, nowMillis);

  // Clicking a pill lights up the level it names on the chart. The strip and
  // the chart are two views of one set of price levels, and without this the
  // operator has to find "wake @ 1899" among four unlabelled rules by eye. The
  // nonce is what lets the same pill flash twice: it keys the overlay, so a
  // second click remounts it and the animation runs again.
  const [flash, setFlash] = useState<{ readonly price: number; readonly nonce: number } | null>(
    null,
  );
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), FLASH_DURATION_MILLIS);
    return () => clearTimeout(timer);
  }, [flash]);
  // Every armed reassessment, not only the nearest: the header's countdown is
  // one appointment, the axis is the whole queue.
  const timeMarkers = deriveChartTimeMarkers(mission);

  // What has already happened, as a rug of ticks along the axis: the mission's
  // own wakes, publishes and stop moves, which no amount of current state can
  // show. Bounded server-side, and again by the geometry's own cap.
  const pastMarkers = deriveChartPastMarkers(mission);

  // The checklist is capped because the panel now sits directly above the
  // composer: a mission that has republished a few times can hold a dozen
  // watches, and an unbounded list would push the input off the screen.
  const rows = watches?.rows ?? [];
  const visibleRows = rows.slice(0, MAX_CONDITION_ROWS);
  const hiddenRows = rows.length - visibleRows.length;

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
  // The quiet half of the staleness signal. The loud half — the banner that
  // claims placement is suspended — waits for a much older read.
  const delayedRead = describeDelayedRead(mission, nowMillis);

  // --- planning: one line, no chart. ----------------------------------------
  if (state === "planning") {
    return (
      <div
        data-testid="mission-live-panel"
        data-panel-state="planning"
        className={cn(
          PANEL_BOX_CLASS,
          "flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground sm:px-4",
        )}
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
        className={cn(
          PANEL_BOX_CLASS,
          "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs sm:px-4",
        )}
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
      <div data-testid="mission-live-panel" data-panel-state={state} className={PANEL_BOX_CLASS}>
        <CollapsedRow
          market={mission.market}
          leverageLabel={leverage === null ? null : formatLeverage(leverage)}
          summary={
            position === null
              ? describeArmedSummary(watches)
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
    <div data-testid="mission-live-panel" data-panel-state={state} className={PANEL_BOX_CLASS}>
      {/* Header: what the mission is doing, and the numbers that go with it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs sm:px-4">
        {position === null ? (
          <ArmedHeader
            market={mission.market}
            plan={plan}
            maximumLeverage={mission.authority.maximumLeverage}
            nextReassessmentAt={nextReassessmentAt}
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
          {delayedRead === null ? null : (
            <span
              className="text-armed"
              title="The position read is behind. Placement is only suspended once it stops landing altogether."
            >
              {delayedRead}
            </span>
          )}
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
          fills={fillMarkers}
          pendingOrder={pendingOrder}
          flash={flash}
          nowMillis={nowMillis}
          timeMarkers={timeMarkers}
          pastMarkers={pastMarkers}
        />
      </div>

      {/* The schedule, as one row of pills: what happens next, in the order it
          is likely to arrive. The checklist below says what is armed; this says
          when. */}
      {upNext.length === 0 ? null : (
        <div
          data-testid="mission-up-next"
          className="flex flex-wrap items-center justify-center gap-1.5 border-t border-border/40 px-3 py-1.5 sm:px-4"
        >
          {upNext.slice(0, MAX_UP_NEXT_PILLS).map((item) => (
            <UpNextPill
              key={item.key}
              item={item}
              isFlashed={flash !== null && item.priceLevel === flash.price}
              onSelect={
                item.priceLevel === null
                  ? null
                  : (price) => setFlash((prev) => ({ price, nonce: (prev?.nonce ?? 0) + 1 }))
              }
            />
          ))}
          {upNext.length > MAX_UP_NEXT_PILLS ? (
            <span className="text-[11px] text-muted-foreground">
              +{upNext.length - MAX_UP_NEXT_PILLS} more
            </span>
          ) : null}
        </div>
      )}

      {/* The full checklist, below the chart. The chart draws the four price
          levels nearest the mark; these rows are the exact set, including the
          watches that have no y on a price chart at all. */}
      {visibleRows.length === 0 ? null : (
        <div className="divide-y divide-border/40 border-t border-border/40">
          {visibleRows.map((row) => (
            <ConditionRow key={row.id} row={row} />
          ))}
          {hiddenRows === 0 && droppedConditions === 0 ? null : (
            <p className="px-3 py-1 text-[11px] text-muted-foreground sm:px-4">
              {hiddenRows > 0
                ? `+${hiddenRows} more condition${hiddenRows === 1 ? "" : "s"} armed`
                : `+${droppedConditions} more level${droppedConditions === 1 ? "" : "s"} armed, off the chart`}
            </p>
          )}
        </div>
      )}

      {/* What is actually held, at the foot of the panel. This used to be a
          `Position` card in the timeline — but a position is state, not an
          event, and state in a scrolling log reads as a fact from the moment
          you scrolled past. The fill receipts stay in the timeline, where an
          event with a timestamp belongs. */}
      {position === null ? null : (
        <PositionStrip
          size={position.size}
          entryPrice={position.entryPrice ?? null}
          markPrice={markPrice}
          liquidationPrice={position.liquidationPrice ?? null}
          protectedSize={position.protectedSize}
          marginUsed={position.marginUsed}
        />
      )}

      {/* The whole published plan, one disclosure away. It used to be a card in
          the timeline, where it consumed height on every scroll whether or not
          anyone was reading it. */}
      {plan === null ? null : <PlanDisclosure plan={plan} />}

      <FooterRow data={chart.data} />
    </div>
  );
}

/**
 * One schedule pill.
 *
 * Same pill language as the header chip — a hairline ring, a tinted ground and
 * an 11px label — because the strip is the same class of statement about the
 * mission and two pill shapes on one card would read as two systems. A
 * `warning` pill is the one exception: the plan named a trigger level and
 * nothing is armed there, which is a gap and should look like one.
 */
function UpNextPill({
  item,
  isFlashed,
  onSelect,
}: {
  readonly item: UpNextItem;
  /** Whether this pill's level is the one currently lit on the chart. */
  readonly isFlashed: boolean;
  /**
   * Called with the pill's price when it is clicked. Null for the items that
   * have no y on a price chart — a countdown, a working order with no limit —
   * and those render as plain spans rather than as buttons that do nothing.
   */
  readonly onSelect: ((price: number) => void) | null;
}): ReactNode {
  const price = item.priceLevel;
  const isClickable = onSelect !== null && price !== null;
  const Tag = isClickable ? "button" : "span";
  return (
    <Tag
      data-testid="mission-up-next-pill"
      data-kind={item.kind}
      data-tone={item.tone}
      data-flashed={isFlashed ? "true" : undefined}
      {...(isClickable
        ? {
            type: "button" as const,
            onClick: () => onSelect(price),
            title: `Show ${formatPrice(price)} on the chart`,
          }
        : {})}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] tabular-nums",
        item.tone === "warning"
          ? "border-armed/40 bg-armed/10 text-armed"
          : "border-border/60 bg-muted/40 text-muted-foreground",
        isClickable && "cursor-pointer transition-colors hover:bg-muted/70",
        isFlashed && "ring-1 ring-foreground/30",
      )}
    >
      <span className="text-foreground">{item.label}</span>
      {item.detail === null ? null : <span>{item.detail}</span>}
      {item.chip === null ? null : (
        <span className="rounded-full bg-foreground/10 px-1 text-[10px]">{item.chip}</span>
      )}
    </Tag>
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
  readonly fills: ReadonlyArray<ChartFillMarker>;
  readonly pendingOrder: { readonly price: number; readonly side: "buy" | "sell" } | null;
  readonly flash: { readonly price: number; readonly nonce: number } | null;
  readonly nowMillis: number;
  readonly timeMarkers: ReadonlyArray<ChartTimeMarkerInput>;
  readonly pastMarkers: ReadonlyArray<ChartPastMarkerInput>;
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
        // The tail of the fetched series, widened when an older fill would
        // otherwise fall off the left edge. See VISIBLE_BARS.
        candles={selectVisibleCandles(data.candles, VISIBLE_BARS, earliestFillAt(props.fills))}
        entryPrice={props.entryPrice}
        stopPrice={props.stopPrice}
        targetPrice={props.targetPrice}
        liquidationPrice={props.liquidationPrice}
        entryTime={props.entryTime}
        markPrice={props.markPrice}
        pnlSign={props.pnlSign}
        conditions={props.conditions}
        fills={props.fills}
        pendingOrder={props.pendingOrder}
        flash={props.flash}
        nowMillis={props.nowMillis}
        timeMarkers={props.timeMarkers}
        pastMarkers={props.pastMarkers}
        className={CHART_HEIGHT_CLASS}
      />
    );
  }
  return <Skeleton className={CHART_HEIGHT_CLASS} />;
}

/** The oldest fill's moment, which the chart window has to reach back to. */
function earliestFillAt(fills: ReadonlyArray<ChartFillMarker>): number | null {
  let earliest: number | null = null;
  for (const fill of fills) {
    if (earliest === null || fill.at < earliest) earliest = fill.at;
  }
  return earliest;
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

/**
 * The held position, as one wrapping line of `label value` pairs.
 *
 * Deliberately missing: unrealised P&L, ROI and progress-to-target. All three
 * are already in the panel header two bands up. One number, one place — the
 * whole reason the position card left the timeline was that the same figures
 * were being read in two places at once, and reproducing them here would have
 * moved the duplication rather than removed it.
 */
function PositionStrip({
  size,
  entryPrice,
  markPrice,
  liquidationPrice,
  protectedSize,
  marginUsed,
}: {
  readonly size: number;
  readonly entryPrice: number | null;
  readonly markPrice: number | null;
  readonly liquidationPrice: number | null;
  readonly protectedSize: number;
  readonly marginUsed: number;
}): ReactNode {
  // §16.1: a stop covering less than the position is the difference between a
  // bounded loss and an open-ended one, so it is a figure and not a checkmark.
  const protection =
    protectedSize === 0
      ? "None"
      : Math.abs(protectedSize) >= Math.abs(size)
        ? "Full"
        : `${formatSize(Math.abs(protectedSize))} of ${formatSize(Math.abs(size))}`;

  return (
    <div
      data-testid="mission-position-strip"
      className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-t border-border/40 px-3 py-1.5 text-[11px] tabular-nums text-muted-foreground sm:px-4"
    >
      <PositionStat label="Size" value={formatSize(Math.abs(size))} />
      {entryPrice === null ? null : <PositionStat label="Entry" value={formatPrice(entryPrice)} />}
      {markPrice === null ? null : <PositionStat label="Mark" value={formatPrice(markPrice)} />}
      {liquidationPrice === null ? null : (
        <PositionStat label="Liq" value={formatPrice(liquidationPrice)} />
      )}
      <PositionStat
        label="Protected"
        value={protection}
        // An unprotected position is the one fact on this line worth a colour.
        toneClass={protectedSize === 0 ? "text-loss" : undefined}
      />
      <PositionStat label="Margin" value={formatUsd(marginUsed)} />
    </div>
  );
}

function PositionStat({
  label,
  value,
  toneClass,
}: {
  readonly label: string;
  readonly value: string;
  readonly toneClass?: string | undefined;
}): ReactNode {
  return (
    <span>
      {label} <span className={toneClass ?? "text-foreground"}>{value}</span>
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
