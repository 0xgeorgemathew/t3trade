/**
 * The mission journal — plan 29 step 6.4.
 *
 * The plan document was quietly doing two jobs. One is a plan: what the model
 * intends to do about the market it is looking at, in eight authored fields
 * the server reconciles the exchange to. The other was memory — "I already
 * tried this level and it chopped me", "the 15m read disagrees with the 1m",
 * "waiting on the London open" — which has no field to live in and was being
 * smuggled into `because` and then overwritten by the next revision.
 *
 * A revision overwriting the record of why the last one existed is the whole
 * problem. So the journal is append-only: one note per call, never edited,
 * never replaced, and read back in the same words it was written in.
 *
 * It is also the object the UI timeline renders. A note is not a private
 * scratchpad — it sits beside the wakes, the publishes and the stop steps on
 * one line of history, because that is where a human reading back the session
 * needs the model's reasoning to be.
 *
 * @module TradingJournal
 */
import { Schema } from "effect";
import { TradingId, UnixMillis } from "./primitives.ts";
import { FailureRecovery } from "./recovery.ts";

export const TRADING_JOURNAL_TOOL = "trading_journal";

/**
 * The longest note that is still a note.
 *
 * Long enough for a paragraph of reasoning; short enough that the journal read
 * riding every turn does not become the turn's largest input. A note over the
 * cap is refused rather than truncated — a note cut off mid-sentence reads
 * back as something the model did not say.
 */
export const TRADING_JOURNAL_NOTE_MAX_CHARS = 1_000;

/** How many notes a read hands back, newest first. */
export const TRADING_JOURNAL_READ_LIMIT = 20;

/**
 * One note, as written.
 *
 * `at` is server-assigned. The model does not stamp its own entries: a
 * timestamp it supplied would be a claim, and the ordering the timeline draws
 * has to be a fact.
 */
export const TradingJournalEntry = Schema.Struct({
  id: TradingId,
  note: Schema.String,
  at: UnixMillis,
});
export type TradingJournalEntry = typeof TradingJournalEntry.Type;

export const TradingJournalInput = Schema.Struct({
  /**
   * Optional since the calling thread is bound to exactly one mission; a wrong
   * `missionId` is still rejected. Same rule as every other trading tool.
   */
  missionId: Schema.optional(TradingId),
  /**
   * The note to append. Omit it and the call is a read — the same tool, the
   * same field names, nothing written.
   */
  note: Schema.optional(Schema.String),
});
export type TradingJournalInput = typeof TradingJournalInput.Type;

/** Why a note was not appended. */
export const TradingJournalRefusalCode = Schema.Literals([
  /** The note was empty or only whitespace. There is nothing to record. */
  "note_empty",
  /** The note is longer than {@link TRADING_JOURNAL_NOTE_MAX_CHARS}. */
  "note_too_long",
  /** The mission ended underneath the call. Nothing was appended. */
  "mission_not_found",
]);
export type TradingJournalRefusalCode = typeof TradingJournalRefusalCode.Type;

/**
 * What the call did, and what the journal now says.
 *
 * `entries` rides every outcome — including a refusal. A model that was told
 * its note was too long should not have to make a second call to see what it
 * had already written.
 */
export const TradingJournalResult = Schema.Struct({
  outcome: Schema.Literals(["noted", "read", "refused"]),
  /** The entry just appended. Present only on `noted`. */
  entry: Schema.optional(TradingJournalEntry),
  /** The mission's most recent notes, newest first. */
  entries: Schema.Array(TradingJournalEntry),
  /** Present only on `refused`, and always from `classifyFailure`. */
  recovery: Schema.optional(FailureRecovery),
  /** Present only on `refused`. */
  reason: Schema.optional(TradingJournalRefusalCode),
  detail: Schema.optional(Schema.String),
});
export type TradingJournalResult = typeof TradingJournalResult.Type;

/** A note the journal will not take, and why. */
export interface TradingJournalRefusal {
  readonly code: TradingJournalRefusalCode;
  readonly detail: string;
}

/**
 * Normalise a note, or say why it is not one.
 *
 * Pure, and deliberately outside the handler: the same two rules decide the
 * answer everywhere, and a refusal costs no transaction.
 */
export function readJournalNote(note: string): string | TradingJournalRefusal {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return { code: "note_empty", detail: "a note with no words in it records nothing" };
  }
  if (trimmed.length > TRADING_JOURNAL_NOTE_MAX_CHARS) {
    return {
      code: "note_too_long",
      detail:
        `a note is at most ${TRADING_JOURNAL_NOTE_MAX_CHARS} characters; this one is ` +
        `${trimmed.length}. Write the part that will still matter next turn.`,
    };
  }
  return trimmed;
}

export function isJournalRefusal(
  result: string | TradingJournalRefusal,
): result is TradingJournalRefusal {
  return typeof result !== "string";
}
