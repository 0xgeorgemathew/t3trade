import { assert, describe, it } from "@effect/vitest";

import { readMissionMode } from "./mode.ts";

describe("readMissionMode", () => {
  it("is discretionary by default", () => {
    assert.deepEqual(readMissionMode("trade ETH on the 1m"), { kind: "discretionary" });
  });

  it("reads a named playbook behind an execute verb", () => {
    const mode = readMissionMode("Execute the momentum playbook on ETH.");
    assert.equal(mode.kind, "execute_strategy");
    if (mode.kind === "execute_strategy") {
      assert.equal(mode.strategy, "momentum");
      assert.include(mode.doctrine, "faithful execution");
      // The sentence that stops a playbook being read as permission.
      assert.include(mode.doctrine, "cannot authorise what the authority refuses");
    }
  });

  it("takes the explicit form a tool would write", () => {
    const mode = readMissionMode("trade ETH\n\nstrategy: range_reversion");
    assert.equal(mode.kind === "execute_strategy" && mode.strategy, "range_reversion");
  });

  it("accepts a name written with spaces", () => {
    const mode = readMissionMode("run the opening range playbook");
    assert.equal(mode.kind === "execute_strategy" && mode.strategy, "opening_range");
  });

  it("does not turn a mention into a standing order", () => {
    // The verb has to be there and the name has to follow it. A mandate that
    // merely talks about momentum is still the operator thinking out loud.
    assert.deepEqual(readMissionMode("momentum has been working lately, trade ETH"), {
      kind: "discretionary",
    });
  });

  it("finds the order behind an earlier clause that also has a verb", () => {
    // An operator writes more than one sentence, and the first verb in a
    // mandate is usually in front of the market. Reading only the first match
    // dropped this mission to discretionary without telling anyone.
    const mode = readMissionMode("Trade ETH on the 1m. Execute the momentum playbook.");
    assert.equal(mode.kind === "execute_strategy" && mode.strategy, "momentum");
  });

  it("does not let a name run across a sentence boundary", () => {
    const mode = readMissionMode(
      "Run this one on ETH. Follow the range_reversion playbook step by step.",
    );
    assert.equal(mode.kind === "execute_strategy" && mode.strategy, "range_reversion");
  });

  it("stays discretionary for a name that is not an executable strategy", () => {
    // `classify` is how to read the regime and `standing_rules` is what holds
    // in every mode; neither is a procedure a mission could be pointed at as
    // its whole job.
    assert.deepEqual(readMissionMode("execute the classify playbook"), { kind: "discretionary" });
    assert.deepEqual(readMissionMode("follow standing_rules"), { kind: "discretionary" });
  });

  it("falls back rather than failing on an unknown name", () => {
    assert.deepEqual(readMissionMode("run the usual"), { kind: "discretionary" });
  });

  it("does not read `trade <name>` as a standing order", () => {
    // "Trade momentum on ETH" is how an operator says _lean momentum, use your
    // judgement_. Read as execute mode it stands the session aside from every
    // non-momentum setup and reports which step failed each time.
    for (const mandate of [
      "Trade momentum on ETH",
      "Trade momentum when the book is offered",
      "Trade the range reversion setup only",
    ]) {
      assert.deepEqual(readMissionMode(mandate), { kind: "discretionary" }, mandate);
    }
  });

  it("refuses a negated order", () => {
    for (const mandate of [
      "Do not run momentum today",
      "Trade ETH, but never follow momentum",
      "Anything except the ema_cross playbook — do not execute ema_cross",
    ]) {
      assert.deepEqual(readMissionMode(mandate), { kind: "discretionary" }, mandate);
    }
  });

  it("reads a negation as cancelling its own clause and no further", () => {
    // `no` has to be in the negation list — "no need to run momentum" carries
    // no other negation word — and `no` is common enough that a bare window of
    // characters before the verb reaches into the sentence before it. Both of
    // these are instructions to execute with a stray `no` in the run-up.
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["There is no edge in chop; run the range_reversion playbook", "range_reversion"],
      ["No discretion today. Execute the momentum playbook", "momentum"],
      ["Not the usual, and no improvising: follow opening range", "opening_range"],
    ];
    for (const [mandate, strategy] of rows) {
      const mode = readMissionMode(mandate);
      assert.equal(mode.kind === "execute_strategy" ? mode.strategy : null, strategy, mandate);
    }

    // And the negation still lands when it is in the same breath as the verb.
    assert.deepEqual(readMissionMode("There is no need to run momentum today"), {
      kind: "discretionary",
    });
  });

  it("still reads the mandates an operator writes to mean the procedure", () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["Execute the momentum playbook", "momentum"],
      ["run the ema cross strategy", "ema_cross"],
      ["Follow opening range on the 5m", "opening_range"],
    ];
    for (const [mandate, strategy] of rows) {
      const mode = readMissionMode(mandate);
      assert.equal(mode.kind === "execute_strategy" ? mode.strategy : null, strategy, mandate);
    }
  });

  it("stays discretionary for the ordinary mandates", () => {
    for (const mandate of [
      "Trade ETH",
      "Trade ETH on testnet using 1m candles",
      "Trade BTC, take small profits",
      "momentum has been working today, trade ETH",
    ]) {
      assert.deepEqual(readMissionMode(mandate), { kind: "discretionary" }, mandate);
    }
  });
});
