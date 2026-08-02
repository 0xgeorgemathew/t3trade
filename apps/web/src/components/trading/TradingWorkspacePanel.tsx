import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import { pocRiskPolicyDefaults } from "@t3tools/trading-contracts/authority";
import { RefreshCwIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { TradingReductionPercent, TradingRiskControl } from "@t3tools/contracts";

import { useTradingMissions } from "../../lib/tradingMissionsState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { NewMissionForm } from "./NewMissionForm";
import {
  deriveCompletionSummary,
  deriveMissionStrip,
  deriveRejectedOrder,
  describeWatch,
  formatDuration,
  formatUsd as usd,
  humanizeLiteral,
  isMissionComplete,
  isPositionDataStale,
  MISSION_STATUS_LABELS,
  shouldShowMissionStrip,
  type MissionStripTone,
  type RejectedOrderNotice,
} from "./tradingPresentation";

/**
 * The Phase 1 trading workspace.
 *
 * Everything rendered here is read from the mission projection. There is no
 * mock data and no client-side derivation of mission state: if the projection
 * has nothing, the empty state says so rather than inventing a mission.
 */

/**
 * The dispatchers a mission's chrome uses.
 *
 * Both go straight to the server. §14.7's controls must work while the harness
 * is offline, so nothing here consults a session, a lease, or a turn.
 */
interface MissionControls {
  readonly isBusy: boolean;
  readonly lifecycle: (
    type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
  ) => void;
  readonly risk: (control: TradingRiskControl, reductionPercent?: TradingReductionPercent) => void;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 sm:px-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function MissionStatus({ mission }: { mission: OrchestrationTradingMission }) {
  return (
    <SettingsSection title="Mission" icon={<TrendingUpIcon className="size-4" />}>
      <Field label="Status" value={MISSION_STATUS_LABELS[mission.status]} />
      {mission.blockedReason === null ? null : (
        <Field label="Blocked because" value={humanizeLiteral(mission.blockedReason)} />
      )}
      <Field label="Instruction" value={mission.instruction} />
      <Field label="Market" value={mission.market} />
      <Field label="Harness" value={`${mission.harness.provider} · ${mission.harness.status}`} />
      <Field label="Thread" value={mission.harness.threadId} />
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
          authority.validUntil === "revoked"
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

const TONE_DOT: Record<MissionStripTone, string> = {
  exposed: "bg-emerald-500",
  armed: "bg-sky-500",
  paused: "bg-amber-500",
  blocked: "bg-destructive",
};

/**
 * The persistent mission strip.
 *
 * Shown for the whole time a mission is armed or exposed, and the way out is
 * always one click: while exposure exists the primary action is close-and-stop,
 * never a menu and never two steps.
 */
function MissionStrip({
  mission,
  controls,
}: {
  mission: OrchestrationTradingMission;
  controls: MissionControls;
}) {
  const strip = deriveMissionStrip(mission);

  return (
    <div
      className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:px-4"
      data-testid="mission-strip"
    >
      <span className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${TONE_DOT[strip.tone]}`} aria-hidden />
        <span className="text-sm font-medium text-foreground">{strip.stateLabel}</span>
      </span>
      <span className="text-sm tabular-nums text-muted-foreground">
        Exposure <span className="text-foreground">{strip.exposureLabel}</span>
      </span>
      <span className="text-sm tabular-nums text-muted-foreground">
        Max loss <span className="text-foreground">{strip.maximumLossLabel}</span>
      </span>
      <Button
        className="ml-auto"
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
    </div>
  );
}

/**
 * The paused card. Its one job is to say the thing a paused user most needs to
 * know and would otherwise have to guess: the stop is still on the exchange.
 */
function PausedCard() {
  return (
    <SettingsSection title="Paused">
      <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
        New entries, scale-ins, and re-entry are blocked. Any protective stop stays live on-exchange
        — pausing does not stand it down.
      </p>
    </SettingsSection>
  );
}

/** The order-rejected surface, with the affordance to re-arm. */
function OrderRejectedCard({
  notice,
  controls,
}: {
  notice: RejectedOrderNotice;
  controls: MissionControls;
}) {
  return (
    <SettingsSection title="Order rejected">
      <p className="px-3 py-2 text-sm text-foreground sm:px-4">
        The {humanizeLiteral(notice.actionType)} of {notice.size} ({notice.side}) was not accepted.
      </p>
      <div className="flex gap-2 px-3 pb-3 sm:px-4">
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
          <p className="text-sm text-muted-foreground">
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
    </SettingsSection>
  );
}

/** The stale-data banner, shown while order placement is suspended. */
function StaleDataBanner() {
  return (
    <div
      className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground sm:px-4"
      data-testid="stale-data-banner"
    >
      Position data is stale. Order placement is suspended until a fresh read lands.
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
    </SettingsSection>
  );
}

/** The completion summary card, shown once a mission has finished. */
function CompletionSummaryCard({ mission }: { mission: OrchestrationTradingMission }) {
  const summary = deriveCompletionSummary(mission);

  return (
    <SettingsSection title="Completion summary">
      <Field label="Realized P&L" value={usd(summary.realizedPnlUsd)} />
      <Field label="Fees paid" value={usd(summary.feesPaidUsd)} />
      <Field label="Net result" value={usd(summary.netResultUsd)} />
      <Field label="Fills" value={String(summary.fillCount)} />
      <Field
        label="Traded duration"
        value={
          summary.tradedDurationMillis === null ? "—" : formatDuration(summary.tradedDurationMillis)
        }
      />
      <Field
        label="Planned risk"
        value={summary.plannedLossUsd === null ? "—" : usd(summary.plannedLossUsd)}
      />
      <Field
        label="Versus plan"
        value={summary.deviationFromPlanUsd === null ? "—" : usd(summary.deviationFromPlanUsd)}
      />
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
  const rejected = deriveRejectedOrder(mission);
  // Recomputed on each render rather than on a timer: the projection push is
  // what moves this, so a timer would only make it disagree with the data.
  const stale = isPositionDataStale(mission, Date.now());

  return (
    <>
      {shouldShowMissionStrip(mission) ? (
        <MissionStrip mission={mission} controls={controls} />
      ) : null}
      {stale ? <StaleDataBanner /> : null}
      {mission.status === "paused" ? <PausedCard /> : null}
      {rejected === null ? null : <OrderRejectedCard notice={rejected} controls={controls} />}
      <MissionStatus mission={mission} />
      <RiskControls mission={mission} controls={controls} />
      {isMissionComplete(mission.status) ? <CompletionSummaryCard mission={mission} /> : null}
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

      {import.meta.env.DEV ? (
        <NewMissionForm
          environmentId={environmentId}
          boundThreadIds={new Set(missions.map((mission) => mission.threadId))}
        />
      ) : null}

      {missions.map((mission) => (
        <MissionWithControls key={mission.id} mission={mission} environmentId={environmentId} />
      ))}
    </SettingsPageContainer>
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
  const dispatchLifecycle = useAtomCommand(orchestrationEnvironment.missionControl);
  const dispatchRisk = useAtomCommand(orchestrationEnvironment.riskControl);
  const [isBusy, setIsBusy] = useState(false);

  // One busy flag per mission, so a press on one mission cannot grey out
  // another mission's way out.
  const run = useCallback((send: () => Promise<unknown>) => {
    setIsBusy(true);
    void send().finally(() => setIsBusy(false));
  }, []);

  const controls = useMemo<MissionControls>(
    () => ({
      isBusy,
      lifecycle: (type) => {
        run(() =>
          dispatchLifecycle({
            environmentId,
            input: { type, threadId: mission.threadId, missionId: mission.id },
          }),
        );
      },
      risk: (control, reductionPercent) => {
        run(() =>
          dispatchRisk({
            environmentId,
            input: {
              threadId: mission.threadId,
              missionId: mission.id,
              control,
              ...(reductionPercent === undefined ? {} : { reductionPercent }),
            },
          }),
        );
      },
    }),
    [dispatchLifecycle, dispatchRisk, environmentId, isBusy, mission.id, mission.threadId, run],
  );

  return <MissionView mission={mission} controls={controls} />;
}
