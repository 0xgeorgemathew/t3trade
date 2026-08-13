/**
 * The versioned thresholds — step 7 of the viability plan.
 *
 * Two things are worth pinning. The first is that collecting the constants
 * changed none of them: every number the loop already ran on is still the
 * number it runs on, which is what makes the baseline a baseline. The second is
 * that the doctrine the harness reads states the same numbers the arithmetic
 * enforces, because a playbook saying 2.2x next to a gate checking 2.5x is the
 * exact failure this module exists to make impossible.
 */
import { describe, expect, it } from "vite-plus/test";

import { PROFIT_TARGET_COST_MULTIPLE } from "./costs.ts";
import { DIRECTION_SCORE_THRESHOLD } from "./momentum.ts";
import { PLAYBOOKS } from "./playbook.ts";
import {
  ACTIVE_TRADING_POLICY,
  assessEnrichment,
  assessEntryGovernance,
  MIN_ENRICHMENT_SAMPLE_RUNS,
  TRADING_POLICY_V1,
} from "./policy.ts";

const playbook = (name: string) => {
  const found = PLAYBOOKS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no playbook named ${name}`);
  return [...found.procedure, ...found.gates, ...found.standDownIf].join("\n");
};

describe("the policy in force", () => {
  it("is the baseline, to the digit", () => {
    // Not a style point. A v1 that differed from shipped behaviour would make
    // every later replay a comparison against a policy that never traded.
    expect(ACTIVE_TRADING_POLICY).toBe(TRADING_POLICY_V1);
    expect(TRADING_POLICY_V1.momentum.targetCostMultiple).toBe(2);
    expect(TRADING_POLICY_V1.momentum.directionScoreThreshold).toBe(0.15);
    expect(TRADING_POLICY_V1.rangeReversion.heightCostMultiple).toBe(2.2);
    expect(TRADING_POLICY_V1.rangeReversion.edgePercent).toBe(20);
    expect(TRADING_POLICY_V1.rangeReversion.stabilityPercent).toBe(30);
    expect(TRADING_POLICY_V1.rangeReversion.minBoundaryTouches).toBe(2);
    expect(TRADING_POLICY_V1.session.noNewEntryFinalMinutes).toBe(15);
    expect(TRADING_POLICY_V1.session.consecutiveLossesBeforeCooldown).toBe(3);
    expect(TRADING_POLICY_V1.session.cooldownMinutes).toBe(30);
  });

  it("is where the arithmetic gets its numbers", () => {
    expect(PROFIT_TARGET_COST_MULTIPLE).toBe(ACTIVE_TRADING_POLICY.momentum.targetCostMultiple);
    expect(DIRECTION_SCORE_THRESHOLD).toBe(ACTIVE_TRADING_POLICY.momentum.directionScoreThreshold);
  });

  it("is where the doctrine gets its numbers", () => {
    const range = playbook("range_reversion");
    expect(range).toContain(`${ACTIVE_TRADING_POLICY.rangeReversion.heightCostMultiple}x`);
    expect(range).toContain(`under ${ACTIVE_TRADING_POLICY.rangeReversion.stabilityPercent}`);
    expect(range).toContain(
      `between ${ACTIVE_TRADING_POLICY.rangeReversion.edgePercent} and ${100 - ACTIVE_TRADING_POLICY.rangeReversion.edgePercent}`,
    );

    expect(playbook("momentum")).toContain(
      `clear ${ACTIVE_TRADING_POLICY.momentum.targetCostMultiple}x the round-trip cost`,
    );
    expect(playbook("opening_range")).toContain(
      `${ACTIVE_TRADING_POLICY.openingRange.heightCostMultiple}x`,
    );

    // The session cutoff and the cooldown lived ONLY in this prose. They were
    // rules with no definition anywhere a change could be reviewed against.
    const standing = playbook("standing_rules");
    expect(standing).toContain(
      `final ${ACTIVE_TRADING_POLICY.session.noNewEntryFinalMinutes} minutes`,
    );
    expect(standing).toContain(`for ${ACTIVE_TRADING_POLICY.session.cooldownMinutes} minutes`);
    expect(standing).toContain(
      `After ${ACTIVE_TRADING_POLICY.session.consecutiveLossesBeforeCooldown} consecutive`,
    );
  });
});

describe("assessEnrichment", () => {
  it("refuses to conclude anything from a handful of runs", () => {
    const verdict = assessEnrichment([
      { standDownCode: "regime_unclear", runs: 9 },
      { standDownCode: "costs_exceed_target", runs: 1 },
    ]);
    expect(verdict.warranted).toBe(false);
    expect(verdict.reason).toContain("anecdote");
  });

  // The distinction the whole gate turns on: a loop that reads the market and
  // declines it does not need more market data. That is a working loop.
  it("does not warrant enrichment when the loop is reading and declining", () => {
    const verdict = assessEnrichment([
      { standDownCode: "costs_exceed_target", runs: 60 },
      { standDownCode: "insufficient_volatility", runs: 30 },
      { standDownCode: "regime_unclear", runs: 10 },
    ]);
    expect(verdict.sampleRuns).toBe(100);
    expect(verdict.regimeUnclearPercent).toBe(10);
    expect(verdict.warranted).toBe(false);
  });

  it("warrants it when the read, not the rules, is what fails", () => {
    const verdict = assessEnrichment([
      { standDownCode: "regime_unclear", runs: 40 },
      { standDownCode: "costs_exceed_target", runs: 30 },
      // Runs that traded carry no code and must not dilute the share.
      { standDownCode: null, runs: 500 },
    ]);
    expect(verdict.sampleRuns).toBe(70);
    expect(verdict.warranted).toBe(true);
    expect(verdict.regimeUnclearPercent).toBeGreaterThan(50);
  });

  it("does not dilute attribution with waiting, refusals, or silent runs", () => {
    const verdict = assessEnrichment([
      { standDownCode: "regime_unclear", runs: 40 },
      { standDownCode: "costs_exceed_target", runs: 30 },
      { standDownCode: "awaiting_trigger", runs: 500 },
      { standDownCode: "preview_refused", runs: 500 },
      { standDownCode: "not_published", runs: 500 },
    ]);
    expect(verdict.sampleRuns).toBe(70);
    expect(verdict.regimeUnclearPercent).toBeGreaterThan(50);
  });

  it("says nothing at all about an empty record", () => {
    const verdict = assessEnrichment([]);
    expect(verdict.warranted).toBe(false);
    expect(verdict.sampleRuns).toBe(0);
    expect(verdict.reason).toContain(String(MIN_ENRICHMENT_SAMPLE_RUNS));
  });
});

describe("assessEntryGovernance", () => {
  const trade = (input: {
    readonly scored: boolean;
    readonly regime: string | null;
    readonly net: number;
  }) => ({
    scoredSetupBehindIt: input.scored,
    setupKindAtEntry: input.scored ? "range_reversion" : null,
    regimeAtEntry: input.regime,
    netPnlUsd: input.net,
  });

  it("splits wins and losses by whether a scored setup was behind the entry", () => {
    const evidence = assessEntryGovernance([
      trade({ scored: true, regime: "ranging", net: 4 }),
      trade({ scored: true, regime: "ranging", net: -2 }),
      trade({ scored: false, regime: "transition", net: -6 }),
      trade({ scored: false, regime: null, net: -3 }),
    ]);

    expect(evidence.scored).toEqual({ trades: 2, wins: 1, losses: 1, netUsd: 2 });
    expect(evidence.unscored).toEqual({ trades: 2, wins: 0, losses: 2, netUsd: -9 });
  });

  it("attributes losses to the regime read in force at entry, worst first", () => {
    const evidence = assessEntryGovernance([
      trade({ scored: true, regime: "ranging", net: -10 }),
      trade({ scored: true, regime: "ranging", net: -5 }),
      trade({ scored: true, regime: "trending", net: 8 }),
      trade({ scored: false, regime: null, net: -1 }),
    ]);

    expect(evidence.lossesByRegime[0]).toEqual({
      regime: "ranging",
      trades: 2,
      losses: 2,
      netUsd: -15,
    });
    expect(evidence.reason).toContain("ranging");
  });

  it("admits an empty record instead of inventing a split", () => {
    const evidence = assessEntryGovernance([]);
    expect(evidence.scored.trades).toBe(0);
    expect(evidence.unscored.trades).toBe(0);
    expect(evidence.lossesByRegime).toEqual([]);
    expect(evidence.reason).toContain("nothing to say");
  });
});
