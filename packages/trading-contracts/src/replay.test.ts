/**
 * Replaying a policy over bars that already happened — step 7 of the plan.
 *
 * The rule the plan states is that no threshold ships on a trade count, so the
 * tests that matter here are the ones that make a count-only improvement fail:
 * a candidate that takes more setups and earns less on each is held, and the
 * reason says which trap it fell into.
 */
import { describe, expect, it } from "vite-plus/test";

import type { MarketCandle } from "./market.ts";
import { TRADING_POLICY_V1, type TradingPolicy } from "./policy.ts";
import {
  comparePolicyReplays,
  MIN_REPLAY_SETUPS,
  replayPolicy,
  type PolicyReplayReport,
  type ReplayFixture,
} from "./replay.ts";

/** Closes into candles, with a wick either side so highs and lows are real. */
const bars = (closes: ReadonlyArray<number>, wick = 0.5): ReadonlyArray<MarketCandle> =>
  closes.map((close, index) => ({
    openTime: index * 60_000,
    closeTime: index * 60_000 + 59_999,
    open: closes[index - 1] ?? close,
    close,
    high: Math.max(close, closes[index - 1] ?? close) + wick,
    low: Math.min(close, closes[index - 1] ?? close) - wick,
    volume: 100,
  }));

/**
 * A window that chops around 3,000 and then closes decisively through its own
 * swing high on the last bar — the shape the breakout setup is defined by.
 */
const breakoutCloses = (): ReadonlyArray<number> => {
  const closes: Array<number> = [];
  for (let i = 0; i < 40; i++) closes.push(3_000 + (i % 4) * 4);
  let close = 3_010;
  for (let i = 0; i < 12; i++) {
    close += 3 + i;
    closes.push(close);
  }
  return closes;
};

const fixture = (over: Partial<ReplayFixture> = {}): ReplayFixture => ({
  name: "breakout",
  interval: "1m",
  history: bars(breakoutCloses()),
  forward: bars([3_124, 3_140, 3_160]),
  notionalUsd: 2_000,
  roundTripCostUsd: 2,
  playbook: "momentum",
  session: {
    minutesRemaining: 60,
    consecutiveNetLosses: 0,
    minutesSinceLastLoss: null,
  },
  ...over,
});

describe("replayPolicy", () => {
  it("reads only the history and settles only on the forward bars", () => {
    const report = replayPolicy([fixture()], TRADING_POLICY_V1);
    const result = report.results[0];

    expect(result?.setup?.kind).toBe("momentum_breakout");
    expect(result?.setup?.direction).toBe("up");
    expect(result?.targetUsd).toBeGreaterThan(fixture().roundTripCostUsd * 2);
    expect(report.policyVersion).toBe(TRADING_POLICY_V1.version);
  });

  it("counts a target reached, net of the round trip that reached it", () => {
    const report = replayPolicy([fixture()], TRADING_POLICY_V1);

    expect(report.setupsTaken).toBe(1);
    expect(report.targetsReached).toBe(1);
    expect(report.stopsHit).toBe(0);
    expect(report.grossUsd).toBeGreaterThan(0);
    expect(report.netUsd).toBeCloseTo(report.grossUsd - 2, 10);
    expect(report.meanNetUsd).toBe(report.netUsd);
  });

  it("counts a stop as a loss at the level the setup said it was wrong", () => {
    // Straight down through the broken level and away.
    const report = replayPolicy(
      [fixture({ forward: bars([3_080, 3_000, 2_980]) })],
      TRADING_POLICY_V1,
    );
    const result = report.results[0];

    expect(result?.outcome).toBe("stop");
    expect(report.netUsd).toBeLessThan(0);
    expect(report.worstNetUsd).toBe(report.netUsd);
    // Adverse excursion is measured on the way, not at the exit.
    expect(result?.adverseExcursionUsd).toBeLessThan(0);
    // A set that made no gross paid its costs out of nothing. Reporting 0%
    // would make the worst possible policy the best on this measure.
    expect(report.feeShareOfGrossPercent).toBe(100);
  });

  it("resolves a bar that reached both ways as the stop", () => {
    // Unresolvable from OHLC. Calling it the target would flatter every policy
    // by exactly the trades whose outcome nobody knows.
    const both = bars([3_082]).map((bar) => ({ ...bar, high: 3_200, low: 2_900 }));
    const report = replayPolicy([fixture({ forward: both })], TRADING_POLICY_V1);
    expect(report.results[0]?.outcome).toBe("stop");
  });

  it("marks an undecided window to its last close rather than dropping it", () => {
    const report = replayPolicy([fixture({ forward: bars([3_114, 3_115]) })], TRADING_POLICY_V1);
    expect(report.results[0]?.outcome).toBe("open");
    expect(report.setupsTaken).toBe(1);
  });

  it("declines a flat window without scoring it as anything", () => {
    const flat = fixture({
      name: "flat",
      history: bars(Array.from({ length: 52 }, () => 3_000)),
    });
    const report = replayPolicy([flat], TRADING_POLICY_V1);

    expect(report.results[0]?.outcome).toBe("declined");
    expect(report.setupsTaken).toBe(0);
    expect(report.meanNetUsd).toBe(0);
  });

  it("re-reads the same bars under a candidate's numbers", () => {
    // A candidate that will not call any direction still must not erase a
    // breakout that the final candle confirmed on its close.
    const deaf: TradingPolicy = {
      ...TRADING_POLICY_V1,
      version: 2,
      label: "direction threshold above anything reachable",
      readings: { ...TRADING_POLICY_V1.readings, directionScoreThreshold: 0.99 },
    };
    expect(replayPolicy([fixture()], TRADING_POLICY_V1).setupsTaken).toBe(1);
    // A just-confirmed breakout is deliberately allowed to lead the slow
    // direction score; the playbook says not to veto the armed signal on that
    // lagging measure. The threshold still changes range classification.
    expect(replayPolicy([fixture()], deaf).setupsTaken).toBe(1);
  });

  it("applies the cost multiple as an eligibility gate instead of manufacturing a target", () => {
    const report = replayPolicy([fixture({ roundTripCostUsd: 100 })], TRADING_POLICY_V1);
    expect(report.setupsTaken).toBe(0);
    expect(report.results[0]?.declineReason).toBe("costs_exceed_target");
  });

  it("replays the session cutoff and losing-streak cooldown", () => {
    const cutoff = fixture({
      session: { minutesRemaining: 15, consecutiveNetLosses: 0, minutesSinceLastLoss: null },
    });
    const cooldown = fixture({
      session: { minutesRemaining: 60, consecutiveNetLosses: 3, minutesSinceLastLoss: 10 },
    });
    expect(replayPolicy([cutoff]).results[0]?.declineReason).toBe("session_cutoff");
    expect(replayPolicy([cooldown]).results[0]?.declineReason).toBe("losing_streak_cooldown");
  });
});

const report = (over: Partial<PolicyReplayReport>): PolicyReplayReport => ({
  policyVersion: 1,
  policyLabel: "baseline",
  fixtures: 100,
  setupsTaken: 40,
  targetsReached: 20,
  stopsHit: 20,
  stillOpen: 0,
  grossUsd: 200,
  netUsd: 120,
  meanNetUsd: 3,
  feeShareOfGrossPercent: 40,
  worstNetUsd: -12,
  meanAdverseExcursionUsd: -4,
  results: [],
  ...over,
});

describe("comparePolicyReplays", () => {
  it("will not compare samples too small to mean anything", () => {
    const comparison = comparePolicyReplays(
      report({ setupsTaken: MIN_REPLAY_SETUPS - 1 }),
      report({ setupsTaken: 80 }),
    );
    expect(comparison.verdict).toBe("insufficient_sample");
  });

  // The whole reason this function exists. Every loosening produces more
  // trades; the only question is whether the extra ones paid.
  it("holds a candidate that trades more and earns less on each", () => {
    const comparison = comparePolicyReplays(
      report({}),
      report({ policyVersion: 2, setupsTaken: 90, netUsd: 180, meanNetUsd: 2 }),
    );
    expect(comparison.verdict).toBe("hold");
    expect(comparison.reasons[0]).toContain("trade-more trap");
    expect(comparison.reasons[0]).toContain("50 more");
  });

  it("holds a candidate whose expectancy holds but whose worst trade deepens", () => {
    const comparison = comparePolicyReplays(
      report({}),
      report({ policyVersion: 2, meanNetUsd: 3.5, worstNetUsd: -40 }),
    );
    expect(comparison.verdict).toBe("hold");
    expect(comparison.reasons.join(" ")).toContain("worst single result");
  });

  it("holds a candidate whose trades are smaller relative to their costs", () => {
    const comparison = comparePolicyReplays(
      report({}),
      report({ policyVersion: 2, meanNetUsd: 3.2, feeShareOfGrossPercent: 55 }),
    );
    expect(comparison.verdict).toBe("hold");
    expect(comparison.reasons.join(" ")).toContain("fees took");
  });

  it("ships a candidate that holds or improves on every measure — and still says to soak it", () => {
    const comparison = comparePolicyReplays(
      report({}),
      report({
        policyVersion: 2,
        meanNetUsd: 4,
        worstNetUsd: -10,
        feeShareOfGrossPercent: 36,
        meanAdverseExcursionUsd: -3,
      }),
    );
    expect(comparison.verdict).toBe("ship");
    expect(comparison.reasons[0]).toContain("testnet soak");
  });

  it("ships a candidate that takes FEWER trades for more each", () => {
    // The mirror of the trap: count is not evidence in either direction.
    const comparison = comparePolicyReplays(
      report({}),
      report({ policyVersion: 2, setupsTaken: 22, meanNetUsd: 6 }),
    );
    expect(comparison.verdict).toBe("ship");
  });
});
