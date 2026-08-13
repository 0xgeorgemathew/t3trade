/**
 * Cutting recorded bars into fixtures — step 7 of the viability plan.
 *
 * The one property worth guarding: no fixture may contain its own answer. A cut
 * that let the history overlap the forward bars would make every policy look
 * clairvoyant and the whole replay worthless.
 */
import { describe, expect, it } from "vite-plus/test";

import type { MarketCandle } from "@t3tools/trading-contracts/market";

import { cutReplayFixtures } from "./TradingReplayFixtures.ts";

const series = (count: number): ReadonlyArray<MarketCandle> =>
  Array.from({ length: count }, (_, index) => ({
    openTime: index * 60_000,
    closeTime: index * 60_000 + 59_999,
    open: 3_000 + index,
    close: 3_000 + index,
    high: 3_000 + index + 1,
    low: 3_000 + index - 1,
    volume: 10,
  }));

const options = {
  interval: "1m" as const,
  historyBars: 40,
  forwardBars: 10,
  notionalUsd: 2_000,
  roundTripCostUsd: 2,
  playbook: "momentum" as const,
  session: {
    minutesRemaining: 60,
    consecutiveNetLosses: 0,
    minutesSinceLastLoss: null,
  },
  label: "ETH-1m",
};

describe("cutReplayFixtures", () => {
  it("never lets a fixture see the bars that settle it", () => {
    const fixtures = cutReplayFixtures(series(200), options);

    for (const fixture of fixtures) {
      const lastHistory = fixture.history[fixture.history.length - 1];
      const firstForward = fixture.forward[0];
      expect(lastHistory).toBeDefined();
      expect(firstForward).toBeDefined();
      expect(firstForward?.openTime).toBeGreaterThan(lastHistory?.closeTime ?? Infinity);
    }
  });

  it("cuts each window to the lengths asked for", () => {
    const fixtures = cutReplayFixtures(series(200), options);
    for (const fixture of fixtures) {
      expect(fixture.history).toHaveLength(40);
      expect(fixture.forward).toHaveLength(10);
    }
  });

  // Overlapping outcomes are not independent samples. The default stride makes
  // each fixture settle on bars no other fixture settled on.
  it("defaults to a stride that keeps outcomes disjoint", () => {
    const fixtures = cutReplayFixtures(series(200), options);
    const forwardStarts = fixtures.map((fixture) => fixture.forward[0]?.openTime);
    expect(new Set(forwardStarts).size).toBe(fixtures.length);
    expect(fixtures).toHaveLength(Math.floor((200 - 50) / 10) + 1);
  });

  it("drops a tail too short to settle anything", () => {
    // 45 bars cannot hold a 40-bar read and a 10-bar outcome, and a fixture with
    // five forward bars would report `open` and count as evidence of nothing.
    expect(cutReplayFixtures(series(45), options)).toHaveLength(0);
    expect(cutReplayFixtures(series(50), options)).toHaveLength(1);
  });
});
