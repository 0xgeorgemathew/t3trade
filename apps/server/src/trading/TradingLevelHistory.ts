/**
 * Level event history — plan 27 B1.
 *
 * A mission used to meet every price level as if for the first time: a
 * boundary that had already broken twice, or already stopped this mission
 * out, read exactly like a fresh one. These helpers are the memory. The write
 * seams (watch registration, the watch evaluator, the fill reconciler) append
 * one row per observed fact; the wakeup composer reads them back grouped into
 * levels with an ATR-scaled tolerance and bounded to the levels nearest the
 * mark.
 *
 * Plain functions over `SqlClient` rather than a service, so the seams that
 * write them — some of which are built before the service layers — can call
 * them without new layer wiring. Event ids are deterministic
 * (`mission:kind:time:level`), so a replayed reconcile or a re-delivered
 * candle records the same fact once.
 *
 * @module TradingLevelHistory
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { LevelEventKind, LevelHistoryEntry } from "@t3tools/trading-contracts/wakeup";

/** Most levels a wakeup carries. The nearest ones to the mark win. */
export const LEVEL_HISTORY_WAKEUP_LEVELS = 6;

/** Most raw events one read considers. Newest first; older history ages out. */
const LEVEL_HISTORY_READ_EVENTS = 500;

/**
 * How near two recorded levels must be to count as the same level, in ATRs.
 * Matches the structure read's touch tolerance (`TOUCH_TOLERANCE_ATR`).
 */
export const LEVEL_GROUP_TOLERANCE_ATR = 0.2;

export interface LevelEventInput {
  readonly missionId: string;
  readonly market: string;
  /** The level the event is about — the armed price, or the entry/exit price. */
  readonly level: number;
  readonly kind: LevelEventKind;
  /** The price observed when the event happened. */
  readonly price: number;
  readonly occurredAt: number;
}

/**
 * Append one level event, idempotently.
 *
 * Never fails the caller: the seams that record these are the watch evaluator
 * and the reconciler, and losing one history row is always better than
 * failing a sweep or a reconcile pass over bookkeeping.
 */
export const recordLevelEvent = (
  input: LevelEventInput,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventId = `${input.missionId}:${input.kind}:${input.occurredAt}:${input.level}`;
    yield* sql`
      INSERT OR IGNORE INTO trading_level_events
        (event_id, mission_id, market, level, kind, price, occurred_at)
      VALUES
        (${eventId}, ${input.missionId}, ${input.market}, ${input.level},
         ${input.kind}, ${input.price}, ${input.occurredAt})
    `;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("TradingLevelHistory: could not record a level event", {
        missionId: input.missionId,
        kind: input.kind,
        level: input.level,
        cause: String(cause),
      }),
    ),
  ) as Effect.Effect<void, never, SqlClient.SqlClient>;

interface LevelEventRow {
  readonly level: number;
  readonly kind: string;
  readonly occurred_at: number;
}

/**
 * Read a mission's level history, grouped and bounded for the wakeup.
 *
 * Grouping is by price adjacency: events sorted by level, split wherever the
 * gap to the previous level exceeds the tolerance. The representative level
 * is the group's mean. Entries come back nearest-to-the-mark first, capped at
 * `LEVEL_HISTORY_WAKEUP_LEVELS`.
 */
export const readLevelHistory = (input: {
  readonly missionId: string;
  readonly market: string;
  readonly markPrice: number;
  readonly toleranceUsd: number;
}): Effect.Effect<ReadonlyArray<LevelHistoryEntry>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<LevelEventRow>`
      SELECT level, kind, occurred_at FROM trading_level_events
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
      ORDER BY occurred_at DESC
      LIMIT ${LEVEL_HISTORY_READ_EVENTS}
    `;
    if (rows.length === 0) return [];

    const sorted = [...rows].sort((a, b) => a.level - b.level);
    const tolerance = Math.max(input.toleranceUsd, 1e-9);

    const groups: Array<Array<LevelEventRow>> = [];
    for (const row of sorted) {
      const current = groups[groups.length - 1];
      const previous = current?.[current.length - 1];
      if (
        current !== undefined &&
        previous !== undefined &&
        row.level - previous.level <= tolerance
      ) {
        current.push(row);
      } else {
        groups.push([row]);
      }
    }

    const entries = groups.map((group): LevelHistoryEntry => {
      const count = (kind: LevelEventKind): number =>
        group.filter((row) => row.kind === kind).length;
      const newest = group.reduce((a, b) => (a.occurred_at >= b.occurred_at ? a : b));
      const level = group.reduce((sum, row) => sum + row.level, 0) / group.length;
      return {
        level,
        armed: count("armed"),
        touched: count("touched"),
        wickRejected: count("wick_rejected"),
        closedThrough: count("closed_through"),
        entries: count("entered_at"),
        stopOuts: count("stopped_out_at"),
        lastEventKind: newest.kind as LevelEventKind,
        lastEventAt: newest.occurred_at,
      };
    });

    return entries
      .sort((a, b) => Math.abs(a.level - input.markPrice) - Math.abs(b.level - input.markPrice))
      .slice(0, LEVEL_HISTORY_WAKEUP_LEVELS);
  }).pipe(Effect.orElseSucceed(() => [])) as Effect.Effect<
    ReadonlyArray<LevelHistoryEntry>,
    never,
    SqlClient.SqlClient
  >;

/**
 * Upsert the latest market-structure read for one mission/market/interval —
 * plan 27 B2's write half. One row per interval, newest read wins.
 */
export const recordStructureRead = (input: {
  readonly missionId: string;
  readonly market: string;
  readonly interval: string;
  readonly classification: "trending" | "ranging" | "transition";
  readonly swingHigh: number | null;
  readonly swingLow: number | null;
  readonly measuredAt: number;
}): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_structure_reads
        (mission_id, market, interval, classification, swing_high, swing_low, measured_at)
      VALUES
        (${input.missionId}, ${input.market}, ${input.interval}, ${input.classification},
         ${input.swingHigh}, ${input.swingLow}, ${input.measuredAt})
      ON CONFLICT(mission_id, market, interval) DO UPDATE SET
        classification = ${input.classification},
        swing_high = ${input.swingHigh},
        swing_low = ${input.swingLow},
        measured_at = ${input.measuredAt}
    `;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("TradingLevelHistory: could not record a structure read", {
        missionId: input.missionId,
        interval: input.interval,
        cause: String(cause),
      }),
    ),
  ) as Effect.Effect<void, never, SqlClient.SqlClient>;

export interface StructureReadRow {
  readonly interval: string;
  readonly classification: "trending" | "ranging" | "transition";
  readonly swing_high: number | null;
  readonly swing_low: number | null;
  readonly measured_at: number;
}

/**
 * The last structure read for one mission/market, preferring the given
 * interval and falling back to the newest row on any interval — a read on a
 * different timeframe is older memory than none at all is not.
 */
export const readPreviousStructureRead = (input: {
  readonly missionId: string;
  readonly market: string;
  readonly preferredInterval: string;
}): Effect.Effect<StructureReadRow | null, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<StructureReadRow>`
      SELECT interval, classification, swing_high, swing_low, measured_at
      FROM trading_structure_reads
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
      ORDER BY (interval = ${input.preferredInterval}) DESC, measured_at DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }).pipe(Effect.orElseSucceed(() => null)) as Effect.Effect<
    StructureReadRow | null,
    never,
    SqlClient.SqlClient
  >;
