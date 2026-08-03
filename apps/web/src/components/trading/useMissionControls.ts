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
import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingReductionPercent,
  TradingRiskControl,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

export interface MissionControls {
  readonly isBusy: boolean;
  readonly lifecycle: (
    type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
  ) => void;
  readonly risk: (control: TradingRiskControl, reductionPercent?: TradingReductionPercent) => void;
}

export function useMissionControls(
  mission: Pick<OrchestrationTradingMission, "id" | "threadId">,
  environmentId: EnvironmentId,
): MissionControls {
  const dispatchLifecycle = useAtomCommand(orchestrationEnvironment.missionControl);
  const dispatchRisk = useAtomCommand(orchestrationEnvironment.riskControl);
  const [isBusy, setIsBusy] = useState(false);

  const run = useCallback((send: () => Promise<unknown>) => {
    setIsBusy(true);
    void send().finally(() => setIsBusy(false));
  }, []);

  return useMemo<MissionControls>(
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
}
