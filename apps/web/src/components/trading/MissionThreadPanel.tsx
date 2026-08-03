/**
 * The trading surfaces a mission-bound thread carries.
 *
 * Two mounts, deliberately separate (§14.2 / §13 / §10):
 *
 * - {@link MissionThreadStrip} is chrome. One line under the chat header, for
 *   as long as the mission is armed or exposed, so the way out is always on
 *   screen without hunting.
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

import { MissionStripBar } from "./MissionStripBar";
import {
  formatPrice,
  formatSignedUsd,
  humanizeLiteral,
  shouldShowMissionStrip,
} from "./tradingPresentation";
import { useMissionControls } from "./useMissionControls";

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
  badge?: string | undefined;
  meta?: string | undefined;
  accentClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg border bg-card/40 ${accentClassName ?? "border-border"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {badge === undefined ? null : (
          <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">
            {badge}
          </span>
        )}
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

/** The order-intent card while an execution record is in flight (§10). */
function OrderIntentCard({ exec }: { exec: TradingExecutionView }) {
  return (
    <Card
      title="Order intent"
      badge={`${humanizeLiteral(exec.actionType)} · ${sideLabel(exec.side)} ${exec.market}`}
      meta={humanizeLiteral(exec.status)}
      accentClassName="border-armed/40 bg-armed/5"
    >
      <FieldRows>
        <Field label="Size" value={String(exec.size)} />
        <Field label="Limit" value={formatPrice(exec.limitPrice)} />
        <Field label="Time in force" value={exec.timeInForce.toUpperCase()} />
        <Field label="Reduce only" value={exec.reduceOnly ? "Yes" : "No"} />
      </FieldRows>
    </Card>
  );
}

/** A fill receipt: what filled, at what price, and what it cost (§10). */
function FillReceipt({ fill }: { fill: TradingFillView }) {
  return (
    <Card
      title="Filled"
      badge={`${sideLabel(fill.side)} ${fill.filledSize} ${fill.market}`}
      meta={`${new Date(fill.tradedAt).toLocaleTimeString()} · #${fill.orderId}`}
    >
      <StatLine>
        <Stat label="Average fill" value={formatPrice(fill.avgFillPrice)} />
        <Stat label="Fee" value={formatSignedUsd(-fill.feeUsd)} />
        <Stat
          label="Realized"
          value={formatSignedUsd(fill.closedPnl)}
          tone={pnlTone(fill.closedPnl)}
        />
        {fill.cloid === undefined ? null : (
          <Stat label="Client order" value={`${fill.cloid.slice(0, 10)}…`} />
        )}
      </StatLine>
    </Card>
  );
}

/** The live position card: entry, mark, unrealised P&L, protection (§10). */
function PositionCard({ position }: { position: TradingPositionView }) {
  const direction = position.size > 0 ? "Long" : position.size < 0 ? "Short" : "Flat";
  // §16.1: a stop that covers less than the position is the difference between
  // a bounded loss and an open-ended one, so it is a figure, not a checkmark.
  const protection =
    Math.abs(position.protectedSize) >= Math.abs(position.size)
      ? "Full"
      : position.protectedSize === 0
        ? "None"
        : `${Math.abs(position.protectedSize)} of ${Math.abs(position.size)}`;

  return (
    <Card
      title={position.market}
      badge={`${direction} · open`}
      meta={`Margin $${position.marginUsed.toFixed(2)}`}
    >
      <div className="grid grid-cols-3 gap-x-4 gap-y-3 px-3 py-3">
        <Cell label="Size" value={String(Math.abs(position.size))} />
        {position.entryPrice === undefined ? null : (
          <Cell label="Entry" value={formatPrice(position.entryPrice)} />
        )}
        {position.markPrice === undefined ? null : (
          <Cell label="Mark" value={formatPrice(position.markPrice)} />
        )}
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
 * The mission strip, as chrome above the thread (§14.7).
 *
 * Renders nothing at all once the mission is settled: a strip with no exposure
 * to unwind and no watch to report is a band of border with nothing in it.
 */
export function MissionThreadStrip({
  mission,
  environmentId,
}: {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
}) {
  const controls = useMissionControls(mission, environmentId);
  if (!shouldShowMissionStrip(mission)) return null;
  return <MissionStripBar mission={mission} controls={controls} />;
}

/**
 * The execution cards, as the tail of the message timeline.
 *
 * They live inside the scroll, so a mission with an intent, a position and
 * three receipts costs the conversation nothing once the user scrolls past it.
 */
export function MissionThreadCards({ mission }: { readonly mission: OrchestrationTradingMission }) {
  const hasCards =
    mission.inFlightExecution !== null ||
    mission.position !== null ||
    mission.recentFills.length > 0;

  if (!hasCards) return null;

  return (
    <div className="flex flex-col gap-2 pt-2">
      {mission.inFlightExecution && <OrderIntentCard exec={mission.inFlightExecution} />}
      {mission.position && <PositionCard position={mission.position} />}
      {mission.recentFills.slice(0, 3).map((fill) => (
        <FillReceipt key={`${fill.orderId}-${fill.tradedAt}`} fill={fill} />
      ))}
    </div>
  );
}
