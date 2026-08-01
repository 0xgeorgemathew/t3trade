/**
 * Mission-bound thread panel — the trading surface in the chat thread.
 *
 * Renders for threads bound to an active trading mission (§10.2). The pinned
 * card shows the mission's market, status, and a five-metric grid. Phase 4
 * adds the three execution surfaces below it: an order-intent card while an
 * execution is in flight, a fill receipt per execution, and a live position
 * card from reconciled projections.
 *
 * Spec §14.2 / §13 / §10 (PROMPT-04): the card is the bound-thread view of the
 * snapshot tools, fed by reconciled projections.
 *
 * @module MissionThreadPanel
 */
import type {
  OrchestrationTradingMission,
  TradingFillView,
  TradingPositionView,
  TradingExecutionView,
} from "@t3tools/contracts";

import { ConnectionStatusDot } from "~/components/ConnectionStatusDot";
import { MISSION_STATUS_LABELS, humanizeLiteral } from "./tradingPresentation";

interface MissionThreadPanelProps {
  readonly mission: OrchestrationTradingMission;
}

/** One cell in the five-metric grid. `pending` shows a dimmed placeholder. */
function Metric({ label, value, pending }: { label: string; value: string; pending?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-medium tabular-nums ${pending ? "text-muted-foreground/50" : "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

/** A labelled key/value row, right-aligned, tabular for alignment. */
function Field({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "green" | "red";
}) {
  const valueColor =
    accent === "green" ? "text-emerald-500" : accent === "red" ? "text-red-500" : "text-foreground";
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 sm:px-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${valueColor}`}>{value}</span>
    </div>
  );
}

function fmtUsd(n: number): string {
  return n >= 0 ? `$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function fmtPnl(n: number): { text: string; accent: "green" | "red" | undefined } {
  if (n > 0) return { text: `+$${n.toFixed(2)}`, accent: "green" };
  if (n < 0) return { text: `-$${Math.abs(n).toFixed(2)}`, accent: "red" };
  return { text: "$0.00", accent: undefined };
}

/** The order-intent card while an execution record is in flight (§10). */
function OrderIntentCard({ exec }: { exec: TradingExecutionView }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium text-amber-500">Order in flight</span>
        <span className="text-xs text-muted-foreground">{exec.status}</span>
      </div>
      <Field
        label={`${exec.side === "buy" ? "Buy" : "Sell"} ${exec.size} ${exec.market}`}
        value={`${exec.limitPrice} · ${exec.timeInForce.toUpperCase()}`}
      />
    </div>
  );
}

/** A fill receipt: timestamp, order id/cloid, average fill, fees (§10). */
function FillReceipt({ fill }: { fill: TradingFillView }) {
  return (
    <div className="rounded-lg border border-border bg-card/30 px-2 py-2">
      <Field
        label={`${fill.side === "buy" ? "Buy" : "Sell"} ${fill.filledSize} ${fill.market}`}
        value={`@ ${fill.avgFillPrice}`}
      />
      <Field label="Fee" value={fmtUsd(fill.feeUsd)} />
    </div>
  );
}

/** The live position card: entry, unrealised P&L, size, protection (§10). */
function PositionCard({ position }: { position: TradingPositionView }) {
  const pnl = fmtPnl(position.unrealisedPnl);
  const direction = position.size > 0 ? "Long" : position.size < 0 ? "Short" : "Flat";
  return (
    <div className="rounded-lg border border-border bg-card/30 px-2 py-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium text-foreground">
          {direction} {position.market}
        </span>
        {position.protectedSize > 0 && (
          <span className="text-xs text-emerald-500">Protected {position.protectedSize}</span>
        )}
      </div>
      <Field label="Size" value={String(Math.abs(position.size))} />
      {position.entryPrice !== undefined && (
        <Field label="Entry" value={String(position.entryPrice)} />
      )}
      {position.liquidationPrice !== undefined && (
        <Field label="Liq." value={String(position.liquidationPrice)} />
      )}
      <Field
        label="Unrealised P&L"
        value={pnl.text}
        {...(pnl.accent ? { accent: pnl.accent } : {})}
      />
      <Field label="Margin used" value={fmtUsd(position.marginUsed)} />
    </div>
  );
}

/**
 * The pinned snapshot card. Five metrics across, mission identity below. The
 * freshness dot is green (live) once the push path delivers; until then it is
 * amber (pending) and the metrics read "—". Below the metrics, the three
 * execution surfaces render only when the snapshot carries them.
 */
export function MissionThreadPanel({ mission }: MissionThreadPanelProps) {
  const pending = true; // Step 9 lights this up when the live push path lands.

  return (
    <div className="border-b border-border bg-card/50">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <ConnectionStatusDot
              dotClassName={pending ? "bg-amber-500" : "bg-emerald-500"}
              pingClassName={pending ? "bg-amber-500/60" : "bg-emerald-500/60"}
              tooltipText={
                pending
                  ? "Live market data connects when the testnet lab is configured."
                  : "Live · market data fresh"
              }
            />
            <span className="truncate text-sm font-medium text-foreground">
              {mission.market} · {MISSION_STATUS_LABELS[mission.status]}
            </span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {humanizeLiteral(mission.strategyFamily)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Metric label="Mark" value={pending ? "—" : ""} pending={pending} />
          <Metric label="24h %" value={pending ? "—" : ""} pending={pending} />
          <Metric label="Funding/8h" value={pending ? "—" : ""} pending={pending} />
          <Metric label="Open interest" value={pending ? "—" : ""} pending={pending} />
          <Metric label="Day volume" value={pending ? "—" : ""} pending={pending} />
        </div>

        {/* PROMPT-04 execution surfaces — render only when the snapshot carries them. */}
        {mission.inFlightExecution && <OrderIntentCard exec={mission.inFlightExecution} />}
        {mission.position && <PositionCard position={mission.position} />}
        {mission.recentFills.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {mission.recentFills.slice(0, 3).map((fill) => (
              <FillReceipt key={`${fill.orderId}-${fill.tradedAt}`} fill={fill} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
