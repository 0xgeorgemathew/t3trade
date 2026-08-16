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

/**
 * Which leaf of the plan a drag replaced.
 *
 * Stop and target only, which is what `draggableKinds` offers. A trigger drag
 * needs three things this hook cannot do on its own and must not be enabled by
 * adding a kind here: the trigger's DESCRIPTION carries the authoritative price
 * (`strategy.ts` says so), so a plan would read "short if we tag 3,009" with a
 * `priceLevel` of 3,015; the armed watch would not move, because step 4.2
 * removed supersede-on-publish, so the mission would still wake at the old
 * level; and a trigger published as a bare string has no `priceLevel` to
 * replace at all.
 */
export type PlanDragTarget =
  | { readonly kind: "stop"; readonly price: number }
  | { readonly kind: "target"; readonly price: number };

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
  /**
   * Set when the publish was accepted and the take-profit could not be
   * confirmed. Nothing was cancelled, so the order the exchange holds is the
   * previous one; the watchdog converges it on its next pass, and until then
   * the panel must not draw a target that is not there.
   */
  readonly unconfirmedTarget: { readonly planPrice: number | null; readonly detail: string } | null;
}

/** The eight authored fields, with exactly one leaf replaced. */
export function applyPlanDrag(plan: TradingPlanState, drag: PlanDragTarget): TradingPlanState {
  switch (drag.kind) {
    case "stop":
      return { ...plan, stop: { ...plan.stop, price: drag.price } };
    case "target":
      return { ...plan, target: { ...plan.target, price: drag.price } };
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
    unconfirmedTarget: null,
  });

  const revise = useCallback<MissionPlanRevision["revise"]>(
    (plan, drag, missionVersion) => {
      setState({
        isBusy: true,
        lockLost: false,
        error: null,
        refusedStop: null,
        unconfirmedTarget: null,
      });
      const { updatedAt: _updatedAt, ...authored } = applyPlanDrag(plan, drag);
      void dispatch({
        environmentId,
        input: { missionId, expectedMissionVersion: missionVersion, strategy: authored },
      })
        .then((result) => {
          const failure = describeControlFailure(result);
          if (failure !== null) {
            setState({
              isBusy: false,
              lockLost: false,
              error: failure,
              refusedStop: null,
              unconfirmedTarget: null,
            });
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
              unconfirmedTarget: null,
            });
            return;
          }
          const stop = revision.stop;
          const target = revision.target;
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
            unconfirmedTarget:
              target !== null && target.status === "failed"
                ? {
                    planPrice: target.targetPrice,
                    detail:
                      target.detail ??
                      "the take-profit could not be confirmed; the previous one is still resting",
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
            unconfirmedTarget: null,
          });
        });
    },
    [dispatch, environmentId, missionId],
  );

  const dismiss = useCallback(() => {
    setState({
      isBusy: false,
      lockLost: false,
      error: null,
      refusedStop: null,
      unconfirmedTarget: null,
    });
  }, []);

  return { ...state, revise, dismiss };
}
