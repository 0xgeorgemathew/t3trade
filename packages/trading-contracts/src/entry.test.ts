import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  deriveFeasibleSize,
  deriveEntryLimitPrice,
  TradingEnterInput,
  type EntrySizingInput,
} from "./entry.ts";

/**
 * A long at 2000 with its stop 10 below, on a mission whose ceilings are all
 * generous. Each test tightens exactly one of them, so the constraint the
 * sizing names is the one the test moved.
 */
const base: EntrySizingInput = {
  side: "buy",
  entryPrice: 2_000,
  stopPrice: 1_990,
  szDecimals: 4,
  existingNotionalUsd: 0,
  allocatedCapitalUsd: 1_000,
  maximumLeverage: 20,
  maximumGrossNotionalUsd: 20_000,
  maximumPlannedRiskPerPositionUsd: 100,
  remainingCumulativeLossUsd: 200,
  takerFeeBpsPerSide: 4.5,
  stopSlippageReserveBps: 10,
  minimumNotionalUsd: 10,
};

describe("deriveFeasibleSize", () => {
  // Plan 34 step 7.1. The four ceilings above are the mandate's — what the
  // mission may take. This one is the account's — what it can fund. They were
  // allowed to disagree by a factor of eight, and the IOC that resulted filled
  // 12% of its request while reporting `filled`.
  it("will not size past what the exchange account can fund", () => {
    // 8x the mandate's ceiling, 1x the account's: the account binds.
    const sizing = deriveFeasibleSize({
      ...base,
      maximumGrossNotionalUsd: 8_000,
      accountMarginCapacityUsd: 900,
    });

    assert.strictEqual(sizing.feasible, true);
    assert.strictEqual(sizing.constrainedBy, "account_margin");
    assert.strictEqual(sizing.size, 0.45);
    assert.strictEqual(sizing.notionalUsd, 900);
  });

  it("lets the mandate bind when the account can fund more than it allows", () => {
    const sizing = deriveFeasibleSize({
      ...base,
      maximumGrossNotionalUsd: 800,
      accountMarginCapacityUsd: 9_000,
    });

    assert.strictEqual(sizing.constrainedBy, "gross_notional");
    assert.strictEqual(sizing.notionalUsd, 800);
  });

  // An unknown capacity is not a zero one: the bound is omitted, not guessed.
  it("binds nothing when the account's capacity could not be read", () => {
    const sizing = deriveFeasibleSize({ ...base, requestedSize: 0.5 });

    assert.strictEqual(sizing.constrainedBy, "requested");
    assert.strictEqual(sizing.size, 0.5);
  });

  it("gives the harness the size it asked for when nothing binds", () => {
    const sizing = deriveFeasibleSize({ ...base, requestedSize: 0.5 });

    assert.strictEqual(sizing.feasible, true);
    assert.strictEqual(sizing.size, 0.5);
    assert.strictEqual(sizing.constrainedBy, "requested");
    // Getting the size asked for says nothing about how much of the approved
    // trade it is: 0.5 ETH is a twentieth of what the ceilings here allow, and
    // the server can only say so because the ceiling is reported alongside.
    assert.strictEqual(sizing.ceilingSize, 10);
    assert.strictEqual(sizing.plannedLossAtStopUsd, 5);
    // 5 planned loss + 1000 notional x (2 x 4.5 + 10) bps.
    assert.closeTo(sizing.reservedRiskUsd, 5 + 1_000 * 0.0019, 1e-9);
  });

  it("proposes a smaller size rather than refusing, and names the ceiling", () => {
    // 100 of per-position risk over a $10 stop distance is 10 ETH, but 20x on
    // $1,000 of capital is only $20,000 of notional — 10 ETH at 2,000.
    // Tighten the gross ceiling so it, and only it, binds.
    const sizing = deriveFeasibleSize({
      ...base,
      maximumGrossNotionalUsd: 4_000,
      requestedSize: 5,
    });

    assert.strictEqual(sizing.feasible, true);
    assert.strictEqual(sizing.size, 2);
    assert.strictEqual(sizing.requestedSize, 5);
    assert.strictEqual(sizing.constrainedBy, "gross_notional");
  });

  it("counts the notional already open against the ceiling", () => {
    const sizing = deriveFeasibleSize({
      ...base,
      maximumGrossNotionalUsd: 4_000,
      existingNotionalUsd: 3_000,
      requestedSize: 5,
    });

    assert.strictEqual(sizing.size, 0.5);
    assert.strictEqual(sizing.constrainedBy, "gross_notional");
  });

  it("sizes off the per-position risk ceiling and the remaining budget", () => {
    const byPosition = deriveFeasibleSize({
      ...base,
      maximumPlannedRiskPerPositionUsd: 20,
      requestedSize: 5,
    });
    assert.strictEqual(byPosition.size, 2);
    assert.strictEqual(byPosition.constrainedBy, "planned_loss_ceiling");
    assert.strictEqual(byPosition.plannedLossAtStopUsd, 20);

    const byBudget = deriveFeasibleSize({
      ...base,
      remainingCumulativeLossUsd: 15,
      requestedSize: 5,
    });
    assert.strictEqual(byBudget.size, 1.0869);
    assert.strictEqual(byBudget.constrainedBy, "loss_budget");
    assert.isAtMost(byBudget.reservedRiskUsd, 15);
  });

  it("returns a budget-bound size whose full reservation clears the budget", () => {
    const sizing = deriveFeasibleSize({
      ...base,
      remainingCumulativeLossUsd: 15,
      requestedSize: 5,
    });

    assert.strictEqual(sizing.feasible, true);
    assert.strictEqual(sizing.constrainedBy, "loss_budget");
    assert.isAtMost(sizing.reservedRiskUsd, 15);
  });

  it("takes the largest feasible size when none was asked for", () => {
    const sizing = deriveFeasibleSize({ ...base, maximumPlannedRiskPerPositionUsd: 30 });

    assert.strictEqual(sizing.size, 3);
    assert.strictEqual(sizing.constrainedBy, "planned_loss_ceiling");
  });

  it("truncates to the market's precision rather than rounding up into a ceiling", () => {
    const sizing = deriveFeasibleSize({
      ...base,
      szDecimals: 2,
      maximumPlannedRiskPerPositionUsd: 1.239,
    });

    // 0.1239 ETH truncates to 0.12, never 0.13 — the ceiling is a ceiling.
    assert.strictEqual(sizing.size, 0.12);
    assert.isAtMost(sizing.plannedLossAtStopUsd, 1.239);
  });

  it("refuses when the largest feasible size cannot clear the exchange minimum", () => {
    const sizing = deriveFeasibleSize({ ...base, maximumPlannedRiskPerPositionUsd: 0.02 });

    assert.strictEqual(sizing.feasible, false);
    assert.strictEqual(sizing.constrainedBy, "below_exchange_minimum");
    assert.include(sizing.detail, "exchange minimum");
  });

  it("refuses a stop that is not on the losing side", () => {
    const longWithStopAbove = deriveFeasibleSize({ ...base, stopPrice: 2_010 });
    assert.strictEqual(longWithStopAbove.feasible, false);
    assert.strictEqual(longWithStopAbove.constrainedBy, "stop_on_wrong_side");

    const shortWithStopBelow = deriveFeasibleSize({ ...base, side: "sell", stopPrice: 1_990 });
    assert.strictEqual(shortWithStopBelow.feasible, false);
    assert.strictEqual(shortWithStopBelow.constrainedBy, "stop_on_wrong_side");

    const short = deriveFeasibleSize({ ...base, side: "sell", stopPrice: 2_010, requestedSize: 1 });
    assert.strictEqual(short.feasible, true);
    assert.strictEqual(short.plannedLossAtStopUsd, 10);
  });
});

describe("deriveEntryLimitPrice", () => {
  it("crosses the far side for a marketable order and rests on the near side otherwise", () => {
    const book = { bestBid: 1_999, bestAsk: 2_001, slippageBps: 50 };

    const buy = deriveEntryLimitPrice({ ...book, side: "buy", orderPreference: "marketable_ioc" });
    assert.isAbove(buy, book.bestAsk);

    const sell = deriveEntryLimitPrice({
      ...book,
      side: "sell",
      orderPreference: "marketable_ioc",
    });
    assert.isBelow(sell, book.bestBid);

    assert.strictEqual(
      deriveEntryLimitPrice({ ...book, side: "buy", orderPreference: "resting_limit" }),
      book.bestBid,
    );
    assert.strictEqual(
      deriveEntryLimitPrice({ ...book, side: "sell", orderPreference: "resting_limit" }),
      book.bestAsk,
    );
  });

  it("prices a post-only order at the near side, never through the book", () => {
    const book = { bestBid: 1_999, bestAsk: 2_001, slippageBps: 50 };

    const buy = deriveEntryLimitPrice({ ...book, side: "buy", orderPreference: "post_only" });
    assert.strictEqual(buy, book.bestBid);
    assert.isBelow(buy, book.bestAsk);

    const sell = deriveEntryLimitPrice({ ...book, side: "sell", orderPreference: "post_only" });
    assert.strictEqual(sell, book.bestAsk);
    assert.isAbove(sell, book.bestBid);
  });
});

describe("sizing to the plan's own profit target", () => {
  it("raises a too-small request to the notional the target needs", () => {
    // $6,000 of notional is 3 ETH at 2,000 — twice the 1.5 asked for.
    const sizing = deriveFeasibleSize({ ...base, requestedSize: 1.5, targetNotionalUsd: 6_000 });

    assert.strictEqual(sizing.feasible, true);
    assert.strictEqual(sizing.size, 3);
    assert.strictEqual(sizing.constrainedBy, "target_notional");
    assert.strictEqual(sizing.fundsTarget, true);
    assert.include(sizing.detail, "profit target");
  });

  it("never lowers a request that already funds the target", () => {
    const sizing = deriveFeasibleSize({ ...base, requestedSize: 4, targetNotionalUsd: 6_000 });

    assert.strictEqual(sizing.size, 4);
    assert.strictEqual(sizing.constrainedBy, "requested");
    assert.strictEqual(sizing.fundsTarget, true);
  });

  it("keeps every risk ceiling above the target, and reports the shortfall", () => {
    // The target wants $6,000 of notional; the gross ceiling allows $4,000.
    const sizing = deriveFeasibleSize({
      ...base,
      requestedSize: 1.5,
      targetNotionalUsd: 6_000,
      maximumGrossNotionalUsd: 4_000,
    });

    assert.strictEqual(sizing.feasible, true);
    assert.strictEqual(sizing.size, 2);
    assert.strictEqual(sizing.constrainedBy, "gross_notional");
    assert.strictEqual(sizing.fundsTarget, false);
  });

  it("is a no-op when no target notional is supplied", () => {
    const sizing = deriveFeasibleSize({ ...base, requestedSize: 1.5 });

    assert.strictEqual(sizing.size, 1.5);
    assert.strictEqual(sizing.constrainedBy, "requested");
    assert.strictEqual(sizing.fundsTarget, true);
  });
});

describe("TradingEnterInput", () => {
  it("rejects two competing size instructions", () => {
    const decode = Schema.decodeUnknownSync(TradingEnterInput);
    assert.throws(() =>
      decode({ market: "ETH", side: "buy", stopPrice: 1_900, sizeEth: 1, notionalUsd: 2_000 }),
    );
    assert.doesNotThrow(() => decode({ market: "ETH", side: "buy", stopPrice: 1_900, sizeEth: 1 }));
  });

  it("defaults urgency to now, and accepts an explicit patient", () => {
    const decode = Schema.decodeUnknownSync(TradingEnterInput);
    const base = { market: "ETH", side: "buy", stopPrice: 1_900 } as const;

    // The harness states urgency, never a time-in-force: an omitted one is a
    // request to cross now.
    assert.strictEqual(decode(base).urgency, "now");
    assert.strictEqual(decode({ ...base, urgency: "patient" }).urgency, "patient");
    assert.throws(() => decode({ ...base, urgency: "eventually" }));
  });
});
