/**
 * The trading surfaces a mission-bound thread carries.
 *
 * Two mounts, deliberately separate (§14.2 / §13 / §10):
 *
 * - {@link MissionThreadBanners} is chrome. The exception banners that sit with
 *   the strip above the thread, for as long as the mission is armed or exposed,
 *   so a feed or staleness warning stays on screen without hunting.
 * - {@link MissionThreadCards} is content. The execution surfaces — an order
 *   intent while one is in flight, the live position, the recent fill receipts
 *   — render at the end of the message timeline and scroll with it.
 *
 * The split is the point. A pinned band that grows with every fill covers the
 * conversation it is supposed to annotate; the prototype puts the cards inline
 * in the thread and keeps only the strip fixed, and so does this.
 *
 * Everything here is read from the projection. These components hold no state
 * of their own and show nothing the projection does not say — there is no
 * placeholder row waiting for data that has not arrived, because a row of
 * em-dashes reads as a broken feed rather than as an absence.
 *
 * @module MissionThreadPanel
 */
import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingFillView,
  TradingPositionView,
  TradingExecutionView,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useActiveEnvironmentId } from "../../state/entities";
import { Button } from "../ui/button";
import { MissionFeedErrorBanner, MissionStalenessBanner } from "./MissionStalenessBanner";
import { MissionReviewChart } from "./MissionReviewChart";
import { useMissionControls } from "./useMissionControls";
import {
  deriveCompletionSummary,
  deriveEffectiveLeverage,
  deriveFillSlippagePercent,
  deriveRejectedOrder,
  formatDuration,
  formatLeverage,
  formatPrice,
  formatSize,
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  humanizeLiteral,
  isMissionComplete,
  readFillLifecycle,
  readIntentLifecycle,
  shouldShowMissionStrip,
  type CompletionSummary,
  type PositionLifecycle,
  type RejectedOrderNotice,
} from "./tradingPresentation";

type Tone = "profit" | "loss" | undefined;

const toneClass = (tone: Tone): string =>
  tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-foreground";

/** The tone a signed figure carries, so P&L reads as a direction. */
const pnlTone = (value: number): Tone => (value > 0 ? "profit" : value < 0 ? "loss" : undefined);

/** The shared card frame: a header row, then whatever the card reports. */
function Card({
  title,
  badge,
  meta,
  accentClassName,
  children,
}: {
  title: ReactNode;
  /** Rendered as-is, so a card can carry a tinted chip instead of plain text. */
  badge?: ReactNode;
  meta?: string | undefined;
  accentClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg border bg-card/40 ${accentClassName ?? "border-border"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {badge}
        {meta === undefined ? null : (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{meta}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A run of `label value` pairs on one wrapping line.
 *
 * The receipt shape from the prototype: a settled fact is a short list of
 * numbers, and a grid of labelled boxes gives it more room than it earns.
 */
function StatLine({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-3 py-2 text-xs">{children}</div>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <span className="text-muted-foreground">
      {label} <span className={`tabular-nums ${toneClass(tone)}`}>{value}</span>
    </span>
  );
}

/** A two-column list of key/value rows: the intent shape from the prototype. */
function FieldRows({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-8 px-3 py-1.5 sm:grid-cols-2">{children}</div>;
}

function Field({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex gap-3 border-b border-border/40 py-1.5 text-xs last:border-b-0">
      <span className="w-28 flex-none text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${toneClass(tone)}`}>{value}</span>
    </div>
  );
}

const sideLabel = (side: "buy" | "sell"): string => (side === "buy" ? "Buy" : "Sell");

/** The neutral chip: a card header's plain, untinted label. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * What a card is about, in the one line every card carries: the market and its
 * leverage, the side of the exposure, and which half of the position's life
 * this is — `ETH 20x Long · Open`.
 *
 * The tint is the exchange's: green for the side that gains when the market
 * rises, red for the other. It is never the only signal — the chip spells the
 * direction out too, because red/green is the distinction an operator is most
 * likely to be unable to see, and on a trading surface that is the expensive
 * kind of guess.
 *
 * With no lifecycle to show (a fill recorded before the exchange's label was
 * carried), the chip goes neutral and names the order instead. An untinted
 * "Sell 0.67" is honest; tinting it red would assert a short the fill may well
 * have been closing.
 */
function LifecycleChips({
  market,
  leverage,
  lifecycle,
  fallbackDetail,
}: {
  market: string;
  /** The market's configured leverage, when the exchange has reported one. */
  leverage: number | null;
  lifecycle: PositionLifecycle | null;
  /** What to say instead when the lifecycle is unknown, e.g. "Sell 0.6729". */
  fallbackDetail: string;
}) {
  const leverageTag =
    leverage === null ? null : (
      <span className="rounded-sm bg-current/15 px-1 tabular-nums">{formatLeverage(leverage)}</span>
    );

  if (lifecycle === null) {
    return (
      <Chip>
        {market} {fallbackDetail}
      </Chip>
    );
  }

  const tone =
    lifecycle.direction === "long"
      ? "border-profit/40 bg-profit/10 text-profit"
      : "border-loss/40 bg-loss/10 text-loss";

  return (
    <>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11px] font-medium ${tone}`}
      >
        <span>{market}</span>
        {leverageTag}
        <span>{lifecycle.direction === "long" ? "Long" : "Short"}</span>
      </span>
      <Chip>{lifecycle.actionLabel}</Chip>
    </>
  );
}

/** The order-intent card while an execution record is in flight (§10). */
function OrderIntentCard({
  exec,
  leverage,
}: {
  exec: TradingExecutionView;
  leverage: number | null;
}) {
  return (
    <Card
      title="Order intent"
      badge={
        <LifecycleChips
          market={exec.market}
          leverage={leverage}
          lifecycle={readIntentLifecycle(exec)}
          fallbackDetail={`${sideLabel(exec.side)} ${formatSize(exec.size)}`}
        />
      }
      meta={humanizeLiteral(exec.status)}
      accentClassName="border-armed/40 bg-armed/5"
    >
      <FieldRows>
        <Field label="Order" value={`${sideLabel(exec.side)} ${formatSize(exec.size)}`} />
        <Field label="Limit" value={formatPrice(exec.limitPrice)} />
        <Field label="Time in force" value={exec.timeInForce.toUpperCase()} />
        <Field label="Action" value={humanizeLiteral(exec.actionType)} />
      </FieldRows>
    </Card>
  );
}

/** A fill receipt: what filled, at what price, and what it cost (§10). */
function FillReceipt({
  fill,
  intent,
  leverage,
}: {
  fill: TradingFillView;
  /** The execution this fill can be attributed to, for the slippage figure. */
  intent: TradingExecutionView | null;
  /** The market's configured leverage, for the chip. */
  leverage: number | null;
}) {
  const slippagePercent = deriveFillSlippagePercent(fill, intent);
  const lifecycle = readFillLifecycle(fill.direction);
  // An entry has no result yet, and "Realized $0.00" on one reads as a trade
  // that made nothing rather than a trade that has not finished.
  const showRealized = lifecycle === null || lifecycle.action !== "open" || fill.closedPnl !== 0;

  return (
    <Card
      title="Filled"
      badge={
        <LifecycleChips
          market={fill.market}
          leverage={leverage}
          lifecycle={lifecycle}
          fallbackDetail={`${sideLabel(fill.side)} ${formatSize(fill.filledSize)}`}
        />
      }
      meta={`${new Date(fill.tradedAt).toLocaleTimeString()} · #${fill.orderId}`}
    >
      <StatLine>
        <Stat label="Size" value={formatSize(fill.filledSize)} />
        <Stat label="Average fill" value={formatPrice(fill.avgFillPrice)} />
        {slippagePercent === null ? null : (
          // Positive means the fill spent some of the slippage bound the server
          // priced the limit at; negative means it did better than the bound.
          <Stat
            label="Slippage"
            value={formatSignedPercent(slippagePercent)}
            tone={slippagePercent > 0 ? "loss" : slippagePercent < 0 ? "profit" : undefined}
          />
        )}
        <Stat label="Fee" value={formatSignedUsd(-fill.feeUsd)} />
        {showRealized && (
          <Stat
            label="Realized"
            value={formatSignedUsd(fill.closedPnl)}
            tone={pnlTone(fill.closedPnl)}
          />
        )}
      </StatLine>
    </Card>
  );
}

/**
 * The live position card: entry, mark, unrealised P&L, protection (§10).
 *
 * Only ever rendered while something is held — see {@link MissionThreadCards}.
 * The projection keeps a mission's snapshot row after the position closes, with
 * its size zeroed, and rendering that row produced a card headed "Flat · open"
 * reporting a size of zero as fully protected. Every figure on it was true and
 * the card as a whole was a lie.
 */
function PositionCard({
  position,
  markPrice,
  leverage,
}: {
  position: TradingPositionView;
  /** The live mark, preferred over the snapshot's own as it is newer. */
  markPrice: number | null;
  /** The market's configured leverage, for the chip. */
  leverage: number | null;
}) {
  const direction = position.size > 0 ? "long" : "short";
  // §16.1: a stop that covers less than the position is the difference between
  // a bounded loss and an open-ended one, so it is a figure, not a checkmark.
  const protection =
    position.protectedSize === 0
      ? "None"
      : Math.abs(position.protectedSize) >= Math.abs(position.size)
        ? "Full"
        : `${formatSize(Math.abs(position.protectedSize))} of ${formatSize(Math.abs(position.size))}`;
  const mark = markPrice ?? position.markPrice ?? null;

  return (
    <Card
      title="Position"
      badge={
        <LifecycleChips
          market={position.market}
          leverage={leverage}
          // The position IS the open half of the cycle — that is what a card
          // rendering only while exposure is held means.
          lifecycle={{ direction, action: "open", actionLabel: "Open" }}
          fallbackDetail=""
        />
      }
      meta={`Margin $${position.marginUsed.toFixed(2)}`}
    >
      <div className="grid grid-cols-3 gap-x-4 gap-y-3 px-3 py-3">
        <Cell label="Size" value={formatSize(Math.abs(position.size))} />
        {position.entryPrice === undefined ? null : (
          <Cell label="Entry" value={formatPrice(position.entryPrice)} />
        )}
        {mark === null ? null : <Cell label="Mark" value={formatPrice(mark)} />}
        <Cell
          label="Unrealised"
          value={formatSignedUsd(position.unrealisedPnl)}
          tone={pnlTone(position.unrealisedPnl)}
        />
        <Cell label="Protected" value={protection} />
        {position.liquidationPrice === undefined ? null : (
          <Cell label="Liquidation" value={formatPrice(position.liquidationPrice)} />
        )}
      </div>
    </Card>
  );
}

/** One labelled figure in the position card's grid. */
function Cell({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${toneClass(tone)}`}>{value}</span>
    </div>
  );
}

/**
 * The order-rejected surface, with the affordance to re-arm (§14.7).
 *
 * Replaces {@link OrderIntentCard} when the in-flight execution was refused — a
 * rejected order must never render as a live one. Tinted loss-red because a
 * rejection is the failure shape the thread carries, and given the re-arm button
 * the plan calls for: `deriveRejectedOrder` already gates `canReArm` on the
 * mission not being blocked or revoked.
 *
 * Controls are bound here rather than threaded from the workspace panel, because
 * the timeline mounts wherever the mission's thread does — the workspace list, a
 * bound chat thread — and either way the active environment is the one that
 * sourced the mission. When no environment is active (no bound mission yet), the
 * buttons are absent and the card reads the rejection aloud instead.
 */
function OrderRejectedCard({
  notice,
  mission,
}: {
  notice: RejectedOrderNotice;
  mission: OrchestrationTradingMission;
}) {
  const environmentId = useActiveEnvironmentId();

  return (
    <Card
      title="Order rejected"
      badge={
        <LifecycleChips
          market={mission.market}
          leverage={mission.leverage ?? null}
          // A rejected order has no clean lifecycle — it never reached the book —
          // so the chip is neutral and names the order that was refused.
          lifecycle={null}
          fallbackDetail={`${humanizeLiteral(notice.actionType)} ${notice.side}`}
        />
      }
      accentClassName="border-loss/40 bg-loss/5"
    >
      <p className="px-3 py-2 text-xs text-foreground">
        The {humanizeLiteral(notice.actionType)} of {formatSize(notice.size)} ({notice.side}) was
        not accepted.
      </p>
      {/*
        Mounted only when an environment is active, so the controls hook inside
        is unconditional (rules-of-hooks) and a flat, environment-less render
        reads the rejection aloud without offering buttons it could not bind.
      */}
      {environmentId === null ? null : (
        <OrderRejectedActions notice={notice} mission={mission} environmentId={environmentId} />
      )}
    </Card>
  );
}

/** The button row for a rejected order: re-arm and cancel resting entries. */
function OrderRejectedActions({
  notice,
  mission,
  environmentId,
}: {
  notice: RejectedOrderNotice;
  mission: OrchestrationTradingMission;
  environmentId: EnvironmentId;
}) {
  // Bound per-mission so a press on one mission cannot grey out another's way
  // out, and so the busy state belongs to the mission it acts on.
  const controls = useMissionControls(mission, environmentId);

  return (
    <div className="flex flex-wrap gap-2 px-3 pb-3">
      {notice.canReArm ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy}
          onClick={() => controls.lifecycle("trading.mission.resume")}
        >
          Re-arm mission
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          The mission is blocked or revoked; re-arming needs an explicit review first.
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={controls.isBusy}
        onClick={() => controls.risk("cancel_entries")}
      >
        Cancel resting entries
      </Button>
    </div>
  );
}

/**
 * The completion summary, as the headline card of a finished mission (§14.7).
 *
 * A finished mission's result is the thing the thread exists to report, so it
 * leads the card stack. Tinted by the net result — green for a profit, red for a
 * loss — the same convention every other P&L figure on the surface uses.
 *
 * Above the figures sits the review chart: the price series over the span the
 * trade occupied, windowed to `firstFillAt → lastFillAt` with the entry as a
 * level and the exit as a static dot. It is a one-shot read on a closed window,
 * not the live panel's 15s poll — see {@link MissionReviewChart}.
 */
function CompletionSummaryCard({ mission }: { mission: OrchestrationTradingMission }) {
  const summary: CompletionSummary = deriveCompletionSummary(mission);
  const environmentId = useActiveEnvironmentId();
  const accent =
    pnlTone(summary.netResultUsd) === "profit"
      ? "border-profit/40 bg-profit/5"
      : pnlTone(summary.netResultUsd) === "loss"
        ? "border-loss/40 bg-loss/5"
        : undefined;

  return (
    <Card
      title="Mission complete"
      meta={
        summary.tradedDurationMillis === null
          ? undefined
          : formatDuration(summary.tradedDurationMillis)
      }
      accentClassName={accent}
    >
      {environmentId === null ? null : (
        <div className="px-3 pb-2">
          <MissionReviewChart
            environmentId={environmentId}
            market={mission.market}
            firstFillAt={summary.firstFillAt}
            lastFillAt={summary.lastFillAt}
            recentFills={mission.recentFills}
            pnlSign={pnlTone(summary.netResultUsd) ?? null}
          />
        </div>
      )}
      <FieldRows>
        <Field
          label="Realized P&L"
          value={formatUsd(summary.realizedPnlUsd)}
          tone={pnlTone(summary.realizedPnlUsd)}
        />
        <Field label="Fees paid" value={formatUsd(summary.feesPaidUsd)} />
        <Field
          label="Net result"
          value={formatSignedUsd(summary.netResultUsd)}
          tone={pnlTone(summary.netResultUsd)}
        />
        <Field label="Fills" value={String(summary.fillCount)} />
        <Field
          label="Traded duration"
          value={
            summary.tradedDurationMillis === null
              ? "—"
              : formatDuration(summary.tradedDurationMillis)
          }
        />
        <Field
          label="Planned risk"
          value={summary.plannedLossUsd === null ? "—" : formatUsd(summary.plannedLossUsd)}
        />
        <Field
          label="Versus plan"
          value={
            summary.deviationFromPlanUsd === null
              ? "—"
              : formatSignedUsd(summary.deviationFromPlanUsd)
          }
          tone={
            summary.deviationFromPlanUsd === null
              ? undefined
              : pnlTone(summary.deviationFromPlanUsd)
          }
        />
      </FieldRows>
    </Card>
  );
}

/**
 * The exception banners that sit above the thread (§14.7).
 *
 * Renders nothing at all once the mission is settled: with no exposure to
 * unwind and no watch to report, there is nothing to flag.
 *
 * The two banners sit with the strip rather than with the cards below, because
 * both say the same kind of thing the strip does — something about this mission
 * needs attention right now — and both must stay on screen when the timeline
 * has scrolled away from the cards.
 */
export function MissionThreadBanners({
  mission,
  feedError,
}: {
  readonly mission: OrchestrationTradingMission;
  /** The projection poll's failure, when the feed itself has stopped. */
  readonly feedError: string | null;
}): ReactNode {
  if (!shouldShowMissionStrip(mission)) return null;

  return (
    <>
      {feedError === null ? null : <MissionFeedErrorBanner message={feedError} />}
      <MissionStalenessBanner mission={mission} />
    </>
  );
}

/**
 * The execution cards, as the tail of the message timeline.
 *
 * They live inside the scroll, so a mission with an intent, a position and
 * three receipts costs the conversation nothing once the user scrolls past it.
 */
export function MissionThreadCards({ mission }: { readonly mission: OrchestrationTradingMission }) {
  // A closed position leaves its snapshot row behind with size zeroed, so the
  // card is gated on exposure rather than on the row existing.
  const openPosition =
    mission.position !== null && mission.position.size !== 0 ? mission.position : null;
  // A rejected order has no position and no fills, so it must hold the wrapper
  // up on its own — otherwise a flat mission whose only event is a refusal
  // would render nothing at all.
  const rejected = deriveRejectedOrder(mission);
  const hasCards =
    mission.inFlightExecution !== null ||
    openPosition !== null ||
    mission.recentFills.length > 0 ||
    isMissionComplete(mission.status) ||
    rejected !== null;

  if (!hasCards) return null;

  // One leverage for the whole thread: it is the market's setting, so it is the
  // same for the order about to go on and the receipt from an hour ago. The
  // exchange's own figure when the reconciler has read one, and notional over
  // margin when it has not.
  const leverage =
    mission.leverage ??
    (openPosition === null ? null : deriveEffectiveLeverage(openPosition)) ??
    null;

  return (
    <div className="flex flex-col gap-2 pt-2">
      {/*
        A finished mission's result is the headline — it leads the stack so the
        thing the thread existed to report is the first thing read. The
        execution cards (intent/position/fills) follow, reporting the trade as
        it happened. The plan and the armed conditions are not here: they live
        in the pinned `MissionLivePanel` above the timeline, where one surface
        carries the whole live picture.
      */}
      {isMissionComplete(mission.status) && <CompletionSummaryCard mission={mission} />}
      {/*
        A rejected execution never renders as a live intent: branch on it before
        the intent card so a refusal shows as a refusal, not as an order about
        to go on.
      */}
      {rejected !== null ? (
        <OrderRejectedCard notice={rejected} mission={mission} />
      ) : mission.inFlightExecution !== null ? (
        <OrderIntentCard exec={mission.inFlightExecution} leverage={leverage} />
      ) : null}
      {openPosition && (
        <PositionCard
          position={openPosition}
          markPrice={mission.marketPrice ?? null}
          leverage={leverage}
        />
      )}
      {mission.recentFills.slice(0, 3).map((fill) => (
        <FillReceipt
          key={`${fill.orderId}-${fill.tradedAt}`}
          fill={fill}
          intent={mission.inFlightExecution}
          leverage={leverage}
        />
      ))}
    </div>
  );
}
