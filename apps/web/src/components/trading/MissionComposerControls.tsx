/**
 * The trading pills in the composer footer.
 *
 * A mission-bound thread carries two facts the user needs while typing: where
 * the order would go, and whether entries are permitted at all. They sit beside
 * the harness picker because that is where the composer already answers "what
 * will happen when I press send".
 *
 * Both are read-only. Editing the mandate means an authority patch, which
 * the spec puts in a later phase; a pill that appeared editable and silently
 * did nothing would be worse than one that plainly reports.
 *
 * @module MissionComposerControls
 */
import type { OrchestrationTradingMission } from "@t3tools/contracts";
import { CircleDollarSignIcon, ZapIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { describeEntryPermission, describeTradingAccount } from "./tradingPresentation";

/** A read-only composer pill that explains itself when pressed. */
function MissionPill({
  icon,
  label,
  title,
  children,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<ComposerControl type="button" aria-label={title} className="shrink-0" />}
      >
        <ComposerControlIcon icon={icon} />
        {label}
      </PopoverTrigger>
      {/* Width only — the popup's own padding would shift the viewport without
          being counted in its child-width formula, clipping the value column. */}
      <PopoverPopup className="w-72" viewportClassName="py-3">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground">{title}</span>
          {children}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function MissionComposerControls({ mission }: { mission: OrchestrationTradingMission }) {
  const { control } = mission;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <MissionPill
        icon={CircleDollarSignIcon}
        label={describeTradingAccount(mission.tradingAccountId)}
        title="Trading account"
      >
        <Row label="Account" value={mission.tradingAccountId} />
        <Row label="Market" value={mission.market} />
        <p className="text-xs text-muted-foreground">
          Orders from this thread are placed on this account only.
        </p>
      </MissionPill>

      <MissionPill icon={ZapIcon} label={describeEntryPermission(control)} title="Entry permission">
        <Row label="Entries" value={control.entriesAllowed ? "Allowed" : "Paused"} />
        <Row label="Re-entry" value={control.reentryAllowed ? "Allowed" : "Not allowed"} />
        <Row label="Pause after close" value={control.pauseAfterPositionClose ? "Yes" : "No"} />
        <p className="text-xs text-muted-foreground">
          Pausing the mission stops new entries. Any protective stop stays live on-exchange.
        </p>
      </MissionPill>
    </>
  );
}
