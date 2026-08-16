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
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadId, TradingMissionId } from "@t3tools/contracts";
import type { OrchestrationTradingMission, TradingMissionTimelineEntry } from "@t3tools/contracts";
import type { TradingOrderTimeInForce } from "@t3tools/trading-contracts/execution";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  TradingPlanState,
  PersistedWatch,
  TradingAuthority,
  TradingHarnessBinding,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  WatchArmedReason,
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
const decodeStrategyJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingPlanState));
const decodeMarketWatchJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PersistedWatch.fields.watch),
);
const decodeStatus = Schema.decodeUnknownSync(TradingMissionStatus);
const decodeBlockedReason = Schema.decodeUnknownSync(TradingMissionBlockedReason);
const decodeWatchStatus = Schema.decodeUnknownSync(PersistedWatch.fields.status);
const decodeArmedReason = Schema.decodeUnknownSync(WatchArmedReason);

/**
 * Decode one mission's persisted strategy, degrading to "no strategy" when the
 * stored JSON no longer satisfies `TradingPlanState`.
 *
 * A strategy published before a field became required (`protection.targetProfitUsd`
 * is the first such field) used to throw a defect straight out of `list()`, which
 * took the whole trading mission snapshot down for every mission and left the
 * workspace polling a permanently failing RPC. One unreadable historical row
 * should cost that one mission's strategy card, nothing more.
 *
 * The warning is logged once per row rather than once per read: the workspace
 * polls this projection, so a handful of legacy missions otherwise reprint the
 * same schema error every few seconds for as long as the server is up.
 */
const loggedUndecodableStrategies = new Set<string>();

/** A persisted strategy row that no longer decodes against the current schema. */
class UndecodableStrategyError extends Data.TaggedError("UndecodableStrategyError")<{
  readonly cause: unknown;
}> {}

const readStrategy = (row: {
  readonly mission_id: string;
  readonly strategy_json: string | null;
}): Effect.Effect<TradingPlanState | null> => {
  const strategyJson = row.strategy_json;
  if (strategyJson === null) {
    return Effect.succeed(null);
  }
  return Effect.try({
    try: () => decodeStrategyJson(strategyJson),
    catch: (cause) => new UndecodableStrategyError({ cause }),
  }).pipe(
    Effect.catch(({ cause }) => {
      if (loggedUndecodableStrategies.has(row.mission_id)) {
        return Effect.succeed(null);
      }
      loggedUndecodableStrategies.add(row.mission_id);
      return Effect.logWarning("trading mission projection could not decode a persisted strategy", {
        missionId: row.mission_id,
        cause,
      }).pipe(Effect.as(null));
    }),
  );
};

interface ProjectionRow {
  readonly mission_id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly trading_account_id: string;
  readonly instruction: string;
  readonly market: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  readonly authority_json: string;
  readonly authority_version: number;
  readonly strategy_json: string | null;
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

/**
 * Row shape for a receipt in the fill list — one order, not one fill event.
 *
 * Hyperliquid reports a market order as however many partial fills it took to
 * cross the book: a 3 ETH entry comes back as a dozen slices of a few hundredths
 * each. Rendering those raw put "Sell 0.044 ETH" on the receipt for an order
 * that sold three, with a fee and a realised PnL to match — every figure on the
 * card a fraction of what the trade actually did, and a cap of three receipts
 * hiding the rest. The aggregate below is the order the operator placed, which
 * is also the row the exchange's own trade history shows.
 */
interface FillRow {
  readonly cloid: string | null;
  readonly order_id: number;
  readonly market: string;
  readonly side: string;
  readonly filled_size: number;
  readonly avg_fill_price: number;
  readonly fee_usd: number;
  readonly closed_pnl: number;
  readonly direction: string | null;
  readonly traded_at: number;
}

/**
 * The mission's realised result, aggregated across every fill.
 *
 * Separate from `recentFills` because that list is capped at all: a completion
 * summary built from a capped list would understate any mission that traded
 * more times than the cap. It is also grouped by order there, so its row count
 * is orders, not fills.
 */
interface MissionResultRow {
  readonly realized_pnl: number | null;
  readonly fees_paid: number | null;
  readonly fill_count: number;
  readonly first_fill_at: number | null;
  readonly last_fill_at: number | null;
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
  readonly leverage: number | null;
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
  /** Realised result across every fill. */
  readonly result: MissionResultRow;
}

/**
 * How many history entries the mission view carries — plan 24 §4.2.
 *
 * The three sources grow for as long as the mission lives and this rides a 3s
 * poll, so the cap is the payload guard. Fifty is a few hours of a busy 1m
 * mission: enough that the chart's past axis and the thread's wake rows are
 * never short, far below anything that would matter on the wire.
 */
export const MISSION_TIMELINE_LIMIT = 50;

/** A harness run, as the timeline reads it. */
interface HarnessRunRow {
  readonly run_id: string;
  readonly cause: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly created_at: number;
}

/** A confirmed stop move (migration 050). */
interface StopAdjustmentRow {
  readonly new_stop_price: number;
  readonly justification: string;
  readonly adjusted_at: number;
}

/** One journal note (migration 066; `author` since 067). */
interface JournalNoteRow {
  readonly note: string;
  readonly created_at: number;
  readonly author?: string;
}

/** A strategy publish. */
interface StrategyVersionRow {
  readonly version: number;
  readonly created_at: number;
}

/**
 * Merge the history sources into one bounded, newest-first list.
 *
 * Pure, and separate from the queries, because the merge is where the rules
 * actually live: which moment each row is filed under, what it reads as, and
 * which entries survive the cap. Each source is queried with its own limit, so
 * a mission that woke two hundred times cannot crowd its four stop steps out of
 * the array before the sort has run.
 */
export function buildMissionTimeline(input: {
  readonly wakes: ReadonlyArray<HarnessRunRow>;
  readonly stopAdjustments: ReadonlyArray<StopAdjustmentRow>;
  readonly publishes: ReadonlyArray<StrategyVersionRow>;
  readonly journal?: ReadonlyArray<JournalNoteRow>;
}): ReadonlyArray<TradingMissionTimelineEntry> {
  const entries: Array<TradingMissionTimelineEntry & { readonly atMillis: number }> = [];

  for (const wake of input.wakes) {
    // A queued run that never started is filed under when it was created: the
    // question the axis answers is when the mission was woken, not when a
    // provider got round to it.
    const atMillis = wake.started_at ?? wake.created_at;
    entries.push({
      atMillis,
      at: toIso(atMillis),
      kind: "wake",
      // A failed run is the one wake worth reading twice — it is a turn the
      // mission was owed and did not get.
      label: wake.status === "failed" ? `${wake.cause} (failed)` : wake.cause,
      cause: wake.cause,
    });
  }

  for (const adjustment of input.stopAdjustments) {
    entries.push({
      atMillis: adjustment.adjusted_at,
      at: toIso(adjustment.adjusted_at),
      kind: "stop_adjusted",
      label: adjustment.justification,
      priceLevel: adjustment.new_stop_price,
    });
  }

  // The model's own words, on the same axis as what it did with them — the
  // note is already prose, so it is the label verbatim (plan 29 step 6.4).
  for (const note of input.journal ?? []) {
    entries.push({
      atMillis: note.created_at,
      at: toIso(note.created_at),
      kind: "journal",
      label: note.note,
      // Narrowed rather than passed through: the column is NOT NULL DEFAULT
      // 'model', so anything else is a row nothing in this codebase wrote.
      author: note.author === "user" ? "user" : "model",
    });
  }

  for (const publish of input.publishes) {
    entries.push({
      atMillis: publish.created_at,
      at: toIso(publish.created_at),
      kind: "strategy_published",
      label: `v${publish.version}`,
    });
  }

  return entries
    .sort((a, b) => b.atMillis - a.atMillis)
    .slice(0, MISSION_TIMELINE_LIMIT)
    .map(({ atMillis: _atMillis, ...entry }) => entry);
}

const EMPTY_RESULT: MissionResultRow = {
  realized_pnl: 0,
  fees_paid: 0,
  fill_count: 0,
  first_fill_at: null,
  last_fill_at: null,
};

const EMPTY_SURFACES: ExecutionSurfaces = {
  inFlightExecution: null,
  recentFills: [],
  position: null,
  result: EMPTY_RESULT,
};

const toMission = (
  row: ProjectionRow,
  exec: ExecutionSurfaces,
  strategy: TradingPlanState | null,
  missionTimeline: ReadonlyArray<TradingMissionTimelineEntry>,
): OrchestrationTradingMission =>
  ({
    id: TradingMissionId.make(row.mission_id),
    threadId: ThreadId.make(row.thread_id),
    userId: row.user_id,
    tradingAccountId: row.trading_account_id,
    instruction: row.instruction,
    market: row.market,
    status: decodeStatus(row.status),
    blockedReason: row.blocked_reason === null ? null : decodeBlockedReason(row.blocked_reason),
    authority: decodeAuthorityJson(row.authority_json),
    authorityVersion: row.authority_version,
    strategy,
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
            timeInForce: exec.inFlightExecution.time_in_force as TradingOrderTimeInForce,
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
      closedPnl: f.closed_pnl,
      direction: f.direction ?? undefined,
      tradedAt: toIso(f.traded_at),
    })),
    result: {
      realizedPnlUsd: exec.result.realized_pnl ?? 0,
      feesPaidUsd: exec.result.fees_paid ?? 0,
      fillCount: exec.result.fill_count,
      firstFillAt: exec.result.first_fill_at === null ? null : toIso(exec.result.first_fill_at),
      lastFillAt: exec.result.last_fill_at === null ? null : toIso(exec.result.last_fill_at),
    },
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
    // The market's configured leverage, read off the position snapshot because
    // that is where the exchange reports it. Mission-level rather than
    // position-level: it outlives the position, and the mission's receipts are
    // read after it has closed.
    leverage: exec.position?.leverage ?? undefined,
    missionTimeline,
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
        readonly harness_json: string;
        readonly status: string;
        readonly blocked_reason: string | null;
        readonly control_json: string;
        readonly authority_version: number;
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
        SELECT strategy_json FROM trading_plan_history
        WHERE mission_id = ${input.missionId}
        ORDER BY version DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("refresh:strategy")));

      const watchRows = yield* sql<{
        readonly watch_id: string;
        readonly mission_id: string;
        readonly watch_json: string;
        readonly status: string;
        readonly armed_reason: string | null;
        readonly created_at: number;
        readonly updated_at: number;
        readonly last_observed_value: number | null;
        readonly last_evaluated_at: number | null;
      }>`
        SELECT watch_id, mission_id, watch_json, status, armed_reason,
               created_at, updated_at, last_observed_value, last_evaluated_at
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
        watch: decodeMarketWatchJson(row.watch_json),
        status: decodeWatchStatus(row.status),
        // The web's provenance chips ("auto", "target", "stop") read this; a
        // mapping that drops it renders every watch as harness-armed.
        ...(row.armed_reason === null ? {} : { armedReason: decodeArmedReason(row.armed_reason) }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Guarded on BOTH columns: `lastEvaluatedAt` is typed non-null when
        // present, so a half-written pair must encode as absent, not as null.
        ...(row.last_observed_value === null || row.last_evaluated_at === null
          ? {}
          : {
              lastObservedValue: row.last_observed_value,
              lastEvaluatedAt: row.last_evaluated_at,
            }),
      }));

      yield* sql`
        INSERT INTO projection_trading_missions (
          mission_id, thread_id, user_id, trading_account_id, instruction, market,
          status, blocked_reason, authority_json, authority_version,
          strategy_json, watches_json, control_json, harness_json,
          created_at, updated_at
        ) VALUES (
          ${mission.mission_id},
          ${decodeHarnessJson(mission.harness_json).threadId},
          ${mission.user_id},
          ${mission.trading_account_id},
          ${mission.instruction},
          ${mission.market},
          ${mission.status},
          ${mission.blocked_reason},
          ${authorityJson},
          ${mission.authority_version},
          ${strategies[0]?.strategy_json ?? null},
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

      // The mission's orders, newest first — each one the sum of its own partial
      // fills. The average price is size-weighted, because the plain mean of a
      // dozen slices is not the price the order got.
      //
      // The cap was 3, to match a receipt list the thread rendered as three
      // cards. The receipts are single rows now and the thread shows all of
      // them, because a session that opened and closed twice before the trade
      // on screen has to be readable — and the chart plots the same fills as
      // markers, so a truncated list would silently truncate the chart too. The
      // limit that remains is a payload guard on a 3s poll, not a display
      // choice: it is far above any real mission's order count.
      const recentFills = yield* sql<FillRow>`
        SELECT
          MIN(cloid) AS cloid,
          order_id,
          market,
          side,
          SUM(filled_size) AS filled_size,
          SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_fill_price,
          SUM(fee_usd) AS fee_usd,
          SUM(closed_pnl) AS closed_pnl,
          MIN(direction) AS direction,
          MAX(traded_at) AS traded_at
        FROM trading_fills WHERE mission_id = ${missionId}
        GROUP BY order_id, market, side
        ORDER BY MAX(traded_at) DESC LIMIT 50
      `.pipe(Effect.mapError(sqlFail("fills")));

      // The realised result across EVERY fill, for the completion summary.
      const resultRows = yield* sql<MissionResultRow>`
        SELECT
          SUM(closed_pnl) AS realized_pnl,
          SUM(fee_usd) AS fees_paid,
          COUNT(*) AS fill_count,
          MIN(traded_at) AS first_fill_at,
          MAX(traded_at) AS last_fill_at
        FROM trading_fills WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("fills")));
      const result = resultRows[0] ?? EMPTY_RESULT;

      // The latest position snapshot. Null when the mission has never had one.
      const positionRows = yield* sql<PositionSnapshotRow>`
        SELECT market, size, entry_price, unrealised_pnl, margin_used, protected_size,
               liquidation_price, mark_px, leverage, observed_at
        FROM trading_position_snapshots WHERE mission_id = ${missionId}
        ORDER BY observed_at DESC LIMIT 1
      `.pipe(Effect.mapError(sqlFail("position")));
      const position = positionRows[0] ?? null;

      return { inFlightExecution, recentFills, position, result } satisfies ExecutionSurfaces;
    });

  /**
   * The mission's history, joined at read time from the three tables that keep
   * it — the same shape as `readExecutionSurfaces`, and for the same reason:
   * the projection row is current state, and rebuilding it must never depend on
   * history having been copied into it.
   */
  const readMissionTimeline = (
    missionId: string,
  ): Effect.Effect<ReadonlyArray<TradingMissionTimelineEntry>, PersistenceSqlError> =>
    Effect.gen(function* () {
      const wakes = yield* sql<HarnessRunRow>`
        SELECT run_id, cause, status, started_at, created_at
        FROM trading_harness_runs WHERE mission_id = ${missionId}
        ORDER BY created_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:wakes")));

      const stopAdjustments = yield* sql<StopAdjustmentRow>`
        SELECT new_stop_price, justification, adjusted_at
        FROM trading_stop_adjustments WHERE mission_id = ${missionId}
        ORDER BY adjusted_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:stops")));

      const publishes = yield* sql<StrategyVersionRow>`
        SELECT version, created_at
        FROM trading_plan_history WHERE mission_id = ${missionId}
        ORDER BY created_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:publishes")));

      const journal = yield* sql<JournalNoteRow>`
        SELECT note, created_at, author
        FROM trading_journal WHERE mission_id = ${missionId}
        -- rowid, because two notes in one turn share a millisecond and the
        -- timeline has to draw them in the order they were written.
        ORDER BY created_at DESC, rowid DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:journal")));

      return buildMissionTimeline({ wakes, stopAdjustments, publishes, journal });
    });

  const getByThreadId: TradingMissionProjectionShape["getByThreadId"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<ProjectionRow>`
        SELECT * FROM projection_trading_missions WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(sqlFail("getByThreadId")));
      const row = rows[0];
      if (row === undefined) return Option.none();
      const exec = yield* readExecutionSurfaces(row.mission_id);
      const strategy = yield* readStrategy(row);
      const timeline = yield* readMissionTimeline(row.mission_id);
      return Option.some(toMission(row, exec, strategy, timeline));
    });

  const list: TradingMissionProjectionShape["list"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<ProjectionRow>`
        SELECT * FROM projection_trading_missions ORDER BY created_at DESC, mission_id DESC
      `.pipe(Effect.mapError(sqlFail("list")));
      const missions = yield* Effect.all(
        rows.map((row) =>
          Effect.map(
            Effect.all([
              readExecutionSurfaces(row.mission_id),
              readStrategy(row),
              readMissionTimeline(row.mission_id),
            ]),
            ([exec, strategy, timeline]) => toMission(row, exec, strategy, timeline),
          ),
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
