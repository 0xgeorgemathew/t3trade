/**
 * The closing review as prose.
 *
 * The review reaches the harness as an inbox summary — a string — so the
 * arithmetic has to survive the trip in words. What these pin is that the two
 * things the realised figure hides are always said out loud: the fees, and how
 * much of the peak was handed back.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  buildRoundTrips,
  describeClosedTrade,
  feeShareOfGross,
  type ClosedTradeReview,
  type TradingTradeHistoryEntry,
} from "./history.ts";

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

/** One completed order, with only the fields the pairing reads. */
const order = (
  overrides: Partial<TradingTradeHistoryEntry> & {
    readonly side: "buy" | "sell";
    readonly firstFillAt: number;
  },
): TradingTradeHistoryEntry => ({
  orderId: overrides.firstFillAt,
  market: "ETH",
  filledSize: 1,
  avgFillPrice: 3_000,
  notionalUsd: 3_000,
  feeUsd: 1,
  closedPnlUsd: 0,
  netPnlUsd: -1,
  lastFillAt: overrides.firstFillAt,
  fillCount: 1,
  ...overrides,
});

describe("buildRoundTrips", () => {
  it("pairs an entry and an exit into the trade they made together", () => {
    const trips = buildRoundTrips([
      order({
        side: "sell",
        firstFillAt: 60_000,
        avgFillPrice: 3_020,
        closedPnlUsd: 20,
        feeUsd: 1,
      }),
      order({ side: "buy", firstFillAt: 0, avgFillPrice: 3_000, feeUsd: 1 }),
    ]);

    assert.equal(trips.length, 1);
    const trip = trips[0];
    assert.equal(trip?.direction, "long");
    assert.equal(trip?.entryAvgPrice, 3_000);
    assert.equal(trip?.exitAvgPrice, 3_020);
    assert.equal(trip?.sizeEth, 1);
    assert.equal(trip?.grossPnlUsd, 20);
    // Both sides paid, so the net is not the closing order's net.
    assert.equal(trip?.feesPaidUsd, 2);
    assert.equal(trip?.netPnlUsd, 18);
    assert.equal(trip?.holdMillis, 60_000);
    assert.equal(trip?.orderCount, 2);
  });

  it("keeps a scale-in and a partial exit inside one trade", () => {
    const trips = buildRoundTrips([
      order({ side: "buy", firstFillAt: 0, filledSize: 1, avgFillPrice: 3_000 }),
      order({ side: "buy", firstFillAt: 10_000, filledSize: 1, avgFillPrice: 3_010 }),
      order({
        side: "sell",
        firstFillAt: 20_000,
        filledSize: 1,
        avgFillPrice: 3_020,
        closedPnlUsd: 20,
      }),
      order({
        side: "sell",
        firstFillAt: 30_000,
        filledSize: 1,
        avgFillPrice: 3_030,
        closedPnlUsd: 20,
      }),
    ]);

    assert.equal(trips.length, 1);
    assert.equal(trips[0]?.sizeEth, 2);
    assert.equal(trips[0]?.entryAvgPrice, 3_005);
    assert.equal(trips[0]?.exitAvgPrice, 3_025);
    assert.equal(trips[0]?.grossPnlUsd, 40);
    assert.equal(trips[0]?.orderCount, 4);
  });

  it("reads a sell-first sequence as the short it was", () => {
    const trips = buildRoundTrips([
      order({ side: "sell", firstFillAt: 0, avgFillPrice: 3_000 }),
      order({ side: "buy", firstFillAt: 60_000, avgFillPrice: 2_990, closedPnlUsd: 10 }),
    ]);
    assert.equal(trips[0]?.direction, "short");
    assert.equal(trips[0]?.entryAvgPrice, 3_000);
    assert.equal(trips[0]?.exitAvgPrice, 2_990);
  });

  it("leaves out a position that has not closed yet", () => {
    const trips = buildRoundTrips([
      order({ side: "buy", firstFillAt: 0 }),
      order({ side: "sell", firstFillAt: 10_000, closedPnlUsd: 5 }),
      // Still open: a result it does not have yet is not a result.
      order({ side: "buy", firstFillAt: 20_000 }),
    ]);
    assert.equal(trips.length, 1);
    assert.equal(trips[0]?.openedAt, 0);
  });

  // A trip is cut at flat and nowhere else, so an order that reverses straight
  // through flat keeps both legs in one trip rather than having its size, fee,
  // and realised PnL split between two on an assumption the exchange never
  // reported. The execution path closes before it re-enters, so this is the odd
  // case — but it should read as one longer trade, not as a lost one.
  it("keeps a reversal that never touched flat inside the trip it opened", () => {
    const trips = buildRoundTrips([
      order({ side: "buy", firstFillAt: 0, filledSize: 1, avgFillPrice: 3_000 }),
      // Straight through flat to a 1 short: the position went +1 to -1.
      order({
        side: "sell",
        firstFillAt: 10_000,
        filledSize: 2,
        avgFillPrice: 3_010,
        closedPnlUsd: 10,
      }),
      order({
        side: "buy",
        firstFillAt: 20_000,
        filledSize: 1,
        avgFillPrice: 3_005,
        closedPnlUsd: 5,
      }),
    ]);

    assert.equal(trips.length, 1);
    assert.equal(trips[0]?.direction, "long");
    assert.equal(trips[0]?.orderCount, 3);
    assert.equal(trips[0]?.grossPnlUsd, 15);
    assert.equal(trips[0]?.holdMillis, 20_000);
  });

  it("returns the newest trade first", () => {
    const trips = buildRoundTrips([
      order({ side: "buy", firstFillAt: 0 }),
      order({ side: "sell", firstFillAt: 10_000, closedPnlUsd: 5 }),
      order({ side: "buy", firstFillAt: 20_000 }),
      order({ side: "sell", firstFillAt: 30_000, closedPnlUsd: 7 }),
    ]);
    assert.equal(trips.length, 2);
    assert.equal(trips[0]?.grossPnlUsd, 7);
    assert.equal(trips[1]?.grossPnlUsd, 5);
  });

  it("scores a trade against the thesis it was closed under", () => {
    const trips = buildRoundTrips([
      order({ side: "buy", firstFillAt: 0, strategyVersion: 1, targetProfitUsd: 5 }),
      order({
        side: "sell",
        firstFillAt: 10_000,
        closedPnlUsd: 5,
        strategyVersion: 2,
        targetProfitUsd: 9,
      }),
    ]);
    // The target the trade was actually being held for is the closing one.
    assert.equal(trips[0]?.strategyVersion, 2);
    assert.equal(trips[0]?.targetProfitUsd, 9);
  });
});

describe("feeShareOfGross", () => {
  const trip = (gross: number, fees: number) =>
    buildRoundTrips([
      order({ side: "buy", firstFillAt: 0, feeUsd: fees / 2 }),
      order({ side: "sell", firstFillAt: 1_000, closedPnlUsd: gross, feeUsd: fees / 2 }),
    ])[0]!;

  it("reports the share the fees took of what the trades produced", () => {
    // $4 of gross across two trips against $2 of fees is half of it gone.
    assert.closeTo(feeShareOfGross([trip(2, 1), trip(2, 1)]), 50, 1e-9);
  });

  it("does not let a loss cancel a win and make the fees look free", () => {
    // Netting these to zero gross would divide by nothing; taking the
    // magnitude shows $4 of movement that cost $2 to produce.
    assert.closeTo(feeShareOfGross([trip(2, 1), trip(-2, 1)]), 50, 1e-9);
  });

  it("says zero rather than dividing by a gross that is not there", () => {
    assert.equal(feeShareOfGross([]), 0);
    assert.equal(feeShareOfGross([trip(0, 2)]), 0);
  });
});
