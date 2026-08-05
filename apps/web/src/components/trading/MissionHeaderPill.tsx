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
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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
 * One step of the phase breadcrumb, as a dot.
 *
 * Filled for what the mission has walked past, ringed for where it is now, and
 * faint for what it has not reached. The labels live in the popover's title
 * attribute so the dots stay legible at 6px.
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

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${strip.marketLabel} mission: ${strip.stateLabel}`}
            data-testid="mission-header-pill"
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/60 px-2 py-0.5 text-xs text-foreground outline-none transition-colors hover:bg-card",
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
            "size-1.5 rounded-full",
            TONE_DOT[strip.tone],
            strip.tone === "exposed" && "animate-pulse",
          )}
          aria-hidden
        />
        {/* Market is always shown; the state sits next to it from the widest
            tier down to xl, where the dot alone carries tone. */}
        <span className="whitespace-nowrap font-medium">{strip.marketLabel}</span>
        <span className="hidden whitespace-nowrap text-muted-foreground @xl/header-actions:inline">
          · {strip.stateLabel}
        </span>

        {/* The phase breadcrumb, as dots. Hidden below 3xl so a cramped header
            does not trade the market name for four 6px circles. */}
        {phases.length > 0 ? (
          <span
            className="hidden items-center gap-0.5 @3xl/header-actions:flex"
            aria-hidden
            title={phases.map((phase) => `${phase.label}: ${phase.state}`).join(" · ")}
          >
            {phases.map((phase) => (
              <span
                key={phase.label}
                className={cn("size-1.5 rounded-full", phaseDotClass(phase.state))}
              />
            ))}
          </span>
        ) : null}

        {/* The live mark. Hidden below 3xl alongside the phase dots: it is the
            figure read against the entry, not the figure scanned for at a
            glance. */}
        {strip.markLabel === null ? null : (
          <span className="hidden tabular-nums text-muted-foreground @3xl/header-actions:inline">
            {strip.markLabel}
          </span>
        )}

        {/* P&L while exposed. Hidden below xl: it is the number that matters most
            while holding, and the one the title can give up first. */}
        {position === null ? null : (
          <span
            className={cn(
              "hidden tabular-nums @xl/header-actions:inline",
              position.unrealisedPnl >= 0 ? "text-profit" : "text-loss",
            )}
          >
            {formatSignedUsd(position.unrealisedPnl)}
          </span>
        )}

        {/* The §14.7 way out. Always inline, always destructive, never behind
            the popover. It appears only while there is something to close. */}
        {showInlineClose ? (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={controls.isBusy}
            // Stop the press from also toggling the popover: the way out is the
            // whole button, not a way to open a menu.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              controls.risk("close_and_revoke");
            }}
            className="ms-0.5 h-5 rounded-full px-2 text-[11px]"
          >
            Close &amp; stop
          </Button>
        ) : null}
      </PopoverTrigger>

      <PopoverPopup className="w-80" side="bottom" align="start" viewportClassName="py-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {strip.marketLabel} · {strip.stateLabel}
            </span>
            <span className={cn("size-1.5 rounded-full", TONE_DOT[strip.tone])} aria-hidden />
          </div>

          {/* A refused control outranks every detail row: the way out not
              working is the one thing on this pill the operator cannot miss. */}
          {controls.error === null ? null : (
            <p
              className="text-xs text-destructive"
              data-testid="mission-strip-error"
              title={controls.error}
            >
              {controls.error}
            </p>
          )}

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

          <Row label="Max loss" value={strip.maximumLossLabel} />
          <Row label="Harness" value={strip.harnessLabel} />
          <Row label="Connection" value={describeTradingAccount(mission.tradingAccountId)} />

          {mission.status === "paused" ? (
            <p className="text-xs text-muted-foreground">
              Entries stopped; any protective stop stays live on-exchange.
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
