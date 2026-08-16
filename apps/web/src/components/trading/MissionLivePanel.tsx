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
//   planning  no strategy yet          → chart + schedule, "Analysing the market…"
//   armed     strategy, flat, watching → chart + condition levels + plan summary
//   live      position open            → the same, plus P&L and the held figures
//   complete  mission finished         → the net result, kept for good (plan 27 H1)
//
// It is the same pane of glass as the composer it sits on — same surface tint,
// blur, saturation and hairline outline — because two stacked surfaces with
// different materials read as two objects, and this is one control strip.
//
// Every figure on it is set in the mono face, at one of two sizes: the P&L at
// 16px because it is the number being read, and everything else at 10.5-11px
// because it is context for that number. Prose — the plan's thesis, the
// disclosure — stays in the UI face. Mixing a proportional face into a column
// of prices is what made four rows of numbers read as four unrelated facts.
//
// One rule holds the density down: a number appears exactly once. P&L, ROI and
// progress-to-target are header figures, so the position strip at the foot does
// not repeat them; the entry price is on the chart and in the strip but nowhere
// else on screen.
//
// `planning`, `armed` and `live` draw the same surface; what differs is how
// much of it there is anything to say about. Planning has a market, a mark, a
// candle series and a run history from its first turn, and none of that needs a
// published strategy — but it has no thesis, no levels and no target, so the
// header states only the market and the mark, and the checklist and plan
// disclosure are absent rather than empty. Nothing on the surface is invented
// to fill the space a plan will later take.
//
// The chart's gate used to be "a
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
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";

import type { ChartInterval } from "~/lib/tradingMarketChartState";
import { useTradingMarketChart } from "~/lib/tradingMarketChartState";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

import { MissionPriceChart } from "./MissionPriceChart";
import { useMissionPlanRevision } from "./useMissionPlanRevision";
import {
  dedupeConditions,
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
  selectVisibleCandles,
  MAX_DRAWN_CONDITIONS,
  type ChartLevelKind,
} from "./missionChartGeometry";
import {
  deriveChartConditions,
  deriveChartFillMarkers,
  deriveChartPastMarkers,
  deriveChartTimeMarkers,
  deriveEffectiveLeverage,
  deriveNextReassessmentAt,
  deriveStrategyPlan,
  deriveTriggerExpiryMillis,
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

/**
 * The band heading — `next`, `armed`, `held` — that starts each section on the
 * panel's left rule.
 *
 * Mono, wide-tracked and set in the faintest ink on the card: it is a label for
 * the row beneath it, never a figure to read. The wide tracking is what keeps a
 * four-letter lowercase word legible at 10px, and it separates the legend from
 * the mono values in the same band without needing a second colour.
 */
const BAND_LEGEND_CLASS =
  "font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70";

/**
 * The two context strips — the schedule and the held line — that bracket the
 * checklist. Both sit on the same faint ground, a shade off the card, so the
 * checklist between them reads as the panel's centre of gravity.
 */
const CONTEXT_BAND_CLASS = "border-t border-border/40 bg-foreground/[0.018] px-3 py-1.5 sm:px-4";

/** Which of the four surfaces the projection says to render. */
export type PanelState = "planning" | "armed" | "live" | "complete";

export function readPanelState(mission: OrchestrationTradingMission): PanelState {
  if (isMissionComplete(mission.status)) return "complete";
  // A closed position leaves its snapshot row behind with size zeroed, so this
  // is gated on exposure rather than on the row existing.
  if (mission.position !== null && mission.position.size !== 0) return "live";
  return mission.strategy === null ? "planning" : "armed";
}

/**
 * Whether a state draws candles, and so puts the 15s chart poll on the wire.
 *
 * Everything the chart needs — a market and an interval — exists from mission
 * creation, so the only state that sits it out is the finished one, whose chart
 * is the timeline's completion summary.
 */
export function panelWantsChart(state: PanelState): boolean {
  return state !== "complete";
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

  // Mark price: the 3s mission poll is fresher than the 15s candle feed, so it
  // wins. Falling back to the position snapshot's mark keeps the figure present
  // when the exchange read failed but the position is still known.
  const markPrice = mission.marketPrice ?? position?.markPrice ?? null;

  const entryPrice = position?.entryPrice ?? null;
  // The stop is a property of an exposure, not of the plan that intends one.
  // The stop leg survives the position that it protected — it is still on the
  // mission after the close, and often after the next republish — so drawing it
  // unconditionally left a stop rule hanging on the chart across a flat
  // mission, at a price nothing was protecting any more.
  const stopPrice = position === null ? null : (strategy?.stop.price ?? null);
  // A stand-aside plan names no target, and drawing a target line from any
  // other figure on it would put a level on the chart for a trade that was
  // explicitly declined.
  const targetProfitUsd = plan?.isStandAside === true ? null : (strategy?.target.profitUsd ?? null);
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

  // --- The operator's own hand on the plan (step 8.4). ----------------------
  //
  // A drag is a `plan()` revision, so it needs the plan the model published and
  // the mission version the panel last read. Both come off the projection; the
  // eight authored fields go out unchanged but for the one leaf that moved.
  const revision = useMissionPlanRevision(mission.id, environmentId);
  const onLevelDragEnd = useCallback(
    (kind: ChartLevelKind, price: number) => {
      if (strategy === null) return;
      if (kind === "stop")
        revision.revise(strategy, { kind: "stop", price }, mission.missionVersion);
      if (kind === "target")
        revision.revise(strategy, { kind: "target", price }, mission.missionVersion);
    },
    [mission.missionVersion, revision, strategy],
  );
  // Only what the plan actually states. A stop rule drawn from a plan with no
  // stop price would be draggable into publishing a price the plan never had.
  const draggableKinds: ReadonlyArray<ChartLevelKind> =
    strategy === null
      ? []
      : [
          ...(stopPrice === null ? [] : (["stop"] as const)),
          ...(strategy.target.price === undefined ? [] : (["target"] as const)),
        ];

  // --- Chart feed. ----------------------------------------------------------
  // Planning draws candles too. The chart needs a market and an interval, both
  // known the moment the mission is created — gating it on a published strategy
  // meant a mission that had taken four turns, and had a market, a mark and a
  // run history, showed one line of text saying it was thinking. Only
  // `complete` sits it out: that mission is reported by the summary card in the
  // timeline, and a second chart of the same finished trade is a duplicate.
  const wantsChart = panelWantsChart(state);
  // The same rule the runtime resolves its own candles with: the interval the
  // mandate names, else 1m. Following the plan's `timeframes[0]` instead meant
  // a plan published on 15m drew a 15m chart of a mission the runtime was
  // waking on 1m structure — two pictures of one mission that disagreed.
  const interval: ChartInterval = runtimeTimeframe(mission.instruction);
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
  // Deduped before it is counted: two watches at one price are one level on a
  // price axis, and counting them twice made "+1 more level armed, off the
  // chart" appear about a level that was already drawn.
  const chartConditions = dedupeConditions(deriveChartConditions(mission, pnlBasis));
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

  // How far the armed entry triggers are drawn into the future gutter: to the
  // plan's own reassessment horizon, and no further. A trigger rule running to
  // the frame edge claims the mission will still be waiting at that price then.
  const triggerExpiryAt = deriveTriggerExpiryMillis(mission);

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
  //
  // Planning shows none of them. The only thing armed before a publish is the
  // staleness reassessment, which the schedule strip above already names — and
  // a checklist headed by a condition the mission never chose reads as a plan
  // when there is not one.
  const rows = state === "planning" ? [] : (watches?.rows ?? []);
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

  // --- complete: the result, one line. --------------------------------------
  // The full review — the post-mortem chart and the fee/PnL breakdown — is the
  // completion summary card in the timeline. Repeating it here would put two
  // charts of the same finished trade on one screen. The row survives settle
  // now (plan 27 H1), so this one-liner is the settled thread's permanent
  // trading surface above the composer.
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
        <span className={cn("font-mono tabular-nums", net >= 0 ? "text-profit" : "text-loss")}>
          {formatSignedUsd(net)} net
        </span>
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
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
            state === "planning"
              ? "Analysing"
              : position === null
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
        {state === "planning" ? (
          <PlanningHeader
            market={mission.market}
            markPrice={markPrice}
            nextReassessmentAt={nextReassessmentAt}
          />
        ) : position === null ? (
          <ArmedHeader
            market={mission.market}
            plan={plan}
            nextReassessmentAt={nextReassessmentAt}
          />
        ) : (
          <>
            <SideChip
              market={mission.market}
              leverageLabel={leverage === null ? null : formatLeverage(leverage)}
              isLong={position.size > 0}
            />
            {/* The one figure the operator is actually reading, at the one
                size on this row that says so, and in the mono face every other
                figure on the panel is set in. Everything after it is context
                for it, grouped behind a separator and set in the muted ink
                the rest of the panel uses for context. */}
            <span
              className={cn(
                "font-mono text-base leading-none tracking-[-0.01em] tabular-nums",
                pnlToneClass,
              )}
            >
              {formatSignedUsd(position.unrealisedPnl)}
            </span>
            {roiPercent === null ? null : (
              <span className={cn("font-mono text-xs tabular-nums", pnlToneClass)}>
                {formatSignedPercent(roiPercent)}
              </span>
            )}
            {progressPercent === null && holdLabel === null ? null : (
              <span className="flex items-center gap-2 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {progressPercent === null ? null : (
                  <>
                    <ProgressToTarget percent={progressPercent} />
                    <span>{Math.round(progressPercent)}% to target</span>
                  </>
                )}
                {progressPercent !== null && holdLabel !== null ? <span>·</span> : null}
                {holdLabel === null ? null : <span>held {holdLabel}</span>}
              </span>
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

      {/* Step 8.6: the bands are the same in every state; their ORDER is not.
          What belongs at the top is whatever that state is a question about.

          `armed` is a question about what the mission is waiting for, so the
          schedule and the checklist stand above the chart and the chart
          becomes the picture that explains them. `live` is a question about a
          position, so the chart — the shape of the trade — stays at the top
          and what is held sits directly under it, with the checklist below;
          before this the checklist separated a position's chart from its own
          size and protection. `planning` has neither band and reads as it did.

          The drag's answer always rides with the chart, wherever the chart is:
          it is about a level that was just moved. */}
      {state === "armed" ? (
        <>
          {/* The schedule, as one row of pills: what happens next, in the order it
            is likely to arrive. The checklist below says what is armed; this says
            when. */}
          {upNext.length === 0 ? null : (
            // Left-aligned under a label, not centred: every other band on this
            // panel starts at the same left rule, and a centred row of pills was
            // the one thing on the card that floated free of it. The label is what
            // makes the row a section rather than a loose set of chips.
            <div
              data-testid="mission-up-next"
              className={cn("flex flex-wrap items-center gap-1.5", CONTEXT_BAND_CLASS)}
            >
              <span className={cn("mr-0.5", BAND_LEGEND_CLASS)}>next</span>
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
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  +{upNext.length - MAX_UP_NEXT_PILLS} more
                </span>
              ) : null}
            </div>
          )}
          {/* The full checklist, below the chart. The chart draws the four price
            levels nearest the mark; these rows are the exact set, including the
            watches that have no y on a price chart at all. */}
          {visibleRows.length === 0 ? null : (
            <div className="border-t border-border/40">
              {/* The band's own label, on the panel's left rule like every other
                section heading. Without it the rows read as a continuation of
                the pill strip above rather than as the checklist. */}
              <p className={cn("px-3 pb-0.5 pt-1.5 sm:px-4", BAND_LEGEND_CLASS)}>armed</p>
              <div className="divide-y divide-border/25">
                {visibleRows.map((row) => (
                  <ConditionRow key={row.id} row={row} />
                ))}
              </div>
              {hiddenRows === 0 && droppedConditions === 0 ? null : (
                <p className="px-3 py-1 font-mono text-[10.5px] text-muted-foreground sm:px-4">
                  {hiddenRows > 0
                    ? `+${hiddenRows} more condition${hiddenRows === 1 ? "" : "s"} armed`
                    : `+${droppedConditions} more level${droppedConditions === 1 ? "" : "s"} armed, off the chart`}
                </p>
              )}
            </div>
          )}
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
              triggerExpiryAt={triggerExpiryAt}
              timeMarkers={timeMarkers}
              pastMarkers={pastMarkers}
              draggableKinds={draggableKinds}
              onLevelDragEnd={onLevelDragEnd}
              refusedStop={revision.refusedStop}
              positionSize={position?.size ?? null}
            />
          </div>
          {/* What the last drag came back saying. Two sentences and no third: the
            model republished underneath it, or the exchange refused to move the
            stop. Both stay until the operator drags again — a message that
            disappears on a timer is one they will miss while looking at the
            chart. */}
          {revision.lockLost || revision.refusedStop !== null || revision.error !== null ? (
            <button
              type="button"
              onClick={revision.dismiss}
              data-testid="mission-revision-note"
              className="w-full px-3 py-1.5 text-left text-[11px] leading-snug text-muted-foreground"
            >
              {revision.lockLost
                ? "The model republished the plan while you were dragging, so the level snapped back. Drag again against what is there now."
                : (revision.refusedStop?.detail ?? revision.error)}
            </button>
          ) : null}
        </>
      ) : (
        <>
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
              triggerExpiryAt={triggerExpiryAt}
              timeMarkers={timeMarkers}
              pastMarkers={pastMarkers}
              draggableKinds={draggableKinds}
              onLevelDragEnd={onLevelDragEnd}
              refusedStop={revision.refusedStop}
              positionSize={position?.size ?? null}
            />
          </div>
          {/* What the last drag came back saying. Two sentences and no third: the
            model republished underneath it, or the exchange refused to move the
            stop. Both stay until the operator drags again — a message that
            disappears on a timer is one they will miss while looking at the
            chart. */}
          {revision.lockLost || revision.refusedStop !== null || revision.error !== null ? (
            <button
              type="button"
              onClick={revision.dismiss}
              data-testid="mission-revision-note"
              className="w-full px-3 py-1.5 text-left text-[11px] leading-snug text-muted-foreground"
            >
              {revision.lockLost
                ? "The model republished the plan while you were dragging, so the level snapped back. Drag again against what is there now."
                : (revision.refusedStop?.detail ?? revision.error)}
            </button>
          ) : null}
          {/* What is actually held, at the foot of the panel. This used to be a
            `Position` card in the timeline — but a position is state, not an
            event, and state in a scrolling log reads as a fact from the moment
            you scrolled past. The fill receipts stay in the timeline, where an
            event with a timestamp belongs. */}
          {position === null ? null : (
            <PositionStrip
              size={position.size}
              liquidationPrice={position.liquidationPrice ?? null}
              protectedSize={position.protectedSize}
            />
          )}
          {/* The schedule, as one row of pills: what happens next, in the order it
            is likely to arrive. The checklist below says what is armed; this says
            when. */}
          {upNext.length === 0 ? null : (
            // Left-aligned under a label, not centred: every other band on this
            // panel starts at the same left rule, and a centred row of pills was
            // the one thing on the card that floated free of it. The label is what
            // makes the row a section rather than a loose set of chips.
            <div
              data-testid="mission-up-next"
              className={cn("flex flex-wrap items-center gap-1.5", CONTEXT_BAND_CLASS)}
            >
              <span className={cn("mr-0.5", BAND_LEGEND_CLASS)}>next</span>
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
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  +{upNext.length - MAX_UP_NEXT_PILLS} more
                </span>
              ) : null}
            </div>
          )}
          {/* The full checklist, below the chart. The chart draws the four price
            levels nearest the mark; these rows are the exact set, including the
            watches that have no y on a price chart at all. */}
          {visibleRows.length === 0 ? null : (
            <div className="border-t border-border/40">
              {/* The band's own label, on the panel's left rule like every other
                section heading. Without it the rows read as a continuation of
                the pill strip above rather than as the checklist. */}
              <p className={cn("px-3 pb-0.5 pt-1.5 sm:px-4", BAND_LEGEND_CLASS)}>armed</p>
              <div className="divide-y divide-border/25">
                {visibleRows.map((row) => (
                  <ConditionRow key={row.id} row={row} />
                ))}
              </div>
              {hiddenRows === 0 && droppedConditions === 0 ? null : (
                <p className="px-3 py-1 font-mono text-[10.5px] text-muted-foreground sm:px-4">
                  {hiddenRows > 0
                    ? `+${hiddenRows} more condition${hiddenRows === 1 ? "" : "s"} armed`
                    : `+${droppedConditions} more level${droppedConditions === 1 ? "" : "s"} armed, off the chart`}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* The whole published plan, one disclosure away. It used to be a card in
          the timeline, where it consumed height on every scroll whether or not
          anyone was reading it. */}
      {plan === null ? null : <PlanDisclosure plan={plan} />}

      <FooterRow data={chart.data} isHolding={position !== null} />
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
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[10.5px] tabular-nums",
        item.tone === "warning"
          ? "border-armed/40 bg-armed/10 text-armed"
          : "border-border/60 bg-foreground/[0.03] text-muted-foreground",
        isClickable && "cursor-pointer transition-colors hover:bg-foreground/[0.07]",
        isFlashed && "ring-1 ring-foreground/30",
      )}
    >
      <span className="text-foreground">{item.label}</span>
      {item.detail === null ? null : <span>{item.detail}</span>}
      {item.chip === null ? null : (
        <span className="rounded-full bg-foreground/10 px-1 text-[9.5px]">{item.chip}</span>
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
 * The planning header: the mission is on the market but has published nothing.
 *
 * It says only what is true — the market, the mark, and when it will look
 * again. No thesis, no size, no leverage ceiling: those are plan figures, and
 * there is no plan. The pulse is the same one the old one-line planning panel
 * carried, because the statement has not changed; what changed is that the
 * chart underneath it is now drawn.
 */
function PlanningHeader({
  market,
  markPrice,
  nextReassessmentAt,
}: {
  readonly market: string;
  readonly markPrice: number | null;
  readonly nextReassessmentAt: number | null;
}): ReactNode {
  const countdown = formatReassessmentCountdown(nextReassessmentAt);
  return (
    <>
      <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-armed/40 bg-armed/10 px-2 py-px font-mono text-[11px] text-armed">
        <span className="size-1.5 animate-pulse rounded-full bg-armed" aria-hidden />
        <span>{market}</span>
      </span>
      <span className="text-foreground">Analysing the market…</span>
      {markPrice === null ? null : (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {formatPrice(markPrice)}
        </span>
      )}
      {countdown === null ? null : (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {countdown}
        </span>
      )}
    </>
  );
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
  nextReassessmentAt,
}: {
  readonly market: string;
  readonly plan: StrategyPlan | null;
  readonly nextReassessmentAt: number | null;
}): ReactNode {
  const countdown = formatReassessmentCountdown(nextReassessmentAt);
  // The narrative is the headline: setup, regime, and the plan in plain terms
  // are one field now.
  const headline = plan?.because ?? null;
  // A stand-aside plan is not waiting on anything — saying "Waiting" would be
  // the one wrong word on the row. The chip states the intent instead.
  const state = plan?.isStandAside === true ? "Standing aside" : "Waiting";
  return (
    <>
      <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-armed/40 bg-armed/10 px-2 py-px font-mono text-[11px] text-armed">
        <span>{market}</span>
        <span>{state}</span>
      </span>
      {headline === null ? null : (
        <span className="min-w-0 max-w-[36ch] truncate text-foreground" title={headline}>
          {headline}
        </span>
      )}
      {plan?.initialSizeUsd == null ? null : (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          size {formatUsd(plan.initialSizeUsd)}
        </span>
      )}
      {plan?.maxLossUsd == null ? null : (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          max loss {formatUsd(plan.maxLossUsd)}
        </span>
      )}
      {/* The leverage ceiling stood here. Step 8.5: it is a constant of the
          mission's authority, not a state of it — it says the same thing on
          every turn of every session, and nothing the operator does while
          waiting is decided by it. It is still in the plan disclosure. Size
          and max loss stay: those two are what the next entry would actually
          risk, which is the one thing an armed panel is for. */}
      {countdown === null ? null : (
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {countdown}
        </span>
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
  readonly triggerExpiryAt: number | null;
  readonly timeMarkers: ReadonlyArray<ChartTimeMarkerInput>;
  readonly pastMarkers: ReadonlyArray<ChartPastMarkerInput>;
  readonly draggableKinds: ReadonlyArray<ChartLevelKind>;
  readonly onLevelDragEnd: (kind: ChartLevelKind, price: number) => void;
  readonly refusedStop: { readonly planPrice: number; readonly detail: string } | null;
  readonly positionSize: number | null;
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
        {...(props.triggerExpiryAt === null ? {} : { triggerExpiryAt: props.triggerExpiryAt })}
        timeMarkers={props.timeMarkers}
        pastMarkers={props.pastMarkers}
        draggableKinds={props.draggableKinds}
        onLevelDragEnd={props.onLevelDragEnd}
        refusedLevel={
          props.refusedStop === null
            ? null
            : {
                kind: "stop",
                planPrice: props.refusedStop.planPrice,
                detail: props.refusedStop.detail,
              }
        }
        positionSize={props.positionSize}
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

  // Fixed-width, right-aligned columns rather than a wrapping baseline row:
  // the values are read DOWN the list against each other, and ragged right
  // edges made four rows of numbers look like four unrelated facts.
  return (
    <div className="flex items-baseline gap-x-3 px-3 py-1.5 font-mono text-[11px] sm:px-4">
      <span className="w-3 flex-none text-center">{glyph}</span>
      {/* The description names the level; the reading beside it is the figure
          being read down the list. So the sentence sits a step back from full
          strength and the numbers keep the foreground ink. */}
      <span
        className="min-w-0 flex-1 truncate leading-[1.35] text-foreground/85"
        title={row.description}
      >
        {row.description}
      </span>
      <span
        className={cn(
          "w-[68px] flex-none text-right tabular-nums",
          row.met ? "text-profit" : "text-foreground",
        )}
      >
        {observed}
      </span>
      <span className="w-[68px] flex-none text-right tabular-nums text-muted-foreground/70">
        {threshold === null ? "" : `/ ${threshold}`}
      </span>
      <span className="w-11 flex-none text-right text-muted-foreground/70">
        {row.met ? "met" : "waiting"}
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
        View full plan · {plan.isStandAside ? "standing aside" : plan.planPhase}
      </summary>
      <div className="mt-2 space-y-1">
        {plan.isStandAside ? (
          // A stand-aside says so in its first line: the plan declined the
          // trade, and reading an intent row before learning that would put
          // the conclusion last.
          <p className="whitespace-pre-wrap text-foreground">
            {plan.because === null ? "Standing aside." : `Standing aside — ${plan.because}`}
          </p>
        ) : (
          <>
            {plan.because === null ? null : <PlanField label="Why" value={plan.because} />}
            <PlanField label="Intent" value={plan.intentLabel} />
          </>
        )}
        {plan.entryTriggers.length === 0 ? null : (
          <PlanField label="Entry trigger" value={plan.entryTriggers.join("; ")} />
        )}
        {plan.orderType === null ? null : <PlanField label="Order type" value={plan.orderType} />}
        {plan.initialSizeUsd === null ? null : (
          <PlanField label="Initial size" value={formatUsd(plan.initialSizeUsd)} />
        )}
        {plan.stopSummary === null ? null : <PlanField label="Stop" value={plan.stopSummary} />}
        {plan.targetUsd === null ? null : (
          <PlanField label="Target" value={formatUsd(plan.targetUsd)} />
        )}
        {plan.maxLossUsd === null ? null : (
          <PlanField label="Max loss" value={formatUsd(plan.maxLossUsd)} />
        )}
        {plan.invalidation.length === 0 ? null : (
          <PlanField label="Invalidation" value={plan.invalidation.join("; ")} />
        )}
        <PlanField label="Reassess after" value={`${plan.reassessMinutes} min untriggered`} />
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

/**
 * Progress to target as a 28px rule, next to the number it stands for.
 *
 * The figure alone ("0% to target") is a number the eye has to read before it
 * means anything; the rule is the same fact at a glance, and it costs one line
 * of the header rather than a band of its own.
 *
 * Drawn in the accent rather than in the P&L's tone. Distance travelled toward
 * the target is not the same statement as whether the position is up or down,
 * and painting the rule red through a drawdown said the plan itself had gone
 * wrong when only the mark had moved.
 */
function ProgressToTarget({ percent }: { readonly percent: number }): ReactNode {
  return (
    <span
      className="inline-block h-[3px] w-7 overflow-hidden rounded-full bg-foreground/10"
      aria-hidden
    >
      <span
        className="block h-full rounded-full bg-primary"
        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </span>
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
        "inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[11px]",
        tone,
      )}
    >
      <span>{market}</span>
      {leverageLabel === null ? null : (
        <span className="rounded-[3px] bg-current/15 px-1 tabular-nums">{leverageLabel}</span>
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
  liquidationPrice,
  protectedSize,
}: {
  readonly size: number;
  readonly liquidationPrice: number | null;
  readonly protectedSize: number;
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
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[10.5px] tabular-nums text-muted-foreground/70",
        CONTEXT_BAND_CLASS,
      )}
    >
      <span className={cn("mr-0.5", BAND_LEGEND_CLASS)}>held</span>
      <PositionStat label="Size" value={formatSize(Math.abs(size))} />
      {/* Entry, mark and margin used to stand here. Step 8.5: the chart draws
          the entry as its one solid rule and the mark as the moving dot, both
          tagged with their price in the gutter — a second copy three rows down
          is the same fact in a worse place. Margin went for a different
          reason: it is size × entry ÷ leverage, and all three of those are
          already on the panel, so it was a figure that could not disagree with
          the ones above it. Liquidation stays: the chart shows it only when it
          is inside the drawn domain, and when it is not, this is its only
          home. */}
      {liquidationPrice === null ? null : (
        <PositionStat label="Liq" value={formatPrice(liquidationPrice)} />
      )}
      <PositionStat
        label="Protected"
        value={protection}
        // An unprotected position is the one fact on this line worth a colour.
        toneClass={protectedSize === 0 ? "text-loss" : undefined}
      />
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
      {label} <span className={cn("ml-0.5", toneClass ?? "text-foreground")}>{value}</span>
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
      className="flex w-full items-center gap-2 px-3 font-mono text-[11px] tabular-nums text-muted-foreground sm:px-4"
      style={{ height: COLLAPSED_ROW_HEIGHT_PX }}
    >
      <span className="text-foreground">
        {market}
        {leverageLabel === null ? "" : ` ${leverageLabel}`}
      </span>
      <span className={summaryToneClass}>{summary}</span>
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
/**
 * The market's own numbers, under everything.
 *
 * Step 8.5 took two of the four away. Open interest and 24h volume are market
 * structure the model reads through `look` and weighs in its own plan; nothing
 * the operator does with this panel turns on either, and they were here because
 * the chart view had fields for them. Funding is a cost of *carrying* — so it
 * appears when something is being carried and not before. The 24h change stays
 * unconditionally: the chart is an hour wide, so it is the one line on the
 * panel that says where the day has been.
 */
function FooterRow({
  data,
  isHolding,
}: {
  readonly data: TradingMarketChartView | null;
  readonly isHolding: boolean;
}): ReactNode {
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/40 px-3 py-1 font-mono text-[10.5px] tabular-nums text-muted-foreground/70 sm:px-4">
      {isHolding ? (
        <span>
          Funding <span className="text-foreground">{(data.fundingRate8h * 100).toFixed(4)}%</span>
          /8h
        </span>
      ) : null}
      <span className={changeTone}>24h {formatSignedPercent(data.change24hPercent)}</span>
    </div>
  );
}
