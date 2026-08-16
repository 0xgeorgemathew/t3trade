/**
 * The numbers the strategy is allowed to argue about, in one versioned place.
 *
 * The thresholds here decide whether a setup reads as a trade: how decisive a
 * directional score has to be, how much a range is worth working, how close to
 * a boundary an entry counts as a boundary entry, when a session stops taking
 * new entries, and how long a losing streak sits out. They were true constants
 * — some in `marketStructure.ts`, some written only into playbook prose — so the same
 * value could be tightened in the arithmetic and left stale in the doctrine
 * the harness actually reads, and nothing would notice.
 *
 * What a trade costs is deliberately not among them any more: plan 29 step 3.1
 * took the entry cost multiples out, and cost survives as context the
 * observation carries, never as a gate.
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

/** How the market readings decide a target is worth its costs. */
export interface MarketReadingPolicy {
  /**
   * How many round trips a target is aiming to be worth — the rung to bank at,
   * not a precondition for entering.
   *
   * A position already open is the case this number is for: it says whether
   * the profit in front of you is worth the exit that realises it, and whether
   * there is enough left on offer to justify extending.
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
   * The height a range is worth working rather than merely taking one scalp
   * out of. Not a gate — the number the management turns argue against.
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

/**
 * How the EMA-cross strategy decides a cross is tradeable.
 *
 * A standalone strategy, not a filter bolted onto the structural ones: it
 * competes in the same tournament, on its own gates, and wins or loses on
 * expectancy after costs like every other candidate.
 */
export interface EmaCrossPolicy {
  /**
   * Oldest a cross may be, in bars, and still be the reason for the entry.
   *
   * A cross twenty bars back is not a signal, it is a description of where
   * price has already been.
   */
  readonly maxCrossAgeBars: number;
  /**
   * Smallest separation between the two EMAs, as a fraction of ATR, before the
   * cross is a cross rather than the two lines grazing each other in chop.
   */
  readonly minSpreadAtrRatio: number;
  /**
   * The move a fresh cross is played for, in ATRs. This is what the candidate
   * offers the cost read — an EMA cross has no range height and no impulse of
   * its own to be paid out of.
   */
  readonly targetAtrMultiple: number;
}

/** How the RSI-band reversion decides a market is stretched rather than trending. */
export interface RsiReversionPolicy {
  /**
   * How long an extreme may have held, in bars, before it is a trend rather
   * than a stretch. Forty bars of overbought is a market being bought, and
   * selling it is fading a trend.
   */
  readonly maxExtremeAgeBars: number;
  /**
   * The share of the swing range a reversion off an RSI extreme plays for —
   * the move back toward the middle, not the whole crossing.
   */
  readonly targetSwingFraction: number;
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
  /**
   * How much of the size the risk ceilings allow an unmandated entry is
   * expected to actually take.
   *
   * The ceilings are the risk policy: a size inside them is a size the mission
   * approved. Asking for a small fraction of one does not make the trade safer
   * in any way the plan cares about — it makes the same thesis pay a fraction
   * as much while the spread, the minimum tick, and the turn it took stay
   * exactly the same. Below this fraction the quote says so; nothing refuses.
   */
  readonly entrySizeFloorFractionOfCeiling: number;
}

/**
 * How soon a flat mission is re-woken to re-run the tournament — plan 27 I2.
 *
 * The quick-trades objective makes the flat cadence a policy number: a missed
 * entry re-evaluated in minutes is another small trade found, one re-evaluated
 * in an hour is a session spent flat. Shortening it ships like any other
 * threshold — a candidate version through replay — which is why it lives here
 * rather than as a constant in `watch.ts`.
 */
export interface ReassessmentPolicy {
  /** The flat staleness floor, in bars of the strategy's primary timeframe. */
  readonly flatFloorBars: number;
  /** The floor's clamp, in minutes: no sooner than, no later than. */
  readonly flatFloorClampMinutes: readonly [number, number];
}

/** One complete, versioned set of the numbers. */
export interface TradingPolicy {
  /** Bumped whenever any number below changes. Never reused. */
  readonly version: number;
  /** What this version was trying to do, for whoever reads a replay report. */
  readonly label: string;
  readonly readings: MarketReadingPolicy;
  readonly rangeReversion: RangePolicy;
  readonly openingRange: OpeningRangePolicy;
  readonly emaCross: EmaCrossPolicy;
  readonly rsiReversion: RsiReversionPolicy;
  readonly session: SessionPolicy;
  readonly reassessment: ReassessmentPolicy;
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
  readings: {
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
  // The indicator strategies did not exist at V1. Their numbers are stated at
  // the same shape their structural cousins had here, so a replay of V1
  // against V2 compares the same rules moving rather than a strategy appearing
  // out of nowhere with looser ones.
  emaCross: {
    maxCrossAgeBars: 5,
    minSpreadAtrRatio: 0.15,
    targetAtrMultiple: 3,
  },
  rsiReversion: {
    maxExtremeAgeBars: 5,
    targetSwingFraction: 0.5,
  },
  session: {
    plannedMinutes: [60, 120],
    noNewEntryFinalMinutes: 15,
    consecutiveLossesBeforeCooldown: 3,
    cooldownMinutes: 30,
    feeShareOfGrossWarningPercent: 50,
    // As shipped nothing said anything about size, which is the same as
    // saying any size is the right one.
    entrySizeFloorFractionOfCeiling: 0,
  },
  reassessment: {
    // The values `watchCoverageFloorMillis` has always used for a flat
    // mission: 10 bars, clamped to [5 min, 30 min]. Shortening them is a
    // plan 27 I2 candidate and waits for D2 replay like every threshold.
    flatFloorBars: 10,
    flatFloorClampMinutes: [5, 30],
  },
};

/**
 * The one number v2 moved that survives: unmandated entries are floored at
 * half the ceiling the risk policy allows.
 *
 * V2 also separated the entry cost gates from the target rungs; plan 29
 * step 3.1 then removed the entry gates outright, so those numbers no longer
 * exist here. Cost is context the wakeup and the structure read carry, not a
 * precondition for entering — the rungs a trade aims at are untouched.
 */
export const TRADING_POLICY_V2: TradingPolicy = {
  ...TRADING_POLICY_V1,
  version: 2,
  label: "unmandated size floored; entry cost gates later removed (plan 29)",
  session: {
    ...TRADING_POLICY_V1.session,
    entrySizeFloorFractionOfCeiling: 0.5,
  },
};

/**
 * The policy in force.
 *
 * Every threshold in the arithmetic and every number in the playbook prose
 * reads through this binding, so a candidate version takes effect in the rules
 * and in the doctrine at once, and the two cannot disagree.
 */
export const ACTIVE_TRADING_POLICY: TradingPolicy = TRADING_POLICY_V2;

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

/** One mission's worth of activity, as the funnel reads it — plan 27 I3. */
export interface ActivitySession {
  /** How long the mission has existed (or existed until it settled). */
  readonly activeMillis: number;
  /** Closed round trips. */
  readonly trades: number;
  /** Total time those trades held a position. */
  readonly heldMillis: number;
}

export interface ActivityEvidence {
  readonly sessions: number;
  readonly trades: number;
  readonly tradesPerSession: number;
  /** Share of the missions' lifetime actually spent holding a position. */
  readonly timeInMarketPercent: number;
  /** Runs that ended in a grounded stand-down. */
  readonly standDownRuns: number;
  readonly reason: string;
}

const round1Percent = (value: number): number => Math.round(value * 10) / 10;

/**
 * "Sat out all day" as a measurement rather than an anecdote — plan 27 I3.
 *
 * Measurement, never a gate: nothing trades off this. It exists so the
 * quick-trades objective (many small positive-expectancy trades over one
 * perfect one) has numbers to be argued from — how often the loop trades, how
 * much of its life it spends in the market, and how often it grounds a
 * stand-down.
 */
export function assessActivity(input: {
  readonly sessions: ReadonlyArray<ActivitySession>;
  readonly standDownRuns: number;
}): ActivityEvidence {
  const sessions = input.sessions.length;
  const trades = input.sessions.reduce((sum, session) => sum + session.trades, 0);
  const activeMillis = input.sessions.reduce(
    (sum, session) => sum + Math.max(0, session.activeMillis),
    0,
  );
  const heldMillis = input.sessions.reduce(
    (sum, session) => sum + Math.max(0, session.heldMillis),
    0,
  );

  const tradesPerSession = sessions === 0 ? 0 : round1Percent(trades / sessions);
  const timeInMarketPercent =
    activeMillis <= 0 ? 0 : round1Percent(Math.min(100, (heldMillis / activeMillis) * 100));

  const reason =
    sessions === 0
      ? "no sessions recorded yet — activity has nothing to measure"
      : `${sessions} session(s), ${trades} trade(s) (${tradesPerSession} per session), ` +
        `in the market ${timeInMarketPercent}% of the time; ` +
        `${input.standDownRuns} grounded stand-down(s)`;

  return {
    sessions,
    trades,
    tradesPerSession,
    timeInMarketPercent,
    standDownRuns: input.standDownRuns,
    reason,
  };
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
