/**
 * TradingEventInbox - persisted mission events with deduplication, spec §18.1.
 *
 * Observed facts are persisted as inbox events keyed for deduplication, then
 * claimed by the run that consumes them. An event moves
 * `pending → included_in_run → consumed`, so a queued event is never silently
 * lost and a run always sees the set it was started with.
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { MissionInboxEventCategory, TradingDomainEventSummary, UnixMillis } from "./Schemas.ts";

const decodeCategory = Schema.decodeUnknownSync(MissionInboxEventCategory);
const encodeCategorySync = Schema.encodeSync(MissionInboxEventCategory);
/** Encode the opaque inbox payload (`unknown`) to a JSON string for storage. */
const encodePayloadJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
/** The payload shape a queued operator message is stored with. */
const decodeQueuedUserMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

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
   * Atomically claim every pending event for `missionId` — flip them to
   * `included_in_run` and return them, oldest first.
   *
   * Called by the turn coordinator once a run has acquired the lease, so the
   * run owns exactly the set it was started with and a follow-up event lands
   * as pending for the next run.
   */
  readonly claimPending: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<TradingDomainEventSummary>, PersistenceSqlError>;

  /**
   * Read one event by its deduplication key, whatever lifecycle status it is
   * in. `isPending` answers "is this still queued for a run"; this answers
   * "was this ever recorded", which is what a caller reporting an outcome
   * needs — the event may already have been claimed by the run that is asking.
   */
  readonly findSummary: (
    missionId: string,
    deduplicationKey: string,
  ) => Effect.Effect<TradingDomainEventSummary | null, PersistenceSqlError>;

  /** Whether an event with `deduplicationKey` is still pending for `missionId`. */
  readonly isPending: (
    missionId: string,
    deduplicationKey: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;

  /**
   * Mark the events previously claimed (`included_in_run`) as `consumed`.
   *
   * Called when a run completes, closing the `pending → included_in_run →
   * consumed` lifecycle so the inbox never holds stale in-flight state.
   */
  readonly markIncludedConsumed: (missionId: string) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * The text of every operator message still queued for `missionId`, oldest
   * first.
   *
   * An operator message that arrives while another run holds the lease is
   * persisted here rather than delivered, and this is what the next run reads
   * to carry it. A row whose payload does not hold a string `text` is skipped:
   * the queue is a delivery mechanism, and one unreadable row must not stop the
   * rest of the operator's words from arriving.
   */
  readonly readQueuedUserMessages: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
}

export class TradingEventInbox extends Context.Service<TradingEventInbox, TradingEventInboxShape>()(
  "t3/trading/TradingEventInbox",
) {}

interface ClaimedRow {
  readonly category: string;
  readonly deduplication_key: string;
  readonly occurred_at: number;
  readonly summary: string;
}

const toSummary = (row: ClaimedRow): TradingDomainEventSummary => ({
  category: decodeCategory(row.category),
  deduplicationKey: row.deduplication_key,
  occurredAt: row.occurred_at,
  summary: row.summary,
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
          (event_id, mission_id, category, deduplication_key, payload_json, status, occurred_at, summary, created_at)
        VALUES
          (${eventId}, ${input.missionId}, ${category}, ${input.deduplicationKey},
           ${payloadJson}, 'pending', ${input.occurredAt}, ${input.summary}, ${now})
        RETURNING event_id
      `.pipe(Effect.mapError(sqlFail("persist")));

      return inserted.length > 0;
    });

  const claimPending: TradingEventInboxShape["claimPending"] = (missionId) =>
    sql<ClaimedRow>`
      UPDATE trading_event_inbox SET status = 'included_in_run'
      WHERE mission_id = ${missionId} AND status = 'pending'
      RETURNING category, deduplication_key, occurred_at, summary
    `.pipe(
      Effect.mapError(sqlFail("claimPending")),
      Effect.map((rows) =>
        rows
          .map(toSummary)
          .sort(
            (a, b) =>
              a.occurredAt - b.occurredAt || a.deduplicationKey.localeCompare(b.deduplicationKey),
          ),
      ),
    );

  const findSummary: TradingEventInboxShape["findSummary"] = (missionId, deduplicationKey) =>
    sql<ClaimedRow>`
      SELECT category, deduplication_key, occurred_at, summary
      FROM trading_event_inbox
      WHERE mission_id = ${missionId} AND deduplication_key = ${deduplicationKey}
    `.pipe(
      Effect.mapError(sqlFail("findSummary")),
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? null : toSummary(row);
      }),
    );

  const isPending: TradingEventInboxShape["isPending"] = (missionId, deduplicationKey) =>
    sql<{ readonly event_id: string }>`
      SELECT event_id FROM trading_event_inbox
      WHERE mission_id = ${missionId}
        AND deduplication_key = ${deduplicationKey}
        AND status = 'pending'
    `.pipe(
      Effect.mapError(sqlFail("isPending")),
      Effect.map((rows) => rows.length > 0),
    );

  const markIncludedConsumed: TradingEventInboxShape["markIncludedConsumed"] = (missionId) =>
    sql`
      UPDATE trading_event_inbox SET status = 'consumed'
      WHERE mission_id = ${missionId} AND status = 'included_in_run'
    `.pipe(Effect.mapError(sqlFail("markIncludedConsumed")), Effect.asVoid);

  const readQueuedUserMessages: TradingEventInboxShape["readQueuedUserMessages"] = (missionId) =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM trading_event_inbox
      WHERE mission_id = ${missionId} AND category = 'user' AND status = 'pending'
      ORDER BY occurred_at ASC, event_id ASC
    `.pipe(
      Effect.mapError(sqlFail("readQueuedUserMessages")),
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const decoded = decodeQueuedUserMessage(row.payload_json);
          return Option.isSome(decoded) ? [decoded.value.text] : [];
        }),
      ),
    );

  return {
    persist,
    claimPending,
    findSummary,
    isPending,
    markIncludedConsumed,
    readQueuedUserMessages,
  } satisfies TradingEventInboxShape;
});

export const TradingEventInboxLive = Layer.effect(TradingEventInbox, makeTradingEventInbox);
