import { assert, describe, it } from "@effect/vitest";

import { classifyFailure } from "./recovery.ts";
import { isJournalRefusal, readJournalNote, TRADING_JOURNAL_NOTE_MAX_CHARS } from "./journal.ts";

describe("readJournalNote", () => {
  it("normalises the note it takes", () => {
    const note = readJournalNote("  3200 chopped me twice  ");
    assert.isFalse(isJournalRefusal(note));
    assert.equal(note, "3200 chopped me twice");
  });

  it("refuses a note with no words in it", () => {
    const note = readJournalNote(" \n\t ");
    assert.isTrue(isJournalRefusal(note));
    if (!isJournalRefusal(note)) return;
    assert.equal(note.code, "note_empty");
  });

  // Refused, never truncated: a note cut off mid-sentence reads back as
  // something the model did not say.
  it("refuses a note over the cap rather than cutting it", () => {
    const note = readJournalNote("x".repeat(TRADING_JOURNAL_NOTE_MAX_CHARS + 1));
    assert.isTrue(isJournalRefusal(note));
    if (!isJournalRefusal(note)) return;
    assert.equal(note.code, "note_too_long");
  });

  // The cap is on the trimmed note, so trailing whitespace never costs a
  // refusal.
  it("measures the cap after trimming", () => {
    const note = readJournalNote(`${"x".repeat(TRADING_JOURNAL_NOTE_MAX_CHARS)}   `);
    assert.isFalse(isJournalRefusal(note));
  });
});

describe("journal refusals classify", () => {
  // Every refusal's recovery comes from the classifier, not from a literal
  // built at the refusal site.
  it("stands down on a rule about the note, and reads state when the mission ended", () => {
    assert.deepStrictEqual(
      classifyFailure({ tag: "TradingJournalRefusal", reason: "note_too_long" }),
      {
        retryable: false,
        action: "stand_down",
        retryAfterMillis: 0,
        reason: "journal_note_too_long",
      },
    );
    assert.deepStrictEqual(
      classifyFailure({ tag: "TradingJournalRefusal", reason: "mission_not_found" }),
      {
        retryable: false,
        action: "read_state",
        retryAfterMillis: 0,
        reason: "journal_mission_not_found",
      },
    );
  });
});
