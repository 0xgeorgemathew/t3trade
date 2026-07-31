/**
 * Mission-bound thread panel — the Phase 2 trading surface in the chat thread.
 *
 * Renders for threads bound to an active trading mission (§10.2). The pinned
 * card shows the mission's market, status, and a five-metric grid styled after
 * the prototype: mark, 24h change, funding/8h, open interest, day volume. Each
 * metric carries a freshness stamp; until the live push path lands (Step 9+),
 * the market metrics read as "pending" and the mission fields read from the
 * projection — the honest Phase 2 shape.
 *
 * Spec §14.2 / §13: the card is the bound-thread view of the snapshot tools.
 *
 * @module MissionThreadPanel
 */
import type { OrchestrationTradingMission } from "@t3tools/contracts";

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

/**
 * The pinned snapshot card. Five metrics across, mission identity below. The
 * freshness dot is green (live) once the push path delivers; until then it is
 * amber (pending) and the metrics read "—".
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
      </div>
    </div>
  );
}
