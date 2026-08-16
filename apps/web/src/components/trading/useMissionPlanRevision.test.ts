import { describe, expect, it } from "vite-plus/test";

import type { TradingPlanState } from "@t3tools/trading-contracts/strategy";

import { applyPlanDrag } from "./useMissionPlanRevision";

const plan: TradingPlanState = {
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [
      { description: "breaks 1,860", priceLevel: 1860, confirmation: "close" },
      { description: "retests 1,850", priceLevel: 1850 },
    ],
    urgency: "patient",
    initialNotionalUsd: 500,
  },
  stop: { method: "below the last swing", price: 1840, maximumPlannedLossUsd: 25 },
  target: { method: "the range high", price: 1900, profitUsd: 40 },
  invalidation: ["the 1m regime flips"],
  reassess: { afterMinutes: 45 },
  because: "the range has held three times",
  updatedAt: 1_000,
};

describe("applyPlanDrag", () => {
  it("replaces exactly one leaf and leaves the other seven fields identical", () => {
    const next = applyPlanDrag(plan, { kind: "stop", price: 1858.1 });
    expect(next.stop).toEqual({
      method: "below the last swing",
      price: 1858.1,
      maximumPlannedLossUsd: 25,
    });
    // Everything else, verbatim — this is the constraint that keeps
    // `misarmedEntryConditions` honest: it compares the plan's `confirmation`
    // against the watch's `confirm` assuming the shape has not drifted.
    expect(next.market).toBe(plan.market);
    expect(next.intent).toBe(plan.intent);
    expect(next.entry).toEqual(plan.entry);
    expect(next.target).toEqual(plan.target);
    expect(next.invalidation).toEqual(plan.invalidation);
    expect(next.reassess).toEqual(plan.reassess);
    expect(next.because).toBe(plan.because);
  });

  it("keeps a target's method and rung when only its price moved", () => {
    const next = applyPlanDrag(plan, { kind: "target", price: 1912 });
    expect(next.target).toEqual({ method: "the range high", price: 1912, profitUsd: 40 });
  });

  it("moves one trigger's price level and keeps its confirmation and its siblings", () => {
    const next = applyPlanDrag(plan, { kind: "trigger", index: 1, price: 1852.5 });
    expect(next.entry.triggers[0]).toEqual(plan.entry.triggers[0]);
    expect(next.entry.triggers[1]).toEqual({ description: "retests 1,850", priceLevel: 1852.5 });
    expect(next.entry.urgency).toBe("patient");
  });

  it("does not mutate the plan it was given", () => {
    applyPlanDrag(plan, { kind: "stop", price: 1 });
    expect(plan.stop.price).toBe(1840);
  });
});
