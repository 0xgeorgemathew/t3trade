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

import type { TradingJournalEntry } from "@t3tools/trading-contracts/journal";
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
}

const toEntry = (row: JournalRow): TradingJournalEntry => ({
  id: row.id,
  note: row.note,
  at: row.created_at,
});

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingJournalService.${operation}`);

const makeTradingJournalService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const list: TradingJournalServiceShape["list"] = ({ missionId, limit }) =>
    Effect.gen(function* () {
      const rows = yield* sql<JournalRow>`
        SELECT id, note, created_at FROM trading_journal
        WHERE mission_id = ${missionId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit ?? TRADING_JOURNAL_READ_LIMIT}
      `.pipe(Effect.mapError(sqlFail("list")));
      return rows.map(toEntry);
    });

  const append: TradingJournalServiceShape["append"] = ({ missionId, note }) =>
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
      yield* sql`
        INSERT INTO trading_journal (id, mission_id, note, created_at)
        VALUES (${id}, ${missionId}, ${note}, ${now})
      `.pipe(Effect.mapError(sqlFail("append:insert")));

      return { id, note, at: now };
    });

  return { append, list } satisfies TradingJournalServiceShape;
});

export const TradingJournalServiceLive = Layer.effect(
  TradingJournalService,
  makeTradingJournalService,
);
