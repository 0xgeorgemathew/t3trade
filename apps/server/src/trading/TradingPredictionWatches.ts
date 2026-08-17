/**
 * The two watches a published prediction arms, and the sweep of the ones the
 * prediction before it left behind.
 *
 * A plan's projection says where price is going, by when, and what would prove
 * it wrong. Those three facts are exactly a pair of triggers — a clock and a
 * level — and until now the model had to write them itself, which meant a plan
 * could be published with a confident read and nothing armed to wake it. A
 * mission in that state either sits blind or is woken by the coverage floor on
 * a cadence that has nothing to do with what it believes.
 *
 * So the runtime arms them. Publishing a projection is the whole act: the
 * horizon wake at `byMinutes` asks "did it happen?", the invalidation wake at
 * `invalidationPrice` says "it didn't, and here is the proof". Between them the
 * mission can genuinely sleep, because the only two things that could change
 * its mind are both armed.
 *
 * Nothing here is allowed to fail a publish. The plan is durable before this
 * runs; a mission whose prediction watches could not be armed is a mission
 * that wakes on its coverage floor instead, which is worse but not unsafe.
 *
 * @module TradingPredictionWatches
 */
import type { MarketWatch, WatchArmedReason } from "@t3tools/trading-contracts/watch";
import {
  projectionInvalidationDirection,
  type TradingPlanState,
} from "@t3tools/trading-contracts/strategy";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingWatchService } from "./TradingWatchService.ts";

/** What the publish path needs to arm a prediction. */
export interface ArmPredictionWatchesInput {
  readonly missionId: string;
  /** The plan-history version this publish wrote — the prediction's id. */
  readonly version: number;
  readonly plan: TradingPlanState;
}

/**
 * The active watch the runtime last armed for this reason, if any.
 *
 * At most one exists per mission and reason: every arm below either re-levels
 * it through `replacesWatchId` or rolls it forward in place.
 */
const readArmedPredictionWatch = Effect.fn("TradingPredictionWatches.readArmed")(function* (input: {
  readonly missionId: string;
  readonly reason: WatchArmedReason;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly watch_id: string;
    readonly watch_json: string;
    readonly prediction_version: number | null;
  }>`
    SELECT watch_id, watch_json, prediction_version FROM trading_watches
    WHERE mission_id = ${input.missionId}
      AND status = 'active'
      AND armed_reason = ${input.reason}
    ORDER BY created_at DESC
  `;
  return rows[0];
});

/**
 * Arm one prediction watch, or roll the existing one forward.
 *
 * An identical level republished is the common case — a plan revision that
 * moved the target and left the invalidation where it was should not retire a
 * live trigger and write a new one, because the watch stream would fill with
 * superseded rows describing a level that never actually moved. So an existing
 * watch whose predicate is byte-identical keeps its row and its history, and
 * only its `prediction_version` is re-stamped so the sweep below spares it.
 *
 * Anything else re-levels through `replacesWatchId`: the cancel and the insert
 * are one transaction, so the mission is never momentarily unwatched on the
 * side being moved.
 */
const armPredictionWatch = Effect.fn("TradingPredictionWatches.arm")(function* (input: {
  readonly missionId: string;
  readonly version: number;
  readonly reason: WatchArmedReason;
  readonly watch: MarketWatch;
}) {
  const sql = yield* SqlClient.SqlClient;
  const watches = yield* TradingWatchService;

  const existing = yield* readArmedPredictionWatch({
    missionId: input.missionId,
    reason: input.reason,
  });

  if (existing !== undefined && isSamePredicate(existing.watch_json, input.watch)) {
    yield* sql`
      UPDATE trading_watches
      SET prediction_version = ${input.version}, version = version + 1
      WHERE watch_id = ${existing.watch_id} AND status = 'active'
    `;
    yield* Effect.logInfo("trading rolled a prediction watch forward", {
      missionId: input.missionId,
      watchId: existing.watch_id,
      reason: input.reason,
      predictionVersion: input.version,
    });
    return;
  }

  const registered = yield* watches.registerWatch({
    missionId: input.missionId,
    watch: input.watch,
    armedReason: input.reason,
    predictionVersion: input.version,
    // Retired as superseded, not cancelled: a newer read replaced this level,
    // nobody disarmed it. Same distinction the sweep below draws.
    ...(existing === undefined
      ? {}
      : { replacesWatchId: existing.watch_id, replacedStatus: "superseded" as const }),
  });
  yield* Effect.logInfo("trading armed a prediction watch", {
    missionId: input.missionId,
    watchId: registered.watch.id,
    reason: input.reason,
    predictionVersion: input.version,
    replaces: existing?.watch_id,
  });
});

/**
 * Whether a stored watch is the predicate we are about to arm.
 *
 * Compared through re-encoded JSON with sorted keys rather than field by
 * field, so a new watch type never silently compares equal on the fields this
 * module happens to know about.
 */
function isSamePredicate(storedJson: string, watch: MarketWatch): boolean {
  try {
    return stableJson(JSON.parse(storedJson) as unknown) === stableJson(watch);
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const record = inner as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/**
 * Arm the published prediction's horizon and invalidation watches, then retire
 * whatever the previous prediction left armed.
 *
 * The order is deliberate. Arming first means the mission is covered by the
 * new read before the old one is taken away; sweeping second means a stale
 * pair cannot survive the revision. A stand-aside plan — no projection —
 * arms nothing and still sweeps, because a mission that has stopped believing
 * anything should not be woken by the level it used to disbelieve at.
 */
export const armPredictionWatches = Effect.fn("TradingPredictionWatches.armPredictionWatches")(
  function* (input: ArmPredictionWatchesInput) {
    const { missionId, plan, version } = input;
    const watches = yield* TradingWatchService;
    const projection = plan.projection;

    if (projection !== undefined) {
      yield* armPredictionWatch({
        missionId,
        version,
        reason: "prediction_horizon",
        watch: {
          type: "scheduled_reassessment",
          runAt: plan.updatedAt + projection.byMinutes * 60_000,
        },
      });

      yield* armPredictionWatch({
        missionId,
        version,
        reason: "prediction_invalidation",
        watch: {
          type: "price_cross",
          market: plan.market,
          priceSource: "mark",
          direction: projectionInvalidationDirection(projection),
          price: projection.invalidationPrice,
        },
      });
    }

    const superseded = yield* watches.supersedePredictionWatches({
      missionId,
      beforeVersion: version,
    });
    if (superseded.length > 0) {
      yield* Effect.logInfo("trading superseded the previous prediction's watches", {
        missionId,
        predictionVersion: version,
        watchIds: superseded,
      });
    }
  },
);

/** Never let arming a prediction break the publish that is already durable. */
export const armPredictionWatchesQuietly = (input: ArmPredictionWatchesInput) =>
  armPredictionWatches(input).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "trading could not arm the published prediction's watches; the coverage floor still wakes the mission",
        { missionId: input.missionId, cause: String(cause) },
      ),
    ),
  );
