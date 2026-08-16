/**
 * TradingStrategyService - plan publishing, revised in place (§14.3, plan 29
 * step 4.2).
 *
 * Publishing is a side-effecting operation guarded by the mission row's own
 * optimistic-lock version: a publish against a mission that has moved on is
 * refused rather than silently overwriting current state. On acceptance the
 * plan document is appended to `trading_plan_history` and becomes the
 * mission's current plan; the watches are NOT supersended — a revision updates
 * its triggers in place, and only genuinely changed conditions re-arm (the
 * model cancels or replaces what it no longer wants).
 *
 * @module TradingStrategyService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { TradingMissionNotFoundError } from "./Errors.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";
import { boundStrategyProse, PUBLISHED_PROSE_CHARS } from "./StrategyProse.ts";
import { toPersistedWatch } from "./TradingWatchService.ts";
import {
  TradingPlanState,
  PersistedWatch,
  TradingMissionStatus,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
} from "./Schemas.ts";
import type { PublishedStrategySummary } from "@t3tools/trading-contracts/tools";

export interface TradingStrategyServiceShape {
  /**
   * Publish (revise) the mission's plan under optimistic locking.
   *
   * A stale expected mission version is rejected rather than silently
   * overwriting current state; the rejection carries the version the server
   * actually holds. Watches survive the revision — nothing is superseded.
   */
  readonly publishPlan: (
    input: TradingPublishPlanInput,
  ) => Effect.Effect<TradingPublishPlanResult, PersistenceSqlError | TradingMissionNotFoundError>;

  readonly getCurrentStrategy: (
    missionId: string,
  ) => Effect.Effect<Option.Option<TradingPlanState>, PersistenceSqlError>;

  /**
   * Every persisted watch for a mission, newest first. Publishing no longer
   * touches them (plan 29 step 4.2), so this is simply the watch registry's
   * read side.
   */
  readonly listWatches: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<PersistedWatch>, PersistenceSqlError>;

  /**
   * The same registry, bounded for the read that rides every turn.
   *
   * `listWatches` is every watch the mission ever registered, and since plan 29
   * step 6.1 it rides EVERY `trading_look`. A mission that re-levels on each
   * wake accumulates terminal rows forever, so by hour three the model is
   * paying for a few hundred cancelled levels on every read — the same cost
   * `PLAN_HISTORY_READ_LIMIT` was introduced to stop on the plan journal.
   *
   * The cap is NOT recency. A watch that has FIRED and has not yet been
   * reasoned about is the single most important row in the list, and it is
   * also, by construction, older than every level armed after it — recency
   * alone would drop exactly the row the turn exists to answer. So nothing
   * live is ever dropped: every `active` and every `triggered` watch is
   * returned in full, and only the settled tail — cancelled, consumed,
   * expired, superseded — is capped, newest first.
   *
   * That leaves the live set unbounded in principle. In practice it is bounded
   * by what a mission can arm and have standing at once, which is the set the
   * coverage floor and the evaluator both already work over; a watch that is
   * still live is a watch the turn may need to act on, and dropping one to
   * save tokens would be a silent risk change.
   */
  readonly listWatchesForRead: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<PersistedWatch>, PersistenceSqlError>;

  /**
   * Every plan the mission has published, newest first.
   *
   * `getCurrentStrategy` answers what the mission believes now. This answers
   * what it has believed — which is what a harness needs to tell "the thesis
   * changed" from "the thesis has changed four times in an hour", and to see
   * the targets it set before this one.
   *
   * A row whose stored JSON no longer decodes is skipped rather than failing
   * the read: one unreadable historical row should not cost the caller the
   * whole history.
   */
  readonly listStrategyVersions: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<PublishedStrategySummary>, PersistenceSqlError>;
}

export class TradingStrategyService extends Context.Service<
  TradingStrategyService,
  TradingStrategyServiceShape
>()("t3/trading/TradingStrategyService") {}

const StrategyJson = Schema.fromJsonString(TradingPlanState);
const decodeStrategyJson = Schema.decodeUnknownSync(StrategyJson);
const encodeStrategyJson = Schema.encodeUnknownSync(StrategyJson);
const decodeMissionStatus = Schema.decodeUnknownSync(TradingMissionStatus);

/**
 * The watch row shape `toPersistedWatch` maps. Shared with
 * `TradingWatchService`, which owns the mapper, so the two readers of
 * `trading_watches` cannot drift apart on a column.
 */
interface WatchRow {
  readonly watch_id: string;
  readonly mission_id: string;
  readonly watch_json: string;
  readonly status: string;
  readonly armed_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * One published plan as its history summary, or nothing.
 *
 * The full `TradingPlanState` is mostly prose; a history of ten of them would
 * crowd out the mission snapshot it rides in. This keeps the skeleton — what
 * was intended, what was targeted, why — and drops the rest.
 *
 * A row that no longer decodes returns `[]`: plans published before a field
 * became required still sit in this table, and a history is a nicety that must
 * never take a mission read down with it.
 */
/**
 * How many revisions back a read of the plan journal reaches.
 *
 * This list used to ride an occasional `trading_get_mission`; since plan 29
 * step 6.1 it rides EVERY `trading_look`, which is the one read a turn always
 * takes. Unbounded, a mission that revised forty times would spend a few
 * thousand tokens per turn re-reading beliefs it has already replaced —
 * exactly the context phase 6 exists to give back. Ten is more revisions than
 * "was the last target the right rung?" needs, and the whole journal is still
 * in `trading_plan_history` for the session report.
 */
const PLAN_HISTORY_READ_LIMIT = 10;

/**
 * How many settled watches a turn's read of the registry carries.
 *
 * Ten, for the same reason the plan journal keeps ten: enough to see the levels
 * this mission has been working and retiring, far short of the whole session.
 * Only terminal rows are counted against it — see `listWatchesForRead`.
 */
const SETTLED_WATCH_READ_LIMIT = 10;

const toStrategySummary = (row: {
  readonly version: number;
  readonly strategy_json: string;
  readonly created_at: number;
}): ReadonlyArray<PublishedStrategySummary> => {
  let strategy: TradingPlanState;
  try {
    strategy = decodeStrategyJson(row.strategy_json);
  } catch {
    return [];
  }
  return [
    {
      version: row.version,
      publishedAt: row.created_at,
      intent: strategy.intent,
      ...(strategy.target.profitUsd === undefined
        ? {}
        : { targetProfitUsd: strategy.target.profitUsd }),
      ...(strategy.because === "" ? {} : { because: strategy.because }),
    },
  ];
};

const makeTradingStrategyService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingStrategyService.${operation}`);

  const getCurrentStrategy: TradingStrategyServiceShape["getCurrentStrategy"] = (missionId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly strategy_json: string }>`
        SELECT strategy_json
        FROM trading_plan_history
        WHERE mission_id = ${missionId}
        ORDER BY version DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("getCurrentStrategy")));

      const row = rows[0];
      if (row === undefined) return Option.none();

      // A row the current schema cannot read behaves like no plan at all, not
      // like a crashed turn. This read is on the wake path, the `trading_look`
      // path, `move_stop`'s staleness check and the drag path — and a throw on
      // the wake path fails the run, consumes the watch that woke it, and
      // leaves nothing to wake the mission again. The history read next door
      // has skipped bad rows since it was written; this one throwing was the
      // asymmetry. Migration 062 rewrote every stored plan; the next one like
      // it is where this earns its keep.
      return yield* Effect.try(() => Option.some(decodeStrategyJson(row.strategy_json))).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            "TradingStrategyService: the mission's current plan could not be decoded; " +
              "reading it as no plan",
            { missionId, cause },
          ),
        ),
        Effect.orElseSucceed(() => Option.none<TradingPlanState>()),
      );
    });

  const listWatches: TradingStrategyServiceShape["listWatches"] = (missionId) =>
    sql<WatchRow>`
      SELECT watch_id, mission_id, watch_json, status, armed_reason,
             created_at, updated_at
      FROM trading_watches
      WHERE mission_id = ${missionId}
      ORDER BY created_at DESC, watch_id DESC
    `.pipe(
      Effect.mapError(sqlFail("listWatches")),
      Effect.map((rows) => rows.map(toPersistedWatch)),
    );

  const listWatchesForRead: TradingStrategyServiceShape["listWatchesForRead"] = (missionId) =>
    sql<WatchRow>`
      SELECT watch_id, mission_id, watch_json, status, armed_reason,
             created_at, updated_at
      FROM trading_watches
      WHERE mission_id = ${missionId}
        AND status IN ('active', 'triggered')
      UNION ALL
      SELECT watch_id, mission_id, watch_json, status, armed_reason,
             created_at, updated_at
      FROM (
        SELECT watch_id, mission_id, watch_json, status, armed_reason,
               created_at, updated_at
        FROM trading_watches
        WHERE mission_id = ${missionId}
          AND status NOT IN ('active', 'triggered')
        ORDER BY created_at DESC, watch_id DESC
        LIMIT ${SETTLED_WATCH_READ_LIMIT}
      )
    `.pipe(
      Effect.mapError(sqlFail("listWatchesForRead")),
      Effect.map((rows) =>
        rows
          .map(toPersistedWatch)
          // The two arms come back in whatever order the union produced. The
          // caller's contract is the same as `listWatches`: newest first.
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)),
      ),
    );

  const listStrategyVersions: TradingStrategyServiceShape["listStrategyVersions"] = (missionId) =>
    sql<{ readonly version: number; readonly strategy_json: string; readonly created_at: number }>`
      SELECT version, strategy_json, created_at
      FROM trading_plan_history
      WHERE mission_id = ${missionId}
      ORDER BY version DESC
      LIMIT ${PLAN_HISTORY_READ_LIMIT}
    `.pipe(
      Effect.mapError(sqlFail("listStrategyVersions")),
      Effect.map((rows) => rows.flatMap((row) => toStrategySummary(row))),
    );

  const publishPlan: TradingStrategyServiceShape["publishPlan"] = (input) =>
    Effect.gen(function* () {
      // `missionId` is optional on the wire input but the handler always
      // resolves it to the bound mission's id before calling, so by the time
      // the publish path runs it is a concrete string.
      const missionId = input.missionId as string;
      const missions = yield* sql<{
        readonly status: string;
        readonly version: number;
      }>`
        SELECT status, version FROM trading_missions
        WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("publish:readMission")));

      const mission = missions[0];
      if (mission === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }

      const status = decodeMissionStatus(mission.status);
      if (!isActiveMissionStatus(status)) {
        return {
          outcome: "rejected",
          reason: "mission_not_active",
          currentVersion: mission.version,
        } as const;
      }

      if (mission.version !== input.expectedMissionVersion) {
        return {
          outcome: "rejected",
          reason: "stale_mission_state",
          currentVersion: mission.version,
        } as const;
      }

      // What actually gets persisted: the harness's plan with its long prose
      // clipped. The plan rides on every wakeup for the mission's life, so an
      // unbounded field here is an unbounded field there — see `StrategyProse`.
      // Nothing grades the target any more: its derivation is the harness's
      // own work, read back on the next wake, and cost is context the
      // observation carries (plan 29 steps 3.1/3.2).
      const { strategy: boundedStrategy, truncatedFields } = boundStrategyProse(
        input.strategy,
        PUBLISHED_PROSE_CHARS,
      );
      const proseWarnings = truncatedFields.map(
        (field) => `${field} truncated to ${PUBLISHED_PROSE_CHARS} chars`,
      );

      const now = yield* Clock.currentTimeMillis;
      const strategy: TradingPlanState = {
        ...boundedStrategy,
        updatedAt: now,
      };

      // The optimistic lock itself: the conditional UPDATE is atomic, so a
      // publish that raced another mission-row write bumps nothing and is
      // refused here. §11.1 `analysing → waiting` folds into the same write —
      // publishing a strategy is one of the two events that end analysis (a
      // plan existing with triggers armed is the other, see
      // `TradingWatchService.registerWatch`); pinning the source status in the
      // CASE is the whole legality check, and no other status is touched.
      //
      // One transaction, because the bump and the plan row are one fact. A
      // failure between them — a full disk, a busy database, a process killed
      // — used to leave the mission saying `waiting` at a version with no plan
      // under it: `getCurrentStrategy` returns nothing, the panel shows a
      // waiting mission with nothing beneath it, and `move_stop` skips its
      // staleness check because there is no plan to be stale against. Step 8.4
      // gave this path a second caller, so an operator dragging a stop can
      // reach it too.
      const staleVersion = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const bumped = yield* sql<{ readonly mission_id: string }>`
              UPDATE trading_missions
              SET status = CASE WHEN status = 'analysing' THEN 'waiting' ELSE status END,
                  version = version + 1,
                  updated_at = ${now}
              WHERE mission_id = ${missionId} AND version = ${input.expectedMissionVersion}
              RETURNING mission_id
            `;

            if (bumped.length === 0) {
              const fresh = yield* sql<{ readonly version: number }>`
                SELECT version FROM trading_missions WHERE mission_id = ${missionId}
              `;
              return fresh[0]?.version ?? input.expectedMissionVersion;
            }

            // The history append: rows keep their own per-mission counter and
            // PK, so the journal stays ordered. Nothing gates on this table —
            // reads of the current plan are latest-by-version, and the mission
            // row points at nothing here.
            const latest = yield* sql<{ readonly version: number }>`
              SELECT MAX(version) AS version FROM trading_plan_history
              WHERE mission_id = ${missionId}
            `;

            yield* sql`
              INSERT INTO trading_plan_history (mission_id, version, strategy_json, created_at)
              VALUES (${missionId}, ${(latest[0]?.version ?? 0) + 1}, ${encodeStrategyJson(strategy)}, ${now})
            `;
            return null;
          }),
        )
        .pipe(Effect.mapError(sqlFail("publish:write")));

      if (staleVersion !== null) {
        return {
          outcome: "rejected",
          reason: "stale_mission_state",
          currentVersion: staleVersion,
        } as const;
      }

      // Watches survive the revision (plan 29 step 4.2): a plan that changes
      // its mind about a level cancels or replaces the watch itself, and a
      // plan that keeps waiting on the same level keeps the trigger it armed.
      // Supersede-on-publish is gone.

      return {
        outcome: "accepted",
        strategy,
        // Everything that was not worth refusing the publish over: any prose
        // the server clipped.
        warnings: [...proseWarnings],
      } as const;
    });

  return {
    publishPlan,
    getCurrentStrategy,
    listWatches,
    listWatchesForRead,
    listStrategyVersions,
  } satisfies TradingStrategyServiceShape;
});

export const TradingStrategyServiceLive = Layer.effect(
  TradingStrategyService,
  makeTradingStrategyService,
);
