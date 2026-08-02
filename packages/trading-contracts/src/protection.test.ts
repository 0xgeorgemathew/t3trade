/**
 * The mandatory-stop gate (§16.3 item 17, §17).
 *
 * The gate is pure, so it is pinned here once and the two callers — the §16.3
 * preview checklist and the execution service's pre-signing check — are proven
 * separately to route through it.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  checkStopInformation,
  describeStopGateDefect,
  isPositionIncreasing,
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
