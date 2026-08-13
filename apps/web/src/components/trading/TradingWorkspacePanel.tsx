import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationTradingMission, ThreadId } from "@t3tools/contracts";
import { pocRiskPolicyDefaults } from "@t3tools/trading-contracts/authority";
import type { ProfitTargetBasis } from "@t3tools/trading-contracts/strategy";
import { useRouter } from "@tanstack/react-router";
import { HistoryIcon, RefreshCwIcon, TrendingUpIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useTradingMissions } from "../../lib/tradingMissionsState";
import { useProjects } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { MissionStalenessBanner } from "./MissionStalenessBanner";
import { MissionStripBar } from "./MissionStripBar";
import { useMissionControls, type MissionControls } from "./useMissionControls";
import {
  deriveMissionHistoryRow,
  deriveMissionPhases,
  derivePausedExposure,
  describeWatch,
  formatSignedUsd,
  formatUsd as usd,
  humanizeLiteral,
  hyperliquidTradeUrl,
  isLiveMission,
  MISSION_STATUS_LABELS,
  settledMissions,
  shouldShowMissionStrip,
  visibleMissions,
} from "./tradingPresentation";

/**
 * The Phase 1 trading workspace.
 *
 * Everything rendered here is read from the mission projection. There is no
 * mock data and no client-side derivation of mission state: if the projection
 * has nothing, the empty state says so rather than inventing a mission.
 */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 sm:px-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/**
 * Where the profit target came from.
 *
 * The target on its own is a number the user has to take on trust; the
 * measurement, the holding period, and the percentage move behind it are what
 * make it checkable. Absent only on strategies published before the basis was
 * required.
 */
function TargetBasis({ basis }: { basis: ProfitTargetBasis | undefined }) {
  if (basis === undefined) return null;

  return (
    <>
      <Field
        label="Target basis"
        value={`${humanizeLiteral(basis.measurement)} · ${basis.lookbackBars} bars of ${basis.timeframe}`}
      />
      <Field
        label="Target move"
        value={`${basis.targetPriceMovePercent.toFixed(2)}% over ~${basis.expectedHoldBars} bars on $${basis.positionNotionalUsd} notional`}
      />
      <p className="px-3 pb-1 text-sm text-muted-foreground sm:px-4">{basis.rationale}</p>
    </>
  );
}

function MissionStatus({ mission }: { mission: OrchestrationTradingMission }) {
  const exchangeUrl = hyperliquidTradeUrl(mission.market, mission.tradingAccountId);

  return (
    <SettingsSection title="Mission" icon={<TrendingUpIcon className="size-4" />}>
      <PhaseBreadcrumb status={mission.status} />
      <Field label="Status" value={MISSION_STATUS_LABELS[mission.status]} />
      {mission.blockedReason === null ? null : (
        <Field label="Blocked because" value={humanizeLiteral(mission.blockedReason)} />
      )}
      <Field label="Instruction" value={mission.instruction} />
      <Field label="Market" value={mission.market} />
      <Field label="Harness" value={`${mission.harness.provider} · ${mission.harness.status}`} />
      <Field label="Thread" value={mission.harness.threadId} />
      {/* The exchange is the other half of every reconciliation question, and
          finding the right book by hand means knowing which network the mission
          is on. Absent when the account id does not name one. */}
      {exchangeUrl === null ? null : (
        <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 sm:px-4">
          <span className="text-sm text-muted-foreground">Exchange</span>
          <a
            href={exchangeUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-foreground underline underline-offset-2"
          >
            Open on Hyperliquid
          </a>
        </div>
      )}
    </SettingsSection>
  );
}

function Mandate({ mission }: { mission: OrchestrationTradingMission }) {
  const { authority } = mission;
  // §10.4 keeps the risk policy separate from the authority: it is the
  // deterministic fee and slippage accounting policy, pinned for the POC rather
  // than authorized per mission, so it is read from the domain constant.
  const riskPolicy = pocRiskPolicyDefaults;

  return (
    <SettingsSection title={`Mandate · authority v${mission.authorityVersion}`}>
      <Field label="Allocated capital" value={usd(authority.allocatedCapitalUsd)} />
      <Field label="Maximum gross notional" value={usd(authority.maximumGrossNotionalUsd)} />
      <Field label="Maximum leverage" value={`${authority.maximumLeverage}x`} />
      <Field label="Maximum cumulative loss" value={usd(authority.maximumCumulativeLossUsd)} />
      <Field
        label="Maximum planned risk per position"
        value={usd(authority.maximumPlannedRiskPerPositionUsd)}
      />
      <Field label="Allowed directions" value={authority.allowedDirections.join(", ")} />
      <Field label="Margin modes" value={authority.marginModes.join(", ")} />
      <Field label="Scale in" value={authority.allowScaleIn ? "Allowed" : "Not allowed"} />
      <Field
        label="Partial reduction"
        value={authority.allowPartialReduction ? "Allowed" : "Not allowed"}
      />
      <Field label="Re-entry" value={authority.allowReentry ? "Allowed" : "Not allowed"} />
      <Field
        label="Direction reversal"
        value={authority.allowDirectionReversal ? "Allowed" : "Not allowed"}
      />
      <Field
        label="Valid until"
        value={
          authority.validUntil === "until_revoked"
            ? "Until revoked"
            : new Date(authority.validUntil).toLocaleString()
        }
      />

      <div className="pt-2">
        <Field label="Fee rate source" value={riskPolicy.feeRateSource} />
        <Field
          label="Fallback taker fee"
          value={`${riskPolicy.fallbackTakerFeeBpsPerSide} bps per side`}
        />
        <Field label="Stop slippage reserve" value={`${riskPolicy.stopSlippageReserveBps} bps`} />
        <Field
          label="Positive PnL expands loss budget"
          value={riskPolicy.positivePnlExpandsLossBudget ? "Yes" : "No"}
        />
      </div>
    </SettingsSection>
  );
}

function Strategy({ mission }: { mission: OrchestrationTradingMission }) {
  const { strategy } = mission;

  if (strategy === null) {
    return (
      <SettingsSection title="Strategy">
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          The harness has not published a strategy yet. It appears here as v1 once it does.
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={`Strategy v${mission.strategyVersion}`}>
      <Field label="Name" value={strategy.name} />
      <Field label="Mode" value={humanizeLiteral(strategy.mode)} />
      <Field label="Direction" value={strategy.direction} />
      <Field label="Timeframes" value={strategy.timeframes.join(", ")} />
      <Field label="Current action" value={strategy.currentAction} />
      <Field label="Order preference" value={strategy.entryPlan.orderPreference} />
      <Field label="Stop method" value={strategy.protection.stopMethod} />
      <Field label="Target" value={`+$${strategy.protection.targetProfitUsd}`} />
      <TargetBasis basis={strategy.protection.targetProfitBasis} />
      <p className="px-3 pt-2 text-sm text-muted-foreground sm:px-4">{strategy.belief.summary}</p>
      <p className="px-3 pb-2 text-sm text-muted-foreground sm:px-4">{strategy.explanation}</p>
    </SettingsSection>
  );
}

function Watches({ mission }: { mission: OrchestrationTradingMission }) {
  if (mission.watches.length === 0) {
    return (
      <SettingsSection title="Watches">
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          No watches are registered. The harness registers them alongside a strategy.
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Watches">
      <ul className="space-y-1">
        {mission.watches.map((watch) => (
          <li
            key={watch.id}
            className="flex items-baseline justify-between gap-4 px-3 py-1.5 sm:px-4"
          >
            <span className="text-sm text-foreground">{describeWatch(watch.watch)}</span>
            <span className="text-xs text-muted-foreground">
              {watch.status} · v{watch.strategyVersion}
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// §14.7 risk chrome
// ---------------------------------------------------------------------------

/**
 * The paused card. Its one job is to say the thing a paused user most needs to
 * know and would otherwise have to guess: the stop is still on the exchange.
 */
function PausedCard({ mission }: { mission: OrchestrationTradingMission }) {
  const exposure = derivePausedExposure(mission.position);

  return (
    <SettingsSection title="Paused">
      <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
        New entries, scale-ins, and re-entry are blocked. Any protective stop stays live on-exchange
        — pausing does not stand it down.
      </p>
      {/* And this is what the stop is still standing over. The sentence above
          says pausing changed nothing about the exposure; these are the
          figures that make that concrete. */}
      {exposure === null ? null : (
        <>
          <Field label="Exposure" value={exposure.exposureLabel} />
          <Field label="Unrealised" value={formatSignedUsd(exposure.unrealisedUsd)} />
          <Field label="Liquidation" value={exposure.liquidationLabel} />
        </>
      )}
    </SettingsSection>
  );
}

/** The mission's progress through the §11.1 loop. Absent once it steps off it. */
function PhaseBreadcrumb({ status }: { status: OrchestrationTradingMission["status"] }) {
  const phases = deriveMissionPhases(status);
  if (phases.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs sm:px-4"
      data-testid="mission-phase-breadcrumb"
    >
      {phases.map((phase, index) => (
        <span key={phase.label} className="flex items-center gap-2">
          {index === 0 ? null : <span className="text-muted-foreground/50">›</span>}
          <span
            className={
              phase.state === "current"
                ? "font-medium text-foreground"
                : phase.state === "done"
                  ? "text-muted-foreground"
                  : "text-muted-foreground/50"
            }
          >
            {phase.label}
          </span>
        </span>
      ))}
    </div>
  );
}

/** The deterministic risk-control buttons (§14.7). */
function RiskControls({
  mission,
  controls,
}: {
  mission: OrchestrationTradingMission;
  controls: MissionControls;
}) {
  const exposed = (mission.position?.size ?? 0) !== 0;

  return (
    <SettingsSection title="Controls">
      <p className="px-3 pt-2 text-sm text-muted-foreground sm:px-4">
        These act immediately. They do not wait for the harness and stay available while it is
        offline.
      </p>
      <div className="flex flex-wrap gap-2 px-3 py-3 sm:px-4">
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy}
          onClick={() => controls.lifecycle("trading.mission.pause")}
        >
          Pause
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy}
          onClick={() => controls.lifecycle("trading.mission.resume")}
        >
          Resume
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy}
          onClick={() => controls.risk("cancel_entries")}
        >
          Cancel entries
        </Button>
        {([25, 50, 75, 100] as const).map((percent) => (
          <Button
            key={percent}
            size="sm"
            variant="secondary"
            disabled={controls.isBusy || !exposed}
            onClick={() => controls.risk("reduce_position", percent)}
          >
            Reduce {percent}%
          </Button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy || !exposed}
          onClick={() => controls.risk("close_position")}
        >
          Close
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy}
          onClick={() => controls.lifecycle("trading.mission.revoke")}
        >
          Revoke
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={controls.isBusy}
          onClick={() => controls.risk("close_and_revoke")}
        >
          Close and revoke
        </Button>
      </div>
      {controls.error === null ? null : (
        <p
          className="px-3 pb-3 text-sm text-destructive sm:px-4"
          data-testid="mission-control-error"
        >
          {controls.error}
        </p>
      )}
    </SettingsSection>
  );
}

function MissionView({
  mission,
  controls,
}: {
  mission: OrchestrationTradingMission;
  controls: MissionControls;
}) {
  // A revoked or completed mission has no authority left to exercise, so every
  // control would be rejected as an illegal transition. The completion summary
  // and the order-rejected surface now live in the thread (MissionThreadCards),
  // so the panel keeps only the controls gate they used to share.
  const complete = mission.status === "completed" || mission.status === "revoked";

  return (
    <>
      {shouldShowMissionStrip(mission) ? (
        <MissionStripBar
          mission={mission}
          controls={controls}
          className="sticky top-0 z-10 rounded-md bg-background/95 backdrop-blur"
        />
      ) : null}
      <MissionStalenessBanner mission={mission} />
      {mission.status === "paused" ? <PausedCard mission={mission} /> : null}
      <MissionStatus mission={mission} />
      {complete ? null : <RiskControls mission={mission} controls={controls} />}
      <Mandate mission={mission} />
      <Strategy mission={mission} />
      <Watches mission={mission} />
    </>
  );
}

export function TradingWorkspacePanel() {
  const projects = useProjects();
  const environmentId = useMemo<EnvironmentId | null>(
    () => projects[0]?.environmentId ?? null,
    [projects],
  );

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Trading" icon={<TrendingUpIcon className="size-4" />}>
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            Connect an environment to see its trading missions.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <TradingWorkspaceForEnvironment environmentId={environmentId} />;
}

function TradingWorkspaceForEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const { missions, error, isLoading, refresh } = useTradingMissions(environmentId);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Trading"
        icon={<TrendingUpIcon className="size-4" />}
        headerAction={
          <Button variant="ghost" size="icon" onClick={refresh} aria-label="Refresh missions">
            <RefreshCwIcon className="size-4" />
          </Button>
        }
      >
        {error !== null ? (
          <p className="px-3 py-2 text-sm text-destructive sm:px-4">{error}</p>
        ) : isLoading && missions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading missions…</p>
        ) : missions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            No trading mission on this environment yet.
          </p>
        ) : null}
      </SettingsSection>

      {visibleMissions(missions).map((mission) => (
        <MissionWithControls key={mission.id} mission={mission} environmentId={environmentId} />
      ))}

      <MissionHistorySection missions={missions} environmentId={environmentId} />
    </SettingsPageContainer>
  );
}

/** How many history rows show before "Show more" has to be pressed. */
const HISTORY_PAGE_SIZE = 10;

/**
 * Past missions, one line each — plan 27 H3.
 *
 * Settled missions survive in the projection now (H1 stopped deleting them),
 * and this is the presentation answer to the wall of dead rows that motivated
 * the deletion: collapsed to a line per mission, paginated, each opening the
 * thread that holds the full record — fills, review chart, plan.
 */
function MissionHistorySection({
  missions,
  environmentId,
}: {
  missions: ReadonlyArray<OrchestrationTradingMission>;
  environmentId: EnvironmentId;
}) {
  const router = useRouter();
  const [shownCount, setShownCount] = useState(HISTORY_PAGE_SIZE);
  const settled = settledMissions(missions);
  if (settled.length === 0) return null;

  const rows = settled.slice(0, shownCount).map(deriveMissionHistoryRow);
  const openThread = (threadId: string) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId as ThreadId)),
    });

  return (
    <SettingsSection title="Mission history" icon={<HistoryIcon className="size-4" />}>
      <ul className="divide-y divide-border/50">
        {rows.map((row) => (
          <li key={row.missionId}>
            <button
              type="button"
              onClick={() => openThread(row.threadId)}
              className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-accent/50 sm:px-4"
            >
              <span className="font-medium text-foreground">{row.market}</span>
              {row.direction !== null ? (
                <span className="text-muted-foreground">{row.direction}</span>
              ) : null}
              <span
                className={
                  "font-medium tabular-nums " + (row.netUsd >= 0 ? "text-profit" : "text-loss")
                }
              >
                {row.netLabel} net
              </span>
              <span className="tabular-nums text-muted-foreground">{row.feesLabel} fees</span>
              {row.durationLabel !== null ? (
                <span className="tabular-nums text-muted-foreground">
                  traded {row.durationLabel}
                </span>
              ) : (
                <span className="text-muted-foreground">no round trip</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {row.statusLabel} · {new Date(row.settledAtIso).toLocaleDateString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {settled.length > shownCount ? (
        <div className="px-3 py-2 sm:px-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShownCount((count) => count + HISTORY_PAGE_SIZE)}
          >
            Show more ({settled.length - shownCount} older)
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Binds one mission's chrome to the command dispatchers.
 *
 * Per-mission rather than per-panel so a control's busy state belongs to the
 * mission it acts on, and a press on one mission cannot grey out another's
 * way out.
 */
function MissionWithControls({
  mission,
  environmentId,
}: {
  mission: OrchestrationTradingMission;
  environmentId: EnvironmentId;
}) {
  const controls = useMissionControls(mission, environmentId);

  return <MissionView mission={mission} controls={controls} />;
}
