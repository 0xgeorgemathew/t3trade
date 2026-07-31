/**
 * TradingWatchService - persisted watch registry, spec §11.3 / §12.1.
 *
 * A watch is a simple, deterministic, typed predicate bound to the strategy
 * version that registered it. This service owns the per-watch lifecycle writes
 * the watch tools and evaluator need: register, cancel, mark triggered, and
 * consume. Supersession on strategy publish stays in `TradingStrategyService`
 * (it is part of the publish transaction); `listWatches` stays there too, since
 * the mission read model already reads watches through it.
 *
 * @module TradingWatchService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { TradingMissionNotFoundError } from "./Errors.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";
import {
  MarketWatch,
  PersistedWatch,
  PersistedWatchStatus,
  TradingMissionStatus,
} from "./Schemas.ts";

const decodeWatch = Schema.decodeUnknownSync(Schema.fromJsonString(MarketWatch));
const encodeWatch = Schema.encodeUnknownSync(Schema.fromJsonString(MarketWatch));
const decodeWatchStatus = Schema.decodeUnknownSync(PersistedWatchStatus);
const decodeMissionStatus = Schema.decodeUnknownSync(TradingMissionStatus);

export interface RegisterWatchInput {
  readonly missionId: string;
  readonly watch: MarketWatch;
}

export interface CancelWatchInput {
  readonly missionId: string;
  readonly watchId: string;
}

export interface TradingWatchServiceShape {
  /**
   * Persist a watch bound to the mission's current strategy version.
   *
   * The watch is created `active`. It is supersedable later by a strategy
   * publish (see `TradingStrategyService.publishMomentumStrategy`) or
   * cancelable by harness or user.
   */
  readonly registerWatch: (
    input: RegisterWatchInput,
  ) => Effect.Effect<PersistedWatch, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * Cancel an active watch. Only an active watch can be cancelled; triggered,
   * consumed, superseded, and expired watches keep their terminal status.
   *
   * Returns the updated watch on success, or `null` when no active watch
   * matched (not found, or already terminal) so the caller can report it.
   */
  readonly cancelWatch: (
    input: CancelWatchInput,
  ) => Effect.Effect<PersistedWatch | null, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * Flip an active watch to `triggered` — its predicate matched.
   *
   * No-op (returns `null`) if the watch is no longer active, so the evaluator
   * never re-fires a watch a concurrent publish has already superseded.
   */
  readonly markTriggered: (
    watchId: string,
  ) => Effect.Effect<PersistedWatch | null, PersistenceSqlError>;
}

export class TradingWatchService extends Context.Service<
  TradingWatchService,
  TradingWatchServiceShape
>()("t3/trading/TradingWatchService") {}

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
  watch: decodeWatch(row.watch_json),
  status: decodeWatchStatus(row.status),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingWatchService.${operation}`);

const makeTradingWatchService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const requireActiveMission = Effect.fn("TradingWatchService.requireActiveMission")(function* (
    missionId: string,
  ) {
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM trading_missions WHERE mission_id = ${missionId}
    `.pipe(Effect.mapError(sqlFail("requireActiveMission")));

    const row = rows[0];
    if (row === undefined) {
      return yield* new TradingMissionNotFoundError({ missionId });
    }
    if (!isActiveMissionStatus(decodeMissionStatus(row.status))) {
      return yield* new TradingMissionNotFoundError({ missionId });
    }
  });

  const registerWatch: TradingWatchServiceShape["registerWatch"] = (input) =>
    Effect.gen(function* () {
      yield* requireActiveMission(input.missionId);

      const rows = yield* sql<{ readonly strategy_version: number }>`
        SELECT strategy_version FROM trading_missions WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("register:readStrategyVersion")));

      const strategyVersion = rows[0]?.strategy_version;
      if (strategyVersion === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: input.missionId });
      }

      const now = yield* Clock.currentTimeMillis;
      const watchId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const watchJson = encodeWatch(input.watch);

      yield* sql`
        INSERT INTO trading_watches
          (watch_id, mission_id, strategy_version, watch_json, status, version, created_at, updated_at)
        VALUES
          (${watchId}, ${input.missionId}, ${strategyVersion}, ${watchJson}, 'active', 1, ${now}, ${now})
      `.pipe(Effect.mapError(sqlFail("register:insert")));

      return {
        id: watchId,
        missionId: input.missionId,
        strategyVersion,
        watch: input.watch,
        status: "active",
        createdAt: now,
        updatedAt: now,
      } satisfies PersistedWatch;
    });

  const cancelWatch: TradingWatchServiceShape["cancelWatch"] = (input) =>
    Effect.gen(function* () {
      yield* requireActiveMission(input.missionId);

      const now = yield* Clock.currentTimeMillis;
      // Only an active watch can be cancelled; a terminal watch keeps its status.
      const result = yield* sql<{ readonly watch_id: string }>`
        UPDATE trading_watches
        SET status = 'cancelled', version = version + 1, updated_at = ${now}
        WHERE watch_id = ${input.watchId}
          AND mission_id = ${input.missionId}
          AND status = 'active'
        RETURNING watch_id
      `.pipe(Effect.mapError(sqlFail("cancel:update")));

      if (result.length === 0) {
        return null;
      }

      const rows = yield* sql<WatchRow>`
        SELECT watch_id, mission_id, strategy_version, watch_json, status, created_at, updated_at
        FROM trading_watches WHERE watch_id = ${input.watchId}
      `.pipe(Effect.mapError(sqlFail("cancel:read")));
      return rows[0] ? toPersistedWatch(rows[0]) : null;
    });

  const markTriggered: TradingWatchServiceShape["markTriggered"] = (watchId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Only an active watch flips to triggered; a concurrent supersede or cancel
      // wins and this returns null so the evaluator does not re-fire it.
      const result = yield* sql<{ readonly mission_id: string }>`
        UPDATE trading_watches
        SET status = 'triggered', version = version + 1, updated_at = ${now}
        WHERE watch_id = ${watchId} AND status = 'active'
        RETURNING mission_id
      `.pipe(Effect.mapError(sqlFail("markTriggered:update")));

      if (result.length === 0) {
        return null;
      }

      const rows = yield* sql<WatchRow>`
        SELECT watch_id, mission_id, strategy_version, watch_json, status, created_at, updated_at
        FROM trading_watches WHERE watch_id = ${watchId}
      `.pipe(Effect.mapError(sqlFail("markTriggered:read")));
      return rows[0] ? toPersistedWatch(rows[0]) : null;
    });

  return { registerWatch, cancelWatch, markTriggered } satisfies TradingWatchServiceShape;
});

export const TradingWatchServiceLive = Layer.effect(TradingWatchService, makeTradingWatchService);
