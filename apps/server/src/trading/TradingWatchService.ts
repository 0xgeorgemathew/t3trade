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
import { WatchArmedReason } from "@t3tools/trading-contracts/watch";
import {
  MarketWatch,
  PersistedWatch,
  PersistedWatchStatus,
  TradingMissionStatus,
} from "./Schemas.ts";

const decodeWatch = Schema.decodeUnknownSync(Schema.fromJsonString(MarketWatch));
const encodeWatch = Schema.encodeUnknownSync(Schema.fromJsonString(MarketWatch));
const decodeWatchStatus = Schema.decodeUnknownSync(PersistedWatchStatus);
const decodeArmedReason = Schema.decodeUnknownSync(WatchArmedReason);
const decodeMissionStatus = Schema.decodeUnknownSync(TradingMissionStatus);

export interface RegisterWatchInput {
  readonly missionId: string;
  readonly watch: MarketWatch;
  /**
   * Set when the runtime — not the harness — armed this watch, so the wake it
   * eventually produces can say why it happened.
   */
  readonly armedReason?: WatchArmedReason;
  /**
   * An active watch to cancel in the same transaction as this one is created.
   *
   * Re-levelling used to be two calls, and between them the mission had no
   * level armed on that side at all. On a 2-second evaluator sweep that gap is
   * usually harmless and occasionally the exact window a move happens in — and
   * a failure between the two leaves the mission uncovered indefinitely, with
   * nothing to say it happened.
   */
  readonly replacesWatchId?: string | undefined;
}

/** What a register call did: the new watch, and the one it replaced. */
export interface RegisteredWatch {
  readonly watch: PersistedWatch;
  /**
   * The watch `replacesWatchId` cancelled. Absent when none was named, or when
   * the one named was already terminal — which the caller has to be told
   * about, since it means the level it meant to retire either fired or was
   * never there, and the replacement is an addition rather than a swap.
   */
  readonly replaced?: PersistedWatch;
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
   *
   * With `replacesWatchId`, the cancel and the insert are one transaction, so
   * the mission is never momentarily uncovered on the side being re-levelled.
   */
  readonly registerWatch: (
    input: RegisterWatchInput,
  ) => Effect.Effect<RegisteredWatch, PersistenceSqlError | TradingMissionNotFoundError>;

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

  /**
   * Read a watch by id, regardless of status. The wake path resolves the
   * triggering watch through this so the resumed snapshot carries the watch
   * that fired (including its `triggered` status after `markTriggered`).
   *
   * Returns `null` when the watch does not exist.
   */
  readonly getWatch: (watchId: string) => Effect.Effect<PersistedWatch | null, PersistenceSqlError>;
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
  readonly armed_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  /**
   * Optional so a `WatchRow` that predates migration 049 (or a caller that
   * does not select these columns) still satisfies this type — `toPersistedWatch`
   * omits the corresponding struct fields when they are absent or null.
   */
  readonly last_observed_value?: number | null;
  readonly last_evaluated_at?: number | null;
}

export const toPersistedWatch = (row: WatchRow): PersistedWatch => ({
  id: row.watch_id,
  missionId: row.mission_id,
  strategyVersion: row.strategy_version,
  watch: decodeWatch(row.watch_json),
  status: decodeWatchStatus(row.status),
  ...(row.armed_reason === null ? {} : { armedReason: decodeArmedReason(row.armed_reason) }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.last_observed_value == null || row.last_evaluated_at == null
    ? {}
    : {
        lastObservedValue: row.last_observed_value,
        lastEvaluatedAt: row.last_evaluated_at,
      }),
});

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingWatchService.${operation}`);

const makeTradingWatchService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  /** The mission's row when it exists and is active; a typed error otherwise. */
  const requireActiveMission = Effect.fn("TradingWatchService.requireActiveMission")(function* (
    missionId: string,
  ) {
    const rows = yield* sql<{ readonly status: string; readonly strategy_version: number }>`
      SELECT status, strategy_version FROM trading_missions WHERE mission_id = ${missionId}
    `.pipe(Effect.mapError(sqlFail("requireActiveMission")));

    const row = rows[0];
    if (row === undefined || !isActiveMissionStatus(decodeMissionStatus(row.status))) {
      return yield* new TradingMissionNotFoundError({ missionId });
    }
    return row;
  });

  /** Cancel one active watch, returning it, or `null` if it was not active. */
  const cancelActive = (missionId: string, watchId: string, now: number) =>
    sql<WatchRow>`
      UPDATE trading_watches
      SET status = 'cancelled', version = version + 1, updated_at = ${now}
      WHERE watch_id = ${watchId} AND mission_id = ${missionId} AND status = 'active'
      RETURNING watch_id, mission_id, strategy_version, watch_json, status, armed_reason,
                created_at, updated_at, last_observed_value, last_evaluated_at
    `.pipe(Effect.map((rows) => (rows[0] ? toPersistedWatch(rows[0]) : null)));

  const registerWatch: TradingWatchServiceShape["registerWatch"] = (input) =>
    Effect.gen(function* () {
      const mission = yield* requireActiveMission(input.missionId);
      const strategyVersion = mission.strategy_version;

      const now = yield* Clock.currentTimeMillis;
      const watchId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const watchJson = encodeWatch(input.watch);

      // One transaction, so a re-level never leaves the side it is re-levelling
      // momentarily unwatched — and a failure half-way leaves the OLD watch
      // standing rather than nothing at all.
      const replaced = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const cancelled =
              input.replacesWatchId === undefined
                ? null
                : yield* cancelActive(input.missionId, input.replacesWatchId, now);

            yield* sql`
              INSERT INTO trading_watches
                (watch_id, mission_id, strategy_version, watch_json, status, armed_reason, version,
                 created_at, updated_at)
              VALUES
                (${watchId}, ${input.missionId}, ${strategyVersion}, ${watchJson}, 'active',
                 ${input.armedReason ?? null}, 1, ${now}, ${now})
            `;
            return cancelled;
          }),
        )
        .pipe(Effect.mapError(sqlFail("register:replace")));

      return {
        watch: {
          id: watchId,
          missionId: input.missionId,
          strategyVersion,
          watch: input.watch,
          status: "active",
          ...(input.armedReason === undefined ? {} : { armedReason: input.armedReason }),
          createdAt: now,
          updatedAt: now,
        },
        ...(replaced === null ? {} : { replaced }),
      } satisfies RegisteredWatch;
    });

  const cancelWatch: TradingWatchServiceShape["cancelWatch"] = (input) =>
    Effect.gen(function* () {
      yield* requireActiveMission(input.missionId);

      const now = yield* Clock.currentTimeMillis;
      // Only an active watch can be cancelled; a terminal watch keeps its status.
      const rows = yield* sql<WatchRow>`
        UPDATE trading_watches
        SET status = 'cancelled', version = version + 1, updated_at = ${now}
        WHERE watch_id = ${input.watchId}
          AND mission_id = ${input.missionId}
          AND status = 'active'
        RETURNING watch_id, mission_id, strategy_version, watch_json, status, armed_reason,
                created_at, updated_at, last_observed_value, last_evaluated_at
      `.pipe(Effect.mapError(sqlFail("cancel:update")));

      return rows[0] ? toPersistedWatch(rows[0]) : null;
    });

  const markTriggered: TradingWatchServiceShape["markTriggered"] = (watchId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Only an active watch flips to triggered; a concurrent supersede or cancel
      // wins and this returns null so the evaluator does not re-fire it.
      const rows = yield* sql<WatchRow>`
        UPDATE trading_watches
        SET status = 'triggered', version = version + 1, updated_at = ${now}
        WHERE watch_id = ${watchId} AND status = 'active'
        RETURNING watch_id, mission_id, strategy_version, watch_json, status, armed_reason,
                  created_at, updated_at, last_observed_value, last_evaluated_at
      `.pipe(Effect.mapError(sqlFail("markTriggered:update")));

      return rows[0] ? toPersistedWatch(rows[0]) : null;
    });

  const getWatch: TradingWatchServiceShape["getWatch"] = (watchId) =>
    Effect.gen(function* () {
      const rows = yield* sql<WatchRow>`
        SELECT watch_id, mission_id, strategy_version, watch_json, status, armed_reason,
               created_at, updated_at, last_observed_value, last_evaluated_at
        FROM trading_watches WHERE watch_id = ${watchId}
      `.pipe(Effect.mapError(sqlFail("getWatch")));
      return rows[0] ? toPersistedWatch(rows[0]) : null;
    });

  return { registerWatch, cancelWatch, markTriggered, getWatch } satisfies TradingWatchServiceShape;
});

export const TradingWatchServiceLive = Layer.effect(TradingWatchService, makeTradingWatchService);
