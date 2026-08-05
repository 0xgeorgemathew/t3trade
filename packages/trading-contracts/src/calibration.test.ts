/**
 * The loop grading its own targets.
 *
 * The distinction every case here turns on: a target is REACHED when the trade
 * was ever worth it, not when it was banked there. Grading on the realised
 * result would blame the target for a decision to hold, and would let a target
 * nobody could ever reach look fine as long as the harness kept closing early.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  calibrateTargets,
  CALIBRATION_TOLERANCE_POINTS,
  MIN_CALIBRATION_TRADES,
  type CalibrationTrade,
} from "./calibration.ts";

const trade = (overrides: Partial<CalibrationTrade> = {}): CalibrationTrade => ({
  strategyVersion: 1,
  targetProfitUsd: 10,
  peakUnrealisedPnlUsd: 12,
  troughUnrealisedPnlUsd: -3,
  netPnlUsd: 6,
  claimedHitRatePercent: 50,
  ...overrides,
});

const many = (count: number, overrides: Partial<CalibrationTrade> = {}) =>
  Array.from({ length: count }, () => trade(overrides));

const calibrate = (trades: ReadonlyArray<CalibrationTrade>) =>
  calibrateTargets({ missionId: "mission_1", measuredAt: 1_000, trades });

describe("calibrateTargets", () => {
  it("scores a target on whether it was ever reached, not on what was banked", () => {
    // Every trade touched the target and every one was closed well under it.
    const result = calibrate(
      many(MIN_CALIBRATION_TRADES, { peakUnrealisedPnlUsd: 11, netPnlUsd: 1 }),
    );

    assert.equal(result.entries[0]?.reachedTargetCount, MIN_CALIBRATION_TRADES);
    assert.equal(result.entries[0]?.observedHitRatePercent, 100);
    // The target was fine; the closing was the thing that cost money. The
    // verdict must not conflate the two.
    assert.equal(result.entries[0]?.verdict, "conservative");
    assert.equal(result.meanNetPnlUsd, 1);
  });

  it("calls a target optimistic when it comes in well under its claim", () => {
    const reached = many(1, { peakUnrealisedPnlUsd: 12 });
    const missed = many(9, { peakUnrealisedPnlUsd: 4, netPnlUsd: -2 });
    const result = calibrate([...reached, ...missed]);

    const entry = result.entries[0];
    assert.equal(entry?.claimedHitRatePercent, 50);
    assert.equal(entry?.observedHitRatePercent, 10);
    assert.equal(entry?.verdict, "optimistic");
    assert.match(entry?.note ?? "", /nearer rung/);
    assert.match(result.recommendation, /nearer rung/);
  });

  it("calls one as claimed while it sits inside the tolerance", () => {
    // 6 of 10 reached against a claim of 50 — inside the band, so noise.
    const result = calibrate([
      ...many(6, { peakUnrealisedPnlUsd: 12 }),
      ...many(4, { peakUnrealisedPnlUsd: 3 }),
    ]);

    const entry = result.entries[0];
    assert.equal(entry?.observedHitRatePercent, 60);
    assert.ok(Math.abs(60 - 50) <= CALIBRATION_TOLERANCE_POINTS);
    assert.equal(entry?.verdict, "as_claimed");
    assert.match(result.recommendation, /in line with what they claimed/);
  });

  it("withholds a hit rate it does not have the sample for", () => {
    const result = calibrate(many(MIN_CALIBRATION_TRADES - 1));

    const entry = result.entries[0];
    assert.equal(entry?.tradeCount, MIN_CALIBRATION_TRADES - 1);
    // The count is published and the percentage is not: a rate off four trades
    // would read as evidence when it is arithmetic on noise.
    assert.equal(entry?.observedHitRatePercent, undefined);
    assert.equal(entry?.verdict, "insufficient_sample");
    assert.equal(result.overallReachedTargetPercent, undefined);
    assert.match(result.recommendation, /not enough to calibrate/);
  });

  it("scores each strategy version separately, newest first", () => {
    const result = calibrate([
      ...many(MIN_CALIBRATION_TRADES, { strategyVersion: 2, targetProfitUsd: 20 }),
      ...many(MIN_CALIBRATION_TRADES, { strategyVersion: 1, targetProfitUsd: 10 }),
    ]);

    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0]?.strategyVersion, 2);
    assert.equal(result.entries[1]?.strategyVersion, 1);
    // v2's target of 20 was never touched by a peak of 12; v1's 10 always was.
    assert.equal(result.entries[0]?.reachedTargetCount, 0);
    assert.equal(result.entries[1]?.reachedTargetCount, MIN_CALIBRATION_TRADES);
  });

  it("drops trades with no version or no target rather than scoring them", () => {
    const result = calibrate([
      ...many(MIN_CALIBRATION_TRADES),
      trade({ strategyVersion: null }),
      trade({ targetProfitUsd: null }),
      trade({ targetProfitUsd: 0 }),
    ]);

    // There is no claim to grade on any of those three.
    assert.equal(result.tradeCount, MIN_CALIBRATION_TRADES);
    assert.equal(result.entries.length, 1);
  });

  it("says nothing rather than recommending anything on an empty record", () => {
    const result = calibrate([]);

    assert.equal(result.tradeCount, 0);
    assert.deepEqual([...result.entries], []);
    assert.equal(result.overallReachedTargetPercent, undefined);
    assert.match(result.recommendation, /not enough to calibrate/);
  });

  it("grades a version whose basis claimed no hit rate without inventing one", () => {
    const result = calibrate(many(MIN_CALIBRATION_TRADES, { claimedHitRatePercent: null }));

    const entry = result.entries[0];
    assert.equal(entry?.claimedHitRatePercent, undefined);
    assert.equal(entry?.observedHitRatePercent, 100);
    assert.equal(entry?.verdict, "as_claimed");
    assert.match(entry?.note ?? "", /claimed no hit rate/);
  });
});
