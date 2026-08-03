/**
 * The persistent mission strip (§14.7 risk chrome).
 *
 * One strip, two mounts: pinned to the top of the workspace list, and pinned
 * under the chat header of the thread the mission is bound to. Both read the
 * same derivation, so the two surfaces cannot disagree about what a mission is
 * doing — which they would within a release if each drew its own.
 *
 * The way out is always one click. While exposure exists the primary action is
 * close-and-stop: never a menu, never two steps, and never dependent on the
 * harness being alive to serve it.
 *
 * It is exactly one line tall, at every width. Chrome that grows is chrome that
 * eats the conversation, so the detail slots truncate and nothing here wraps:
 * the strip costs the thread 40px whatever the mission is doing.
 *
 * @module MissionStripBar
 */
import type { OrchestrationTradingMission } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { deriveMissionStrip, type MissionStripTone } from "./tradingPresentation";

/**
 * What the strip can press. Both dispatchers go straight to the server: §14.7's
 * controls must work while the harness is offline, so nothing here consults a
 * session, a lease, or a turn.
 */
export interface MissionStripControls {
  readonly isBusy: boolean;
  /** Why the last press did not take effect, or null. */
  readonly error: string | null;
  readonly lifecycle: (
    type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
  ) => void;
  readonly risk: (control: "close_and_revoke") => void;
}

const TONE_DOT: Record<MissionStripTone, string> = {
  exposed: "bg-long",
  armed: "bg-armed",
  paused: "bg-muted-foreground",
  blocked: "bg-destructive",
};

const TONE_TEXT: Record<MissionStripTone, string> = {
  exposed: "text-long",
  armed: "text-armed",
  paused: "text-muted-foreground",
  blocked: "text-destructive",
};

/** A muted label with its value in the foreground, the strip's unit of content. */
function Slot({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex-none tabular-nums text-muted-foreground">
      {label} <span className="text-foreground">{value}</span>
    </span>
  );
}

export function MissionStripBar({
  mission,
  controls,
  className,
}: {
  mission: OrchestrationTradingMission;
  controls: MissionStripControls;
  className?: string;
}) {
  const strip = deriveMissionStrip(mission);

  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-b border-border bg-card/40 px-3 text-xs sm:px-4",
        className,
      )}
      data-testid="mission-strip"
    >
      <span className="flex flex-none items-center gap-2 font-medium text-foreground">
        <span className={cn("size-1.5 rounded-full", TONE_DOT[strip.tone])} aria-hidden />
        {strip.marketLabel}
      </span>
      <span className={cn("flex-none tabular-nums", TONE_TEXT[strip.tone])}>
        {strip.stateLabel}
      </span>
      <span className="flex-none tabular-nums text-foreground">{strip.exposureLabel}</span>

      {/* The two detail slots give up their width first: the strip is one line
          at every width, so a long watch description truncates rather than
          pushing the way out off screen. */}
      <span className="min-w-0 shrink truncate tabular-nums text-muted-foreground">
        {strip.detailPrimary}
      </span>
      {strip.detailSecondary === null ? null : (
        <span className="min-w-0 shrink truncate tabular-nums text-muted-foreground">
          {strip.detailSecondary}
        </span>
      )}

      {/* A refused press outranks both detail slots: the way out not working is
          the one thing on this strip the operator cannot afford to miss. */}
      {controls.error === null ? null : (
        <span
          className="min-w-0 shrink truncate text-destructive"
          data-testid="mission-strip-error"
          title={controls.error}
        >
          {controls.error}
        </span>
      )}

      <span className="ml-auto flex flex-none items-center gap-4">
        <Slot label="Max loss" value={strip.maximumLossLabel} />
        {/* The binding is immutable while the mission is active (§10.2), so it
            is reported here rather than offered as a choice. Changing it means
            revoking the mission — the composer's picker says the same. */}
        <Slot label="Harness" value={strip.harnessLabel} />
        <Button
          size="sm"
          variant={strip.primaryAction === "close_and_revoke" ? "destructive" : "secondary"}
          disabled={controls.isBusy}
          onClick={() => {
            if (strip.primaryAction === "close_and_revoke") {
              controls.risk("close_and_revoke");
            } else if (strip.primaryAction === "pause") {
              controls.lifecycle("trading.mission.pause");
            } else {
              controls.lifecycle("trading.mission.resume");
            }
          }}
        >
          {strip.primaryActionLabel}
        </Button>
      </span>
    </div>
  );
}
