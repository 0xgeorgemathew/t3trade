import { describe, expect, it } from "@effect/vitest";

import { deriveDecisionOutcome, deriveStandDownCode, type TradingRunFacts } from "./decision.ts";

const facts = (overrides: Partial<TradingRunFacts> = {}): TradingRunFacts => ({
  toolsCalled: [],
  toolErrorCount: 0,
  publishedPlan: false,
  publishedStandDown: false,
  hasArmedEntry: false,
  executeAttempted: false,
  ...overrides,
});

describe("deriveDecisionOutcome", () => {
  it("ranks reaching the exchange above every other signal", () => {
    const reached = facts({
      exchangeAction: "open",
      exchangeStatus: "filled",
      firstPreviewRefusal: "an earlier attempt was refused",
      toolErrorCount: 2,
    });
    expect(deriveDecisionOutcome(reached)).toBe("entered");
    expect(deriveStandDownCode(reached, "entered")).toBeUndefined();
  });

  it("does not count an exit or cancel as a new entry", () => {
    for (const action of ["close", "reduce", "cancel", "modify_stop"]) {
      const managed = facts({ exchangeAction: action, exchangeStatus: "succeeded" });
      expect(deriveDecisionOutcome(managed)).toBe("managed_position");
      expect(deriveStandDownCode(managed, "managed_position")).toBeUndefined();
    }
  });

  it("does not call an exchange rejection an entry", () => {
    const rejected = facts({ exchangeAction: "open", exchangeStatus: "rejected" });
    expect(deriveDecisionOutcome(rejected)).toBe("execution_refused");
    expect(deriveStandDownCode(rejected, "execution_refused")).toBe("exchange_rejected");
  });

  it("separates a refused attempt from a turn that never tried", () => {
    expect(deriveDecisionOutcome(facts({ firstPreviewRefusal: "valid_stop_defined" }))).toBe(
      "execution_refused",
    );
    expect(deriveDecisionOutcome(facts({ executeAttempted: true }))).toBe("no_decision");
  });

  it("separates a failed read from a silent turn", () => {
    expect(deriveDecisionOutcome(facts({ toolErrorCount: 1 }))).toBe("blocked_by_data");
    expect(deriveDecisionOutcome(facts())).toBe("no_decision");
  });

  it("counts a reasoned stand-down as a decision even when a read failed", () => {
    // The turn published: it concluded something. The failed read is recorded
    // on the run, but it is not what the outcome is about.
    const standDown = facts({
      publishedPlan: true,
      publishedStandDown: true,
      toolErrorCount: 1,
    });
    expect(deriveDecisionOutcome(standDown)).toBe("no_setup");
    expect(deriveStandDownCode(standDown, "no_setup")).toBe("insufficient_volatility");
  });

  it("keeps the explicit stand-down reason instead of inferring volatility", () => {
    // The plan document carries no reason code any more (plan 29 step 4.1:
    // standing aside is `intent: "stand_aside"`, the reasoning is prose), so a
    // published stand-aside attributes to the volatility default and nothing
    // masquerades as an explicit code.
    const costs = facts({
      publishedPlan: true,
      publishedStandDown: true,
    });
    expect(deriveDecisionOutcome(costs)).toBe("no_setup");
    expect(deriveStandDownCode(costs, "no_setup")).toBe("insufficient_volatility");

    // A publish that is not a stand-aside and armed nothing is the flatter
    // refusal: the read resolved and the market had nothing.
    const thesis = facts({ publishedPlan: true, publishedStandDown: false });
    expect(deriveDecisionOutcome(thesis)).toBe("no_setup");
    expect(deriveStandDownCode(thesis, "no_setup")).toBe("regime_unclear");
  });

  it("distinguishes a published thesis with armed levels from one without", () => {
    expect(deriveDecisionOutcome(facts({ publishedPlan: true, hasArmedEntry: true }))).toBe(
      "waiting_with_setup",
    );
    expect(deriveDecisionOutcome(facts({ publishedPlan: true }))).toBe("no_setup");
  });
});
