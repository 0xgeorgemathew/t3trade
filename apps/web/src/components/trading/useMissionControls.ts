/**
 * Binds one mission to the §14.7 control dispatchers.
 *
 * Per-mission rather than per-surface so a control's busy state belongs to the
 * mission it acts on, and a press on one mission cannot grey out another's way
 * out. Both dispatchers go straight to the server: §14.7's controls must work
 * while the harness is offline, so nothing here consults a session, a lease, or
 * a turn.
 *
 * The hook is shared because the strip now renders in two places — the
 * workspace list and the bound thread — and a second copy of this wiring would
 * be a second chance to get the busy semantics wrong.
 *
 * @module useMissionControls
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingReductionPercent,
  TradingRiskControl,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { refreshTradingMissions } from "../../lib/tradingMissionsState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

export interface MissionControls {
  readonly isBusy: boolean;
  /**
   * Why the last command failed, or null. A pause that does not pause is the
   * one outcome the operator must not have to infer from a status that did not
   * move: `void send()` swallowed the rejection entirely, so a revoke refused
   * by the domain looked exactly like a revoke still in flight.
   */
  readonly error: string | null;
  readonly lifecycle: (
    type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
  ) => void;
  readonly risk: (control: TradingRiskControl, reductionPercent?: TradingReductionPercent) => void;
}

/** The one line a failed control shows. Never empty: a blank error reads as none. */
export function describeControlFailure(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  // An interrupt is a navigation or an unmount, not a refusal.
  if (isAtomCommandInterrupted(result)) return null;

  const squashed = squashAtomCommandFailure(result);
  const message = squashed instanceof Error ? squashed.message : String(squashed);
  return message.trim().length === 0 ? "The command failed." : message;
}

export function useMissionControls(
  mission: Pick<OrchestrationTradingMission, "id" | "threadId">,
  environmentId: EnvironmentId,
): MissionControls {
  const dispatchLifecycle = useAtomCommand(orchestrationEnvironment.missionControl);
  const dispatchRisk = useAtomCommand(orchestrationEnvironment.riskControl);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
      setIsBusy(true);
      setError(null);
      void send()
        .then((result) => {
          const failure = describeControlFailure(result);
          setError(failure);
          // The projection is pull-only and polls every 3s. Refreshing on the
          // way out is what makes a successful control land in under a second
          // instead of whenever the timer next fires.
          if (failure === null) refreshTradingMissions(environmentId);
        })
        .finally(() => setIsBusy(false));
    },
    [environmentId],
  );

  const lifecycle = useCallback<MissionControls["lifecycle"]>(
    (type) => {
      run(() =>
        dispatchLifecycle({
          environmentId,
          input: { type, threadId: mission.threadId, missionId: mission.id },
        }),
      );
    },
    [dispatchLifecycle, environmentId, mission.id, mission.threadId, run],
  );

  const risk = useCallback<MissionControls["risk"]>(
    (control, reductionPercent) => {
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
    [dispatchRisk, environmentId, mission.id, mission.threadId, run],
  );

  // The two dispatchers are memoized; the object around them deliberately is
  // not. Memoizing it over `isBusy` — a value that changes on every press —
  // bought nothing and made the dependency list read as though it did.
  return { isBusy, error, lifecycle, risk };
}
