/**
 * The mission read model the workspace UI renders.
 *
 * A trading event says only "mission X changed". This service then re-reads
 * mission X from the authoritative migration-035 tables and writes one flat row
 * to `projection_trading_missions`. Doing it that way rather than carrying the
 * mandate, strategy, and watches through event payloads keeps the domain tables
 * the single source of truth: the projection can always be dropped and rebuilt.
 *
 * This is also the one place epoch millis become ISO strings. The row's own
 * `created_at`/`updated_at` are ISO, matching every other `projection_*` table;
 * the JSON payload columns keep the published spec contracts verbatim.
 *
 * @module TradingMissionProjection
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationTradingMission } from "@t3tools/contracts";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  MomentumStrategyState,
  PersistedWatch,
  TradingAuthority,
  TradingHarnessBinding,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
} from "./Schemas.ts";

export interface TradingMissionProjectionShape {
  /**
   * Rebuild one mission's projection row from the domain tables. A mission that
   * no longer exists is removed rather than left stale.
   */
  readonly refresh: (input: {
    readonly missionId: string;
    readonly occurredAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;

  readonly getByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<OrchestrationTradingMission>, PersistenceSqlError>;

  readonly list: () => Effect.Effect<
    ReadonlyArray<OrchestrationTradingMission>,
    PersistenceSqlError
  >;
}

export class TradingMissionProjection extends Context.Service<
  TradingMissionProjection,
  TradingMissionProjectionShape
>()("t3/trading/TradingMissionProjection") {}

/** The one place migration 035's epoch millis become read-model ISO strings. */
const toIso = (epochMillis: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const WatchesJson = Schema.fromJsonString(Schema.Array(PersistedWatch));
const encodeWatchesJson = Schema.encodeUnknownSync(WatchesJson);
const decodeWatchesJson = Schema.decodeUnknownSync(WatchesJson);
const decodeAuthorityJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingAuthority));
const decodeControlJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingMissionControl));
const decodeHarnessJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingHarnessBinding));
const decodeStrategyJson = Schema.decodeUnknownSync(Schema.fromJsonString(MomentumStrategyState));
const decodeMarketWatchJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PersistedWatch.fields.watch),
);
const decodeStatus = Schema.decodeUnknownSync(TradingMissionStatus);
const decodeBlockedReason = Schema.decodeUnknownSync(TradingMissionBlockedReason);
const decodeWatchStatus = Schema.decodeUnknownSync(PersistedWatch.fields.status);

interface ProjectionRow {
  readonly mission_id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly trading_account_id: string;
  readonly instruction: string;
  readonly market: string;
  readonly strategy_family: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  readonly authority_json: string;
  readonly authority_version: number;
  readonly strategy_json: string | null;
  readonly strategy_version: number;
  readonly watches_json: string;
  readonly control_json: string;
  readonly harness_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const toMission = (row: ProjectionRow): OrchestrationTradingMission =>
  ({
    id: row.mission_id,
    threadId: row.thread_id,
    userId: row.user_id,
    tradingAccountId: row.trading_account_id,
    instruction: row.instruction,
    market: row.market,
    strategyFamily: row.strategy_family,
    status: decodeStatus(row.status),
    blockedReason: row.blocked_reason === null ? null : decodeBlockedReason(row.blocked_reason),
    authority: decodeAuthorityJson(row.authority_json),
    authorityVersion: row.authority_version,
    strategy: row.strategy_json === null ? null : decodeStrategyJson(row.strategy_json),
    strategyVersion: row.strategy_version,
    watches: decodeWatchesJson(row.watches_json),
    control: decodeControlJson(row.control_json),
    harness: decodeHarnessJson(row.harness_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as OrchestrationTradingMission;

const makeTradingMissionProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingMissionProjection.${operation}`);

  const refresh: TradingMissionProjectionShape["refresh"] = (input) =>
    Effect.gen(function* () {
      const missions = yield* sql<{
        readonly mission_id: string;
        readonly user_id: string;
        readonly trading_account_id: string;
        readonly instruction: string;
        readonly market: string;
        readonly strategy_family: string;
        readonly harness_json: string;
        readonly status: string;
        readonly blocked_reason: string | null;
        readonly control_json: string;
        readonly authority_version: number;
        readonly strategy_version: number;
        readonly created_at: number;
        readonly updated_at: number;
      }>`
        SELECT * FROM trading_missions WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("refresh:mission")));

      const mission = missions[0];
      if (mission === undefined) {
        yield* sql`
          DELETE FROM projection_trading_missions WHERE mission_id = ${input.missionId}
        `.pipe(Effect.mapError(sqlFail("refresh:delete")));
        return;
      }

      const authorities = yield* sql<{ readonly authority_json: string }>`
        SELECT authority_json FROM trading_authority_versions
        WHERE mission_id = ${input.missionId} AND version = ${mission.authority_version}
      `.pipe(Effect.mapError(sqlFail("refresh:authority")));

      const strategies = yield* sql<{ readonly strategy_json: string }>`
        SELECT strategy_json FROM momentum_strategy_versions
        WHERE mission_id = ${input.missionId} AND version = ${mission.strategy_version}
      `.pipe(Effect.mapError(sqlFail("refresh:strategy")));

      const watchRows = yield* sql<{
        readonly watch_id: string;
        readonly mission_id: string;
        readonly strategy_version: number;
        readonly watch_json: string;
        readonly status: string;
        readonly created_at: number;
        readonly updated_at: number;
      }>`
        SELECT watch_id, mission_id, strategy_version, watch_json, status, created_at, updated_at
        FROM trading_watches
        WHERE mission_id = ${input.missionId}
        ORDER BY created_at DESC, watch_id DESC
      `.pipe(Effect.mapError(sqlFail("refresh:watches")));

      const authorityJson = authorities[0]?.authority_json;
      if (authorityJson === undefined) {
        // A mission always points at a published authority version; if it does
        // not, the projection is better empty than wrong.
        yield* Effect.logWarning("trading mission has no authority version to project", {
          missionId: input.missionId,
          authorityVersion: mission.authority_version,
        });
        return;
      }

      const watches = watchRows.map((row) => ({
        id: row.watch_id,
        missionId: row.mission_id,
        strategyVersion: row.strategy_version,
        watch: decodeMarketWatchJson(row.watch_json),
        status: decodeWatchStatus(row.status),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      yield* sql`
        INSERT INTO projection_trading_missions (
          mission_id, thread_id, user_id, trading_account_id, instruction, market,
          strategy_family, status, blocked_reason, authority_json, authority_version,
          strategy_json, strategy_version, watches_json, control_json, harness_json,
          created_at, updated_at
        ) VALUES (
          ${mission.mission_id},
          ${decodeHarnessJson(mission.harness_json).threadId},
          ${mission.user_id},
          ${mission.trading_account_id},
          ${mission.instruction},
          ${mission.market},
          ${mission.strategy_family},
          ${mission.status},
          ${mission.blocked_reason},
          ${authorityJson},
          ${mission.authority_version},
          ${strategies[0]?.strategy_json ?? null},
          ${mission.strategy_version},
          ${encodeWatchesJson(watches)},
          ${mission.control_json},
          ${mission.harness_json},
          ${toIso(mission.created_at)},
          ${toIso(mission.updated_at)}
        )
        ON CONFLICT (mission_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          status = excluded.status,
          blocked_reason = excluded.blocked_reason,
          authority_json = excluded.authority_json,
          authority_version = excluded.authority_version,
          strategy_json = excluded.strategy_json,
          strategy_version = excluded.strategy_version,
          watches_json = excluded.watches_json,
          control_json = excluded.control_json,
          harness_json = excluded.harness_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(sqlFail("refresh:upsert")));
    });

  const getByThreadId: TradingMissionProjectionShape["getByThreadId"] = (threadId) =>
    sql<ProjectionRow>`
      SELECT * FROM projection_trading_missions WHERE thread_id = ${threadId}
    `.pipe(
      Effect.mapError(sqlFail("getByThreadId")),
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(toMission(row));
      }),
    );

  const list: TradingMissionProjectionShape["list"] = () =>
    sql<ProjectionRow>`
      SELECT * FROM projection_trading_missions ORDER BY created_at DESC, mission_id DESC
    `.pipe(
      Effect.mapError(sqlFail("list")),
      Effect.map((rows) => rows.map(toMission)),
    );

  return { refresh, getByThreadId, list } satisfies TradingMissionProjectionShape;
});

export const TradingMissionProjectionLive = Layer.effect(
  TradingMissionProjection,
  makeTradingMissionProjection,
);
