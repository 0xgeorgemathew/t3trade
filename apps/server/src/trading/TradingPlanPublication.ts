/**
 * Publishing a plan, and everything an accepted publish drags behind it.
 *
 * `TradingStrategyService.publishPlan` writes the row. It does not announce the
 * publish to the workspace, it does not reconcile the exchange to the plan it
 * just accepted, and it does not withdraw the resting entry the previous plan
 * left working. Those three were assembled inside the `trading_plan` MCP
 * handler, which made them the model's path and only the model's path.
 *
 * Plan 29 step 8.4 gives the operator a second way to revise a plan — dragging
 * a level on the chart is a `plan()` revision — and a drag that called
 * `publishPlan` alone would move the stop on screen and not on Hyperliquid.
 * So the whole sequence lives here, and both callers get all of it.
 *
 * @module TradingPlanPublication
 */
import type {
  TradingPublishPlanInput,
  TradingPublishPlanResult,
} from "@t3tools/trading-contracts/tools";
import { TradingToolRejectedError } from "@t3tools/trading-contracts/tools";
import { CommandId, ThreadId, TradingMissionId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { TradingMission } from "./Schemas.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { armPredictionWatchesQuietly } from "./TradingPredictionWatches.ts";
import {
  TradingPlanProtectionService,
  type PlanProtectionOutcome,
} from "./TradingPlanProtectionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWorkingOrderService } from "./TradingWorkingOrderService.ts";

const announceStrategyPublished = Effect.fn("TradingPlanPublication.announceStrategyPublished")(
  function* (input: { readonly threadId: string; readonly missionId: string }) {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

    yield* engine
      .dispatch({
        type: "trading.mission.strategy-published",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(input.threadId),
        missionId: TradingMissionId.make(input.missionId),
        createdAt,
      })
      // The strategy is already durable; failing to announce it costs the UI a
      // refresh, not the publish.
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not announce a published strategy to the orchestration engine", {
            missionId: input.missionId,
            cause,
          }),
        ),
      );
  },
);

/**
 * Put the mission's post-publish status on the WS push path.
 *
 * `publishPlan` moves a mission out of `analysing` as part of the
 * publish itself (§11.1 `analysing → waiting`). That write is durable but
 * invisible to the workspace, which learns about mission status from
 * `trading.mission.status-set` events; announcing the status the publish
 * settled on is what closes that gap.
 */
const announceMissionStatus = Effect.fn("TradingPlanPublication.announceMissionStatus")(
  function* (input: { readonly threadId: string; readonly missionId: string }) {
    const missions = yield* TradingMissionService;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;

    yield* Effect.gen(function* () {
      const mission = yield* missions.getMission(input.missionId);
      const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* engine.dispatch({
        type: "trading.mission.status-set",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make(input.threadId),
        missionId: TradingMissionId.make(input.missionId),
        status: mission.status,
        createdAt,
      });
    }).pipe(
      // The publish and its status are already durable; failing to announce them
      // costs the UI a refresh, not the publish.
      Effect.catchCause((cause) =>
        Effect.logWarning("could not announce a mission status after a strategy publish", {
          missionId: input.missionId,
          cause,
        }),
      ),
    );
  },
);

/**
 * What the publish and its aftermath between them did.
 *
 * `warnings` is what the model is told: the publish's own warnings plus the
 * reconcile's refusal and the withdrawn-entry note. `reconciled` is the same
 * information unflattened, because a caller drawing the plan on a chart needs
 * to know _which_ level the exchange refused, not just that a sentence was
 * added — a refused stop has to render where it actually rests.
 */
export interface PlanPublicationOutcome {
  readonly published: TradingPublishPlanResult;
  readonly warnings: ReadonlyArray<string>;
  /** `null` when the reconcile never ran, or ran and failed. */
  readonly reconciled: PlanProtectionOutcome | null;
  /** True when a resting patient entry was withdrawn by this revision. */
  readonly withdrewRestingEntry: boolean;
}

/**
 * Publish a plan and carry out everything an accepted publish owes.
 *
 * The mission must already be resolved and authorized by the caller: this
 * function acts on it, it does not decide who may.
 */
export const publishPlanWithAftermath = Effect.fn(
  "TradingPlanPublication.publishPlanWithAftermath",
)(function* (input: {
  readonly threadId: string;
  readonly mission: TradingMission;
  readonly publish: TradingPublishPlanInput;
}) {
  const { threadId, mission } = input;
  const strategies = yield* TradingStrategyService;
  const published = yield* strategies.publishPlan(input.publish).pipe(
    Effect.catchTags({
      // The mission was resolved a moment ago, so a miss here means it was
      // deleted mid-call. Report it as a rejection rather than a defect.
      TradingMissionNotFoundError: () =>
        new TradingToolRejectedError({
          reason: "mission_not_found",
          threadId,
          missionId: mission.id,
        }),
      PersistenceSqlError: (error) => Effect.die(error),
    }),
  );
  const nothingMore = (): PlanPublicationOutcome => ({
    published,
    warnings: published.outcome === "accepted" ? published.warnings : [],
    reconciled: null,
    withdrewRestingEntry: false,
  });
  if (published.outcome !== "accepted") return nothingMore();

  // An accepted publish is mission state the workspace has to see. Raising
  // it as an orchestration command is what puts it on the ordered WS push
  // path instead of leaving the UI to poll.
  yield* announceStrategyPublished({ threadId, missionId: mission.id });
  yield* announceMissionStatus({ threadId, missionId: mission.id });

  // The published prediction gets its own two triggers — the horizon and the
  // invalidation level — and the previous prediction's pair is retired. This
  // is what lets a plan be published and then waited on: without it a
  // confident read arms nothing, and the mission's only wake is the coverage
  // floor's cadence, which knows nothing about what the plan believes.
  yield* armPredictionWatchesQuietly({
    missionId: mission.id,
    version: published.version,
    plan: published.strategy,
  });

  // Plan 29 step 4.5: the plan is the position's declared state, so an
  // accepted publish reconciles the exchange to it NOW — the stop and the
  // resting target move at publish time, not on the watchdog's next pass.
  // A stop the envelope refuses to widen stays where it is, and the
  // refusal rides the publish response back to the model. A failed
  // reconcile never fails the publish: the plan is already durable and the
  // watchdog keeps converging.
  const missions = yield* TradingMissionService;
  // The mission was resolved a moment ago and its account row is immutable
  // for its life, so a miss here is an environment gap, not a refusal —
  // skip the reconcile and let the watchdog own convergence.
  const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId).pipe(
    Effect.catchTags({
      TradingMissionNotFoundError: () => Effect.succeed(null),
      // The plan is already durable; a read failure costs the immediate
      // reconcile, not the publish.
      PersistenceSqlError: () => Effect.succeed(null),
    }),
  );
  if (masterAddress === null) return nothingMore();

  const planProtection = yield* TradingPlanProtectionService;
  const reconciled = yield* planProtection
    .reconcilePlan({
      missionId: mission.id,
      masterAddress,
      plan: published.strategy,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "trading publish: the plan's exchange reconcile could not run; the watchdog pass retries it",
          { missionId: mission.id, error: error.message },
        ).pipe(Effect.as(null)),
      ),
    );
  const warnings = [...published.warnings];
  if (reconciled !== null && reconciled.refusal !== undefined) {
    warnings.push(reconciled.refusal);
  }

  // The audited risk fix: a resting patient entry kept working up to the
  // ~90s cross horizon even after the model changed its mind. A publish IS
  // the mind changing — retract the mission's resting working entries now,
  // through the same abandon() the reactor's retirement path uses, and say
  // so in the response so the model can re-place under the new plan.
  //
  // `scope: "entries"` is load-bearing: a revision changed the way IN. The
  // patient exit the model asked for and the take-profit the reconcile
  // above just placed are not this publish's to cancel — the mission-end
  // path is the one that takes everything.
  const workingOrders = yield* TradingWorkingOrderService;
  const retracted = yield* workingOrders
    .abandon({
      missionId: mission.id,
      masterAddress,
      market: published.strategy.market,
      nowMs: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      scope: "entries",
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "trading publish: a resting entry could not be withdrawn; the working-order backstop will",
          { missionId: mission.id, reason: error.message },
        ).pipe(Effect.as(null)),
      ),
    );
  const withdrewRestingEntry = retracted !== null && retracted.found;
  if (withdrewRestingEntry) {
    warnings.push(
      "the plan was revised, so its resting patient entry was withdrawn — re-place it under " +
        "the new plan if you still want in",
    );
  }

  return { published, warnings, reconciled, withdrewRestingEntry } satisfies PlanPublicationOutcome;
});
