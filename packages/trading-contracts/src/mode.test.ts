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
});
