import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import { pocRiskPolicyDefaults } from "@t3tools/trading-contracts/authority";
import { RefreshCwIcon, TrendingUpIcon } from "lucide-react";
import { useMemo } from "react";

import { useTradingMissions } from "../../lib/tradingMissionsState";
import { useProjects } from "../../state/entities";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  describeWatch,
  formatUsd as usd,
  humanizeLiteral,
  MISSION_STATUS_LABELS,
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

function MissionView({ mission }: { mission: OrchestrationTradingMission }) {
  return (
    <>
      <MissionStatus mission={mission} />
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

      {missions.map((mission) => (
        <MissionView key={mission.id} mission={mission} />
      ))}
    </SettingsPageContainer>
  );
}
