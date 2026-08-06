/**
 * The chart RPC's entitlement rule, both shapes.
 *
 * The live chart and the post-mortem chart ask the same RPC for very different
 * things, and the rule that was written for the live one refuses every review
 * chart there is — a completed mission is terminal by definition, which is
 * exactly what makes it reviewable.
 */
import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { isChartReadEntitled } from "./chartReadEntitlement.ts";

const LIVE = { market: "ETH" };
const REVIEW = { market: "ETH", startTime: 1_000, endTime: 2_000 };

describe("isChartReadEntitled", () => {
  it("refuses a market with no mission at all", () => {
    expect(isChartReadEntitled(LIVE, [])).toBe(false);
    expect(isChartReadEntitled(REVIEW, [])).toBe(false);
  });

  it("refuses a market some OTHER mission is running", () => {
    const missions = [{ market: "BTC", status: "position_open" }];
    expect(isChartReadEntitled(LIVE, missions)).toBe(false);
    expect(isChartReadEntitled(REVIEW, missions)).toBe(false);
  });

  it("serves a live read on a running mission", () => {
    expect(isChartReadEntitled(LIVE, [{ market: "ETH", status: "position_open" }])).toBe(true);
  });

  it("refuses a live read once the mission is terminal", () => {
    expect(isChartReadEntitled(LIVE, [{ market: "ETH", status: "completed" }])).toBe(false);
    expect(isChartReadEntitled(LIVE, [{ market: "ETH", status: "revoked" }])).toBe(false);
  });

  // The whole point of the review shape: the mission whose chart is being
  // reviewed has finished, so a terminal status must not refuse the read.
  it("serves a windowed read on a terminal mission", () => {
    expect(isChartReadEntitled(REVIEW, [{ market: "ETH", status: "completed" }])).toBe(true);
    expect(isChartReadEntitled(REVIEW, [{ market: "ETH", status: "revoked" }])).toBe(true);
  });

  // Half a window is not a window: a caller that sends only one bound gets the
  // live rule, so the review relaxation cannot be reached by accident.
  it("treats a half-specified window as a live read", () => {
    const missions = [{ market: "ETH", status: "completed" }];
    expect(isChartReadEntitled({ market: "ETH", startTime: 1_000 }, missions)).toBe(false);
    expect(isChartReadEntitled({ market: "ETH", endTime: 2_000 }, missions)).toBe(false);
  });
});
