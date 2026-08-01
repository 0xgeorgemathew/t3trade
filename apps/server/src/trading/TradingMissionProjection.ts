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

import { ThreadId, TradingMissionId } from "@t3tools/contracts";
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

/** Row shape for the most recent non-terminal execution record. */
interface ExecutionRecordRow {
  readonly execution_id: string;
  readonly cloid: string;
  readonly action_type: string;
  readonly side: string;
  readonly market: string;
  readonly size: number;
  readonly limit_price: number;
  readonly time_in_force: string;
  readonly reduce_only: number;
  readonly status: string;
  readonly updated_at: number;
}

/** Row shape for a fill in the receipt list. */
interface FillRow {
  readonly cloid: string | null;
  readonly order_id: number;
  readonly market: string;
  readonly side: string;
  readonly filled_size: number;
  readonly avg_fill_price: number;
  readonly fee_usd: number;
  readonly traded_at: number;
}

/** Row shape for the latest position snapshot. */
interface PositionSnapshotRow {
  readonly market: string;
  readonly size: number;
  readonly entry_price: number | null;
  readonly unrealised_pnl: number;
  readonly margin_used: number;
  readonly protected_size: number;
  readonly liquidation_price: number | null;
  readonly mark_px: number | null;
  readonly observed_at: number;
}

/** The PROMPT-04 execution surfaces for one mission, read from the 037 tables. */
interface ExecutionSurfaces {
  /** The most recent non-terminal execution record, or null. */
  readonly inFlightExecution: ExecutionRecordRow | null;
  /** Recent fills, newest first (caller limits the count). */
  readonly recentFills: ReadonlyArray<FillRow>;
  /** The latest position snapshot, or null when flat/absent. */
  readonly position: PositionSnapshotRow | null;
}

const EMPTY_SURFACES: ExecutionSurfaces = {
  inFlightExecution: null,
  recentFills: [],
  position: null,
};

const toMission = (row: ProjectionRow, exec: ExecutionSurfaces): OrchestrationTradingMission =>
  ({
    id: TradingMissionId.make(row.mission_id),
    threadId: ThreadId.make(row.thread_id),
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
    // PROMPT-04 execution surfaces, joined from the migration-037 tables. The
    // cards render only when these are non-null/non-empty.
    inFlightExecution:
      exec.inFlightExecution === null
        ? null
        : {
            executionId: exec.inFlightExecution.execution_id,
            cloid: exec.inFlightExecution.cloid,
            actionType: exec.inFlightExecution.action_type,
            side: exec.inFlightExecution.side as "buy" | "sell",
            market: exec.inFlightExecution.market,
            size: exec.inFlightExecution.size,
            limitPrice: exec.inFlightExecution.limit_price,
            timeInForce: exec.inFlightExecution.time_in_force as "ioc" | "gtc",
            reduceOnly: exec.inFlightExecution.reduce_only !== 0,
            status: exec.inFlightExecution.status,
            updatedAt: toIso(exec.inFlightExecution.updated_at),
          },
    recentFills: exec.recentFills.map((f) => ({
      cloid: f.cloid ?? undefined,
      orderId: f.order_id,
      market: f.market,
      side: f.side as "buy" | "sell",
      filledSize: f.filled_size,
      avgFillPrice: f.avg_fill_price,
      feeUsd: f.fee_usd,
      tradedAt: toIso(f.traded_at),
    })),
    position:
      exec.position === null
        ? null
        : {
            market: exec.position.market,
            size: exec.position.size,
            entryPrice: exec.position.entry_price ?? undefined,
            unrealisedPnl: exec.position.unrealised_pnl,
            marginUsed: exec.position.margin_used,
            protectedSize: exec.position.protected_size,
            liquidationPrice: exec.position.liquidation_price ?? undefined,
            markPrice: exec.position.mark_px ?? undefined,
            observedAt: toIso(exec.position.observed_at),
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) satisfies OrchestrationTradingMission;

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

  /**
   * Read the three PROMPT-04 execution surfaces for one mission from the
   * migration-037 tables. The 036 projection row carries mission state only;
   * these joins populate the order-intent / fill / position cards. A mission
   * with no execution history decodes to empty surfaces.
   */
  const readExecutionSurfaces = (
    missionId: string,
  ): Effect.Effect<ExecutionSurfaces, PersistenceSqlError> =>
    Effect.gen(function* () {
      // The most recent non-terminal execution record (reserved/submitted/accepted).
      // Rejected records are terminal and not shown as in-flight.
      const execRows = yield* sql<ExecutionRecordRow>`
        SELECT execution_id, cloid, action_type, side, market, size, limit_price,
               time_in_force, reduce_only, status, updated_at
        FROM trading_execution_records
        WHERE mission_id = ${missionId} AND status IN ('reserved', 'submitted', 'accepted')
        ORDER BY updated_at DESC LIMIT 1
      `.pipe(Effect.mapError(sqlFail("execution")));
      const inFlightExecution = execRows[0] ?? null;

      // Recent fills, newest first. Capped at 3 to match the receipt list the
      // thread card renders — the projection and the UI agree on the same count
      // rather than the UI silently truncating a larger list.
      const recentFills = yield* sql<FillRow>`
        SELECT cloid, order_id, market, side, filled_size, avg_fill_price, fee_usd, traded_at
        FROM trading_fills WHERE mission_id = ${missionId}
        ORDER BY traded_at DESC LIMIT 3
      `.pipe(Effect.mapError(sqlFail("fills")));

      // The latest position snapshot. Null when the mission has never had one.
      const positionRows = yield* sql<PositionSnapshotRow>`
        SELECT market, size, entry_price, unrealised_pnl, margin_used, protected_size,
               liquidation_price, mark_px, observed_at
        FROM trading_position_snapshots WHERE mission_id = ${missionId}
        ORDER BY observed_at DESC LIMIT 1
      `.pipe(Effect.mapError(sqlFail("position")));
      const position = positionRows[0] ?? null;

      return { inFlightExecution, recentFills, position } satisfies ExecutionSurfaces;
    });

  const getByThreadId: TradingMissionProjectionShape["getByThreadId"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<ProjectionRow>`
        SELECT * FROM projection_trading_missions WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(sqlFail("getByThreadId")));
      const row = rows[0];
      if (row === undefined) return Option.none();
      const exec = yield* readExecutionSurfaces(row.mission_id);
      return Option.some(toMission(row, exec));
    });

  const list: TradingMissionProjectionShape["list"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<ProjectionRow>`
        SELECT * FROM projection_trading_missions ORDER BY created_at DESC, mission_id DESC
      `.pipe(Effect.mapError(sqlFail("list")));
      const missions = yield* Effect.all(
        rows.map((row) =>
          Effect.map(readExecutionSurfaces(row.mission_id), (exec) => toMission(row, exec)),
        ),
        { concurrency: "unbounded" },
      );
      return missions;
    });

  return { refresh, getByThreadId, list } satisfies TradingMissionProjectionShape;
});

export const TradingMissionProjectionLive = Layer.effect(
  TradingMissionProjection,
  makeTradingMissionProjection,
);
