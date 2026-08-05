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
  /** What the basis claimed, when it published one. A p50 claims 50. */
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
      note: `target of $${targetProfitUsd.toFixed(2)} was reached in ${observed}% of ${trades.length} trades; the basis claimed no hit rate to compare against`,
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
