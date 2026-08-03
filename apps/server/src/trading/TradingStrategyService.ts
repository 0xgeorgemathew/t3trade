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

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { TradingMissionNotFoundError } from "./Errors.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";
import {
  MarketWatch,
  MomentumStrategyState,
  PersistedWatch,
  PersistedWatchStatus,
  TradingMissionStatus,
  TradingPublishMomentumStrategyInput,
  TradingPublishMomentumStrategyResult,
} from "./Schemas.ts";

export interface TradingStrategyServiceShape {
  /**
   * Publish a momentum strategy under optimistic locking.
   *
   * A stale expected version is rejected rather than silently overwriting
   * current state; the rejection carries the version the server actually holds.
   */
  readonly publishMomentumStrategy: (
    input: TradingPublishMomentumStrategyInput,
  ) => Effect.Effect<
    TradingPublishMomentumStrategyResult,
    PersistenceSqlError | TradingMissionNotFoundError
  >;

  readonly getCurrentStrategy: (
    missionId: string,
  ) => Effect.Effect<Option.Option<MomentumStrategyState>, PersistenceSqlError>;

  /**
   * Every persisted watch for a mission, newest first — including the
   * superseded ones, so a reader can see what the previous strategy version
   * was waiting on.
   */
  readonly listWatches: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<PersistedWatch>, PersistenceSqlError>;
}

export class TradingStrategyService extends Context.Service<
  TradingStrategyService,
  TradingStrategyServiceShape
>()("t3/trading/TradingStrategyService") {}

const StrategyJson = Schema.fromJsonString(MomentumStrategyState);
const decodeStrategyJson = Schema.decodeUnknownSync(StrategyJson);
const encodeStrategyJson = Schema.encodeUnknownSync(StrategyJson);
const decodeMissionStatus = Schema.decodeUnknownSync(TradingMissionStatus);
const decodeWatchJson = Schema.decodeUnknownSync(Schema.fromJsonString(MarketWatch));
const decodeWatchStatus = Schema.decodeUnknownSync(PersistedWatchStatus);

interface WatchRow {
  readonly watch_id: string;
  readonly mission_id: string;
  readonly strategy_version: number;
  readonly watch_json: string;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
}

const toPersistedWatch = (row: WatchRow): PersistedWatch => ({
  id: row.watch_id,
  missionId: row.mission_id,
  strategyVersion: row.strategy_version,
  watch: decodeWatchJson(row.watch_json),
  status: decodeWatchStatus(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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
      SELECT watch_id, mission_id, strategy_version, watch_json, status, created_at, updated_at
      FROM trading_watches
      WHERE mission_id = ${missionId}
      ORDER BY created_at DESC, watch_id DESC
    `.pipe(
      Effect.mapError(sqlFail("listWatches")),
      Effect.map((rows) => rows.map(toPersistedWatch)),
    );

  const publishMomentumStrategy: TradingStrategyServiceShape["publishMomentumStrategy"] = (input) =>
    Effect.gen(function* () {
      const missions = yield* sql<{
        readonly status: string;
        readonly strategy_version: number;
      }>`
        SELECT status, strategy_version FROM trading_missions
        WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("publish:readMission")));

      const mission = missions[0];
      if (mission === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: input.missionId });
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

      const version = input.expectedVersion + 1;
      const now = yield* Clock.currentTimeMillis;
      const strategy: MomentumStrategyState = {
        version,
        ...input.strategy,
        updatedAt: now,
      };

      yield* sql`
        INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
        VALUES (${input.missionId}, ${version}, ${encodeStrategyJson(strategy)}, ${now})
      `.pipe(Effect.mapError(sqlFail("publish:insertStrategy")));

      // §11.3: publishing a new strategy supersedes the active watches of the
      // prior version. Only active watches can be superseded; triggered,
      // consumed, cancelled, and expired watches keep their terminal status.
      const superseded = yield* sql<{ readonly watch_id: string }>`
        SELECT watch_id FROM trading_watches
        WHERE mission_id = ${input.missionId}
          AND status = 'active'
          AND strategy_version < ${version}
      `.pipe(Effect.mapError(sqlFail("publish:selectSuperseded")));

      yield* sql`
        UPDATE trading_watches
        SET status = 'superseded', version = version + 1, updated_at = ${now}
        WHERE mission_id = ${input.missionId}
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
        WHERE mission_id = ${input.missionId} AND strategy_version = ${input.expectedVersion}
      `.pipe(Effect.mapError(sqlFail("publish:bumpMission")));

      return {
        outcome: "accepted",
        strategy,
        strategyVersion: version,
        supersededWatchIds: superseded.map((row) => row.watch_id),
      } as const;
    });

  return {
    publishMomentumStrategy,
    getCurrentStrategy,
    listWatches,
  } satisfies TradingStrategyServiceShape;
});

export const TradingStrategyServiceLive = Layer.effect(
  TradingStrategyService,
  makeTradingStrategyService,
);
