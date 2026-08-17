/**
 * The mission status pill that lives in the chat header.
 *
 * A compact sibling of {@link MissionStripBar}: the same derivation, the same
 * one-click way out, but sized for a header slot rather than a full-width bar.
 * It collapses by container query (`@container/header-actions`) so the title
 * truncates before the pill does, and the close-and-stop button is always
 * visible while exposure exists — never tucked behind the popover.
 *
 * The popover behind it carries the detail the strip's single line cannot: the
 * watch the mission is waiting on, the protection figure, the liquidation, the
 * harness binding. Those are read-only here; editing means a control dispatch,
 * and the only control exposed inline is the §14.7 way out.
 *
 * @module MissionHeaderPill
 */
import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import {
  CircleSlash,
  Crosshair,
  ExternalLinkIcon,
  Radar,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  describeTradingAccount,
  deriveMissionPhases,
  deriveMissionStrip,
  formatPrice,
  formatSignedUsd,
  formatSize,
  humanizeLiteral,
  hyperliquidTradeUrl,
  type MissionStripTone,
} from "./tradingPresentation";
import { useMissionControls } from "./useMissionControls";

/**
 * The strip's state dot, matched to how urgent the mission's state is.
 *
 * A local copy of {@link MissionStripBar}'s map: four entries, kept here so a
 * change to one pill's chrome does not have to touch the other's file.
 */
const TONE_DOT: Record<MissionStripTone, string> = {
  exposed: "bg-long",
  armed: "bg-armed",
  paused: "bg-muted-foreground",
  blocked: "bg-destructive",
};

/**
 * The capsule's state glyph, in the live panel's own vocabulary.
 *
 * The same four shapes the readout card's StateChip uses, so a mission reading
 * the market looks the same in the header as it does in the panel: Radar while
 * it is analysing, CircleSlash where it declined the trade, Crosshair while it
 * waits on a level, and the trend arrow of the side it holds while exposed.
 */
function stateIcon(input: {
  readonly tone: MissionStripTone;
  readonly status: string;
  readonly exposure: number;
  readonly isStandAside: boolean;
}): LucideIcon {
  if (input.tone === "exposed") return input.exposure > 0 ? TrendingUp : TrendingDown;
  if (input.status === "analysing" || input.status === "initializing") return Radar;
  if (input.isStandAside) return CircleSlash;
  return Crosshair;
}

/**
 * One step of the phase breadcrumb, as a dot.
 *
 * Filled for what the mission has walked past, ringed for where it is now, and
 * faint for what it has not reached. The words live in the popover's Phase row —
 * at 6px the dots carry position, not names.
 */
function phaseDotClass(state: "done" | "current" | "pending"): string {
  if (state === "done") return "bg-foreground";
  if (state === "current") return "border border-foreground bg-transparent";
  return "border border-muted-foreground/40 bg-transparent";
}

/**
 * The protection figure, as the position card names it.
 *
 * `describeProtection` returns coarser labels ("Protected" / "Partially
 * protected"); the §16.1 figure — how much of the size the stop actually
 * covers — is the one the header needs, so it is computed here the same way
 * {@link MissionThreadPanel}'s PositionCard computes it.
 */
function describeProtectionFigure(position: {
  readonly size: number;
  readonly protectedSize: number;
}): string {
  if (position.protectedSize === 0) return "None";
  return Math.abs(position.protectedSize) >= Math.abs(position.size)
    ? "Full"
    : `${formatSize(Math.abs(position.protectedSize))} of ${formatSize(Math.abs(position.size))}`;
}

/** A muted label with its value in the foreground, the popover's unit of content. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function MissionHeaderPill({
  mission,
  environmentId,
}: {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
}): ReactNode {
  const controls = useMissionControls(mission, environmentId);
  const strip = deriveMissionStrip(mission);
  const position = mission.position;
  const phases = deriveMissionPhases(mission.status);
  const exchangeUrl = hyperliquidTradeUrl(mission.market, mission.tradingAccountId);
  // The way out is always one click while exposed (§14.7). It lives on the pill
  // body itself, not inside the popover, so it cannot be hidden by a collapse
  // tier or an unopened menu.
  const showInlineClose = strip.primaryAction === "close_and_revoke";
  const exposed = strip.tone === "exposed";
  const StateIcon = stateIcon({
    tone: strip.tone,
    status: mission.status,
    exposure: strip.exposure,
    isStandAside: mission.strategy?.intent === "stand_aside",
  });
  // While exposed the state word is the exposure itself: "Long 0.2631" says
  // both what state the mission is in and what it is in it with, and the
  // status word ("Position open") would only repeat the dot beside it.
  const stateWord = exposed ? strip.exposureLabel : strip.stateLabel;
  const { control } = mission;

  return (
    <Popover>
      {/* The capsule is the shell; the two controls inside it are siblings. The
          way out used to be nested inside the popover trigger, which is a
          button inside a button — invalid, and the reason the press needed to
          stop its own propagation to avoid opening the popover on the way. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/60 text-sm text-foreground backdrop-blur transition-colors hover:bg-card",
          showInlineClose ? "py-1 pl-3 pr-1" : "px-3 py-1",
        )}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`${strip.marketLabel} mission: ${stateWord}`}
              data-testid="mission-header-pill"
              className={cn(
                "flex items-center gap-1.5 rounded-full outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              )}
            />
          }
        >
          {/* The tone dot. Pulsing only while exposed keeps the animation tied to
            the one state where latency is expensive, rather than animating at
            rest. */}
          <span
            className={cn(
              "size-2 rounded-full",
              TONE_DOT[strip.tone],
              // Guarded, unlike bare `animate-pulse`: the workspace's other
              // pulses stop under reduced motion and this one has to as well.
              exposed && "animate-pulse motion-reduce:animate-none",
            )}
            aria-hidden
          />
          {/* The market is the capsule's anchor word: it never drops, at any
            width, because a state without its market names nothing. */}
          <span className="whitespace-nowrap font-medium">{strip.marketLabel}</span>
          {/* The state, as the panel's own glyph plus its word. The icon survives
            every tier — it is the one mark that still says what the mission is
            doing once the words have gone. */}
          <StateIcon
            className={cn(
              "size-3.5 flex-none",
              exposed ? "text-foreground/70" : "text-muted-foreground",
            )}
            strokeWidth={2}
            aria-hidden
          />
          <span className="hidden whitespace-nowrap text-muted-foreground @lg/header-actions:inline">
            {stateWord}
          </span>

          {/* P&L while exposed. It is money, so it keeps the money palette. Given
            up before the way out when the tier runs short, and never before the
            market. */}
          {position === null ? null : (
            <span
              className={cn(
                "hidden tabular-nums @lg/header-actions:inline",
                position.unrealisedPnl >= 0 ? "text-profit" : "text-loss",
              )}
            >
              {formatSignedUsd(position.unrealisedPnl)}
            </span>
          )}

          {/* The phase breadcrumb, as dots. Hidden below 2xl so a cramped header
            does not trade the state word for four 6px circles. The words are in
            the popover's Phase row. */}
          {phases.length > 0 ? (
            <span className="hidden items-center gap-0.5 @2xl/header-actions:flex" aria-hidden>
              {phases.map((phase) => (
                <span
                  key={phase.label}
                  className={cn("size-1.5 rounded-full", phaseDotClass(phase.state))}
                />
              ))}
            </span>
          ) : null}
        </PopoverTrigger>

        {/* The §14.7 way out. Always inline, always destructive, never behind
            the popover. It appears only while there is something to close. */}
        {showInlineClose ? (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={controls.isBusy}
            onClick={() => controls.risk("close_and_revoke")}
            className="h-6 rounded-full px-2.5 text-xs"
          >
            Close &amp; stop
          </Button>
        ) : null}
      </div>

      <PopoverPopup className="w-80" side="bottom" align="start" viewportClassName="py-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {strip.marketLabel} · {strip.stateLabel}
            </span>
            <span className={cn("size-1.5 rounded-full", TONE_DOT[strip.tone])} aria-hidden />
          </div>

          {/* A refused control outranks every detail row: the way out not
              working is the one thing on this pill the operator cannot miss.
              Truncated to one line with the whole message on the hover, rather
              than a native tooltip the workspace's own lint forbids. */}
          {controls.error === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <p
                    className="truncate text-xs text-destructive"
                    data-testid="mission-strip-error"
                  >
                    {controls.error}
                  </p>
                }
              />
              <TooltipPopup side="bottom" variant="glass" className="max-w-xs">
                {controls.error}
              </TooltipPopup>
            </Tooltip>
          )}

          {/* The mark the capsule no longer has room for. It is the figure every
              other figure here is read against, so it leads them. */}
          {strip.markLabel === null ? null : <Row label="Mark" value={strip.markLabel} />}

          {position === null ? null : (
            <>
              <Row label="Exposure" value={strip.exposureLabel} />
              {position.entryPrice === undefined ? null : (
                <Row label="Entry" value={formatPrice(position.entryPrice)} />
              )}
              <Row label="Unrealised P&L" value={formatSignedUsd(position.unrealisedPnl)} />
              <Row label="Protection" value={describeProtectionFigure(position)} />
              <Row
                label="Liquidation"
                value={
                  position.liquidationPrice === undefined
                    ? "—"
                    : formatPrice(position.liquidationPrice)
                }
              />
            </>
          )}

          {/* What a flat mission is waiting on. Hidden while exposed: an exposed
              mission's detail is the position itself, which the rows above
              already say. */}
          {strip.tone === "exposed" || strip.detailPrimary.length === 0 ? null : (
            <Row label="Waiting on" value={strip.detailPrimary} />
          )}

          {mission.blockedReason === null ? null : (
            <Row label="Blocked" value={humanizeLiteral(mission.blockedReason)} />
          )}

          {/* The phase breadcrumb's words, which the dots on the capsule cannot
              carry at 6px. The phase the mission is in reads in foreground ink;
              the rest recede. */}
          {phases.length === 0 ? null : (
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs text-muted-foreground">Phase</span>
              <span className="text-right text-xs">
                {phases.map((phase, index) => (
                  <span key={phase.label}>
                    {index === 0 ? null : <span className="text-muted-foreground/50"> · </span>}
                    <span
                      className={
                        phase.state === "current" ? "text-foreground" : "text-muted-foreground"
                      }
                    >
                      {phase.label}
                    </span>
                  </span>
                ))}
              </span>
            </div>
          )}

          <Row label="Max loss" value={strip.maximumLossLabel} />
          <Row label="Harness" value={strip.harnessLabel} />
          <Row label="Connection" value={describeTradingAccount(mission.tradingAccountId)} />
          {/* The two facts the composer footer used to carry. They belong with
              the connection: all three answer "what will happen if the mission
              decides to act". */}
          <Row label="Entries" value={control.entriesAllowed ? "Allowed" : "Paused"} />
          <Row label="Re-entry" value={control.reentryAllowed ? "Allowed" : "Not allowed"} />

          {mission.status === "paused" ? (
            <p className="text-xs text-muted-foreground">
              Entries stopped; any protective stop stays live on-exchange.
            </p>
          ) : control.pauseAfterPositionClose ? (
            <p className="text-xs text-muted-foreground">
              The mission pauses itself once this position closes.
            </p>
          ) : null}

          <div className="mt-1 flex items-center gap-2">
            {/* Pause/resume is the secondary control. Close-and-stop stays on the
                pill body: it is the primary one, and the §14.7 rule is that it
                is never two steps. */}
            {strip.primaryAction === "close_and_revoke" ? null : (
              <Button
                size="xs"
                variant="secondary"
                disabled={controls.isBusy}
                onClick={() => {
                  if (strip.primaryAction === "pause") {
                    controls.lifecycle("trading.mission.pause");
                  } else {
                    controls.lifecycle("trading.mission.resume");
                  }
                }}
              >
                {strip.primaryActionLabel}
              </Button>
            )}

            {exchangeUrl === null ? null : (
              <a
                href={exchangeUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Open on Hyperliquid
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
