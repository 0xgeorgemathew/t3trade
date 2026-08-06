/**
 * TradingStrategyService - versioned momentum strategy publishing (§14.3).
 *
 * Publishing is a versioned, side-effecting operation. It requires an expected
 * current version and, on acceptance, increments the strategy version and
 * supersedes the watches bound to the previous version, so an obsolete watch can
 * never wake a harness against stale intent (§11.3).
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

import { pocRiskPolicyDefaults } from "@t3tools/trading-contracts/authority";
import { checkProfitTarget } from "@t3tools/trading-contracts/costs";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { TradingMissionNotFoundError } from "./Errors.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";
import { boundStrategyProse, fillOmittedProse, PUBLISHED_PROSE_CHARS } from "./StrategyProse.ts";
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
   * Publish a momentum strategy under optimistic locking.
   *
   * A stale expected version is rejected rather than silently overwriting
   * current state; the rejection carries the version the server actually holds.
   */
  readonly publishMomentumStrategy: (
    input: TradingPublishPlanInput,
  ) => Effect.Effect<TradingPublishPlanResult, PersistenceSqlError | TradingMissionNotFoundError>;

  readonly getCurrentStrategy: (
    missionId: string,
  ) => Effect.Effect<Option.Option<TradingPlanState>, PersistenceSqlError>;

  /**
   * Every persisted watch for a mission, newest first — including the
   * superseded ones, so a reader can see what the previous strategy version
   * was waiting on.
   */
  readonly listWatches: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<PersistedWatch>, PersistenceSqlError>;

  /**
   * Every strategy version the mission has published, newest first.
   *
   * `getCurrentStrategy` answers what the mission believes now. This answers
   * what it has believed — which is what a harness needs to tell "the thesis
   * changed" from "the thesis has changed four times in an hour", and to see
   * the targets it set before this one.
   *
   * A version whose stored JSON no longer decodes is skipped rather than
   * failing the read: one unreadable historical row should not cost the caller
   * the whole history.
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
  readonly strategy_version: number;
  readonly watch_json: string;
  readonly status: string;
  readonly armed_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * One published version as its history summary, or nothing.
 *
 * The full `TradingPlanState` is large and mostly prose; a history of ten
 * of them would crowd out the mission snapshot it rides in. This keeps the
 * skeleton — what was believed, what was targeted, on what basis — and drops
 * the rest.
 *
 * A row that no longer decodes returns `[]`: strategies published before a
 * field became required still sit in this table, and a history is a nicety
 * that must never take a mission read down with it.
 */
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
      mode: strategy.mode,
      direction: strategy.direction,
      currentAction: strategy.currentAction,
      ...(strategy.timeframes[0] === undefined ? {} : { timeframe: strategy.timeframes[0] }),
      targetProfitUsd: strategy.protection.targetProfitUsd,
      ...(strategy.protection.targetProfitBasis === undefined
        ? {}
        : { targetProfitBasis: strategy.protection.targetProfitBasis }),
      beliefSummary: strategy.belief.summary,
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
        SELECT s.strategy_json
        FROM momentum_strategy_versions s
        JOIN trading_missions m
          ON m.mission_id = s.mission_id AND m.strategy_version = s.version
        WHERE s.mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("getCurrentStrategy")));

      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(decodeStrategyJson(row.strategy_json));
    });

  const listWatches: TradingStrategyServiceShape["listWatches"] = (missionId) =>
    sql<WatchRow>`
      SELECT watch_id, mission_id, strategy_version, watch_json, status, armed_reason,
             created_at, updated_at
      FROM trading_watches
      WHERE mission_id = ${missionId}
      ORDER BY created_at DESC, watch_id DESC
    `.pipe(
      Effect.mapError(sqlFail("listWatches")),
      Effect.map((rows) => rows.map(toPersistedWatch)),
    );

  const listStrategyVersions: TradingStrategyServiceShape["listStrategyVersions"] = (missionId) =>
    sql<{ readonly version: number; readonly strategy_json: string; readonly created_at: number }>`
      SELECT version, strategy_json, created_at
      FROM momentum_strategy_versions
      WHERE mission_id = ${missionId}
      ORDER BY version DESC
    `.pipe(
      Effect.mapError(sqlFail("listStrategyVersions")),
      Effect.map((rows) => rows.flatMap((row) => toStrategySummary(row))),
    );

  const publishMomentumStrategy: TradingStrategyServiceShape["publishMomentumStrategy"] = (input) =>
    Effect.gen(function* () {
      // `missionId` is optional on the wire input but the handler always
      // resolves it to the bound mission's id before calling, so by the time
      // the publish path runs it is a concrete string.
      const missionId = input.missionId as string;
      const missions = yield* sql<{
        readonly status: string;
        readonly strategy_version: number;
      }>`
        SELECT status, strategy_version FROM trading_missions
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
          currentVersion: mission.strategy_version,
        } as const;
      }

      if (mission.strategy_version !== input.expectedVersion) {
        return {
          outcome: "rejected",
          reason: "stale_strategy_version",
          currentVersion: mission.strategy_version,
        } as const;
      }

      // The profit target is the one published number the runtime acts on by
      // itself — it arms a `pnl_above` watch at it — so it is the one number
      // worth checking before the publish lands. `checkProfitTarget` rejects a
      // target with no derivation and one its own derivation does not produce;
      // the cost floor only warns, and rides back in-band. See `costs.ts`.
      const protection = input.strategy.protection;
      const check = checkProfitTarget({
        targetProfitUsd: protection.targetProfitUsd,
        basis: protection.targetProfitBasis,
        takerFeeBpsPerSide: pocRiskPolicyDefaults.fallbackTakerFeeBpsPerSide,
      });
      if (check.rejections.length > 0) {
        return {
          outcome: "rejected",
          reason: "target_not_justified",
          currentVersion: mission.strategy_version,
          detail: check.messages.join("; "),
        } as const;
      }

      // What actually gets persisted: the harness's plan with its omitted prose
      // filled in and its long prose clipped. The plan rides on every wakeup for
      // the mission's life, so an unbounded field here is an unbounded field
      // there — see `StrategyProse`.
      const filled = fillOmittedProse(input.strategy);
      const { strategy: boundedStrategy, truncatedFields } = boundStrategyProse(
        filled,
        PUBLISHED_PROSE_CHARS,
      );
      const proseWarnings = truncatedFields.map(
        (field) => `${field} truncated to ${PUBLISHED_PROSE_CHARS} chars`,
      );

      const version = input.expectedVersion + 1;
      const now = yield* Clock.currentTimeMillis;
      const strategy: TradingPlanState = {
        version,
        ...boundedStrategy,
        updatedAt: now,
      };

      yield* sql`
        INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
        VALUES (${missionId}, ${version}, ${encodeStrategyJson(strategy)}, ${now})
      `.pipe(Effect.mapError(sqlFail("publish:insertStrategy")));

      // §11.3: publishing a new strategy supersedes the active watches of the
      // prior version. Only active watches can be superseded; triggered,
      // consumed, cancelled, and expired watches keep their terminal status.
      const superseded = yield* sql<{ readonly watch_id: string }>`
        SELECT watch_id FROM trading_watches
        WHERE mission_id = ${missionId}
          AND status = 'active'
          AND strategy_version < ${version}
      `.pipe(Effect.mapError(sqlFail("publish:selectSuperseded")));

      yield* sql`
        UPDATE trading_watches
        SET status = 'superseded', version = version + 1, updated_at = ${now}
        WHERE mission_id = ${missionId}
          AND status = 'active'
          AND strategy_version < ${version}
      `.pipe(Effect.mapError(sqlFail("publish:supersedeWatches")));

      // §11.1 `analysing → waiting`: publishing a strategy is what ends
      // analysis — from here the mission waits on the conditions it just
      // armed. `analysing` has exactly one outgoing loop edge and this is the
      // event that takes it, so pinning the source status in the CASE is the
      // whole legality check; no other status is touched. Folded into the
      // version bump so the status and the strategy move under one write.
      //
      // Without this step a mission never leaves `analysing`, and §16.3 item 1
      // — which admits an entry only from `executing`/`position_open`, both
      // reachable only through `waiting` — refuses every entry the harness
      // ever requests.
      yield* sql`
        UPDATE trading_missions
        SET strategy_version = ${version},
            status = CASE WHEN status = 'analysing' THEN 'waiting' ELSE status END,
            version = version + 1,
            updated_at = ${now}
        WHERE mission_id = ${missionId} AND strategy_version = ${input.expectedVersion}
      `.pipe(Effect.mapError(sqlFail("publish:bumpMission")));

      return {
        outcome: "accepted",
        strategy,
        strategyVersion: version,
        supersededWatchIds: superseded.map((row) => row.watch_id),
        // Everything that was not worth refusing the publish over: a target
        // below twice its round-trip cost, and any prose the server clipped.
        warnings: [...check.messages, ...proseWarnings],
      } as const;
    });

  return {
    publishMomentumStrategy,
    getCurrentStrategy,
    listWatches,
    listStrategyVersions,
  } satisfies TradingStrategyServiceShape;
});

export const TradingStrategyServiceLive = Layer.effect(
  TradingStrategyService,
  makeTradingStrategyService,
);
