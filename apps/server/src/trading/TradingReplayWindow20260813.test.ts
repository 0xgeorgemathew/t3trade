/**
 * The 2026-08-13 window, replayed — plan 27 D1/D2.
 *
 * The fixtures are checked-in candles, so these replays are deterministic:
 * the figures pinned here are the window's actual answer under the policy in
 * force, and any arithmetic change that silently rewrites a historical
 * verdict fails here first.
 *
 * What the window actually said, and what this file therefore enforces:
 * under V1 the morning was almost entirely a decline — 28 fixtures per
 * playbook, momentum took none (the grind never expanded ATR until the
 * breakdown), range reversion took exactly one setup and won it, the ORB
 * window never qualified. One setup is not a sample, so the comparison
 * machinery answers `insufficient_sample` for ANY candidate on this window
 * alone — which is the discipline working, not failing: no threshold (G5
 * stop widening, I2 cadence, I4 sizing, B3 numbers) ships off six hours of
 * one morning. More windows accumulate before any of them move.
 */
import { assert, describe, it } from "@effect/vitest";

import { TRADING_POLICY_V1 } from "@t3tools/trading-contracts/policy";
import {
  comparePolicyReplays,
  MIN_REPLAY_SETUPS,
  replayPolicy,
} from "@t3tools/trading-contracts/replay";

import { loadWindowCandles, windowFixtures } from "./TradingReplayWindow20260813.ts";

const WINDOW_END_UTC = Date.UTC(2026, 7, 13, 12, 0, 0);

describe("the recorded window (D1)", () => {
  it("carries the testnet feed's own candles, ending at 12:00 UTC", () => {
    const oneMinute = loadWindowCandles("1m");
    assert.equal(oneMinute.length, 501);
    assert.equal(oneMinute[0]?.openTime, Date.UTC(2026, 7, 13, 3, 40, 0));
    assert.equal(oneMinute[oneMinute.length - 1]?.openTime, WINDOW_END_UTC);

    // Prices decoded, oldest-first, every bar coherent.
    for (const candle of oneMinute) {
      assert.ok(candle.high >= candle.low);
      assert.ok(candle.high >= Math.max(candle.open, candle.close));
      assert.ok(candle.low <= Math.min(candle.open, candle.close));
    }

    assert.equal(loadWindowCandles("5m").length, 193);
    assert.equal(loadWindowCandles("15m").length, 145);
    assert.equal(loadWindowCandles("1h").length, 133);
  });

  it("cuts the same fixtures every time", () => {
    const fixtures = windowFixtures("momentum");
    // 1m: (501-260)/20 → 13, 5m: (193-132)/12 → 6, 15m: (145-104)/8 → 6,
    // 1h: (133-124)/4 → 3.
    assert.equal(fixtures.length, 28);
    // Contract: the setup finder never sees a forward bar.
    for (const fixture of fixtures) {
      const lastHistory = fixture.history[fixture.history.length - 1];
      const firstForward = fixture.forward[0];
      assert.ok((lastHistory?.openTime ?? 0) < (firstForward?.openTime ?? 0));
    }
  });
});

describe("the window under the policy in force (D2)", () => {
  it("declined the grind under V1 — momentum took nothing before the breakdown", () => {
    const report = replayPolicy(windowFixtures("momentum"), TRADING_POLICY_V1);
    assert.equal(report.fixtures, 28);
    assert.equal(report.setupsTaken, 0);
    // The morning's declines were structural, not threshold-marginal.
    const reasons = new Set(report.results.map((result) => result.declineReason));
    assert.ok(reasons.has("atr_not_expanding") || reasons.has("momentum_structure_not_eligible"));
  });

  it("took exactly one range setup, and won it", () => {
    const report = replayPolicy(windowFixtures("range_reversion"), TRADING_POLICY_V1);
    assert.equal(report.setupsTaken, 1);
    assert.equal(report.targetsReached, 1);
    assert.equal(report.stopsHit, 0);
    assert.equal(report.netUsd, 2.41);
  });

  it("never qualified an opening-range break", () => {
    const report = replayPolicy(windowFixtures("opening_range"), TRADING_POLICY_V1);
    assert.equal(report.setupsTaken, 0);
  });

  // The plan's rule made executable: every threshold change (G5, I2, I4, B3
  // numbers) waits for a replay verdict, and this window alone cannot give
  // one. A candidate that loosens the very thresholds the morning's declines
  // named still takes nothing more — so the honest verdict is a sample
  // problem, not a threshold problem, and nothing ships off it.
  it("refuses to ship any candidate off this window alone", () => {
    const candidate = {
      ...TRADING_POLICY_V1,
      version: 2,
      label: "candidate: earlier trend calls, cheaper targets",
      momentum: { targetCostMultiple: 1.5, directionScoreThreshold: 0.1 },
      rangeReversion: { ...TRADING_POLICY_V1.rangeReversion, heightCostMultiple: 1.8 },
    };

    for (const playbook of ["momentum", "range_reversion"] as const) {
      const fixtures = windowFixtures(playbook);
      const comparison = comparePolicyReplays(
        replayPolicy(fixtures, TRADING_POLICY_V1),
        replayPolicy(fixtures, candidate),
      );
      assert.equal(comparison.verdict, "insufficient_sample");
      assert.ok(comparison.candidate.setupsTaken < MIN_REPLAY_SETUPS);
    }
  });
});
