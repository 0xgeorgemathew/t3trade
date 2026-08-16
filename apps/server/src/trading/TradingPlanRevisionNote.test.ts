import { assert, describe, it } from "@effect/vitest";
import type { TradingPlanState } from "@t3tools/trading-contracts/strategy";

import { composePlanRevisionNote } from "./TradingPlanRevisionNote.ts";

const plan = (overrides: Partial<TradingPlanState> = {}): TradingPlanState => ({
  market: "ETH",
  intent: "long",
  entry: { triggers: [{ description: "breaks 1,860" }], urgency: "now" },
  stop: { method: "below the last swing", price: 1840 },
  target: { method: "the range high", price: 1900 },
  invalidation: [],
  reassess: { afterMinutes: 90 },
  because: "",
  updatedAt: 1_000,
  ...overrides,
});

describe("composePlanRevisionNote", () => {
  it("says nothing when the drag moved nothing", () => {
    assert.equal(composePlanRevisionNote(plan(), plan({ updatedAt: 2_000 })), null);
  });

  it("names the stop and the price it moved to", () => {
    const note = composePlanRevisionNote(
      plan(),
      plan({ stop: { method: "below the last swing", price: 1858.1 } }),
    );
    assert.equal(note, "the operator revised the plan from the chart — stop moved to 1,858.10");
  });

  it("names every level one revision moved, in one note", () => {
    const note = composePlanRevisionNote(
      plan(),
      plan({
        stop: { method: "below the last swing", price: 1845 },
        target: { method: "the range high", price: 1912 },
        reassess: { afterMinutes: 30 },
      }),
    );
    assert.equal(
      note,
      "the operator revised the plan from the chart — stop moved to 1,845.00; " +
        "target moved to 1,912.00; reassessment moved to 30 minutes after this revision",
    );
  });

  it("names a trigger by its position in the plan's own order", () => {
    const before = plan({
      entry: {
        triggers: [
          { description: "breaks 1,860", priceLevel: 1860 },
          { description: "retests 1,850", priceLevel: 1850 },
        ],
        urgency: "now",
      },
    });
    const after = plan({
      entry: {
        triggers: [
          { description: "breaks 1,860", priceLevel: 1860 },
          { description: "retests 1,850", priceLevel: 1852.5 },
        ],
        urgency: "now",
      },
    });
    assert.equal(
      composePlanRevisionNote(before, after),
      "the operator revised the plan from the chart — entry trigger 2 moved to 1,852.50",
    );
  });

  it("reports a changed trigger count rather than guessing which one moved", () => {
    const after = plan({ entry: { triggers: [], urgency: "now" } });
    assert.equal(
      composePlanRevisionNote(plan(), after),
      "the operator revised the plan from the chart — entry triggers changed from 1 to 0",
    );
  });

  it("describes a first plan without inventing a previous one", () => {
    // A drag needs a plan to drag, so this case is not reachable from the
    // chart; it is here to pin what the note says if a caller ever publishes a
    // first plan through the same path. Everything is "set", not "moved", and
    // the reassessment stays silent because a first plan's horizon is the
    // default rather than an operator's edit.
    const note = composePlanRevisionNote(null, plan({ reassess: { afterMinutes: 30 } }));
    assert.equal(
      note,
      "the operator revised the plan from the chart — stop set to 1,840.00; " +
        "target set to 1,900.00; entry triggers changed from 0 to 1",
    );
  });
});
