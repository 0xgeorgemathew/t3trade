/**
 * Replaying a policy over bars that already happened.
 *
 * The assessment's rule for this step is that no threshold ships on a trade
 * count. That rule needs somewhere to be enforced, because "we loosened the
 * range multiple and got more trades" is both true and worthless on its own —
 * every loosening produces more trades, and the only question is whether the
 * extra ones paid.
 *
 * So a candidate policy is run over recorded windows the way the live loop
 * would read them: the setup finder sees the history and nothing else, the
 * outcome comes from bars it never saw, and the comparison against the shipped
 * baseline holds net expectancy, drawdown, fee share, and adverse excursion —
 * with the count reported alongside and never counted as evidence.
 *
 * Two honest limits. The fill is assumed at the last close of the history, so
 * this measures the setup and the thresholds, not the execution path; and a
 * fixture is a window somebody chose, so a replay that looks good is a reason to
 * run a testnet soak, never a substitute for one.
 *
 * @module TradingReplay
 */
import type { MarketCandle, MarketCandleInterval } from "./market.ts";
import {
  analyseMomentum,
  analyseTimeframe,
  type CandidateSetup,
  type MomentumTimeframeContext,
} from "./momentum.ts";
import { ACTIVE_TRADING_POLICY, type TradingPolicy } from "./policy.ts";

/** One recorded window: what the policy may read, and what settles it. */
export interface ReplayFixture {
  readonly name: string;
  readonly interval: MarketCandleInterval;
  /** The bars the setup is read from. Everything the policy is allowed to see. */
  readonly history: ReadonlyArray<MarketCandle>;
  /** The bars that decide the outcome. Never shown to the setup finder. */
  readonly forward: ReadonlyArray<MarketCandle>;
  /** The notional the trade would have been taken at. */
  readonly notionalUsd: number;
  /** What one round trip costs on that notional, in USD. */
  readonly roundTripCostUsd: number;
  /** The playbook that was actually in force for this recorded decision. */
  readonly playbook: "momentum" | "range_reversion" | "opening_range";
  /** Session facts the standing rules read before allowing a new entry. */
  readonly session: ReplaySessionState;
  /** Opening-range length for ORB fixtures. Must be 15–20 one-minute bars. */
  readonly openingRangeBars?: number | undefined;
}

export interface ReplaySessionState {
  readonly minutesRemaining: number;
  readonly consecutiveNetLosses: number;
  /** Null when there is no active losing streak. */
  readonly minutesSinceLastLoss: number | null;
}

/** How one fixture resolved. */
export type ReplayOutcome =
  /** The policy found nothing to take. Not a loss — a correct decline, maybe. */
  | "declined"
  /** The target was reached before the stop. */
  | "target"
  /** The stop was reached before the target. */
  | "stop"
  /** Neither, in the bars available. Marked to the last close. */
  | "open";

export interface ReplayResult {
  readonly fixture: string;
  readonly outcome: ReplayOutcome;
  readonly setup: CandidateSetup | null;
  readonly entryPrice: number;
  /** Where the setup says it is wrong: the level itself. */
  readonly stopPrice: number;
  readonly targetUsd: number;
  readonly grossUsd: number;
  readonly netUsd: number;
  /** Worst unrealised PnL reached before the outcome. */
  readonly adverseExcursionUsd: number;
  /** The first live entry rule that declined the fixture. */
  readonly declineReason?: string | undefined;
}

export interface PolicyReplayReport {
  readonly policyVersion: number;
  readonly policyLabel: string;
  readonly fixtures: number;
  /** Fixtures where the policy found a setup. Reported, never argued from. */
  readonly setupsTaken: number;
  readonly targetsReached: number;
  readonly stopsHit: number;
  readonly stillOpen: number;
  readonly grossUsd: number;
  readonly netUsd: number;
  /** Net per setup taken — the expectancy a comparison actually turns on. */
  readonly meanNetUsd: number;
  /** Costs as a share of gross, on the trades that made any. */
  readonly feeShareOfGrossPercent: number;
  /** The single worst net result. The drawdown proxy a fixture set can carry. */
  readonly worstNetUsd: number;
  readonly meanAdverseExcursionUsd: number;
  readonly results: ReadonlyArray<ReplayResult>;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface SetupEvaluation {
  readonly eligible: boolean;
  readonly setup: CandidateSetup | null;
  readonly targetMovePrice: number;
  readonly stopPrice: number;
  readonly reason: string;
}

const declinedEvaluation = (reason: string): SetupEvaluation => ({
  eligible: false,
  setup: null,
  targetMovePrice: 0,
  stopPrice: 0,
  reason,
});

/**
 * Evaluate the same structural, cost, and standing-rule gates the live
 * playbooks state. Policy values decide whether a setup exists; they never
 * manufacture the target used to grade it.
 */
export function evaluateSetup(input: {
  readonly fixture: ReplayFixture;
  readonly frame: MomentumTimeframeContext;
  readonly candidates: ReadonlyArray<CandidateSetup>;
  readonly entryPrice: number;
  readonly policy: TradingPolicy;
}): SetupEvaluation {
  const { fixture, frame, entryPrice, policy } = input;
  if (fixture.session.minutesRemaining <= policy.session.noNewEntryFinalMinutes) {
    return declinedEvaluation("session_cutoff");
  }
  if (
    fixture.session.consecutiveNetLosses >= policy.session.consecutiveLossesBeforeCooldown &&
    fixture.session.minutesSinceLastLoss !== null &&
    fixture.session.minutesSinceLastLoss < policy.session.cooldownMinutes
  ) {
    return declinedEvaluation("losing_streak_cooldown");
  }
  if (entryPrice <= 0 || fixture.notionalUsd <= 0) {
    return declinedEvaluation("invalid_fixture_notional");
  }

  const size = fixture.notionalUsd / entryPrice;
  const clearsCosts = (movePrice: number, multiple: number): boolean =>
    movePrice > 0 && movePrice * size >= fixture.roundTripCostUsd * multiple;

  if (fixture.playbook === "range_reversion") {
    const setup = input.candidates.find((candidate) => candidate.kind === "range_reversion");
    const height =
      frame.swingHighPrice !== undefined && frame.swingLowPrice !== undefined
        ? frame.swingHighPrice - frame.swingLowPrice
        : 0;
    if (setup === undefined) return declinedEvaluation("range_structure_not_eligible");
    if (!clearsCosts(height, policy.rangeReversion.heightCostMultiple)) {
      return declinedEvaluation("costs_exceed_target");
    }
    return {
      eligible: true,
      setup,
      // The live range playbook targets a discounted 60–70% capture.
      targetMovePrice: height * 0.65,
      stopPrice: setup.level,
      reason: "eligible",
    };
  }

  if (fixture.playbook === "opening_range") {
    const openingBars = fixture.openingRangeBars ?? 20;
    if (fixture.interval !== "1m" || openingBars < 15 || openingBars > 20) {
      return declinedEvaluation("opening_range_window_invalid");
    }
    const opening = analyseTimeframe(
      { interval: fixture.interval, candles: fixture.history.slice(0, openingBars) },
      policy,
    );
    const high = opening.swingHighPrice;
    const low = opening.swingLowPrice;
    const last = fixture.history[fixture.history.length - 1];
    if (
      high === undefined ||
      low === undefined ||
      last === undefined ||
      (opening.swingHighTouches ?? 0) < policy.openingRange.minBoundaryTouches ||
      (opening.swingLowTouches ?? 0) < policy.openingRange.minBoundaryTouches
    ) {
      return declinedEvaluation("opening_range_not_tested");
    }
    const direction = last.close > high ? "up" : last.close < low ? "down" : null;
    if (direction === null) return declinedEvaluation("opening_range_not_broken_on_close");
    const height = high - low;
    if (!clearsCosts(height, policy.openingRange.heightCostMultiple)) {
      return declinedEvaluation("costs_exceed_target");
    }
    const setup: CandidateSetup = {
      kind: "opening_range_break",
      direction,
      interval: fixture.interval,
      score: 1,
      level: direction === "up" ? high : low,
      closeConfirmed: true,
      rationale: `${openingBars}-bar opening range broke on the close after both boundaries were tested`,
    };
    return {
      eligible: true,
      setup,
      targetMovePrice: height,
      stopPrice: direction === "up" ? low : high,
      reason: "eligible",
    };
  }

  if ((frame.atrExpansionRatio ?? 0) <= 1) {
    return declinedEvaluation("atr_not_expanding");
  }
  const setup = input.candidates.find((candidate) => candidate.kind !== "range_reversion");
  if (setup === undefined) return declinedEvaluation("momentum_structure_not_eligible");
  // A close-confirmed break is itself fresh on this bar. `impulseIsFresh`
  // remains a gate for pre-break continuation evidence, but must not veto the
  // very candle that confirmed an armed breakout.
  if (frame.breakout?.closedBeyond !== true && frame.impulseIsFresh !== true) {
    return declinedEvaluation("impulse_stale");
  }

  // The measured move is the smaller of current ATR and the fresh impulse.
  // It comes from the bars, not from the cost multiple being tested.
  const targetMovePrice = Math.min(frame.atrUsd, frame.lastImpulse?.sizeUsd ?? frame.atrUsd);
  if (!clearsCosts(targetMovePrice, policy.momentum.targetCostMultiple)) {
    return declinedEvaluation("costs_exceed_target");
  }
  return {
    eligible: true,
    setup: { ...setup, kind: "momentum_breakout" },
    targetMovePrice,
    stopPrice: setup.level,
    reason: "eligible",
  };
}

/**
 * Replay one fixture.
 *
 * Eligibility applies the policy to measured structure, costs, and session
 * state. The target is then derived from the bars (ATR, discounted range
 * capture, or opening-range height), never from the threshold being tested.
 * This separation is essential: a policy cannot pass replay by manufacturing
 * a target exactly large enough to clear its own cost gate.
 */
function replayFixture(fixture: ReplayFixture, policy: TradingPolicy): ReplayResult {
  const structure = analyseMomentum(
    {
      market: fixture.name,
      measuredAt: 0,
      frames: [{ interval: fixture.interval, candles: fixture.history }],
    },
    policy,
  );
  const frame = structure.timeframes[0];
  const entryPrice = fixture.history[fixture.history.length - 1]?.close ?? 0;

  const declined: ReplayResult = {
    fixture: fixture.name,
    outcome: "declined",
    setup: null,
    entryPrice,
    stopPrice: 0,
    targetUsd: 0,
    grossUsd: 0,
    netUsd: 0,
    adverseExcursionUsd: 0,
  };
  if (frame === undefined || entryPrice <= 0) {
    return { ...declined, declineReason: "insufficient_market_structure" };
  }
  const evaluation = evaluateSetup({
    fixture,
    frame,
    candidates: structure.setups,
    entryPrice,
    policy,
  });
  const setup = evaluation.setup;
  if (!evaluation.eligible || setup === null) {
    return { ...declined, declineReason: evaluation.reason };
  }

  const size = fixture.notionalUsd / entryPrice;
  if (size <= 0) return declined;
  const targetUsd = evaluation.targetMovePrice * size;
  const long = setup.direction === "up";
  const targetPrice = long ? entryPrice + targetUsd / size : entryPrice - targetUsd / size;
  const stopPrice = evaluation.stopPrice;

  // A stop on the wrong side of the entry is not a stop — the level has already
  // been passed, so the fixture cannot settle this setup either way.
  if ((long && stopPrice >= entryPrice) || (!long && stopPrice <= entryPrice)) {
    return { ...declined, setup, stopPrice };
  }

  let adverse = 0;
  let outcome: ReplayOutcome = "open";
  let exitPrice = entryPrice;
  for (const bar of fixture.forward) {
    const worst = long ? (bar.low - entryPrice) * size : (entryPrice - bar.high) * size;
    adverse = Math.min(adverse, worst);

    const hitStop = long ? bar.low <= stopPrice : bar.high >= stopPrice;
    const hitTarget = long ? bar.high >= targetPrice : bar.low <= targetPrice;
    // Both inside one bar is unresolvable from OHLC, so it counts as the stop.
    // Resolving it the other way would flatter every policy by exactly the
    // trades whose outcome is unknown.
    if (hitStop) {
      outcome = "stop";
      exitPrice = stopPrice;
      break;
    }
    if (hitTarget) {
      outcome = "target";
      exitPrice = targetPrice;
      break;
    }
    exitPrice = bar.close;
  }

  const grossUsd = (long ? exitPrice - entryPrice : entryPrice - exitPrice) * size;
  return {
    fixture: fixture.name,
    outcome,
    setup,
    entryPrice,
    stopPrice,
    targetUsd: round2(targetUsd),
    grossUsd: round2(grossUsd),
    netUsd: round2(grossUsd - fixture.roundTripCostUsd),
    adverseExcursionUsd: round2(adverse),
  };
}

/** Replay every fixture under one policy and total it up. */
export function replayPolicy(
  fixtures: ReadonlyArray<ReplayFixture>,
  policy: TradingPolicy = ACTIVE_TRADING_POLICY,
): PolicyReplayReport {
  const results = fixtures.map((fixture) => replayFixture(fixture, policy));
  const taken = results.filter((result) => result.outcome !== "declined");

  const grossUsd = taken.reduce((sum, result) => sum + result.grossUsd, 0);
  const netUsd = taken.reduce((sum, result) => sum + result.netUsd, 0);
  const positiveGross = taken.reduce((sum, r) => sum + Math.max(0, r.grossUsd), 0);
  const costs = taken.reduce((sum, result) => sum + (result.grossUsd - result.netUsd), 0);

  return {
    policyVersion: policy.version,
    policyLabel: policy.label,
    fixtures: fixtures.length,
    setupsTaken: taken.length,
    targetsReached: taken.filter((result) => result.outcome === "target").length,
    stopsHit: taken.filter((result) => result.outcome === "stop").length,
    stillOpen: taken.filter((result) => result.outcome === "open").length,
    grossUsd: round2(grossUsd),
    netUsd: round2(netUsd),
    meanNetUsd: taken.length === 0 ? 0 : round2(netUsd / taken.length),
    // A set that produced no gross at all paid its costs out of nothing, which
    // is 100% of what it made — not the 0% a bare division would report, and
    // 0% is the number that reads as "the best fee share in the comparison".
    feeShareOfGrossPercent:
      positiveGross === 0 ? (taken.length === 0 ? 0 : 100) : round2((costs / positiveGross) * 100),
    worstNetUsd: taken.length === 0 ? 0 : round2(Math.min(...taken.map((r) => r.netUsd))),
    meanAdverseExcursionUsd:
      taken.length === 0
        ? 0
        : round2(taken.reduce((sum, r) => sum + r.adverseExcursionUsd, 0) / taken.length),
    results,
  };
}

/**
 * Fewest setups a replay must produce before its verdict means anything.
 *
 * Twenty is not a statistically comfortable sample. It is the point below which
 * a comparison is obviously anecdote, and it is stated so that a replay over
 * five fixtures reports `insufficient_sample` instead of a confident number.
 */
export const MIN_REPLAY_SETUPS = 20;

export type PolicyVerdict = "ship" | "hold" | "insufficient_sample";

export interface PolicyComparison {
  readonly verdict: PolicyVerdict;
  /** Every reason the verdict is what it is, worst first. */
  readonly reasons: ReadonlyArray<string>;
  readonly baseline: PolicyReplayReport;
  readonly candidate: PolicyReplayReport;
}

/**
 * Compare a candidate against the shipped baseline.
 *
 * Four measures have to improve or hold: net expectancy per setup, the worst
 * single result, fee share of gross, and mean adverse excursion. Trade count is
 * deliberately absent from the test — it appears in the reasons only to name
 * the trap when a candidate takes more trades and earns less on each.
 */
export function comparePolicyReplays(
  baseline: PolicyReplayReport,
  candidate: PolicyReplayReport,
): PolicyComparison {
  const reasons: Array<string> = [];

  if (candidate.setupsTaken < MIN_REPLAY_SETUPS || baseline.setupsTaken < MIN_REPLAY_SETUPS) {
    return {
      verdict: "insufficient_sample",
      reasons: [
        `${candidate.setupsTaken} candidate and ${baseline.setupsTaken} baseline setups — under ${MIN_REPLAY_SETUPS}, this compares noise`,
      ],
      baseline,
      candidate,
    };
  }

  if (candidate.meanNetUsd < baseline.meanNetUsd) {
    reasons.push(
      `net expectancy fell from ${baseline.meanNetUsd} to ${candidate.meanNetUsd} per setup` +
        (candidate.setupsTaken > baseline.setupsTaken
          ? ` while taking ${candidate.setupsTaken - baseline.setupsTaken} more of them — that is the trade-more trap, not an improvement`
          : ""),
    );
  }
  if (candidate.worstNetUsd < baseline.worstNetUsd) {
    reasons.push(
      `the worst single result deepened from ${baseline.worstNetUsd} to ${candidate.worstNetUsd}`,
    );
  }
  if (candidate.feeShareOfGrossPercent > baseline.feeShareOfGrossPercent) {
    reasons.push(
      `fees took ${candidate.feeShareOfGrossPercent}% of gross against ${baseline.feeShareOfGrossPercent}% — the extra trades are smaller relative to their costs`,
    );
  }
  if (candidate.meanAdverseExcursionUsd < baseline.meanAdverseExcursionUsd) {
    reasons.push(
      `positions went further against the thesis first: mean adverse excursion ${candidate.meanAdverseExcursionUsd} against ${baseline.meanAdverseExcursionUsd}`,
    );
  }

  if (reasons.length > 0) return { verdict: "hold", reasons, baseline, candidate };
  return {
    verdict: "ship",
    reasons: [
      `net expectancy ${candidate.meanNetUsd} against ${baseline.meanNetUsd} per setup, worst result ${candidate.worstNetUsd} against ${baseline.worstNetUsd}, fee share ${candidate.feeShareOfGrossPercent}% against ${baseline.feeShareOfGrossPercent}% — every measure holds or improves; confirm on a testnet soak before it ships`,
    ],
    baseline,
    candidate,
  };
}
