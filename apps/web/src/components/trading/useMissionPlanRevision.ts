/**
 * A drag on the chart, on its way to `plan()` — plan 29 step 8.4.
 *
 * The hook owns the three states a drag can end in and nothing else. It builds
 * no plan of its own: the caller hands it the mission's `TradingPlanState` and
 * the one leaf that moved, and the eight authored fields go out exactly as the
 * model publishes them. A UI-local plan shape would drift from
 * `tradingPlanAuthoredFields`, and `misarmedEntryConditions` compares the
 * plan's `confirmation` against the watch's `confirm` on the assumption that it
 * has not.
 *
 * @module useMissionPlanRevision
 */
import type {
  EnvironmentId,
  OrchestrationReviseTradingPlanResult,
  TradingMissionId,
} from "@t3tools/contracts";
import type { TradingPlanState } from "@t3tools/trading-contracts/strategy";
import { useCallback, useState } from "react";

import { refreshTradingMissions } from "../../lib/tradingMissionsState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

import { describeControlFailure } from "./useMissionControls";

/** Which leaf of the plan a drag replaced. */
export type PlanDragTarget =
  | { readonly kind: "stop"; readonly price: number }
  | { readonly kind: "target"; readonly price: number }
  | { readonly kind: "trigger"; readonly index: number; readonly price: number };

/**
 * What the panel has to say about the last drag, or null when it has nothing.
 *
 * `lockLost` is deliberately not an error string: the level has to snap back to
 * where the model's newer plan puts it, and the panel has to say who moved it.
 * A silent retry would apply the operator's stop to a plan they never saw.
 */
export interface PlanRevisionState {
  readonly isBusy: boolean;
  readonly lockLost: boolean;
  readonly error: string | null;
  /**
   * Set when the publish was accepted and the exchange refused to move the
   * stop. The rule stays where the stop rests; this is what the plan now says.
   */
  readonly refusedStop: { readonly planPrice: number; readonly detail: string } | null;
}

/** The eight authored fields, with exactly one leaf replaced. */
export function applyPlanDrag(plan: TradingPlanState, drag: PlanDragTarget): TradingPlanState {
  switch (drag.kind) {
    case "stop":
      return { ...plan, stop: { ...plan.stop, price: drag.price } };
    case "target":
      return { ...plan, target: { ...plan.target, price: drag.price } };
    case "trigger":
      return {
        ...plan,
        entry: {
          ...plan.entry,
          triggers: plan.entry.triggers.map((trigger, index) =>
            index === drag.index ? { ...trigger, priceLevel: drag.price } : trigger,
          ),
        },
      };
  }
}

export interface MissionPlanRevision extends PlanRevisionState {
  readonly revise: (plan: TradingPlanState, drag: PlanDragTarget, missionVersion: number) => void;
  readonly dismiss: () => void;
}

export function useMissionPlanRevision(
  missionId: TradingMissionId,
  environmentId: EnvironmentId,
): MissionPlanRevision {
  const dispatch = useAtomCommand(orchestrationEnvironment.reviseTradingPlan);
  const [state, setState] = useState<PlanRevisionState>({
    isBusy: false,
    lockLost: false,
    error: null,
    refusedStop: null,
  });

  const revise = useCallback<MissionPlanRevision["revise"]>(
    (plan, drag, missionVersion) => {
      setState({ isBusy: true, lockLost: false, error: null, refusedStop: null });
      const { updatedAt: _updatedAt, ...authored } = applyPlanDrag(plan, drag);
      void dispatch({
        environmentId,
        input: { missionId, expectedMissionVersion: missionVersion, strategy: authored },
      })
        .then((result) => {
          const failure = describeControlFailure(result);
          if (failure !== null) {
            setState({ isBusy: false, lockLost: false, error: failure, refusedStop: null });
            return;
          }
          if (result._tag !== "Success") return;
          const revision: OrchestrationReviseTradingPlanResult = result.value;
          if (revision.outcome === "rejected") {
            // The model republished under the drag. Not a retry: the operator
            // drags again against what is now there.
            setState({
              isBusy: false,
              lockLost: revision.reason === "stale_mission_state",
              error:
                revision.reason === "stale_mission_state"
                  ? null
                  : (revision.detail ?? "The mission is no longer taking revisions."),
              refusedStop: null,
            });
            return;
          }
          const stop = revision.stop;
          setState({
            isBusy: false,
            lockLost: false,
            error: null,
            refusedStop:
              stop !== null && stop.status === "refused" && stop.planStopPrice !== null
                ? {
                    planPrice: stop.planStopPrice,
                    detail: stop.refusal ?? "the exchange stop was left where it is",
                  }
                : null,
          });
          // The panel polls every 3s; refreshing on the way out is what makes
          // an accepted drag land in under a second rather than on the timer.
          refreshTradingMissions(environmentId);
        })
        .catch(() => {
          setState({
            isBusy: false,
            lockLost: false,
            error: "The revision could not be sent.",
            refusedStop: null,
          });
        });
    },
    [dispatch, environmentId, missionId],
  );

  const dismiss = useCallback(() => {
    setState({ isBusy: false, lockLost: false, error: null, refusedStop: null });
  }, []);

  return { ...state, revise, dismiss };
}
