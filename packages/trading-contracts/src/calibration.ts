/**
 * Did the targets the mission published actually get reached?
 *
 * Every profit target carries a claim: a `historicalHitRatePercent` that says
 * the measured move was available in that share of recent windows. Nothing has
 * ever checked the claim against what the mission then did, so the loop could
 * publish p50 targets that were reached a fifth of the time, forever, without
 * anything noticing — and the two knobs that would fix it, which rung to read
 * the target off and how far above cost the floor sits, had no evidence behind
 * them either.
 *
 * This compares the claim to the record. Pure arithmetic over closed trades:
 * the maximum favourable excursion of each trade against the target that was
 * live when it closed. `peakUnrealisedPnlUsd` is what makes it possible — it is
 * the only record of whether a target was ever REACHED, as opposed to whether
 * the harness happened to still be holding when it was.
 *
 * @module TradingCalibration
 */
import { Schema } from "effect";
import { TradingId, UnixMillis } from "./primitives.ts";

/**
 * Fewest closed trades under one target before its hit rate is published.
 *
 * Three trades can miss a genuinely well-set target and one lucky trade can
 * flatter a bad one. Below this the sample is reported with the trades counted
 * and the rate withheld, which is more honest than a percentage computed from
 * two data points.
 */
export const MIN_CALIBRATION_TRADES = 5;

/**
 * How far the observed hit rate may sit under the claimed one before the target
 * is called optimistic, in percentage points.
 *
 * Wide, deliberately. A p50 target reached 40% of the time is sampling noise on
 * any sample a POC mission produces; one reached 15% of the time is a target
 * read off the wrong rung.
 */
export const CALIBRATION_TOLERANCE_POINTS = 20;

/**
 * Fewest measured stops before the placement percentages are published.
 *
 * Same reasoning as `MIN_CALIBRATION_TRADES`, same failure mode: a
 * percentage over two stops is an anecdote wearing a decimal point.
 */
export const MIN_STOP_PLACEMENT_SAMPLE = 5;

/**
 * How the mission's stops were actually placed, graded — plan 27 G1.
 *
 * Measurement, not a rule change: G5 says any widening of stops ships as a
 * new policy version through replay, and this is the evidence that decision
 * waits for.
 */
export const StopPlacementReview = Schema.Struct({
  /** Closed trades that carried a measurable stop (noise-floor multiple known). */
  measuredTrades: Schema.Number,
  losingTrades: Schema.Number,
  /**
   * Share of measured stops that sat INSIDE the noise floor at entry.
   * Withheld under `MIN_STOP_PLACEMENT_SAMPLE`.
   */
  stopsInsideNoiseFloorPercent: Schema.optional(Schema.Number),
  /**
   * Share of losing trades whose stop-out looks avoidable: the stop was
   * inside the noise floor, or price came back through the entry within the
   * review window when that was measured. Withheld under the same minimum.
   */
  avoidableStopPercent: Schema.optional(Schema.Number),
  note: Schema.String,
});
export type StopPlacementReview = typeof StopPlacementReview.Type;

/** How a published target actually performed. */
export const TargetCalibrationVerdict = Schema.Literals([
  "insufficient_sample",
  "as_claimed",
  "optimistic",
  "conservative",
]);
export type TargetCalibrationVerdict = typeof TargetCalibrationVerdict.Type;

/** One strategy version's target, scored against the trades taken under it. */
export const TargetCalibrationEntry = Schema.Struct({
  strategyVersion: Schema.Number,
  targetProfitUsd: Schema.Number,
  /**
   * What the plan claimed, when it published one. Nothing publishes a claim
   * since the target basis went away (plan 29 step 3.2); the field stays
   * optional so the verdict logic keeps one shape.
   */
  claimedHitRatePercent: Schema.optional(Schema.Number),
  tradeCount: Schema.Number,
  /** Trades whose best unrealised PnL reached the target at least once. */
  reachedTargetCount: Schema.Number,
  /**
   * `reachedTargetCount / tradeCount`, as a percentage. Withheld below
   * `MIN_CALIBRATION_TRADES` — the verdict says so rather than the number
   * pretending to a precision the sample cannot carry.
   */
  observedHitRatePercent: Schema.optional(Schema.Number),
  /** Mean best-case and worst-case excursion across those trades. */
  meanPeakUsd: Schema.Number,
  meanTroughUsd: Schema.Number,
  /** Mean realised result net of fees — the figure that pays for any of this. */
  meanNetPnlUsd: Schema.Number,
  verdict: TargetCalibrationVerdict,
  note: Schema.String,
});
export type TargetCalibrationEntry = typeof TargetCalibrationEntry.Type;

/** What the whole record says about how this mission sets targets. */
export const TargetCalibration = Schema.Struct({
  missionId: TradingId,
  measuredAt: UnixMillis,
  /** Newest strategy version first. */
  entries: Schema.Array(TargetCalibrationEntry),
  tradeCount: Schema.Number,
  /** Across every scored trade, whatever version it was taken under. */
  overallReachedTargetPercent: Schema.optional(Schema.Number),
  meanNetPnlUsd: Schema.Number,
  /**
   * The one line the harness should act on: keep reading targets off the same
   * rung, or step down to a nearer one.
   */
  recommendation: Schema.String,
  /** How the stops were placed, over the same trades — see {@link StopPlacementReview}. */
  stopPlacement: StopPlacementReview,
});
export type TargetCalibration = typeof TargetCalibration.Type;

/** One closed trade, as calibration reads it. */
export interface CalibrationTrade {
  readonly strategyVersion: number | null;
  readonly targetProfitUsd: number | null;
  readonly peakUnrealisedPnlUsd: number;
  readonly troughUnrealisedPnlUsd: number;
  readonly netPnlUsd: number;
  readonly claimedHitRatePercent?: number | null;
  /** Stop distance over the noise floor at entry; null when not measured. */
  readonly stopNoiseFloorMultiple?: number | null;
  /**
   * Whether price came back through the entry within the review window after
   * a losing exit. Null when unmeasured — post-close candles need the trade
   * record to outlive the mission (plan 27 Phase H), so most rows carry null
   * until that lands.
   */
  readonly reEnteredWithinReviewBars?: boolean | null;
}

const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const round1 = (value: number): number => Math.round(value * 10) / 10;

const scoreOne = (
  strategyVersion: number,
  trades: ReadonlyArray<CalibrationTrade>,
): TargetCalibrationEntry => {
  const targetProfitUsd = trades[0]?.targetProfitUsd ?? 0;
  const claimed = trades.find((t) => t.claimedHitRatePercent != null)?.claimedHitRatePercent;
  // A target is REACHED when the trade was ever worth it, not when it was
  // banked at it. Those are different questions and only the first one grades
  // the target; the second grades the decision to hold.
  const reached = trades.filter((t) => t.peakUnrealisedPnlUsd >= targetProfitUsd).length;
  const meanPeakUsd = mean(trades.map((t) => t.peakUnrealisedPnlUsd));
  const meanTroughUsd = mean(trades.map((t) => t.troughUnrealisedPnlUsd));
  const meanNetPnlUsd = mean(trades.map((t) => t.netPnlUsd));
  const base = {
    strategyVersion,
    targetProfitUsd,
    ...(claimed == null ? {} : { claimedHitRatePercent: claimed }),
    tradeCount: trades.length,
    reachedTargetCount: reached,
    meanPeakUsd: round1(meanPeakUsd),
    meanTroughUsd: round1(meanTroughUsd),
    meanNetPnlUsd: round1(meanNetPnlUsd),
  };

  if (trades.length < MIN_CALIBRATION_TRADES) {
    return {
      ...base,
      verdict: "insufficient_sample",
      note: `${trades.length} closed trade(s) under v${strategyVersion} — under ${MIN_CALIBRATION_TRADES}, a hit rate would be noise`,
    };
  }

  const observed = round1((reached / trades.length) * 100);
  const withRate = { ...base, observedHitRatePercent: observed };

  if (claimed == null) {
    return {
      ...withRate,
      verdict: "as_claimed",
      note: `target of $${targetProfitUsd.toFixed(2)} was reached in ${observed}% of ${trades.length} trades; no claimed hit rate was published to compare against`,
    };
  }
  if (observed < claimed - CALIBRATION_TOLERANCE_POINTS) {
    return {
      ...withRate,
      verdict: "optimistic",
      note: `target of $${targetProfitUsd.toFixed(2)} claimed ${claimed}% but was reached in ${observed}% of ${trades.length} trades — read the next target off a nearer rung`,
    };
  }
  if (observed > claimed + CALIBRATION_TOLERANCE_POINTS) {
    return {
      ...withRate,
      verdict: "conservative",
      note: `target of $${targetProfitUsd.toFixed(2)} claimed ${claimed}% and was reached in ${observed}% of ${trades.length} trades — the mean peak of $${round1(meanPeakUsd)} says there was more move available`,
    };
  }
  return {
    ...withRate,
    verdict: "as_claimed",
    note: `target of $${targetProfitUsd.toFixed(2)} claimed ${claimed}% and was reached in ${observed}% of ${trades.length} trades`,
  };
};

/**
 * Score every published target against the trades taken under it.
 *
 * Trades with no strategy version (traded before the first publish) and trades
 * with no target are dropped: there is no claim to grade. The overall figures
 * span every scored trade regardless of version, because the question "are this
 * mission's targets set too far out?" is about the habit, not one version.
 */
export function calibrateTargets(input: {
  readonly missionId: string;
  readonly measuredAt: number;
  readonly trades: ReadonlyArray<CalibrationTrade>;
}): TargetCalibration {
  const scored = input.trades.filter(
    (t) => t.strategyVersion !== null && t.targetProfitUsd !== null && t.targetProfitUsd > 0,
  );

  const byVersion = new Map<number, Array<CalibrationTrade>>();
  for (const trade of scored) {
    const version = trade.strategyVersion as number;
    const group = byVersion.get(version) ?? [];
    group.push(trade);
    byVersion.set(version, group);
  }

  const entries = [...byVersion.entries()]
    .sort(([a], [b]) => b - a)
    .map(([version, trades]) => scoreOne(version, trades));

  const reachedOverall = scored.filter(
    (t) => t.peakUnrealisedPnlUsd >= (t.targetProfitUsd ?? 0),
  ).length;
  const overall =
    scored.length >= MIN_CALIBRATION_TRADES
      ? round1((reachedOverall / scored.length) * 100)
      : undefined;

  return {
    missionId: input.missionId,
    measuredAt: input.measuredAt,
    entries,
    tradeCount: scored.length,
    ...(overall === undefined ? {} : { overallReachedTargetPercent: overall }),
    meanNetPnlUsd: round1(mean(scored.map((t) => t.netPnlUsd))),
    recommendation: recommend(scored.length, overall, entries),
    // Stop placement spans EVERY trade with a measured stop, scored or not:
    // a stop that died to noise is the same lesson whether or not the trade
    // carried a graded target.
    stopPlacement: assessStopPlacement(input.trades),
  };
}

/**
 * Grade the mission's stop placement over its closed trades — plan 27 G1.
 *
 * Two questions, both about the habit rather than one trade: how often did
 * the stop sit inside the market's own noise at entry, and how many of the
 * losses look avoidable — inside the floor, or price back through the entry
 * within the review window when that was measured. Percentages are withheld
 * under `MIN_STOP_PLACEMENT_SAMPLE` for the same reason hit rates are.
 */
export function assessStopPlacement(trades: ReadonlyArray<CalibrationTrade>): StopPlacementReview {
  const measured = trades.filter((t) => t.stopNoiseFloorMultiple != null);
  const losers = measured.filter((t) => t.netPnlUsd < 0);
  const inside = measured.filter((t) => (t.stopNoiseFloorMultiple as number) < 1);
  const avoidable = losers.filter(
    (t) => (t.stopNoiseFloorMultiple as number) < 1 || t.reEnteredWithinReviewBars === true,
  );

  if (measured.length < MIN_STOP_PLACEMENT_SAMPLE) {
    return {
      measuredTrades: measured.length,
      losingTrades: losers.length,
      note: `${measured.length} closed trade(s) carry a measured stop — under ${MIN_STOP_PLACEMENT_SAMPLE}, a placement percentage would be noise`,
    };
  }

  const insidePercent = round1((inside.length / measured.length) * 100);
  const avoidablePercent =
    losers.length === 0 ? 0 : round1((avoidable.length / losers.length) * 100);
  return {
    measuredTrades: measured.length,
    losingTrades: losers.length,
    stopsInsideNoiseFloorPercent: insidePercent,
    avoidableStopPercent: avoidablePercent,
    note:
      insidePercent > 0
        ? `${insidePercent}% of measured stops sat inside the noise floor at entry and ${avoidablePercent}% of the losses look avoidable — placement is the problem before the market is`
        : `no measured stop sat inside the noise floor; ${avoidablePercent}% of losses look avoidable on the evidence recorded so far`,
  };
}

/**
 * The single line the harness is expected to act on.
 *
 * It says nothing at all until there is a sample, because "no evidence" and
 * "evidence that you are fine" are different answers and only one of them
 * should change behaviour.
 */
function recommend(
  tradeCount: number,
  overall: number | undefined,
  entries: ReadonlyArray<TargetCalibrationEntry>,
): string {
  if (overall === undefined) {
    return `only ${tradeCount} closed trade(s) with a published target so far — not enough to calibrate; keep deriving targets from the measurement and check back after ${MIN_CALIBRATION_TRADES}`;
  }
  const optimistic = entries.filter((e) => e.verdict === "optimistic").length;
  const conservative = entries.filter((e) => e.verdict === "conservative").length;
  if (optimistic > conservative) {
    return `targets are reached ${overall}% of the time across ${tradeCount} trades and ${optimistic} version(s) came in under their claim — read the next target off a nearer rung (p50 rather than p75, or a shorter hold horizon) before widening anything`;
  }
  if (conservative > optimistic) {
    return `targets are reached ${overall}% of the time across ${tradeCount} trades, above what they claimed — the conservative rung is leaving move on the table, so extend more often at the target wake rather than banking every one`;
  }
  return `targets are reached ${overall}% of the time across ${tradeCount} trades, in line with what they claimed — keep deriving them the same way`;
}
