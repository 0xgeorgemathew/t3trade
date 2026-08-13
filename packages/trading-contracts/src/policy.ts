/**
 * The numbers the strategy is allowed to argue about, in one versioned place.
 *
 * Six thresholds decide whether a setup is a trade: how decisive a directional
 * score has to be, how many round trips a target must be worth, how much bigger
 * than its break-even move a range must be, how close to a boundary an entry
 * counts as a boundary entry, when a session stops taking new entries, and how
 * long a losing streak sits out. All six were true constants — three in
 * `momentum.ts`, one in `costs.ts`, and two written only into playbook prose —
 * so the same value could be tightened in the arithmetic and left stale in the
 * doctrine the harness actually reads, and nothing would notice.
 *
 * Collecting them changes no behaviour: {@link TRADING_POLICY_V1} is the
 * numbers as they already were, to the digit. What it buys is the ability to
 * state a candidate as a value rather than a diff, replay both over the same
 * fixtures (see `./replay.ts`), and ship the change only if the evidence says
 * so — which is the whole discipline this module exists to make possible.
 *
 * These are policy, not safety. Nothing here relaxes a §16 gate, a stop
 * requirement, or a risk ceiling; those are not calibrated, they are kept.
 *
 * @module TradingPolicy
 */

/** How momentum decides a target is worth its costs. */
export interface MomentumPolicy {
  /**
   * How many round trips a target has to be worth before the trade is worth
   * taking. One round trip is break-even before slippage and funding; a target
   * at exactly 1x pays the exchange and takes the variance for nothing.
   */
  readonly targetCostMultiple: number;
  /**
   * How decisive a directional score has to be before a timeframe is called.
   * Below it the window spent most of its travel undoing itself, which is chop.
   */
  readonly directionScoreThreshold: number;
}

/** How the range scalp decides a range is a range, and worth trading. */
export interface RangePolicy {
  /**
   * Range height as a multiple of the break-even price move. Higher than
   * momentum's because a scalp takes only part of the crossing.
   */
  readonly heightCostMultiple: number;
  /**
   * How far into an edge a touch counts as a boundary entry, in percent of the
   * range. An entry between this and its mirror is mid-range.
   */
  readonly edgePercent: number;
  /** A stable range is one whose height moved less than this across the window. */
  readonly stabilityPercent: number;
  /** Boundary touches before a level is a level rather than a coincidence. */
  readonly minBoundaryTouches: number;
}

/** The opening-range break, which shares the range's arithmetic. */
export interface OpeningRangePolicy {
  readonly heightCostMultiple: number;
  readonly minBoundaryTouches: number;
}

/** The standing rules that hold in every mode. */
export interface SessionPolicy {
  /** How long a mission is planned to run, in minutes: shortest, longest. */
  readonly plannedMinutes: readonly [number, number];
  /** No new entry inside this many minutes of the session's end. */
  readonly noNewEntryFinalMinutes: number;
  /** Consecutive net-negative scalps that trigger the cooldown. */
  readonly consecutiveLossesBeforeCooldown: number;
  /** How long that cooldown lasts, in minutes. */
  readonly cooldownMinutes: number;
  /**
   * Fees as a share of gross, above which the size is too big for the range
   * being traded. Read off `trading_get_trade_history`.
   */
  readonly feeShareOfGrossWarningPercent: number;
}

/** One complete, versioned set of the six. */
export interface TradingPolicy {
  /** Bumped whenever any number below changes. Never reused. */
  readonly version: number;
  /** What this version was trying to do, for whoever reads a replay report. */
  readonly label: string;
  readonly momentum: MomentumPolicy;
  readonly rangeReversion: RangePolicy;
  readonly openingRange: OpeningRangePolicy;
  readonly session: SessionPolicy;
}

/**
 * The thresholds as the harness has always run them.
 *
 * Deliberately not tuned. A first version that differs from the shipped
 * behaviour would make every later replay a comparison against a baseline that
 * never traded, which is exactly the mistake the versioning exists to prevent.
 */
export const TRADING_POLICY_V1: TradingPolicy = {
  version: 1,
  label: "as-shipped baseline; the constants before they were collected",
  momentum: {
    targetCostMultiple: 2,
    directionScoreThreshold: 0.15,
  },
  rangeReversion: {
    heightCostMultiple: 2.2,
    edgePercent: 20,
    stabilityPercent: 30,
    minBoundaryTouches: 2,
  },
  openingRange: {
    heightCostMultiple: 2.2,
    minBoundaryTouches: 2,
  },
  session: {
    plannedMinutes: [60, 120],
    noNewEntryFinalMinutes: 15,
    consecutiveLossesBeforeCooldown: 3,
    cooldownMinutes: 30,
    feeShareOfGrossWarningPercent: 50,
  },
};

/**
 * The policy in force.
 *
 * Every threshold in the arithmetic and every number in the playbook prose
 * reads through this binding, so a candidate version takes effect in the rules
 * and in the doctrine at once, and the two cannot disagree.
 */
export const ACTIVE_TRADING_POLICY: TradingPolicy = TRADING_POLICY_V1;

/**
 * Whether the market data the harness reads is what is limiting its decisions.
 *
 * The plan authorises volume, open interest, and funding features only if the
 * stand-down record shows they would change an answer. That is a real question
 * with a real answer, and it is answerable from the funnel the runs already
 * write: a loop standing down because it could not resolve a regime is starved
 * of evidence, and one standing down because the costs ate the move is not — it
 * read the market correctly and declined.
 *
 * `regime_unclear` is the only code enrichment plausibly fixes. `data_unavailable`
 * and `tool_call_failed` are plumbing, `insufficient_volatility` and
 * `costs_exceed_target` are correct refusals, and `awaiting_trigger` is a
 * working loop.
 */
export interface StandDownTally {
  /** A `TradingStandDownCode`, or null for runs that carried none. */
  readonly standDownCode: string | null;
  readonly runs: number;
}

export interface EnrichmentEvidence {
  /** Whether the record supports spending latency on more market features. */
  readonly warranted: boolean;
  /** Runs the verdict was drawn from. */
  readonly sampleRuns: number;
  /** Share of stand-downs attributable to an unresolvable regime read. */
  readonly regimeUnclearPercent: number;
  readonly reason: string;
}

/** Below this the funnel is anecdote, and no feature ships on anecdote. */
export const MIN_ENRICHMENT_SAMPLE_RUNS = 50;

/**
 * Share of stand-downs that must be `regime_unclear` before more data is the
 * plausible fix. A third is a lot: it means the loop is more often unable to
 * read the market than able to read it and decline.
 */
export const ENRICHMENT_REGIME_UNCLEAR_PERCENT = 33;

/**
 * One closed trade, joined back to the entry that opened it — plan 27 C2/C3.
 *
 * `scoredSetupBehindIt` is whether the entry's quote carried a scored setup
 * snapshot (C1); `regimeAtEntry` is the regime classification in force when
 * the entry was quoted, or null when no read had been made.
 */
export interface EntryGovernanceTrade {
  readonly scoredSetupBehindIt: boolean;
  readonly setupKindAtEntry: string | null;
  readonly regimeAtEntry: string | null;
  readonly netPnlUsd: number;
}

export interface EntryGovernanceSplit {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly netUsd: number;
}

export interface RegimeLossAttribution {
  /** The regime classification at entry, or null when none was recorded. */
  readonly regime: string | null;
  readonly trades: number;
  readonly losses: number;
  readonly netUsd: number;
}

export interface EntryGovernanceEvidence {
  /** Trades whose entry had a scored setup behind it. */
  readonly scored: EntryGovernanceSplit;
  /** Trades entered with no scored setup — the discipline gap C2 measures. */
  readonly unscored: EntryGovernanceSplit;
  /** Losses attributed to the regime read in force at entry — plan 27 C3. */
  readonly lossesByRegime: ReadonlyArray<RegimeLossAttribution>;
  readonly reason: string;
}

const splitOf = (trades: ReadonlyArray<EntryGovernanceTrade>): EntryGovernanceSplit => ({
  trades: trades.length,
  wins: trades.filter((trade) => trade.netPnlUsd > 0).length,
  losses: trades.filter((trade) => trade.netPnlUsd < 0).length,
  netUsd: Math.round(trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0) * 100) / 100,
});

/**
 * The `assessEnrichment` sibling for entries — plan 27 C2/C3.
 *
 * Measurement, not a gate: nothing refuses an entry off this. It answers the
 * two questions the stop-out review could not: do the entries taken WITHOUT a
 * scored setup behind them actually pay, and which regime read was in force
 * when the losing ones were taken. A loss column concentrated under one
 * regime classification is the evidence a doctrine change ships on.
 */
export function assessEntryGovernance(
  trades: ReadonlyArray<EntryGovernanceTrade>,
): EntryGovernanceEvidence {
  const scored = splitOf(trades.filter((trade) => trade.scoredSetupBehindIt));
  const unscored = splitOf(trades.filter((trade) => !trade.scoredSetupBehindIt));

  const regimes = new Map<string | null, Array<EntryGovernanceTrade>>();
  for (const trade of trades) {
    const key = trade.regimeAtEntry;
    const bucket = regimes.get(key);
    if (bucket === undefined) regimes.set(key, [trade]);
    else bucket.push(trade);
  }
  const lossesByRegime = [...regimes.entries()]
    .map(([regime, bucket]): RegimeLossAttribution => {
      const split = splitOf(bucket);
      return { regime, trades: split.trades, losses: split.losses, netUsd: split.netUsd };
    })
    .sort((left, right) => left.netUsd - right.netUsd);

  const reason =
    trades.length === 0
      ? "no closed trades joined to an entry record yet — the split has nothing to say"
      : `${scored.trades} entries had a scored setup behind them (net ${scored.netUsd} USD), ` +
        `${unscored.trades} did not (net ${unscored.netUsd} USD); ` +
        `worst regime at entry: ${lossesByRegime[0]?.regime ?? "unrecorded"} at ${lossesByRegime[0]?.netUsd ?? 0} USD net`;

  return { scored, unscored, lossesByRegime, reason };
}

export function assessEnrichment(tallies: ReadonlyArray<StandDownTally>): EnrichmentEvidence {
  const attributable = new Set([
    "regime_unclear",
    "costs_exceed_target",
    "insufficient_volatility",
    "data_unavailable",
    "tool_call_failed",
  ]);
  const standDowns = tallies.filter(
    (row) => row.standDownCode !== null && attributable.has(row.standDownCode),
  );
  const total = standDowns.reduce((sum, row) => sum + row.runs, 0);
  const unclear = standDowns
    .filter((row) => row.standDownCode === "regime_unclear")
    .reduce((sum, row) => sum + row.runs, 0);
  const percent = total === 0 ? 0 : Math.round((unclear / total) * 1000) / 10;

  if (total < MIN_ENRICHMENT_SAMPLE_RUNS) {
    return {
      warranted: false,
      sampleRuns: total,
      regimeUnclearPercent: percent,
      reason: `${total} stand-down(s) recorded — under ${MIN_ENRICHMENT_SAMPLE_RUNS}, the attribution is anecdote and no feature should ship on it`,
    };
  }
  if (percent < ENRICHMENT_REGIME_UNCLEAR_PERCENT) {
    return {
      warranted: false,
      sampleRuns: total,
      regimeUnclearPercent: percent,
      reason: `only ${percent}% of ${total} stand-downs could not resolve a regime — the loop is reading the market and declining it, so volume, open interest, and funding would add latency without changing an answer`,
    };
  }
  return {
    warranted: true,
    sampleRuns: total,
    regimeUnclearPercent: percent,
    reason: `${percent}% of ${total} stand-downs could not resolve a regime — the read, not the rules, is what is limiting decisions; add range/flow features in the order the assessment gives and re-measure`,
  };
}
