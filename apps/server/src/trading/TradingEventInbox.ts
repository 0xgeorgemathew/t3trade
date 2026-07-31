/**
 * TradingEventInbox - persisted mission events with deduplication, spec §18.1.
 *
 * Observed facts are persisted as inbox events keyed for deduplication, then
 * coalesced before a run consumes them. An event moves
 * `pending → included_in_run → consumed`, so a queued event is never silently
 * lost and a run always sees the coalesced set it was started with.
 *
 * Deduplication is enforced by the `idx_trading_event_inbox_dedupe` unique
 * index (migration 035): a second persist with the same
 * `(missionId, deduplicationKey)` is ignored, so reconnects and replays cannot
 * generate a second wake-up.
 *
 * @module TradingEventInbox
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { MissionInboxEventCategory, TradingDomainEventSummary, UnixMillis } from "./Schemas.ts";

const decodeCategory = Schema.decodeUnknownSync(MissionInboxEventCategory);
const encodeCategorySync = Schema.encodeSync(MissionInboxEventCategory);
/** Encode the opaque inbox payload (`unknown`) to a JSON string for storage. */
const encodePayloadJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

export interface PersistEventInput {
  readonly missionId: string;
  readonly category: MissionInboxEventCategory;
  readonly deduplicationKey: string;
  readonly payload: unknown;
  readonly occurredAt: UnixMillis;
  /** Short human-readable rendering, surfaced to the harness via the wakeup. */
  readonly summary: string;
}

export interface TradingEventInboxShape {
  /**
   * Persist an event, deduplicating on `(missionId, deduplicationKey)`.
   *
   * Returns `true` when a new row was inserted and `false` when the
   * deduplication key collapsed it, so the caller can tell a genuine first
   * observation from a replay.
   */
  readonly persist: (input: PersistEventInput) => Effect.Effect<boolean, PersistenceSqlError>;

  /**
   * The coalesced set of pending events a run for `missionId` should start
   * with, oldest first.
   *
   * Coalescing here is the dedupe above plus status filtering: only `pending`
   * events are returned, and each deduplication key appears at most once (the
   * newest pending occurrence wins, since an earlier one was either consumed
   * already or collapsed at insert).
   */
  readonly collectPending: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<TradingDomainEventSummary>, PersistenceSqlError>;

  /**
   * Mark every pending event for `missionId` as `included_in_run`.
   *
   * Called by the turn coordinator once a run has started, so the run owns the
   * coalesced set and a follow-up event lands as pending for the next run.
   */
  readonly markPendingIncludedInRun: (
    missionId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * Mark the events previously marked `included_in_run` as `consumed`.
   *
   * Called when a run completes, closing the `pending → included_in_run →
   * consumed` lifecycle so the inbox never holds stale in-flight state.
   */
  readonly markIncludedConsumed: (missionId: string) => Effect.Effect<void, PersistenceSqlError>;
}

export class TradingEventInbox extends Context.Service<TradingEventInbox, TradingEventInboxShape>()(
  "t3/trading/TradingEventInbox",
) {}

interface InboxRow {
  readonly event_id: string;
  readonly mission_id: string;
  readonly category: string;
  readonly deduplication_key: string;
  readonly payload_json: string;
  readonly status: string;
  readonly occurred_at: number;
}

const toSummary = (row: InboxRow): TradingDomainEventSummary => ({
  category: decodeCategory(row.category),
  deduplicationKey: row.deduplication_key,
  occurredAt: row.occurred_at,
  // `summary` is not re-read from the row: it was supplied at persist time and
  // is not stored separately. Re-derive a minimal label here so a run always
  // sees a non-empty summary even after a restart re-reads rows.
  summary: `${row.category}:${row.deduplication_key}`,
});

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingEventInbox.${operation}`);

const makeTradingEventInbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const persist: TradingEventInboxShape["persist"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const eventId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const payloadJson = encodePayloadJson(input.payload);
      const category = encodeCategorySync(input.category);

      // INSERT OR IGNORE: the (mission_id, deduplication_key) unique index
      // collapses replays. RETURNING yields the row only when it was actually
      // inserted — an ignored duplicate returns nothing, which is exactly the
      // "this was a replay" signal.
      const inserted = yield* sql<{ readonly event_id: string }>`
        INSERT OR IGNORE INTO trading_event_inbox
          (event_id, mission_id, category, deduplication_key, payload_json, status, occurred_at, created_at)
        VALUES
          (${eventId}, ${input.missionId}, ${category},
           ${input.deduplicationKey}, ${payloadJson}, 'pending', ${input.occurredAt}, ${now})
        RETURNING event_id
      `.pipe(Effect.mapError(sqlFail("persist")));

      return inserted.length > 0;
    });

  const collectPending: TradingEventInboxShape["collectPending"] = (missionId) =>
    sql<InboxRow>`
      SELECT event_id, mission_id, category, deduplication_key, payload_json, status, occurred_at
      FROM trading_event_inbox
      WHERE mission_id = ${missionId} AND status = 'pending'
      ORDER BY occurred_at ASC, event_id ASC
    `.pipe(
      Effect.mapError(sqlFail("collectPending")),
      Effect.map((rows) => rows.map(toSummary)),
    );

  const markPendingIncludedInRun: TradingEventInboxShape["markPendingIncludedInRun"] = (
    missionId,
  ) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE trading_event_inbox SET status = 'included_in_run'
        WHERE mission_id = ${missionId} AND status = 'pending'
      `.pipe(Effect.mapError(sqlFail("markPendingIncludedInRun")));
    });

  const markIncludedConsumed: TradingEventInboxShape["markIncludedConsumed"] = (missionId) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE trading_event_inbox SET status = 'consumed'
        WHERE mission_id = ${missionId} AND status = 'included_in_run'
      `.pipe(Effect.mapError(sqlFail("markIncludedConsumed")));
    });

  return {
    persist,
    collectPending,
    markPendingIncludedInRun,
    markIncludedConsumed,
  } satisfies TradingEventInboxShape;
});

export const TradingEventInboxLive = Layer.effect(TradingEventInbox, makeTradingEventInbox);
