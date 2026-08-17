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
//   planning  no strategy yet          → chart + mark, "Analysing the market…"
//   armed     strategy, flat, watching → chart + condition levels + plan summary
//   live      position open            → the same, plus P&L and the held figures
//   complete  mission finished         → the net result, kept for good (plan 27 H1)
//
// It is THREE panes of glass, floating clear of each other and of the composer
// below: the chart card on the left, closed by the risk/reward bar; the readout
// card on the right — the side chip and the P&L, the progress rule, the thesis,
// the grid of figures the exposure is made of, and the armed watches; and under
// both of them, spanning the full width, the status bar that says in a sentence
// what the mission is doing, with the ambient facts trailing right.
// All three carry the composer's material, the same surface tint, blur,
// saturation and hairline outline, plus a 1px inner highlight along the top
// edge so each reads as a lit pane rather than a painted rectangle.
//
// One box holding everything was the first attempt and it was wrong: a price
// chart and a column of prices divided by a single hairline read as one flat
// table, and the eye had nothing to tell it where the picture ended and the
// instrument began. The gaps do that. Below `lg` the two cards stack, each
// keeping its own edges, and the bar stays under them.
//
// Proportion is the point of the row. At the panel's own width (6xl, set at
// its call site in ChatView) the readout takes a fixed 400px and the chart
// takes everything else, which is about 64/35 — a picture with an instrument
// beside it, not two columns splitting the difference. The chart is 440px tall
// because the price line is the one thing here that is read as a shape.
//
// ONE line in the picture. The chart draws closes at the runtime's own
// interval, and nothing else: no candle bodies, no moving averages. Three
// curves in one frame — price, fast EMA, slow EMA — read as three subjects,
// and the two smooth ones won, which is the opposite of the intent. Everything
// else on the chart is a level the plan drew across that line.
//
// Every figure on it is set in the mono face, at one of three sizes: the P&L
// at 24px because it is the number being read, the exposure figures and the
// watch rows at 12px because they are read down a list, and the labels that
// name them at 10.5px. Prose — the plan's thesis, the disclosure — stays in
// the UI face. Mixing a proportional face into a column of prices is what made
// four rows of numbers read as four unrelated facts.
//
// Density is held down by cutting whole objects, not by shrinking type. Three
// things went in the pass that made this match its reference: the schedule
// strip, whose every pill named a price the chart was already drawing a rule
// at; the strip of recent wake pills, which was three amber capsules saying a
// watch had fired, on a panel whose entire subject is watches; and the EMA
// pair with its legend. What is left is a picture, a column of figures, a list
// of conditions and a sentence.
//
// A number still appears at most twice, and only when the two say different
// things: P&L, ROI and progress are header figures and the grid never repeats
// them, while entry and mark ARE in both places — as a tag on the shape and as
// a cell in the column — because the gutter says where and the cell says what.
// Hold time, funding and the day's change are true but not acted on, so they
// sit in the ambient line at the foot; the exact threshold behind each watch is
// a hover; everything the plan said is one disclosure away. Exceptions get
// louder, not quieter: a stop covering only part of the position takes a cell
// of its own, in the loss tone, because that is the difference between a
// bounded loss and an open one.
//
// `planning`, `armed` and `live` draw the same surface; what differs is how
// much of it there is anything to say about. Planning has a market, a mark, a
// candle series and a run history from its first turn, and none of that needs a
// published strategy — but it has no thesis, no levels and no target, so its
// grid holds a mark and a countdown, and the checklist, the risk/reward bar and
// the plan disclosure are absent rather than empty. Nothing on the surface is
// invented to fill the space a plan will later take.
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
import {
  Activity,
  ArrowDownRight,
  ArrowRightToLine,
  ArrowUpRight,
  Box,
  ChartCandlestick,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock,
  Crosshair,
  ExternalLinkIcon,
  FileText,
  Gauge,
  OctagonMinus,
  Radar,
  Receipt,
  ShieldAlert,
  Target,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { readMissionMode } from "@t3tools/trading-contracts/mode";
import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";

import type { ChartInterval } from "~/lib/tradingMarketChartState";
import { useTradingMarketChart } from "~/lib/tradingMarketChartState";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

import { MissionPriceChart } from "./MissionPriceChart";
import { useMissionPlanRevision, type MissionPlanRevision } from "./useMissionPlanRevision";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  derivePositionLedger,
  deriveRoundTrips,
  deriveStrategyPlan,
  deriveTriggerExpiryMillis,
  deriveWatchConditions,
  deriveWatchLifecycle,
  describeDelayedRead,
  formatAge,
  formatFixed3,
  formatDuration,
  formatLeverage,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
  formatSize,
  formatUsd,
  hyperliquidTradeUrl,
  isArmedRow,
  isMissionComplete,
  type ChartFillMarker,
  type ChartPastMarkerInput,
  type ChartTimeMarkerInput,
  type PositionLedgerRow,
  type StrategyPlan,
  type WatchLifecycleState,
  type WatchRowType,
  type WatchStreamGroup,
  type WatchStreamItem,
  type WatchStreamRow,
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

/** Expanded chart area height.
 *
 * Taller than the band-stacked panel it replaces: the chart no longer shares
 * its column with the schedule, the checklist and the held figures, so the
 * height it takes is height the readout beside it was going to take anyway. */
const CHART_HEIGHT_CLASS = "h-[260px] w-full sm:h-[340px]";

/**
 * The readout card's width on a wide workspace.
 *
 * Wide enough for a full watch sentence, a price and its verdict on one line
 * at 12px, which is the row this column exists to hold. At 336px the same row
 * truncated the sentence to make room for the word "waiting".
 */
const READOUT_WIDTH_CLASS = "lg:w-[400px]";

/**
 * How many SETTLED positions the ledger shows before it counts the rest.
 *
 * Same posture as the watch stream's own cap: four rows is the recent activity
 * a glance can take in, and past that the number of earlier ones is the useful
 * fact rather than the forty rows themselves. The open position is never one of
 * the four — it is the row the band exists to keep in view.
 */
const MAX_LEDGER_ROWS = 4;

/**
 * How often the panel's clock ticks.
 *
 * 250ms rather than a second. The axis ends at the forming bar's close, so the
 * live edge walks toward it continuously — at 1Hz that walk was four visible
 * steps a second apart, which reads as a re-render rather than as a price
 * advancing. Four ticks a second is a text update and one ~60-point polyline
 * re-render: no animation loop, no GPU work, and still nowhere near a frame
 * budget. Durations shown in seconds simply re-render the same string three
 * times out of four.
 */
const TICK_INTERVAL_MILLIS = 250;

/** Collapsed summary row height, in pixels. */
const COLLAPSED_ROW_HEIGHT_PX = 38;

/**
 * How many settled watches the stream renders before it says how many are left.
 *
 * A mission that re-levels on every bar retires hundreds of them, and rendering
 * all of them makes a 220px window into sixty screens of scroll — with the row
 * anyone would want in the first two. Forty is a few screens of genuine
 * scrollback; past that the number itself is the useful fact.
 */
const MAX_SETTLED_WATCH_ROWS = 40;

/**
 * How many of the fetched bars the live chart draws.
 *
 * The RPC serves 120 (`maxBars` in `ws.ts`), which on a 1m series is two hours
 * — wide enough that an hour-old trade is a twentieth of the frame and a minute
 * of drift is a few pixels. Sixty bars is the hour that a 1m mission is
 * actually operating on: twice the price resolution, and twice the rate the
 * series slides left.
 */
const VISIBLE_BARS = 24;

/**
 * One card of glass.
 *
 * The chart and the readout are two of these, side by side with a gap between
 * them, not two halves of one box divided by a hairline. A shared box made a
 * chart and a column of figures read as one flat table; two cards on the
 * thread's own ground read as a picture and the instrument beside it, which is
 * what they are. Each carries the composer's material — the same surface tint,
 * blur, saturation and outline — so the pair still belongs to the surface it
 * is docked above.
 */
// The bevel and the drop shadow live in `.mission-panel-glass` rather than in a
// utility here: a Tailwind `shadow-*` replaces the whole box-shadow, so setting
// the inner highlight from this side silently deleted the outer one.
const CARD_CLASS = "mission-panel-glass overflow-hidden rounded-xl border";

/** The shell: the chart and the readout on one row, the status bar under both.
 *  It draws nothing itself — the gaps are the separation, and a third surface
 *  behind three glass ones would be a fourth object on a strip that should
 *  read as one instrument. */
const PANEL_SHELL_CLASS = "group/panel flex w-full flex-col gap-3";

/** The two cards' own row. Wider gap than the shell's, because these two sit
 *  shoulder to shoulder and the eye needs the seam between a picture and an
 *  instrument to be unmistakable. */
const CARD_ROW_CLASS = "flex flex-col gap-3 lg:flex-row lg:gap-4";

/** The padding every band on either card starts from, so a figure in the
 *  readout lines up with the chart's own left rule. */
const BAND_PAD_CLASS = "px-4 sm:px-5";

/**
 * The band heading — `next`, `armed`, `held` — that starts each section on the
 * panel's left rule.
 *
 * Mono, wide-tracked and set in the faintest ink on the card: it is a label for
 * the row beneath it, never a figure to read. The wide tracking is what keeps a
 * four-letter lowercase word legible at 10px, and it separates the legend from
 * the mono values in the same band without needing a second colour.
 */
// Set in the muted ink rather than a fraction of it: at 10px a 70%-opacity
// label is under the AA contrast floor in both themes, and these are the words
// that tell an operator what they are looking at.
const BAND_LEGEND_CLASS =
  "font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground";

/**
 * The context strips — the risk/reward bar, the schedule — that close out a
 * card. Both sit on the same faint ground, a shade off the card, so the band
 * above them reads as that card's centre of gravity.
 */
const CONTEXT_BAND_CLASS = "border-t border-border/40 bg-foreground/[0.02] px-4 py-2 sm:px-5";

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
    const id = window.setInterval(() => setNowMillis(Date.now()), TICK_INTERVAL_MILLIS);
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
  // The stop, in both states, on two different grounds.
  //
  // While exposed it is the price protecting the position. While armed it is
  // the price the published plan says it will protect at — and a plan that
  // states a stop and does not draw it is the panel withholding the number the
  // whole trade is sized from. What it must NOT do is survive either: the stop
  // leg outlives the position it protected, and drawing it unconditionally
  // left a rule hanging across a flat mission at a price nothing was
  // protecting. Gated on a live plan that intends a trade, it cannot.
  const isPlanning = state === "planning";
  const wantsPlanLevels = !isPlanning && plan?.isStandAside !== true;
  const stopPrice = wantsPlanLevels ? (strategy?.stop.price ?? null) : null;
  // A stand-aside plan names no target, and drawing a target line from any
  // other figure on it would put a level on the chart for a trade that was
  // explicitly declined.
  const targetProfitUsd = plan?.isStandAside === true ? null : (strategy?.target.profitUsd ?? null);
  // Derived from the exposure once there is one — the price at which this size
  // makes the plan's money — and otherwise taken from the price the plan
  // states. A waiting mission drew no target at all, so the chart showed a
  // stop-less, target-less line while the readout beside it named both.
  const targetPrice =
    entryPrice !== null && targetProfitUsd !== null && position !== null
      ? deriveTargetPrice(entryPrice, targetProfitUsd, position.size)
      : wantsPlanLevels
        ? (strategy?.target.price ?? null)
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
  // Phase 9's mode is derived from the mandate rather than stored, which is the
  // right call and leaves one gap: nothing on screen said whether the sentence
  // the operator typed actually put the mission in execute mode. A mode read
  // out of prose that nobody can see read is a mode nobody can correct. Derived
  // here from the same function the server derives it from, off the same
  // `instruction`, so the panel cannot disagree with the model's own read.
  const mode = readMissionMode(mission.instruction);
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

  // Every position the mission has taken, the open one first. The chart already
  // draws where each fill landed; this says what each position came to, which no
  // figure on the panel was carrying — the stat grid describes the current
  // exposure and the completion summary only arrives once the mission is over.
  const ledgerRows = derivePositionLedger({
    position,
    markPrice,
    trips: deriveRoundTrips(mission.recentFills),
    openedAtMillis: entryMillis,
  });

  // The order the agent has committed to but the book has not filled. This is
  // the "I will enter long at X" the plan announces, drawn where it will happen
  // rather than described in a card somewhere else on the screen.
  const inFlight = mission.inFlightExecution;
  const pendingOrder =
    inFlight === null ? null : { price: inFlight.limitPrice, side: inFlight.side };

  // The plan's own read of where price is headed, as a moment on the clock
  // axis: `byMinutes` is measured from the publish, so the endpoint stays
  // fixed while the series slides toward it. Drawn whatever the intent — a
  // stand-aside plan still holds an estimate of where price is going, and the
  // estimate is exactly why it is standing aside.
  const planProjection =
    strategy?.projection !== undefined
      ? {
          price: strategy.projection.price,
          atMillis: strategy.updatedAt + strategy.projection.byMinutes * 60_000,
        }
      : null;

  // The next reassessment, as a mark on the axis rather than only as a
  // countdown in the header — "3m from now" is a moment, and the chart has an
  // axis of moments.
  const nextReassessmentAt = deriveNextReassessmentAt(mission);

  // How far the armed entry triggers are drawn into the future gutter: to the
  // plan's own reassessment horizon, and no further. A trigger rule running to
  // the frame edge claims the mission will still be waiting at that price then.
  const triggerExpiryAt = deriveTriggerExpiryMillis(mission);

  // Every armed reassessment, not only the nearest: the header's countdown is
  // one appointment, the axis is the whole queue.
  const timeMarkers = deriveChartTimeMarkers(mission);

  // What has already happened, as a rug of ticks along the axis: the mission's
  // own wakes, publishes and stop moves, which no amount of current state can
  // show. Bounded server-side, and again by the geometry's own cap.
  const pastMarkers = deriveChartPastMarkers(mission);

  // One stream: what is armed, then everything that has settled, newest first.
  //
  // Planning shows none of it. The only thing armed before a publish is the
  // staleness reassessment, which the stream excludes anyway — and a list
  // headed by a condition the mission never chose reads as a plan when there
  // is not one.
  const watchStream = state === "planning" ? [] : deriveWatchLifecycle(mission).stream;
  // A row that just fired holds its place at the top for a beat while the live
  // dot becomes a tick, so the operator sees the moment happen instead of a row
  // sliding down between polls.
  const recentlyFired = useRecentlyFiredWatches(watchStream, nowMillis);

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
          CARD_CLASS,
          BAND_PAD_CLASS,
          "flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm",
        )}
      >
        <span className="text-foreground">{mission.market} finished</span>
        <span
          className={cn("font-mono text-base tabular-nums", net >= 0 ? "text-profit" : "text-loss")}
        >
          {formatSignedUsd(net)} net
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">
          {mission.result.fillCount} fill{mission.result.fillCount === 1 ? "" : "s"} ·{" "}
          {formatUsd(mission.result.feesPaidUsd)} fees
        </span>
      </div>
    );
  }

  // --- collapsed: the 32px summary row. -------------------------------------
  if (collapsed) {
    return (
      <div data-testid="mission-live-panel" data-panel-state={state} className={CARD_CLASS}>
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

  // The schedule strip is gone. Every pill on it named a price the chart was
  // already drawing a rule at, in the same gutter, with the same figure — so
  // the readout carried a text copy of the picture beside it, and the copy was
  // the noisier of the two. The next reassessment keeps both of its homes: a
  // rule standing in the chart's future gutter, captioned there, and a cell in
  // the grid in the two states that have room for one.
  const checklist =
    watchStream.length === 0 ? null : (
      <WatchStream
        rows={watchStream}
        nowMillis={nowMillis}
        recentlyFired={recentlyFired}
        droppedConditions={droppedConditions}
      />
    );

  return (
    <div data-testid="mission-live-panel" data-panel-state={state} className={PANEL_SHELL_CLASS}>
      {/* Two cards with air between them, not two halves of one box. The chart
          is the picture and the readout is the instrument beside it; welding
          them into a single bordered surface made a candle chart and a column
          of prices read as one flat table, which is how the first pass at this
          went wrong.

          Below `lg` they stack, chart first, each keeping its own edges. */}
      <div className={CARD_ROW_CLASS}>
        <section className={cn(CARD_CLASS, "flex min-w-0 flex-1 flex-col")}>
          <ChartPriceHeader
            market={mission.market}
            intervalLabel={interval}
            markPrice={markPrice}
            changePercent={chart.data?.change24hPercent ?? null}
          />
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
            nowMillis={nowMillis}
            triggerExpiryAt={triggerExpiryAt}
            projection={planProjection}
            timeMarkers={timeMarkers}
            pastMarkers={pastMarkers}
            draggableKinds={draggableKinds}
            onLevelDragEnd={onLevelDragEnd}
            refusedStop={revision.refusedStop}
            positionSize={position?.size ?? null}
          />
          <RiskRewardBar
            riskUsd={plan?.maxLossUsd ?? null}
            rewardUsd={targetProfitUsd}
            isStandAside={plan?.isStandAside === true}
          />
        </section>

        <section
          className={cn(
            CARD_CLASS,
            READOUT_WIDTH_CLASS,
            "flex w-full min-w-0 flex-col lg:flex-none",
          )}
        >
          <div className="flex flex-1 flex-col">
            {/* The header: what is held, and the one figure being read. */}
            <div className={cn(BAND_PAD_CLASS, "flex items-center gap-x-3 py-3")}>
              {position === null ? (
                <StateChip
                  market={mission.market}
                  state={
                    state === "planning"
                      ? "planning"
                      : plan?.isStandAside === true
                        ? "standing_aside"
                        : "waiting"
                  }
                />
              ) : (
                // Live, the identity chip belongs to the position block below —
                // one pill per fact. What the header keeps is the P&L, which is
                // the figure this card exists to show.
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  unrealised
                </span>
              )}
              {/* The staleness word is the one thing allowed to interrupt the
                header, because it qualifies every figure under it. */}
              {delayedRead === null && !chart.stale ? null : (
                <span
                  // On one line, always. "Stale 2m 36s" wrapping after the
                  // word STALE made the header two rows tall and pushed the
                  // P&L — the figure this card exists for — down with it.
                  className="flex flex-none items-center gap-1 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.1em] text-armed"
                  title={
                    delayedRead === null
                      ? "The last exchange read failed"
                      : "The position read is behind. Placement is only suspended once it stops landing altogether."
                  }
                >
                  <Clock className="size-3" strokeWidth={2} aria-hidden />
                  {delayedRead ?? "delayed"}
                </span>
              )}
              {position === null ? null : (
                <span className="ml-auto flex items-baseline gap-2">
                  {roiPercent === null ? null : (
                    <span className={cn("font-mono text-xs tabular-nums", pnlToneClass)}>
                      {formatSignedPercent(roiPercent)}
                    </span>
                  )}
                  <span
                    className={cn(
                      "font-mono text-2xl leading-none tracking-[-0.02em] tabular-nums transition-colors duration-300 motion-reduce:transition-none",
                      pnlToneClass,
                    )}
                  >
                    {formatSignedUsd(position.unrealisedPnl)}
                  </span>
                </span>
              )}
              {/* The collapse control is the panel's only chrome, so it recedes
                to a hint until the pointer is on the panel. A monitoring
                surface should read as figures, not as a toolbar. */}
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Collapse chart"
                className={cn(
                  "text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:text-foreground group-hover/panel:text-muted-foreground motion-reduce:transition-none",
                  position === null && "ml-auto",
                )}
              >
                <ChevronUp className="size-4" aria-hidden />
              </button>
            </div>

            {/* Progress to target as a full-width rule under the figure it
              stands for, rather than a 28px stub inside a wrapping header
              row. Same fact, at the width that makes it readable at a glance. */}
            {progressPercent === null ? null : (
              <div className={cn(BAND_PAD_CLASS, "flex items-center gap-3 pb-3")}>
                <ProgressToTarget percent={progressPercent} />
                <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
                  {Math.round(progressPercent)}% to target
                </span>
              </div>
            )}

            {/* The thesis paragraph is gone from this card. It was the one
              block of prose on a surface of figures, and clamping it to two or
              three lines meant the sentence was usually cut anyway — a
              paragraph the reader could see had been truncated, taking the
              height of one they could not finish. It keeps two homes, both
              whole: the status bar's headline carries it as a hover, and the
              plan popup opened from that bar states it as its first field. */}

            {/* The position, where the receipt in the conversation used to say
                it: the same chips, above the same figures. */}
            {position === null ? null : (
              <div className={cn(BAND_PAD_CLASS, "flex items-center gap-1.5 pb-2")}>
                <SideChip
                  market={mission.market}
                  leverageLabel={leverage === null ? null : formatLeverage(leverage)}
                  isLong={position.size > 0}
                />
                <span className="inline-flex items-center rounded-full border border-border/60 bg-foreground/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  Open
                </span>
                {mission.result.feesPaidUsd > 0 ? (
                  <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                    {formatUsd(mission.result.feesPaidUsd)} fees
                  </span>
                ) : null}
              </div>
            )}

            <StatGrid
              state={state}
              markPrice={markPrice}
              plan={plan}
              stopPrice={stopPrice}
              {...(position === null ? {} : { position })}
            />

            {/* The exposure's own block, before there is an exposure. The
                readout is built around six position figures, and while the
                mission waits that whole region was blank — a third of the card
                reading as something that had failed to render, and then
                everything below it jumping when a fill landed. The skeleton
                holds the shape and says what will fill it. */}
            {position === null ? <PositionSkeleton market={mission.market} /> : null}
          </div>

          {/* The checklist sits at the foot of the card, so the slack a short
            readout leaves collects ABOVE it rather than in the middle of the
            list — which is exactly where the reference leaves its own air. */}
          {checklist}
          <RevisionNote revision={revision} />

          {/* The plan disclosure that used to close this card is now the popup
            opened from the status bar's plan pill. It was a control at the foot
            of a scrolling column, below the watch stream, where the thing it
            opened had nothing to do with the rows above it; on the bar it sits
            beside the sentence it explains. */}
        </section>
      </div>

      {/* The ledger spans both cards rather than sitting in the readout column.
          A position is five figures wide — side, size, notional, both prices,
          net — and five figures do not fit a 400px column without one of them
          being cut, which is the one thing this band must never do. Given the
          panel's width the columns rule up with room to spare, and the readout
          card gets the height back for the watch stream, which is the list that
          actually scrolls. Below `lg` the cards stack and this is the same
          width they are, so nothing changes there. */}
      {ledgerRows.length === 0 ? null : (
        <section className={cn(CARD_CLASS, "pt-3")}>
          <PositionLedger
            rows={ledgerRows}
            market={mission.market}
            leverageLabel={leverage === null ? null : formatLeverage(leverage)}
          />
        </section>
      )}

      {/* The third element, spanning both cards: what the mission is doing,
          said in a sentence, with the facts that qualify it trailing on the
          right. It is the line the landing page closes its readout with, and
          the panel had nowhere to say the one thing a passing glance wants —
          not a price, not a percentage, but a state. Everything on it is
          ambient: a state, a duration, a carrying cost, the day's move. None
          of it is decided on, which is why it is a bar under the instrument
          rather than a cell inside it. */}
      <MissionStatusBar
        headline={describeMissionStatus(state, position, watches, plan)}
        because={plan?.because ?? null}
        plan={plan}
        countdown={formatReassessmentCountdown(nextReassessmentAt)}
        projection={
          // A stand-aside states no prediction, so the bar shows none — and it
          // is read off the intent rather than trusted to be absent. Nothing in
          // the schema forbids the field on a `stand_aside` plan, and a plan
          // published before the wake stopped nagging for one may carry the
          // invented projection that nagging produced. Drawing it would be the
          // panel asserting a direction the plan declined to take.
          strategy?.projection === undefined || plan?.isStandAside === true
            ? null
            : {
                direction: strategy.projection.direction,
                price: strategy.projection.price,
                atMillis: strategy.updatedAt + strategy.projection.byMinutes * 60_000,
              }
        }
        tone={position === null ? "flat" : position.unrealisedPnl >= 0 ? "profit" : "loss"}
        data={chart.data}
        isHolding={position !== null}
        holdLabel={holdLabel}
        modeLabel={mode.kind === "execute_strategy" ? mode.strategy.replaceAll("_", " ") : null}
        exchangeUrl={exchangeUrl}
        lastActivity={deriveLastActivity(mission.missionTimeline, nowMillis)}
      />
    </div>
  );
}

/**
 * What the mission is doing, in one clause.
 *
 * The panel is dense with figures and had no sentence on it. A figure answers
 * "how much"; this answers "what is happening", which is the question a glance
 * from across the room is actually asking.
 */
function describeMissionStatus(
  state: PanelState,
  position: { readonly size: number } | null,
  watches: { readonly rows: ReadonlyArray<{ readonly met: boolean }> } | null,
  plan: StrategyPlan | null,
): string {
  if (position !== null) return position.size > 0 ? "Holding long" : "Holding short";
  if (state === "planning") return "Analysing the market";
  if (plan?.isStandAside === true) return "Standing aside";
  const pending = watches?.rows.filter((row) => !row.met).length ?? 0;
  if (pending === 0) return "Waiting for the entry";
  return `Waiting on ${pending} condition${pending === 1 ? "" : "s"}`;
}

/**
 * The price, above the picture of it.
 *
 * Borrowed wholesale from the Stocks app, which puts the number first and the
 * shape under it: the market, then the mark set large, then how far the day has
 * moved, then which bars are being drawn. It is the one figure that is true
 * whatever the mission is doing — planning, waiting, holding — so it belongs to
 * the chart card rather than to the readout, and it stays put while the panel's
 * state changes underneath it.
 *
 * The mark is `mission.marketPrice` (3s poll) rather than the candle feed's
 * (15s), so this figure and the dot at the end of the line are the same read.
 */
function ChartPriceHeader({
  market,
  intervalLabel,
  markPrice,
  changePercent,
}: {
  readonly market: string;
  readonly intervalLabel: string;
  readonly markPrice: number | null;
  readonly changePercent: number | null;
}): ReactNode {
  const changeTone =
    changePercent === null || changePercent === 0
      ? "text-muted-foreground"
      : changePercent > 0
        ? "text-profit"
        : "text-loss";
  return (
    <div className={cn(BAND_PAD_CLASS, "flex items-end justify-between gap-3 pb-2 pt-3")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
          {market} · USD
        </span>
        <span className="flex items-baseline gap-2">
          <span
            data-testid="mission-chart-mark"
            className="font-mono text-[26px] leading-none tracking-[-0.02em] tabular-nums text-foreground"
          >
            {markPrice === null ? "—" : formatPrice(markPrice)}
          </span>
          {changePercent === null ? null : (
            <span className={cn("font-mono text-[13px] tabular-nums", changeTone)}>
              {formatSignedPercent(changePercent)}
            </span>
          )}
        </span>
      </div>
      {/* Which bars the shape below is made of. The Stocks app puts a row of
          ranges here; this chart draws one, so it states it rather than
          offering it. */}
      <span
        data-testid="mission-chart-interval"
        // Lower case, deliberately: "1M" is a month in every chart app the
        // operator has ever used, and this is one minute.
        className="flex-none rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] lowercase tracking-[0.08em] text-muted-foreground"
      >
        {intervalLabel}
      </span>
    </div>
  );
}

/**
 * The two figures the plan fixed before it signed anything, drawn as one bar.
 *
 * The risk and the reward are the same statement read from two ends, so they
 * are one object: a red segment and a green one, sized in proportion to each
 * other. It sits under the chart because it is a property of the levels drawn
 * on it, and it disappears when either half is unknown — half a risk/reward bar
 * claims a ratio that has not been decided.
 */
/**
 * A reward-to-risk ratio, printed so it never rounds itself away.
 *
 * A plan risking $63.67 to make $0.66 has a ratio of 0.0104, and one decimal
 * place prints that as "0.0:1" — a figure that reads as a rendering fault
 * rather than as the (alarming) thing it is. Below a tenth the ratio is stated
 * as a bound instead, which is both honest and legible.
 */
function formatRatio(ratio: number): string {
  if (ratio > 0 && ratio < 0.1) return "<0.1";
  return ratio.toFixed(ratio < 10 ? 1 : 0);
}

function RiskRewardBar({
  riskUsd,
  rewardUsd,
  isStandAside,
}: {
  readonly riskUsd: number | null;
  readonly rewardUsd: number | null;
  readonly isStandAside: boolean;
}): ReactNode {
  if (isStandAside) return null;
  if (riskUsd === null || rewardUsd === null) return null;
  if (riskUsd <= 0 || rewardUsd <= 0) return null;
  const ratio = rewardUsd / riskUsd;
  // The proportion is clamped to a readable band. A 6:1 plan drawn honestly
  // gives the risk segment 14% of the bar, which is narrower than the figure
  // printed in it, and a number spilling out of its own segment is worse than
  // a foreshortened one. The exact ratio is stated in words beside the bar, so
  // nothing here is the only source of the truth it shortens.
  const riskShare = Math.min(72, Math.max(28, (riskUsd / (riskUsd + rewardUsd)) * 100));
  return (
    <div
      data-testid="mission-risk-reward"
      className={cn("flex items-center gap-3", CONTEXT_BAND_CLASS)}
    >
      <span className="flex h-5 min-w-0 flex-1 overflow-hidden rounded-[4px] font-mono text-[10px] tabular-nums">
        <span
          className="flex items-center justify-start whitespace-nowrap bg-loss/15 px-1.5 text-loss"
          style={{ width: `${riskShare}%` }}
        >
          {formatSignedUsd(-riskUsd)}
        </span>
        <span className="flex flex-1 items-center justify-end whitespace-nowrap bg-profit/15 px-1.5 text-profit">
          {formatSignedUsd(rewardUsd)}
        </span>
      </span>
      <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatRatio(ratio)}:1 planned
      </span>
    </div>
  );
}

/**
 * The few figures that describe the exposure, as a two-column grid of hairline
 * cells rather than a wrapping line of `label value` pairs.
 *
 * A wrapping line puts a different number under a different label every time
 * the panel resizes; a grid puts the same figure in the same cell, so the eye
 * learns where "liq" is and stops reading labels.
 *
 * Six cells while live, in the reference's own order: what is held, what it
 * was bought at, what it is worth now, where it stops, where it is closed out
 * for us, and what is posted against it. Entry and mark are also tagged on the
 * chart, and that duplication is deliberate: the gutter tag says WHERE on the
 * shape, the cell says WHAT the number is, and an operator reading a column of
 * figures should not have to read a picture to find two of them. Two cells
 * (size and stop, which is all the panel showed before this) left the card
 * looking like it had failed to load the rest.
 *
 * P&L, ROI and progress stay out: they are header figures, and this grid sits
 * directly beneath them.
 *
 * Protection is an exception cell, not a standing one. A stop that covers the
 * whole position is the normal case and says nothing worth a row; a stop
 * covering part of it, or none, is the difference between a bounded loss and
 * an open-ended one, so THAT gets a cell, in the loss tone (§16.1).
 */
/**
 * The icon that leads each cell's label.
 *
 * One table, so the nine of them read as one system: a cell's glyph never
 * changes with the mission's state, and a label with no entry here simply goes
 * without rather than borrowing a near-enough shape.
 */
const STAT_ICONS: Record<string, typeof Box> = {
  Size: Box,
  Entry: ArrowRightToLine,
  Mark: Crosshair,
  Stop: OctagonMinus,
  Liq: TriangleAlert,
  Margin: Wallet,
  Risk: TrendingDown,
  Target: Target,
  Protected: ShieldAlert,
};

function StatGrid({
  state,
  position,
  markPrice,
  stopPrice,
  plan,
}: {
  readonly state: PanelState;
  readonly position?: {
    readonly size: number;
    readonly entryPrice?: number | null | undefined;
    readonly liquidationPrice?: number | null | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  };
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
  readonly plan: StrategyPlan | null;
}): ReactNode {
  const cells: Array<{ label: string; value: string; tone?: string }> = [];

  if (position !== undefined) {
    cells.push({ label: "Size", value: formatSize(Math.abs(position.size)) });
    if (position.entryPrice != null)
      cells.push({ label: "Entry", value: formatPrice(position.entryPrice) });
    if (markPrice !== null) cells.push({ label: "Mark", value: formatPrice(markPrice) });
    cells.push(
      stopPrice === null
        ? { label: "Stop", value: "None", tone: "text-loss" }
        : { label: "Stop", value: formatPrice(stopPrice) },
    );
    if (position.liquidationPrice != null)
      cells.push({ label: "Liq", value: formatPrice(position.liquidationPrice) });
    if (position.marginUsed > 0)
      cells.push({ label: "Margin", value: formatUsd(position.marginUsed) });
    const covered = Math.abs(position.protectedSize);
    const held = Math.abs(position.size);
    if (stopPrice !== null && covered < held)
      cells.push({
        label: "Protected",
        value: covered === 0 ? "None" : `${formatSize(covered)} of ${formatSize(held)}`,
        tone: "text-loss",
      });
  } else if (state === "armed") {
    if (plan?.initialSizeUsd != null)
      cells.push({ label: "Size", value: formatUsd(plan.initialSizeUsd) });
    if (plan?.maxLossUsd != null)
      cells.push({ label: "Risk", value: formatUsd(plan.maxLossUsd), tone: "text-loss" });
    if (plan?.targetUsd != null)
      cells.push({ label: "Target", value: formatUsd(plan.targetUsd), tone: "text-profit" });
  } else {
    // Planning has no plan to describe, so it says the one thing it knows: the
    // market it is reading.
    if (markPrice !== null) cells.push({ label: "Mark", value: formatPrice(markPrice) });
  }
  // The countdown is not a cell in either state any more. It had a home in the
  // chart's future gutter already, and a third copy in a grid of prices made
  // the one figure on the panel that is a duration read as one of them. It is
  // the status bar's now — see MissionStatusBar.

  if (cells.length === 0) return null;
  return (
    <div
      data-testid="mission-stat-grid"
      className="mx-4 mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/40 bg-border/40 sm:mx-5"
    >
      {cells.map((cell, index) => {
        const Icon = STAT_ICONS[cell.label] ?? null;
        return (
          <span
            key={cell.label}
            // An odd last cell takes the whole row rather than leaving a hole in
            // the grid: a blank half-cell reads as a figure that failed to load.
            className={cn(
              "flex items-baseline justify-between gap-2 bg-foreground/[0.03] px-3 py-2 font-mono text-[12px] tabular-nums",
              index === cells.length - 1 && cells.length % 2 === 1 && "col-span-2",
            )}
          >
            {/* The icon rides the label, in the label's own ink — an exception
                cell tints both together, so the glyph never says something
                milder than the words beside it. The label is the accessible
                name; the icon is decoration on top of it. */}
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em]",
                cell.tone ?? "text-muted-foreground",
              )}
            >
              {Icon === null ? null : (
                <Icon
                  className="size-[11px] flex-none translate-y-[-0.5px] opacity-70"
                  strokeWidth={2}
                  aria-hidden
                />
              )}
              <span className="truncate">{cell.label}</span>
            </span>
            <span className={cn("truncate", cell.tone ?? "text-foreground")}>{cell.value}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Where the exposure will be reported, drawn empty while there is none.
 *
 * The six cells the fill will fill, as bars — same grid, same rhythm, same
 * height — so the card does not reflow at the one moment the operator is
 * watching it hardest. It names the cells rather than shimmering anonymously:
 * a placeholder that says SIZE / ENTRY / MARK / STOP / LIQ / MARGIN is telling
 * the operator what is about to appear, which a generic loading block does not.
 */
function PositionSkeleton({ market }: { readonly market: string }): ReactNode {
  const labels = ["Size", "Entry", "Mark", "Stop", "Liq", "Margin"] as const;
  return (
    <div data-testid="mission-position-skeleton" className="mx-4 mb-3 sm:mx-5">
      {/* The receipt's own chip row, drawn empty. This is the pill that used to
          sit in the conversation — same capsule, same rhythm — waiting in the
          place it will report from. */}
      <div className="flex items-center gap-1.5 pb-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border/70 px-2.5 py-0.5 font-mono text-[11.5px] text-muted-foreground">
          <Clock className="size-3 opacity-60" aria-hidden />
          <span>{market}</span>
          <span className="opacity-60">no position</span>
        </span>
        <span className={cn("ml-auto", BAND_LEGEND_CLASS)}>opens on the entry fill</span>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-dashed border-border/50 bg-border/25">
        {labels.map((label) => {
          const Icon = STAT_ICONS[label] ?? null;
          return (
            <span
              key={label}
              className="flex items-center justify-between gap-2 bg-foreground/[0.02] px-3 py-2"
            >
              {/* The same glyphs the filled grid uses, a stop fainter: the
                placeholder names the cell the fill will land in, so it should
                be the same object, not a different one at the same size. */}
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground/60">
                {Icon === null ? null : (
                  <Icon
                    className="size-[11px] flex-none translate-y-[-0.5px] opacity-40"
                    strokeWidth={2}
                    aria-hidden
                  />
                )}
                <span className="truncate">{label}</span>
              </span>
              {/* A static dash, not a shimmer: nothing is loading here — the
                mission is flat and waiting for a fill. A shimmering bar in
                this cell read as a request stuck forever. */}
              <span className="font-mono text-[11px] text-muted-foreground/40" aria-hidden>
                —
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Every position the mission has taken, one row each, the open one first.
 *
 * The stat grid is the exposure now; the watch stream is what could still
 * happen. Between them there was nothing that said what the mission had
 * already done, and the position it was IN was described in a different block
 * from the ones it came from. This is the ledger: side, size, what it committed,
 * where it went in and out, and what it came to.
 *
 * The side pill is the same pill the card's position block uses, so a position
 * looks the same wherever the panel names it. It is also the one place the
 * long/short palette is borrowed for something other than P&L, and the
 * legitimate one: it IS the direction of the trade. The net beside it is money,
 * so its tint means what it always means.
 *
 * Every row is the same five columns, always, on one grid rather than one grid
 * per row: the band is read down a column as often as across a row. Figures are
 * fixed at three decimals, which is what lets the price column right-align and
 * have its arrows line up too. Missing figures render as "—" rather than
 * collapsing a column.
 *
 * The open row is told apart by the only honest difference there is: its exit
 * figure is the live mark, so it is the one row in the band that moves. No
 * colour of its own, and no animation.
 */
function PositionLedger({
  rows,
  market,
  leverageLabel,
}: {
  readonly rows: ReadonlyArray<PositionLedgerRow>;
  readonly market: string;
  /**
   * The mission's configured leverage. Fills record none, so this is the
   * mandate the position ran under rather than a per-fill fact; null renders
   * the pill without a leverage tag instead of inventing one.
   */
  readonly leverageLabel: string | null;
}): ReactNode {
  if (rows.length === 0) return null;
  // The open position is never the row that gets cut: the cap counts settled
  // ones, which are the ones an operator scrolls back through.
  const active = rows.filter((row) => row.isActive);
  const settled = rows.filter((row) => !row.isActive);
  const shown = [...active, ...settled.slice(0, MAX_LEDGER_ROWS)];
  const earlier = settled.length - (shown.length - active.length);

  return (
    <div data-testid="mission-position-history" className={cn(BAND_PAD_CLASS, "pb-3")}>
      <p className={cn(BAND_LEGEND_CLASS, "pb-1.5")}>positions</p>
      {/* One grid for the whole band, each row a subgrid of it: the columns are
          measured once, so a row with a "—" entry price rules up with a row
          that has both prices. Per-row grids would each size their own `auto`
          columns and the band would drift line by line. */}
      {/* Identity and time take what they need; the four figure columns share
          the rest equally, so the band's width becomes even spacing rather than
          one lake of it. Sized in `fr` rather than by `justify-between`, which
          Chromium redistributes inside each subgrid row and which drifted the
          headings sixty pixels off their own figures. `max-content` floors keep
          a figure from ever wrapping when the panel is narrow. */}
      <div className="grid grid-cols-[auto_auto_repeat(4,minmax(max-content,1fr))] gap-y-1.5">
        {/* Six figures a row need naming, the same way every cell of the stat
            grid is named: on a band this wide the reader cannot tell a notional
            from a net by position alone. The identity column labels itself. */}
        {/* The same box as a row — transparent border, same column gap — so the
            headings sit over the figures they name. A subgrid with a different
            gap redistributes inside the shared outer lines, which is what put
            the headings six pixels off their own columns. */}
        <div className="col-span-full grid grid-cols-subgrid gap-x-3 border border-transparent px-2 pb-0.5">
          <span />
          <LedgerHeading>closed</LedgerHeading>
          <LedgerHeading>size</LedgerHeading>
          <LedgerHeading>notional</LedgerHeading>
          <LedgerHeading>entry → exit</LedgerHeading>
          <LedgerHeading>net</LedgerHeading>
        </div>
        {shown.map((row) => (
          <LedgerRow key={row.key} row={row} market={market} leverageLabel={leverageLabel} />
        ))}
        {earlier === 0 ? null : (
          <span className="col-span-full font-mono text-[11px] tabular-nums text-muted-foreground/60">
            +{earlier} earlier
          </span>
        )}
      </div>
    </div>
  );
}

/** A ledger column's name, in the legend's own ink so it recedes behind figures. */
function LedgerHeading({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <span
      className={cn(BAND_LEGEND_CLASS, "whitespace-nowrap text-right text-muted-foreground/50")}
    >
      {children}
    </span>
  );
}

/**
 * A position's full record, as the fill receipt states it.
 *
 * The receipts in the conversation are on their way out, so this is where their
 * fields have to keep living: both legs with their fees, times and order ids,
 * and the money figures the position came to. The open row says what it is
 * holding instead of what it settled at, because that is what it has.
 */
function LedgerDetail({
  row,
  market,
  leverageLabel,
}: {
  readonly row: PositionLedgerRow;
  readonly market: string;
  readonly leverageLabel: string | null;
}): ReactNode {
  const isLong = row.direction === "long";
  return (
    <div className="flex w-64 flex-col gap-1.5 text-left">
      <div className="flex items-center gap-1.5">
        <SideChip market={market} leverageLabel={leverageLabel} isLong={isLong} size="sm" />
        {row.isActive ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            active
          </span>
        ) : null}
      </div>
      <LedgerDetailRow
        label="Opened"
        value={
          row.entryPrice === null
            ? "older than the panel's fill window"
            : `${formatFixed3(row.size)} ${market} @ ${formatFixed3(row.entryPrice)}`
        }
      />
      {row.openedAtMillis === null ? null : (
        <LedgerDetailRow
          label=""
          value={
            row.openOrderRef === null
              ? new Date(row.openedAtMillis).toLocaleTimeString()
              : `${new Date(row.openedAtMillis).toLocaleTimeString()} · order ${row.openOrderRef}`
          }
        />
      )}
      <LedgerDetailRow
        label={row.isActive ? "Mark" : "Closed"}
        value={
          row.exitPrice === null
            ? "no read yet"
            : row.isActive
              ? formatFixed3(row.exitPrice)
              : `${formatFixed3(row.size)} ${market} @ ${formatFixed3(row.exitPrice)}`
        }
      />
      {row.isActive || row.closedAtMillis === null ? null : (
        <LedgerDetailRow
          label=""
          value={`${new Date(row.closedAtMillis).toLocaleTimeString()} · order ${row.orderRef ?? "—"}`}
        />
      )}
      <LedgerDetailRow
        label="Notional"
        value={row.notionalUsd === null ? "—" : `${formatUsd(row.notionalUsd)} at entry`}
      />
      {row.marginUsd === null ? null : (
        <LedgerDetailRow label="Margin" value={formatUsd(row.marginUsd)} />
      )}
      {row.closedPnlUsd === null ? null : (
        <LedgerDetailRow label="Realised" value={formatSignedUsd(row.closedPnlUsd)} />
      )}
      {row.feesUsd === null ? null : (
        <LedgerDetailRow label="Fees" value={formatUsd(row.feesUsd)} />
      )}
      <LedgerDetailRow
        label={row.isActive ? "Unrealised" : "Net"}
        value={formatSignedUsd(row.netUsd)}
      />
    </div>
  );
}

/** A label/value line of the ledger detail, in the popover's own row style. */
function LedgerDetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-[11px] tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/**
 * One position: side pill, size in its own units, notional, both prices, net.
 *
 * The row is a button because it has somewhere to go — hover and keyboard focus
 * show the record as a tooltip, and a press opens the same record as a popover,
 * which is the only path a touch screen has to it. A row that merely lit up
 * under the pointer would be an affordance pointing at nothing.
 */
function LedgerRow({
  row,
  market,
  leverageLabel,
}: {
  readonly row: PositionLedgerRow;
  readonly market: string;
  readonly leverageLabel: string | null;
}): ReactNode {
  const isLong = row.direction === "long";
  // One surface at a time: while the pressed-open record is showing, the hover
  // one is switched off rather than stacked behind it.
  const [detailOpen, setDetailOpen] = useState(false);
  const detail = <LedgerDetail row={row} market={market} leverageLabel={leverageLabel} />;
  // The same record flattened, so the row reads back whole rather than as five
  // orphaned figures.
  const label = [
    `${row.isActive ? "Active" : "Closed"} ${isLong ? "long" : "short"} ${formatFixed3(row.size)} ${market} at ${leverageLabel ?? "unstated leverage"}`,
    row.notionalUsd === null ? "notional unknown" : `notional ${formatUsd(row.notionalUsd)}`,
    row.entryPrice === null
      ? "the opening fill is older than the panel's window"
      : `entered ${formatFixed3(row.entryPrice)}`,
    row.exitPrice === null
      ? "no closing price"
      : row.isActive
        ? `marked ${formatFixed3(row.exitPrice)}`
        : `exited ${formatFixed3(row.exitPrice)}`,
    `${row.isActive ? "unrealised" : "net"} ${formatSignedUsd(row.netUsd)}`,
  ].join(", ");

  return (
    <Popover open={detailOpen} onOpenChange={setDetailOpen}>
      <Tooltip disabled={detailOpen}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  data-active={row.isActive ? "" : undefined}
                  className={cn(
                    "col-span-full grid h-7 grid-cols-subgrid items-center gap-x-3 rounded-full border px-2 text-left font-mono text-[11px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    row.isActive
                      ? "border-border bg-foreground/[0.06] hover:bg-foreground/[0.09]"
                      : "border-border/60 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
                  )}
                />
              }
            />
          }
        >
          {/* The card's own side pill, so one position reads the same in the
              ledger as it does in the position block above. */}
          <SideChip market={market} leverageLabel={leverageLabel} isLong={isLong} size="sm" />
          {/* How the position ended, which for one of them is that it has not.
              `active` sits in the column where every other row states its close
              time, rather than as a badge beside the pill: it is the answer to
              the same question, so it belongs in the same place. */}
          <span
            className={cn(
              "whitespace-nowrap",
              row.isActive
                ? "uppercase tracking-[0.14em] text-foreground/80"
                : "text-muted-foreground/60",
            )}
          >
            {row.isActive
              ? "active"
              : row.closedAtMillis === null
                ? "—"
                : new Date(row.closedAtMillis).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
          </span>
          {/* The size carries its own unit: a bare 0.500 in a column beside
              dollar figures is a number without a denomination. */}
          <span className="whitespace-nowrap text-right text-muted-foreground">
            {formatFixed3(row.size)} <span className="text-muted-foreground/60">{market}</span>
          </span>
          {/* What the position committed, which is the figure that says whether
              a $2 result came off a small position or a large one. */}
          <span className="whitespace-nowrap text-right text-muted-foreground/70">
            {row.notionalUsd === null ? "—" : formatUsd(row.notionalUsd)}
          </span>
          {/* Always the pair, so the column reads as one shape. The open row's
              second figure is the live mark, in foreground ink because it is
              the only figure here still moving. */}
          <span className="whitespace-nowrap text-right text-muted-foreground/70">
            {row.entryPrice === null ? "—" : formatFixed3(row.entryPrice)}{" "}
            <span className="text-muted-foreground/50">→</span>{" "}
            <span className={row.isActive ? "text-foreground/90" : undefined}>
              {row.exitPrice === null ? "—" : formatFixed3(row.exitPrice)}
            </span>
          </span>
          <span className={cn("text-right", row.netUsd >= 0 ? "text-profit" : "text-loss")}>
            {formatSignedUsd(row.netUsd)}
          </span>
        </TooltipTrigger>
        {/* Left, so the record does not cover the watch stream under the band. */}
        <TooltipPopup side="left" variant="glass" className="max-w-none">
          {detail}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="left" align="start" viewportClassName="py-3">
        {detail}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * What the last drag came back saying.
 *
 * Three sentences and no fourth: the model republished underneath it, the
 * exchange refused to move the stop, or the take-profit could not be confirmed
 * and the previous one is still resting. All stay until the operator drags
 * again — a message that disappears on a timer is one they will miss while
 * looking at the chart.
 */
function RevisionNote({ revision }: { readonly revision: MissionPlanRevision }): ReactNode {
  const message = revision.lockLost
    ? "The model republished the plan while you were dragging, so the level snapped back. Drag again against what is there now."
    : (revision.refusedStop?.detail ?? revision.unconfirmedTarget?.detail ?? revision.error);
  if (message === null || message === undefined) return null;
  return (
    <button
      type="button"
      onClick={revision.dismiss}
      data-testid="mission-revision-note"
      className="w-full px-3 py-1.5 text-left text-[11px] leading-snug text-muted-foreground"
    >
      {message}
    </button>
  );
}

/** What a collapsed armed mission says in one clause. */
function describeArmedSummary(armed: { readonly rows: ReadonlyArray<unknown> } | null): string {
  if (armed === null || armed.rows.length === 0) return "Waiting";
  return `Waiting on ${armed.rows.length} condition${armed.rows.length === 1 ? "" : "s"}`;
}

/**
 * The header chip of a flat mission: the market, and what it is doing about it.
 *
 * The figures that used to sit beside it — size, max loss, the countdown — are
 * cells in the stat grid now, where they line up with the same figures a live
 * mission shows. The pulse marks the one state where nothing has been decided
 * yet, so it is the mission working rather than the mission waiting.
 *
 * The icon leads and the word stays. A glyph alone would make three states that
 * differ by a great deal — reading the market, waiting for a level, having
 * declined the trade — depend on the reader knowing three shapes; the word is
 * what makes it accurate, and the icon is what makes it findable.
 */
function StateChip({
  market,
  state,
}: {
  readonly market: string;
  readonly state: "planning" | "waiting" | "standing_aside";
}): ReactNode {
  const { Icon, label } =
    state === "planning"
      ? { Icon: Radar, label: "Analysing" }
      : state === "standing_aside"
        ? { Icon: CircleSlash, label: "Standing aside" }
        : { Icon: Crosshair, label: "Waiting" };
  return (
    <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-armed/40 bg-armed/10 px-2.5 py-0.5 font-mono text-[12px] text-armed">
      <Icon className="size-3" strokeWidth={2} aria-hidden />
      {state === "planning" ? (
        <span
          className="size-1.5 animate-pulse rounded-full bg-armed motion-reduce:animate-none"
          aria-hidden
        />
      ) : null}
      <span>{market}</span>
      <span className="text-armed/80">{label}</span>
    </span>
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
  readonly nowMillis: number;
  readonly triggerExpiryAt: number | null;
  readonly projection: { readonly price: number; readonly atMillis: number } | null;
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
        nowMillis={props.nowMillis}
        {...(props.triggerExpiryAt === null ? {} : { triggerExpiryAt: props.triggerExpiryAt })}
        projection={props.projection}
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

/**
 * How long a just-fired row keeps its place on the checklist while the live
 * dot becomes a tick, before it drops into the history below.
 */
const FIRED_LINGER_MILLIS = 4_000;

/**
 * Which rows flipped from waiting to met since the panel last looked.
 *
 * The server is the truth about `met`; this hook only remembers the moment of
 * transition so the row can be held on screen through its tick animation. A
 * row that mounts already met (the panel just opened) never counts — there is
 * no moment to show.
 */
function useRecentlyFiredWatches(
  items: ReadonlyArray<WatchStreamItem>,
  nowMillis: number,
): ReadonlySet<string> {
  // No timers: the panel already re-renders on its 250ms clock, so the linger
  // is read off `nowMillis` and expired entries are pruned lazily. A timeout
  // here would be cleared by the next poll's new `rows` identity and leave a
  // fired row stuck at the top of the stream forever.
  const seenMet = useRef<Map<string, boolean>>(new Map());
  const firedAt = useRef<Map<string, number>>(new Map());

  for (const item of items) {
    // Only take-downs group, so a group never contains the transition this
    // hook exists to catch.
    if (item.kind !== "watch") continue;
    const row = item;
    const met = row.state === "triggered";
    const wasMet = seenMet.current.get(row.id);
    if (wasMet === false && met && !firedAt.current.has(row.id)) {
      firedAt.current.set(row.id, nowMillis);
    }
    seenMet.current.set(row.id, met);
  }

  const fired = new Set<string>();
  for (const [id, at] of firedAt.current) {
    if (nowMillis - at < FIRED_LINGER_MILLIS) fired.add(id);
    else firedAt.current.delete(id);
  }
  return fired;
}

/**
 * The watch stream: one list from armed to settled.
 *
 * It was two lists under two headings — a checklist of what was armed, and a
 * scrollback of what had fired. A watch that fired vanished from the first and
 * reappeared in the second, which is the single event the operator most wants
 * to follow, hidden by the layout. One list, one scroll, and the row stays put
 * while its dot changes.
 *
 * Armed rows are sticky at the top of the scroll: what can still happen is
 * what the operator is monitoring, and scrolling back through an hour of
 * history should not take it off screen. They are naturally few — a mission
 * arms a handful of levels, not a page of them.
 */
function WatchStream({
  rows,
  nowMillis,
  recentlyFired,
  droppedConditions,
}: {
  readonly rows: ReadonlyArray<WatchStreamItem>;
  readonly nowMillis: number;
  readonly recentlyFired: ReadonlySet<string>;
  /** Armed levels the chart could not draw, reported once under the list. */
  readonly droppedConditions: number;
}): ReactNode {
  // A row that just fired is held among the armed rows for a beat: the dot
  // becomes a tick in place rather than the row jumping down the list.
  const held = (item: WatchStreamItem) => isArmedRow(item) || recentlyFired.has(item.id);
  const armed = rows.filter(held);
  const allSettled = rows.filter((item) => !held(item));
  // A long mission re-levels constantly: six hundred settled watches is sixty
  // screens of scroll, and the row worth finding is never the four-hundredth.
  // The tail is bounded and the count says what was left off, so the list stays
  // scrollable rather than becoming an archive nobody reaches the end of.
  const settled = allSettled.slice(0, MAX_SETTLED_WATCH_ROWS);
  const earlierSettled = allSettled.length - settled.length;

  return (
    <div data-testid="mission-watch-stream" className="border-t border-border/40 pt-2.5 pb-1">
      <div className="max-h-[220px] overflow-y-auto overscroll-contain">
        {armed.length === 0 ? null : (
          // Sticky, on a surface that actually hides what slides under it. The
          // panel is a translucent card, so a translucent strip inside it let
          // settled rows read straight through the armed ones — two sentences
          // in the same place, which is worse than either. The blur closes the
          // gap between this opaque fill and the card's own tint.
          <div className="sticky top-0 z-10 bg-card backdrop-blur-sm">
            <div className="divide-y divide-border/25">
              {armed.map((item) => (
                <WatchStreamItemRow
                  key={item.id}
                  item={item}
                  nowMillis={nowMillis}
                  justFired={recentlyFired.has(item.id)}
                />
              ))}
            </div>
            {/* The waterline: live above, over below. No heading on either
                side of it — both halves are the same objects, and two labels
                made them read as two systems. Flush at the pinned block's
                bottom edge, because when the stream is scrolled this is also
                the edge settled rows slide under. */}
            {settled.length === 0 ? null : <div className="h-px bg-border" />}
          </div>
        )}
        <div className="divide-y divide-border/15">
          {settled.map((item) => (
            <WatchStreamItemRow key={item.id} item={item} nowMillis={nowMillis} justFired={false} />
          ))}
        </div>
        {earlierSettled === 0 ? null : (
          <p
            className={cn(
              BAND_PAD_CLASS,
              "py-2 font-mono text-[11px] tabular-nums text-muted-foreground/60",
            )}
          >
            {earlierSettled} earlier watch{earlierSettled === 1 ? "" : "es"} not shown
          </p>
        )}
      </div>
      {droppedConditions === 0 ? null : (
        <p className={cn(BAND_PAD_CLASS, "pt-1.5 font-mono text-[11px] text-muted-foreground")}>
          +{droppedConditions} more level{droppedConditions === 1 ? "" : "s"} armed, off the chart
        </p>
      )}
    </div>
  );
}

/**
 * The lifecycle dot.
 *
 * Four states, and none of them borrows the long/short palette: a watch firing
 * is not a profit and a watch being cancelled is not a loss, and colouring them
 * green and red would put two unrelated meanings on the panel's most loaded
 * pair of hues. Armed is the amber `--armed` already used for "committed but
 * not yet exposed"; triggered is `--info` blue, which reads as an arrival;
 * disarmed and expired both recede into the muted ink, separated by fill
 * against ring — taken down is solid, ran out is hollow.
 */
function WatchDot({
  state,
  justFired,
}: {
  readonly state: WatchLifecycleState;
  readonly justFired: boolean;
}): ReactNode {
  if (state === "armed") {
    return (
      <span className="relative inline-flex size-2" aria-label="armed">
        {/* The evaluator really is sweeping this predicate every couple of
            seconds, so the dot breathes. `watch-dot-pulse` rather than
            Tailwind's `animate-ping`, which carries no reduced-motion guard —
            see index.css. */}
        <span className="watch-dot-pulse absolute inline-flex size-full rounded-full bg-armed/50" />
        <span className="relative inline-flex size-2 rounded-full bg-armed/70" />
      </span>
    );
  }
  if (state === "triggered") {
    return (
      <span
        className={cn("inline-block size-2 rounded-full bg-info", justFired && "watch-tick-in")}
        aria-label="fired"
      />
    );
  }
  if (state === "expired") {
    return (
      <span
        className="inline-block size-2 rounded-full border border-muted-foreground/45"
        aria-label="expired"
      />
    );
  }
  return (
    <span
      className="inline-block size-2 rounded-full bg-muted-foreground/45"
      aria-label="disarmed"
    />
  );
}

/**
 * The icon that says which kind of predicate a row is.
 *
 * One vocabulary across the whole card: Crosshair already means "a price level"
 * wherever it appears, Activity is the wake beacon's PnL mark, and Receipt is
 * its fill mark. A row therefore names its kind in the shape the reader has
 * already learned somewhere else on the panel.
 */
const WATCH_TYPE_ICON: Record<WatchRowType, LucideIcon> = {
  candle_close: ChartCandlestick,
  price_cross: Crosshair,
  pnl_above: Activity,
  pnl_below: Activity,
  pnl_giveback: Activity,
  metric_threshold: Gauge,
  order_update: Receipt,
  position_update: Receipt,
};

/**
 * A watch's figure in the units its own predicate compares.
 *
 * A PnL level is signed dollars, a give-back is a dollar distance (the sign
 * would claim a side it does not have), a metric is the raw number the
 * evaluator uses — a formatter that guessed units would misstate at least one
 * metric — and a price is a price.
 */
function formatWatchFigure(watchType: WatchRowType, value: number): string {
  switch (watchType) {
    case "price_cross":
    case "candle_close":
      return formatPrice(value);
    case "pnl_above":
    case "pnl_below":
      return formatSignedUsd(value);
    case "pnl_giveback":
      return formatUsd(value);
    case "metric_threshold":
      return String(value);
    case "order_update":
    case "position_update":
      // Neither carries a level; these rows show their subject instead.
      return "";
  }
}

/**
 * One row: dot, kind, direction, figure — and when.
 *
 * It used to be a sentence, and three of its words repeated on every row: the
 * market (the card header names it once) and the verb phrase (which is the
 * predicate's type, and a type is a glyph). What is left is the row's payload —
 * the figure — with the icons that qualify it, in the chart gutter's own
 * ▲ / ▼ + mono-figure vocabulary, so a row here and its dotted line over there
 * read as the same object seen twice.
 *
 * The direction triangle is muted ink, never the profit/loss pair: the side of
 * a predicate is not the side of a trade.
 *
 * Everything else — the live reading against the threshold, the decision the
 * mission took after it fired — is behind the disclosure, because a stream
 * four rows deep with two lines each stops being scannable at exactly the
 * moment it matters.
 */
function WatchStreamEntry({
  row,
  nowMillis,
  justFired,
}: {
  readonly row: WatchStreamRow;
  readonly nowMillis: number;
  readonly justFired: boolean;
}): ReactNode {
  const armed = isArmedRow(row);
  const format = (value: number) => formatWatchFigure(row.watchType, value);
  const observed = row.observedValue === null ? null : format(row.observedValue);
  const threshold = row.thresholdValue === null ? null : format(row.thresholdValue);
  const hasDetail = observed !== null || threshold !== null || row.actionLabel !== null;

  const TypeIcon = WATCH_TYPE_ICON[row.watchType];
  const age = formatAge(Math.max(0, nowMillis - row.atMillis));
  // The full sentence stays the row's accessible name: the glyphs are a
  // shorthand for readers who can see them, not a replacement for the fact.
  const label = armed
    ? `${row.description}, armed ${age}`
    : `${row.description}, ${row.outcomeLabel ?? "fired"} ${age}`;

  const summary = (
    <>
      <span className="w-3 flex-none text-center">
        <WatchDot state={row.state} justFired={justFired} />
      </span>
      <TypeIcon
        className="size-[11px] flex-none self-center text-muted-foreground/60"
        strokeWidth={2}
        aria-hidden
      />
      {row.direction === null ? null : (
        <span className="flex-none text-[9px] text-muted-foreground" aria-hidden>
          {row.direction === "above" ? "▲" : "▼"}
        </span>
      )}
      {/* The payload. It never truncates — the icons before it drop first —
          because the figure is the only thing on the row that cannot be
          inferred from anything else on the card. */}
      {threshold === null ? (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            armed ? "text-foreground/90" : "text-muted-foreground",
          )}
        >
          {row.description}
        </span>
      ) : (
        <span
          className={cn(
            "flex-none tabular-nums",
            armed ? "text-foreground/90" : "text-muted-foreground",
          )}
        >
          {threshold}
        </span>
      )}
      {row.intervalLabel === null ? null : (
        <span className="min-w-0 truncate text-muted-foreground/60">{row.intervalLabel}</span>
      )}
      {/* Which prediction armed it. Only the runtime's own prediction watches
          carry one, so the column is empty for everything the model armed
          itself — which is the distinction, not a gap. */}
      {row.predictionVersion === null ? null : (
        <span className="ml-auto flex-none tabular-nums text-muted-foreground/60">
          v{row.predictionVersion}
        </span>
      )}
      <span
        className={cn(
          "flex-none tabular-nums text-muted-foreground/60",
          row.predictionVersion === null && "ml-auto",
        )}
      >
        {age}
      </span>
    </>
  );

  const rowClass = cn(BAND_PAD_CLASS, "flex items-baseline gap-x-2 py-2 font-mono text-[11.5px]");

  if (!hasDetail) {
    return (
      <div className={rowClass} aria-label={label}>
        {summary}
      </div>
    );
  }

  return (
    <details className="group">
      <summary
        aria-label={label}
        className={cn(
          rowClass,
          "cursor-pointer list-none select-none marker:hidden hover:bg-foreground/[0.02]",
        )}
      >
        {summary}
      </summary>
      {/* Indented past the dot column so the detail hangs under the row it
          belongs to, not under the dot. The sentence the row no longer spells
          out leads it: this is where the words live now. */}
      <div className={cn(BAND_PAD_CLASS, "pb-2 font-mono text-[11px] text-muted-foreground/70")}>
        <div className="pl-[1.375rem]">
          <p className="leading-[1.35]">{row.description}</p>
          {threshold === null ? null : (
            <p className="tabular-nums">
              {observed === null
                ? `no reading taken yet, against ${threshold}`
                : `last read ${observed}, against ${threshold}`}
            </p>
          )}
          {row.actionLabel === null ? null : <p>then: {row.actionLabel}</p>}
        </div>
      </div>
    </details>
  );
}

/** A watch row or a folded burst of take-downs, whichever the stream holds here. */
function WatchStreamItemRow({
  item,
  nowMillis,
  justFired,
}: {
  readonly item: WatchStreamItem;
  readonly nowMillis: number;
  readonly justFired: boolean;
}): ReactNode {
  if (item.kind === "group") {
    return <WatchGroupEntry group={item} nowMillis={nowMillis} />;
  }
  return <WatchStreamEntry row={item} nowMillis={nowMillis} justFired={justFired} />;
}

/**
 * A replan's take-downs, as one line that opens into the rows it stands for.
 *
 * "watches" rather than "levels": a burst can carry a PnL floor and a metric
 * threshold, neither of which is a level. No type icon either — a group spans
 * types, and one of its members' glyphs would misname the rest.
 */
function WatchGroupEntry({
  group,
  nowMillis,
}: {
  readonly group: WatchStreamGroup;
  readonly nowMillis: number;
}): ReactNode {
  const age = formatAge(Math.max(0, nowMillis - group.atMillis));
  const summary = `${group.count} watches ${group.outcomeLabel}`;

  return (
    <details className="group">
      <summary
        aria-label={`${summary}, ${age}`}
        className={cn(
          BAND_PAD_CLASS,
          "flex cursor-pointer list-none select-none items-baseline gap-x-2 py-2 font-mono text-[11.5px] text-muted-foreground marker:hidden hover:bg-foreground/[0.02]",
        )}
      >
        <span className="w-3 flex-none text-center">
          <span
            className="inline-block size-2 rounded-full border border-muted-foreground/45"
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1 truncate tabular-nums">{summary}</span>
        <span className="flex-none tabular-nums text-muted-foreground/60">{age}</span>
      </summary>
      {/* The members as the ordinary settled rows they are, indented so the
          group reads as the heading over them rather than a peer. */}
      <div className="divide-y divide-border/15 pl-[1.375rem]">
        {group.members.map((row) => (
          <WatchStreamEntry key={row.id} row={row} nowMillis={nowMillis} justFired={false} />
        ))}
      </div>
    </details>
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
  if (remaining <= 0) return "due";
  // Just the duration. The cell is labelled NEXT, so "reassess in 14m 3s" both
  // repeated its own label and overflowed the cell — the panel was printing
  // "reassess in 14…", which says neither how long nor until what.
  return formatDuration(remaining);
}

/**
 * Everything the published plan says.
 *
 * The same body that used to sit behind a disclosure at the foot of the readout
 * card, unchanged but for losing its own `<details>`: the popup it now lives in
 * IS the disclosure, and a second expander inside an opened popup would be a
 * control the reader has already used.
 */
function PlanBody({ plan }: { readonly plan: StrategyPlan }): ReactNode {
  return (
    <div className="text-[12px]">
      <p className={cn(BAND_LEGEND_CLASS, "pb-2")}>
        plan · {plan.isStandAside ? "standing aside" : plan.planPhase}
      </p>
      <div className="space-y-1">
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
    </div>
  );
}

/**
 * The plan, on the bar, opening upward.
 *
 * It is anchored to the sentence it explains rather than to the foot of a
 * scrolling column, and it opens over the panel instead of pushing the
 * composer down — which is what the disclosure did every time it was used, at
 * the moment the reader wanted to compare the plan against the figures it had
 * just displaced.
 *
 * 400px wide on purpose: the readout card's own width, so the plan's fields
 * wrap on the same measure as the figures they describe.
 */
function PlanPopover({ plan }: { readonly plan: StrategyPlan }): ReactNode {
  return (
    <Popover>
      <PopoverTrigger
        aria-haspopup="dialog"
        data-testid="mission-plan-trigger"
        className="inline-flex flex-none items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
      >
        <FileText className="size-3" strokeWidth={2} aria-hidden />
        Plan
      </PopoverTrigger>
      {/* Upward, because the bar is the panel's bottom edge and the composer is
          directly under it. */}
      <PopoverPopup side="top" align="start" className="w-[400px] max-w-[calc(100vw-2rem)]">
        <div className="max-h-[60vh] overflow-y-auto">
          <PlanBody plan={plan} />
        </div>
      </PopoverPopup>
    </Popover>
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
      className="block h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10"
      aria-hidden
    >
      {/* The width eases rather than jumping: the mark moves every 3s, and a
          rule that snaps reads as a re-render while one that travels reads as
          the trade advancing. */}
      <span
        className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
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
  size = "md",
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly isLong: boolean;
  /**
   * `sm` is the ledger's row height. One component at two sizes rather than a
   * second pill that would drift from this one the first time either changed.
   */
  readonly size?: "md" | "sm";
}): ReactNode {
  const tone = isLong
    ? "border-profit/40 bg-profit/10 text-profit"
    : "border-loss/40 bg-loss/10 text-loss";
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center gap-1.5 rounded-full border font-mono",
        size === "sm" ? "px-1.5 text-[10.5px]" : "px-2.5 py-0.5 text-[12px]",
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
      className={cn(
        BAND_PAD_CLASS,
        "flex w-full items-center gap-3 font-mono text-[12px] tabular-nums text-muted-foreground",
      )}
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
 * The ambient line, under everything: the facts that qualify the panel without
 * being decided on.
 *
 * Hold time lives here rather than in the exposure grid. "Held 12m" is a
 * property of the session, not a figure anyone acts on, and in the grid it
 * displaced one that is. Funding is a cost of *carrying*, so it appears when
 * something is being carried and not before. The 24h change stays
 * unconditionally: the chart is an hour wide, so this is the one line that
 * says where the day has been. Open interest and 24h volume left in step 8.5
 * and have not come back.
 *
 * The exchange link sits at the end of it, at the panel's quietest edge. It is
 * the one control here that leaves the app, and it was competing with the P&L
 * for the top-right corner.
 */
/**
 * The newest thing the harness did, for the status bar's activity segment.
 *
 * The timeline already carries composed prose for every wake, publish and
 * stop move; the bar shows the newest one with its age, so a glance says not
 * just what the mission is doing but what the model last did about it.
 */
function deriveLastActivity(
  timeline: ReadonlyArray<{ readonly at: string; readonly label: string }>,
  nowMillis: number,
): { readonly label: string; readonly ageLabel: string } | null {
  const newest = timeline[0];
  if (newest === undefined) return null;
  const at = Date.parse(newest.at);
  if (Number.isNaN(at)) return null;
  return {
    label: newest.label,
    ageLabel: formatDuration(Math.max(0, nowMillis - at)),
  };
}

function MissionStatusBar({
  headline,
  because,
  plan,
  countdown,
  projection,
  tone,
  data,
  isHolding,
  holdLabel,
  modeLabel,
  exchangeUrl,
  lastActivity,
}: {
  readonly headline: string;
  /** The plan's thesis, carried as the headline's hover. It has no paragraph
   *  on the readout card any more, so this is the cheapest of its two homes —
   *  the other being the plan popup's own first field. */
  readonly because: string | null;
  /** The published plan, for the popup. Null while planning: there is none. */
  readonly plan: StrategyPlan | null;
  /** How long until the next reassessment. Null when none is armed. */
  readonly countdown: string | null;
  /** The plan's own price prediction — the bar's twin of the chart's dotted
   *  line. Absent on a stand-aside, which states none. */
  readonly projection: {
    readonly direction: "long" | "short";
    readonly price: number;
    readonly atMillis: number;
  } | null;
  /** Tinted by the exposure, not by the market: the bar states what this
   *  mission is doing, and a flat mission is neither winning nor losing. */
  readonly tone: "profit" | "loss" | "flat";
  readonly data: TradingMarketChartView | null;
  readonly isHolding: boolean;
  readonly holdLabel: string | null;
  /** The playbook this mission executes, when it executes one rather than
   *  deciding for itself. Read from the mandate, so nothing else on the panel
   *  can disagree with it. */
  readonly modeLabel: string | null;
  readonly exchangeUrl: string | null;
  /** The newest timeline entry — what the model last did, and how long ago. */
  readonly lastActivity: { readonly label: string; readonly ageLabel: string } | null;
}): ReactNode {
  const dotTone =
    tone === "profit" ? "bg-profit" : tone === "loss" ? "bg-loss" : "bg-muted-foreground";
  return (
    <div
      data-testid="mission-status-bar"
      className={cn(
        CARD_CLASS,
        BAND_PAD_CLASS,
        "flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5",
      )}
    >
      {/* The one dot on the panel. It carries real state — flat, up, down —
          and it is what makes this a status bar rather than another figure
          strip. */}
      <span className={cn("size-1.5 flex-none rounded-full", dotTone)} aria-hidden />
      <span
        className="flex-none text-[13px] text-foreground"
        {...(because === null || because === "" ? {} : { title: because })}
      >
        {headline}
      </span>

      {/* The three objects this bar exists for, in the DOM directly after the
          headline so a wrapped bar keeps them on its first row. None of them
          hides at any width: the ambient cluster on the right gives up its
          segments first, and the activity segment truncates before that. */}
      {plan === null ? null : <PlanPopover plan={plan} />}
      {countdown === null ? null : (
        <span
          data-testid="mission-next-reassessment"
          className="flex flex-none items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
          title="When the mission next reconsiders its plan. The chart's future gutter draws the same appointment as a rule: that says where on the axis, this says how long."
        >
          <Clock className="size-3" strokeWidth={2} aria-hidden />
          next {countdown}
        </span>
      )}
      {projection === null ? null : (
        <span
          data-testid="mission-projection"
          className="flex flex-none items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
          title="The plan's own price prediction; the dotted line on the chart is this object."
        >
          {projection.direction === "long" ? (
            <TrendingUp className="size-3" strokeWidth={2} aria-hidden />
          ) : (
            <TrendingDown className="size-3" strokeWidth={2} aria-hidden />
          )}
          <span>
            → {formatPrice(projection.price)} by{" "}
            {new Date(projection.atMillis).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </span>
      )}

      {/* What the model last did, in its own composed words. The headline says
          the state; this says the most recent step the harness took toward it
          — the one line of model activity the panel has room for. Truncated,
          with the full sentence a hover away. */}
      {lastActivity === null ? null : (
        <span
          data-testid="mission-last-activity"
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70"
          title={lastActivity.label}
        >
          {lastActivity.label}
          <span className="text-muted-foreground/50"> · {lastActivity.ageLabel} ago</span>
        </span>
      )}
      {/* The ambient cluster, and the bar's overflow budget.
          At `lg` and above the bar is one line, so something has to give as it
          narrows. In order: the activity segment truncates (it already carries
          `flex-1 truncate`), then funding drops, then hold time, then the mode.
          The plan pill, the countdown and the prediction never drop — they are
          why this bar exists. Below `lg` the bar is allowed a second row, so
          every segment comes back rather than staying hidden on the narrowest
          screens, which is what a plain `hidden lg:inline` would have done. */}
      <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground lg:flex-nowrap">
        {isHolding && holdLabel !== null ? (
          <span className="whitespace-nowrap lg:hidden xl:inline">Held {holdLabel}</span>
        ) : null}
        {isHolding && data !== null ? (
          <span className="whitespace-nowrap lg:hidden 2xl:inline">
            Funding {(data.fundingRate8h * 100).toFixed(4)}%/8h
          </span>
        ) : null}
        {modeLabel === null ? null : (
          <span
            data-testid="mission-mode"
            className="whitespace-nowrap uppercase tracking-[0.12em]"
            title="This mission executes a named playbook rather than deciding for itself. It is read from the mandate."
          >
            execute · {modeLabel}
          </span>
        )}
        {exchangeUrl === null ? null : (
          <a
            href={exchangeUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground/60 underline-offset-2 transition-colors hover:text-foreground hover:underline group-hover/panel:text-muted-foreground motion-reduce:transition-none"
          >
            Hyperliquid
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        )}
      </span>
    </div>
  );
}
