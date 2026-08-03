/**
 * The mandatory-stop gate (§16.3 item 17, §17).
 *
 * The gate is pure, so it is pinned here once and the two callers — the §16.3
 * preview checklist and the execution service's pre-signing check — are proven
 * separately to route through it.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  checkStopReplacement,
  checkStopInformation,
  confirmedProtectedSize,
  describeStopGateDefect,
  EXPOSURE_REDUCING_ACTION_TYPES,
  isFullyProtected,
  isPositionIncreasing,
  isProtectiveOrder,
  type ProtectiveOrderCandidate,
  type StopGateInput,
} from "./protection.ts";

const longEntry = {
  actionType: "open",
  side: "buy",
  referencePrice: 3_750,
  stop: { stopPrice: 3_700, plannedLossAtStopUsd: 18 },
} satisfies StopGateInput;

describe("isPositionIncreasing", () => {
  it("names open and scale_in as increasing", () => {
    expect(isPositionIncreasing("open")).toBe(true);
    expect(isPositionIncreasing("scale_in")).toBe(true);
  });

  it("names cancel, reduce, and close as reducing", () => {
    expect(isPositionIncreasing("cancel")).toBe(false);
    expect(isPositionIncreasing("reduce")).toBe(false);
    expect(isPositionIncreasing("close")).toBe(false);
  });

  it("fails closed on an action type it has never seen", () => {
    // A new action added later inherits the stop gate rather than slipping
    // past it, which is the direction a safety gate has to fail in.
    expect(isPositionIncreasing("reverse")).toBe(true);
  });

  it("agrees with the exported list the exhaustion SQL reads", () => {
    // `TradingExecutionGuard.blockForExhaustion` cancels everything outside
    // this list. If the two ever disagree, that query starts cancelling the
    // protective orders it is meant to leave alone.
    for (const actionType of EXPOSURE_REDUCING_ACTION_TYPES) {
      expect(isPositionIncreasing(actionType)).toBe(false);
    }
  });
});

describe("checkStopInformation", () => {
  it("passes a long whose stop sits below the entry", () => {
    expect(checkStopInformation(longEntry)).toBeNull();
  });

  it("passes a short whose stop sits above the entry", () => {
    expect(
      checkStopInformation({
        ...longEntry,
        side: "sell",
        stop: { stopPrice: 3_800, plannedLossAtStopUsd: 18 },
      }),
    ).toBeNull();
  });

  it("refuses a position-increasing intent carrying no stop", () => {
    expect(checkStopInformation({ ...longEntry, stop: undefined })).toBe("stop_missing");
  });

  it("refuses a scale-in carrying no stop", () => {
    expect(checkStopInformation({ ...longEntry, actionType: "scale_in", stop: undefined })).toBe(
      "stop_missing",
    );
  });

  it("refuses a stop priced at or below zero", () => {
    expect(
      checkStopInformation({
        ...longEntry,
        stop: { stopPrice: 0, plannedLossAtStopUsd: 18 },
      }),
    ).toBe("stop_price_not_positive");
  });

  it("refuses a long whose stop sits above the entry", () => {
    expect(
      checkStopInformation({
        ...longEntry,
        stop: { stopPrice: 3_800, plannedLossAtStopUsd: 18 },
      }),
    ).toBe("stop_on_wrong_side_of_entry");
  });

  it("refuses a short whose stop sits below the entry", () => {
    expect(
      checkStopInformation({
        ...longEntry,
        side: "sell",
        stop: { stopPrice: 3_700, plannedLossAtStopUsd: 18 },
      }),
    ).toBe("stop_on_wrong_side_of_entry");
  });

  it("exempts a reduce-only close, which is itself the exit", () => {
    // Demanding a stop here would reject the one action that removes exposure.
    expect(
      checkStopInformation({
        actionType: "close",
        side: "sell",
        referencePrice: 3_750,
        stop: undefined,
      }),
    ).toBeNull();
  });

  it("exempts a reduce and a cancel", () => {
    for (const actionType of ["reduce", "cancel"]) {
      expect(
        checkStopInformation({ actionType, side: "sell", referencePrice: 3_750, stop: undefined }),
      ).toBeNull();
    }
  });

  it("does not second-guess a stop the exit happens to carry", () => {
    // A close inheriting the entry's stop would look "wrong-sided" once the
    // side flips. The exemption is on the action, not on the stop's shape.
    expect(
      checkStopInformation({
        actionType: "close",
        side: "sell",
        referencePrice: 3_750,
        stop: { stopPrice: 3_700, plannedLossAtStopUsd: 18 },
      }),
    ).toBeNull();
  });
});

describe("describeStopGateDefect", () => {
  it("names the section for a missing stop", () => {
    const input = { ...longEntry, stop: undefined };
    expect(describeStopGateDefect("stop_missing", input)).toContain("§16.3 item 17");
    expect(describeStopGateDefect("stop_missing", input)).toContain("open");
  });

  it("reports both prices for a wrong-sided stop", () => {
    const message = describeStopGateDefect("stop_on_wrong_side_of_entry", longEntry);
    expect(message).toContain("3700");
    expect(message).toContain("3750");
  });
});

// ---------------------------------------------------------------------------
// §17.2 steps 7–8 · Confirming protection from canonical state
// ---------------------------------------------------------------------------

const stopOrder = (
  overrides: Partial<ProtectiveOrderCandidate> = {},
): ProtectiveOrderCandidate => ({
  market: "ETH",
  side: "sell",
  remainingSize: 0.5,
  reduceOnly: true,
  isTrigger: true,
  triggerPrice: 3_700,
  ...overrides,
});

/** A long of 0.5 ETH marked at 3750. */
const longAt = (openOrders: ReadonlyArray<ProtectiveOrderCandidate>) => ({
  market: "ETH",
  positionSize: 0.5,
  referencePrice: 3_750,
  openOrders,
});

describe("isProtectiveOrder", () => {
  it("accepts a reduce-only sell trigger below a long", () => {
    expect(isProtectiveOrder(stopOrder(), longAt([stopOrder()]))).toBe(true);
  });

  it("rejects an order that is not reduce-only", () => {
    const order = stopOrder({ reduceOnly: false });
    expect(isProtectiveOrder(order, longAt([order]))).toBe(false);
  });

  it("rejects a plain limit order sitting at the same price", () => {
    const order = stopOrder({ isTrigger: false, triggerPrice: undefined });
    expect(isProtectiveOrder(order, longAt([order]))).toBe(false);
  });

  it("rejects a trigger on the increasing side", () => {
    // A buy trigger under a long adds exposure; it protects nothing.
    const order = stopOrder({ side: "buy" });
    expect(isProtectiveOrder(order, longAt([order]))).toBe(false);
  });

  it("rejects a take-profit above a long", () => {
    // A TP is also a reduce-only trigger on the reducing side. Counting it as
    // protection would report the position safe with its whole downside open.
    const order = stopOrder({ triggerPrice: 3_900 });
    expect(isProtectiveOrder(order, longAt([order]))).toBe(false);
  });

  it("rejects a take-profit below a short", () => {
    const order = stopOrder({ side: "buy", triggerPrice: 3_600 });
    expect(
      isProtectiveOrder(order, {
        market: "ETH",
        positionSize: -0.5,
        referencePrice: 3_750,
        openOrders: [order],
      }),
    ).toBe(false);
  });

  it("accepts a reduce-only buy trigger above a short", () => {
    const order = stopOrder({ side: "buy", triggerPrice: 3_800 });
    expect(
      isProtectiveOrder(order, {
        market: "ETH",
        positionSize: -0.5,
        referencePrice: 3_750,
        openOrders: [order],
      }),
    ).toBe(true);
  });

  it("rejects an order on another market", () => {
    const order = stopOrder({ market: "BTC" });
    expect(isProtectiveOrder(order, longAt([order]))).toBe(false);
  });

  it("rejects a fully consumed order", () => {
    const order = stopOrder({ remainingSize: 0 });
    expect(isProtectiveOrder(order, longAt([order]))).toBe(false);
  });
});

describe("confirmedProtectedSize", () => {
  it("reports zero when nothing rests", () => {
    expect(confirmedProtectedSize(longAt([]))).toBe(0);
  });

  it("reports the covered size for a full-size stop", () => {
    expect(confirmedProtectedSize(longAt([stopOrder()]))).toBe(0.5);
    expect(isFullyProtected(longAt([stopOrder()]))).toBe(true);
  });

  it("reports partial coverage when the stop is smaller than the position", () => {
    // The §17.3 shape: an entry partially filled, the stop sized to the slice
    // that was live when it was placed.
    const input = longAt([stopOrder({ remainingSize: 0.2 })]);
    expect(confirmedProtectedSize(input)).toBe(0.2);
    expect(isFullyProtected(input)).toBe(false);
  });

  it("sums overlapping stops during a §17.4 replacement", () => {
    const input = longAt([
      stopOrder({ remainingSize: 0.2 }),
      stopOrder({ remainingSize: 0.3, triggerPrice: 3_690 }),
    ]);
    expect(confirmedProtectedSize(input)).toBe(0.5);
  });

  it("clamps coverage to the position rather than reporting over-protection", () => {
    const input = longAt([stopOrder({ remainingSize: 5 })]);
    expect(confirmedProtectedSize(input)).toBe(0.5);
  });

  it("ignores non-protective orders when summing", () => {
    const input = longAt([
      stopOrder({ remainingSize: 0.2 }),
      stopOrder({ remainingSize: 0.3, reduceOnly: false }),
      stopOrder({ remainingSize: 0.3, triggerPrice: 3_900 }),
    ]);
    expect(confirmedProtectedSize(input)).toBe(0.2);
  });

  it("calls a flat position fully protected", () => {
    const input = { market: "ETH", positionSize: 0, referencePrice: 3_750, openOrders: [] };
    expect(confirmedProtectedSize(input)).toBe(0);
    expect(isFullyProtected(input)).toBe(true);
  });
});

describe("checkStopReplacement", () => {
  it("accepts a stop below the mark on a long and above it on a short", () => {
    expect(
      checkStopReplacement({ positionSize: 0.5, referencePrice: 3_000, stopPrice: 2_950 }),
    ).toBeNull();
    expect(
      checkStopReplacement({ positionSize: -0.5, referencePrice: 3_000, stopPrice: 3_050 }),
    ).toBeNull();
  });

  it("rejects a stop that would trigger the instant it rests", () => {
    // A long stopped above the mark, and a short stopped below it. Neither is
    // protection; both are an immediate exit at whatever the book pays.
    expect(
      checkStopReplacement({ positionSize: 0.5, referencePrice: 3_000, stopPrice: 3_050 }),
    ).toBe("stop_on_wrong_side_of_entry");
    expect(
      checkStopReplacement({ positionSize: -0.5, referencePrice: 3_000, stopPrice: 2_950 }),
    ).toBe("stop_on_wrong_side_of_entry");
  });

  it("rejects a stop exactly at the mark", () => {
    expect(
      checkStopReplacement({ positionSize: 0.5, referencePrice: 3_000, stopPrice: 3_000 }),
    ).toBe("stop_on_wrong_side_of_entry");
  });

  it("rejects a non-positive stop price", () => {
    expect(checkStopReplacement({ positionSize: 0.5, referencePrice: 3_000, stopPrice: 0 })).toBe(
      "stop_price_not_positive",
    );
  });

  it("treats moving a stop as exposure-reducing, so it needs no stop of its own", () => {
    // `modify_stop` replaces one reduce-only trigger with another; the
    // mandatory-stop gate must not demand a stop for the action that IS one.
    expect(isPositionIncreasing("modify_stop")).toBe(false);
  });
});
