/**
 * The bounded stop-adjustment policy (plan 24 §5.3).
 *
 * The tool is a thin wrapper over `replaceProtection`, so every rule that makes
 * it safe lives here and is proven here. Each case moves exactly one number away
 * from a baseline that passes, so a refusal is always attributable.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  checkStopAdjustment,
  plannedLossAtStopUsd,
  STOP_ADJUSTMENT_LIMITS,
  stopProximityWatchLevel,
  type StopAdjustmentPolicyInput,
} from "./stopAdjustment.ts";

const MINUTE = 60_000;

/**
 * A long of 1 ETH entered at 1,900 with its stop 20 below, now 20 in profit and
 * trailing the stop 4 higher. Everything clears: the step is 4 against a cap of
 * min(0.5 x 10, 0.25 x 40) = 5, the new stop sits 36 from the mark against a
 * noise floor of 3.5, and it is still on the losing side of entry.
 */
const longTrail: StopAdjustmentPolicyInput = {
  positionSize: 1,
  entryPrice: 1_900,
  markPrice: 1_920,
  currentStopPrice: 1_880,
  newStopPrice: 1_884,
  originalStopPrice: 1_880,
  targetPrice: 1_960,
  serverAtrUsd: 10,
  observedAtrUsd: 10,
  halfSpreadUsd: 0.25,
  nowMillis: 100 * MINUTE,
  barMillis: MINUTE,
  lastAdjustmentAtMillis: 90 * MINUTE,
  adjustmentsThisPosition: 2,
};

/** The mirror: a short of 1 ETH at 1,900, stop above, trailing down. */
const shortTrail: StopAdjustmentPolicyInput = {
  ...longTrail,
  positionSize: -1,
  markPrice: 1_880,
  currentStopPrice: 1_920,
  newStopPrice: 1_916,
  originalStopPrice: 1_920,
  targetPrice: 1_840,
};

describe("plannedLossAtStopUsd", () => {
  it("prices the adverse move at the stop, both directions", () => {
    expect(plannedLossAtStopUsd({ positionSize: 2, entryPrice: 1_900, stopPrice: 1_880 })).toBe(40);
    expect(plannedLossAtStopUsd({ positionSize: -2, entryPrice: 1_900, stopPrice: 1_920 })).toBe(
      40,
    );
  });

  it("reports no loss for a stop already on the winning side", () => {
    expect(plannedLossAtStopUsd({ positionSize: 1, entryPrice: 1_900, stopPrice: 1_910 })).toBe(0);
  });
});

describe("checkStopAdjustment", () => {
  it("allows the trailing step it exists for, long and short", () => {
    expect(checkStopAdjustment(longTrail)).toBeNull();
    expect(checkStopAdjustment(shortTrail)).toBeNull();
  });

  // Rule 6 of §5.3: the same wrong-side check `modify_stop` runs, reported
  // before anything else, because a stop through the mark fires as it rests.
  it("refuses a stop on the wrong side of the mark", () => {
    expect(checkStopAdjustment({ ...longTrail, newStopPrice: 1_925 })).toBe("wrong_side");
    expect(checkStopAdjustment({ ...shortTrail, newStopPrice: 1_875 })).toBe("wrong_side");
  });

  // Rule 1: risk never grows past the plan.
  describe("the risk envelope", () => {
    it("refuses a stop that would risk more than the entry was approved with", () => {
      expect(checkStopAdjustment({ ...longTrail, newStopPrice: 1_877 })).toBe("risk_envelope");
      expect(checkStopAdjustment({ ...shortTrail, newStopPrice: 1_923 })).toBe("risk_envelope");
    });

    it("allows loosening back toward — but not past — the original stop", () => {
      const tightened = { ...longTrail, currentStopPrice: 1_884, originalStopPrice: 1_880 };
      expect(checkStopAdjustment({ ...tightened, newStopPrice: 1_881 })).toBeNull();
      expect(checkStopAdjustment({ ...tightened, newStopPrice: 1_879.9 })).toBe("risk_envelope");
    });
  });

  // Rule 2: the ATR step cap, and the cross-check on the agent's own number.
  describe("the step cap", () => {
    it("refuses a step past half an ATR", () => {
      // Stop distance 40 makes the fractional cap 10, so 0.5 x ATR = 5 binds.
      expect(checkStopAdjustment({ ...longTrail, newStopPrice: 1_885.5 })).toBe("step_too_large");
    });

    it("refuses a step past a quarter of the current stop distance", () => {
      // Mark 4 above the stop: the fractional cap is 1, inside 0.5 x ATR of 2.
      const close = {
        ...longTrail,
        serverAtrUsd: 4,
        observedAtrUsd: 4,
        markPrice: 1_888,
        currentStopPrice: 1_884,
      };
      expect(checkStopAdjustment({ ...close, newStopPrice: 1_884.9 })).toBeNull();
      expect(checkStopAdjustment({ ...close, newStopPrice: 1_885.5 })).toBe("step_too_large");
    });

    it("refuses when the agent's measured ATR diverges from the server's", () => {
      const limit = STOP_ADJUSTMENT_LIMITS.maximumAtrDivergence;
      expect(checkStopAdjustment({ ...longTrail, observedAtrUsd: 10 * (1 + limit) })).toBeNull();
      expect(checkStopAdjustment({ ...longTrail, observedAtrUsd: 14 })).toBe("atr_mismatch");
      expect(checkStopAdjustment({ ...longTrail, observedAtrUsd: 6 })).toBe("atr_mismatch");
    });
  });

  // Rule 3: never choke the trade — the noise floor and the 50%-to-target cap.
  describe("the room the trade needs", () => {
    it("refuses a stop inside the ATR noise floor", () => {
      // 0.35 x ATR = 3.5 from a mark of 1,920.
      const near = { ...longTrail, currentStopPrice: 1_916.5, markPrice: 1_920 };
      expect(checkStopAdjustment({ ...near, newStopPrice: 1_916.4 })).toBeNull();
      expect(checkStopAdjustment({ ...near, newStopPrice: 1_916.6 })).toBe("noise_floor");
    });

    it("refuses a stop inside twice the half-spread when the spread is what binds", () => {
      // Half-spread 4 puts the floor at 8, well past the ATR's own 1.4.
      const wideSpread = {
        ...longTrail,
        serverAtrUsd: 4,
        observedAtrUsd: 4,
        halfSpreadUsd: 4,
        currentStopPrice: 1_912.4,
        markPrice: 1_920,
      };
      expect(checkStopAdjustment({ ...wideSpread, newStopPrice: 1_911.5 })).toBeNull();
      expect(checkStopAdjustment({ ...wideSpread, newStopPrice: 1_912.5 })).toBe("noise_floor");
    });

    it("refuses dragging the stop more than halfway from entry to target", () => {
      // Entry 1,900, target 1,960: the cap is 1,930.
      const deepWinner = {
        ...longTrail,
        markPrice: 1_958,
        currentStopPrice: 1_929,
        adjustmentsThisPosition: 0,
      };
      expect(checkStopAdjustment({ ...deepWinner, newStopPrice: 1_930 })).toBeNull();
      expect(checkStopAdjustment({ ...deepWinner, newStopPrice: 1_932 })).toBe(
        "target_encroachment",
      );
    });

    it("has no target cap to apply when the strategy names no target price", () => {
      const noTarget = {
        ...longTrail,
        markPrice: 1_958,
        currentStopPrice: 1_929,
        adjustmentsThisPosition: 0,
        targetPrice: undefined,
      };
      expect(checkStopAdjustment({ ...noTarget, newStopPrice: 1_932 })).toBeNull();
    });
  });

  // Rule 4: the breakeven ratchet.
  describe("the breakeven ratchet", () => {
    const ratcheted = {
      ...longTrail,
      markPrice: 1_940,
      currentStopPrice: 1_902,
      originalStopPrice: 1_880,
      adjustmentsThisPosition: 0,
    };

    it("refuses moving a winning-side stop back below entry", () => {
      expect(checkStopAdjustment({ ...ratcheted, newStopPrice: 1_899 })).toBe("breakeven_ratchet");
    });

    it("still allows loosening within the winning side", () => {
      expect(checkStopAdjustment({ ...ratcheted, newStopPrice: 1_900 })).toBeNull();
    });

    it("mirrors for a short", () => {
      const shortRatcheted = {
        ...shortTrail,
        markPrice: 1_860,
        currentStopPrice: 1_898,
        originalStopPrice: 1_920,
        adjustmentsThisPosition: 0,
      };
      expect(checkStopAdjustment({ ...shortRatcheted, newStopPrice: 1_901 })).toBe(
        "breakeven_ratchet",
      );
      expect(checkStopAdjustment({ ...shortRatcheted, newStopPrice: 1_900 })).toBeNull();
    });
  });

  // Rule 5: trailing, not twitching.
  describe("the adjustment budget", () => {
    it("refuses a second adjustment inside three primary-timeframe bars", () => {
      const tooSoon = { ...longTrail, lastAdjustmentAtMillis: longTrail.nowMillis - 2 * MINUTE };
      expect(checkStopAdjustment(tooSoon)).toBe("adjustment_budget");
      expect(
        checkStopAdjustment({
          ...longTrail,
          lastAdjustmentAtMillis: longTrail.nowMillis - 3 * MINUTE,
        }),
      ).toBeNull();
    });

    it("refuses past the per-position cap", () => {
      const spent = {
        ...longTrail,
        adjustmentsThisPosition: STOP_ADJUSTMENT_LIMITS.maximumAdjustmentsPerPosition,
      };
      expect(checkStopAdjustment(spent)).toBe("adjustment_budget");
    });

    it("does not rate-limit the first adjustment on a position", () => {
      expect(
        checkStopAdjustment({
          ...longTrail,
          adjustmentsThisPosition: 0,
          lastAdjustmentAtMillis: undefined,
        }),
      ).toBeNull();
    });
  });
});

describe("stopProximityWatchLevel", () => {
  it("wakes a long on the way down, one ATR above its stop", () => {
    expect(
      stopProximityWatchLevel({
        positionSize: 1,
        stopPrice: 1_880,
        markPrice: 1_920,
        atrUsd: 10,
      }),
    ).toEqual({ price: 1_890, direction: "below" });
  });

  it("wakes a short on the way up, one ATR below its stop", () => {
    expect(
      stopProximityWatchLevel({
        positionSize: -1,
        stopPrice: 1_920,
        markPrice: 1_880,
        atrUsd: 10,
      }),
    ).toEqual({ price: 1_910, direction: "above" });
  });

  // A level already through the mark is not coverage; it is an immediate wake.
  it("arms nothing when the level is already behind the mark", () => {
    expect(
      stopProximityWatchLevel({ positionSize: 1, stopPrice: 1_880, markPrice: 1_885, atrUsd: 10 }),
    ).toBeNull();
  });

  it("arms nothing without a usable ATR or a position", () => {
    expect(
      stopProximityWatchLevel({ positionSize: 1, stopPrice: 1_880, markPrice: 1_920, atrUsd: 0 }),
    ).toBeNull();
    expect(
      stopProximityWatchLevel({ positionSize: 0, stopPrice: 1_880, markPrice: 1_920, atrUsd: 10 }),
    ).toBeNull();
  });
});
