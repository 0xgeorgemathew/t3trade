/**
 * TradingJournalService — the mission's append-only memory (plan 29 step 6.4).
 *
 * Two operations and no third: append one note, read the recent ones back.
 * There is no update and no delete, which is the point — the plan document is
 * replaced on every revision, and everything the model wanted to remember
 * across revisions was being lost with it.
 *
 * A note is refused rather than truncated or silently dropped, and only for
 * reasons the contract's `readJournalNote` decides. The mission-liveness check
 * lives here because it is the one refusal that is not about the note.
 *
 * @module TradingJournalService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { TradingJournalAuthor, TradingJournalEntry } from "@t3tools/trading-contracts/journal";
import { TRADING_JOURNAL_READ_LIMIT } from "@t3tools/trading-contracts/journal";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";
import { TradingMissionStatus } from "./Schemas.ts";

const decodeMissionStatus = Schema.decodeUnknownSync(TradingMissionStatus);

export interface TradingJournalServiceShape {
  /**
   * Append one note to the mission's journal.
   *
   * `null` when the mission is gone or is no longer active — the same shape
   * `registerWatch` uses for the same situation, so the handler's refusal
   * reads the same in both.
   *
   * The note is taken as given: normalising it is the contract's job and has
   * already happened by the time it reaches here.
   */
  readonly append: (input: {
    readonly missionId: string;
    readonly note: string;
    /**
     * Who is writing. The tool's caller is the model; the panel's drag handler
     * is the user. Defaults to `model` because that is the only author the
     * journal had before step 8.4, so an unstated author is the historical one.
     */
    readonly author?: TradingJournalAuthor;
  }) => Effect.Effect<TradingJournalEntry | null, PersistenceSqlError>;

  /**
   * The mission's most recent notes, newest first.
   *
   * Bounded, because this read rides a turn: a mission that journals every
   * wake for an hour would otherwise hand the model back its whole session.
   * The cap is on the read, never on the table.
   */
  readonly list: (input: {
    readonly missionId: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<TradingJournalEntry>, PersistenceSqlError>;
}

export class TradingJournalService extends Context.Service<
  TradingJournalService,
  TradingJournalServiceShape
>()("t3/trading/TradingJournalService") {}

interface JournalRow {
  readonly id: string;
  readonly note: string;
  readonly created_at: number;
  readonly author: string;
}

const toEntry = (row: JournalRow): TradingJournalEntry => ({
  id: row.id,
  note: row.note,
  at: row.created_at,
  // The column is NOT NULL DEFAULT 'model' (migration 067), so the only way a
  // row reads as anything else is if something wrote it — but the read is
  // narrowed rather than cast, because a value the database does not
  // understand is not a reason to hand a client a string it cannot render.
  author: row.author === "user" ? "user" : "model",
});

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingJournalService.${operation}`);

const makeTradingJournalService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const list: TradingJournalServiceShape["list"] = ({ missionId, limit }) =>
    Effect.gen(function* () {
      const rows = yield* sql<JournalRow>`
        SELECT id, note, created_at, author FROM trading_journal
        WHERE mission_id = ${missionId}
        -- Two notes in one turn land in the same millisecond, and the id is a
        -- random UUID, so it cannot break that tie: ordering on it hands the
        -- model its own reasoning back in an arbitrary order. The rowid is the
        -- order the rows were actually written in.
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${limit ?? TRADING_JOURNAL_READ_LIMIT}
      `.pipe(Effect.mapError(sqlFail("list")));
      return rows.map(toEntry);
    });

  const append: TradingJournalServiceShape["append"] = ({ missionId, note, author }) =>
    Effect.gen(function* () {
      const missions = yield* sql<{ readonly status: string }>`
        SELECT status FROM trading_missions WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("append:mission")));
      const mission = missions[0];
      if (mission === undefined || !isActiveMissionStatus(decodeMissionStatus(mission.status))) {
        return null;
      }

      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const now = yield* Clock.currentTimeMillis;
      const writer = author ?? "model";
      yield* sql`
        INSERT INTO trading_journal (id, mission_id, note, created_at, author)
        VALUES (${id}, ${missionId}, ${note}, ${now}, ${writer})
      `.pipe(Effect.mapError(sqlFail("append:insert")));

      return { id, note, at: now, author: writer };
    });

  return { append, list } satisfies TradingJournalServiceShape;
});

export const TradingJournalServiceLive = Layer.effect(
  TradingJournalService,
  makeTradingJournalService,
);
