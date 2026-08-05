/**
 * The closing review as prose.
 *
 * The review reaches the harness as an inbox summary — a string — so the
 * arithmetic has to survive the trip in words. What these pin is that the two
 * things the realised figure hides are always said out loud: the fees, and how
 * much of the peak was handed back.
 */
import { assert, describe, it } from "@effect/vitest";

import { describeClosedTrade, type ClosedTradeReview } from "./history.ts";

const review = (overrides: Partial<ClosedTradeReview> = {}): ClosedTradeReview => ({
  missionId: "mission_1",
  market: "ETH",
  direction: "long",
  openedAt: 1_000_000,
  closedAt: 1_000_000 + 12 * 60_000,
  holdMillis: 12 * 60_000,
  sizeEth: 2,
  entryPrice: 3_000,
  exitPrice: 3_012.5,
  realizedPnlUsd: 25,
  feesPaidUsd: 2,
  netPnlUsd: 23,
  peakUnrealisedPnlUsd: 40,
  worstUnrealisedPnlUsd: -8,
  givebackFromPeakUsd: 15,
  fillCount: 4,
  ...overrides,
});

describe("describeClosedTrade", () => {
  it("leads with the result net of fees, not the gross one", () => {
    const summary = describeClosedTrade(review());
    assert.include(summary, "realised $25.00 less $2.00 of fees = NET $23.00");
    assert.include(summary, "long 2 ETH held 12m");
  });

  it("always names both excursions and the give-back", () => {
    const summary = describeClosedTrade(review());
    assert.include(summary, "worth $40.00 at its best");
    assert.include(summary, "-$8.00 at its worst");
    assert.include(summary, "$15.00 of the peak was given back");
  });

  it("signs a loss rather than reporting its magnitude", () => {
    const summary = describeClosedTrade(
      review({
        realizedPnlUsd: -6,
        netPnlUsd: -7,
        peakUnrealisedPnlUsd: 0,
        givebackFromPeakUsd: 0,
      }),
    );
    assert.include(summary, "NET -$7.00");
  });

  it("names the published target when there was one to score against", () => {
    assert.include(describeClosedTrade(review({ targetProfitUsd: 30 })), "target was $30.00");
    // And says nothing about a target the trade never had.
    assert.notInclude(describeClosedTrade(review()), "Published target");
  });
});
