/**
 * Event-driven harness wake-up - spec §12.2, §12.3.
 *
 * Between harness turns T3 observes facts and resumes the same provider session
 * with a fresh mission snapshot; it never generates discretionary intent. The
 * `TradingHarnessWakeup` is the authoritative, bounded snapshot a resumed run
 * starts with; `TradingTurnCoordinator` is the single gate between an observed
 * event and a started run and owns the one-at-a-time decision lease.
 *
 * @module TradingWakeup
 */
import { Schema } from "effect";
import { AgentAccountSnapshot, AgentNetPosition } from "./account-snapshot.ts";
import { TradingAuthority } from "./authority.ts";
import { TradingCostContext, TradingCostEstimate } from "./costs.ts";
import { AgentMarketSnapshot, MarketHistory } from "./market.ts";
import { TradingHarnessRunCause } from "./mission.ts";
import { TradingId, TradingText, UnixMillis } from "./primitives.ts";
import { TradingPlanState, TradingTimeframe } from "./strategy.ts";
import { ObservedVolatility } from "./volatility.ts";
import {
  MisarmedEntryCondition,
  PersistedWatch,
  UnarmedEntryCondition,
  WatchArmedReason,
} from "./watch.ts";

/**
 * A coalesced inbox event as a resumed run sees it - spec §18.1.
 *
 * `summary` is a short human-readable rendering of the persisted `payload`; the
 * harness reads context from it without re-decoding the opaque inbox payload.
 */
export const TradingDomainEventSummary = Schema.Struct({
  category: Schema.Literals(["market", "exchange", "timer", "user", "system"]),
  deduplicationKey: Schema.String,
  occurredAt: UnixMillis,
  summary: Schema.String,
});
export type TradingDomainEventSummary = typeof TradingDomainEventSummary.Type;

/**
 * One armed watch, with how far the market is from firing it.
 *
 * A resumed run used to see only the watch that fired and had to call
 * `trading_list_watches` — and then do the arithmetic itself — to learn what
 * else was armed and whether any of it was close. Both numbers are signed
 * against the direction the watch fires in: positive means the market still has
 * that far to travel, negative means the level is already behind the mark.
 *
 * Only `price_cross` and `candle_close` carry a level, so only they carry a
 * distance; the other three watch types report none.
 */
export const WakeupArmedWatch = Schema.Struct({
  watch: PersistedWatch,
  distanceUsd: Schema.optional(Schema.Number),
  distanceBps: Schema.optional(Schema.Number),
});
export type WakeupArmedWatch = typeof WakeupArmedWatch.Type;

/**
 * Measure one armed watch against the current mark.
 *
 * The sign follows the direction the watch fires in, so a positive distance
 * always reads as "this far still to go" whichever way the level sits.
 */
export function describeArmedWatch(persisted: PersistedWatch, markPrice: number): WakeupArmedWatch {
  const watch = persisted.watch;
  if (watch.type !== "price_cross" && watch.type !== "candle_close") {
    return { watch: persisted };
  }
  const distanceUsd =
    watch.direction === "above" ? watch.price - markPrice : markPrice - watch.price;
  return {
    watch: persisted,
    distanceUsd,
    distanceBps: markPrice > 0 ? (distanceUsd / markPrice) * 10_000 : 0,
  };
}

/**
 * What one price level has already done to this mission - plan 27 B1.
 *
 * Written by the runtime at the seams that observe each fact (watch
 * registration, the watch evaluator's candle and price sweeps, the fill
 * reconciler) and surfaced back on the wakeup, bounded, so the level a run is
 * about to arm carries its own record: how often it was touched, how often a
 * break at it failed, and whether this mission has already entered or been
 * stopped out there. Events are grouped into levels with an ATR-scaled
 * tolerance at read time, so 1899.7 and 1900.2 are one level, not two.
 */
export const LevelEventKind = Schema.Literals([
  "armed",
  "touched",
  "wick_rejected",
  "closed_through",
  "entered_at",
  "stopped_out_at",
]);
export type LevelEventKind = typeof LevelEventKind.Type;

export const LevelHistoryEntry = Schema.Struct({
  /** The representative price of the grouped level. */
  level: Schema.Number,
  armed: Schema.Number,
  touched: Schema.Number,
  /** Bars that traded through the level and closed back inside — failed breaks. */
  wickRejected: Schema.Number,
  closedThrough: Schema.Number,
  entries: Schema.Number,
  stopOuts: Schema.Number,
  lastEventKind: LevelEventKind,
  lastEventAt: UnixMillis,
});
export type LevelHistoryEntry = typeof LevelHistoryEntry.Type;

/**
 * The previous market-structure read, echoed back - plan 27 B2.
 *
 * A mission re-derives its regime and its boundaries from scratch every wake,
 * which is how a boundary quietly redrawn lower on three consecutive reads
 * looked like three fresh ranges instead of one trend. The echo is the last
 * `trading_look` read this mission made: its regime verdict
 * and the primary timeframe's swing bounds, with how old that read is.
 */
export const PreviousStructureRead = Schema.Struct({
  interval: TradingTimeframe,
  classification: Schema.Literals(["trending", "ranging", "transition"]),
  swingHighUsd: Schema.optional(Schema.Number),
  swingLowUsd: Schema.optional(Schema.Number),
  readAgeMillis: Schema.Number,
});
export type PreviousStructureRead = typeof PreviousStructureRead.Type;

/**
 * The authoritative mission snapshot a resumed run starts with - spec §12.2.
 *
 * The harness does not receive unbounded market data or a free-form prompt. It
 * receives the cause, the triggering watch or user message, and a fresh,
 * versioned snapshot of market, account, position, recent price action, active
 * strategy, authority, and the coalesced pending events the run was started
 * with. The bounded snapshot answers "what do I hold, what did price just do?"
 * without tool calls; deeper history stays behind `trading_look`.
 *
 * `cause` is the §11.2 `TradingHarnessRunCause` union verbatim, including
 * `mission_created` for the first run.
 */
export const TradingHarnessWakeup = Schema.Struct({
  /**
   * What this message is, for anything reading the serialized payload rather
   * than the typed value.
   *
   * The wakeup is delivered as the resumed turn's user-message text (§12.4), so
   * the chat timeline receives a JSON blob with no way to tell it from
   * something the operator typed — and rendered it verbatim, once per wake. The
   * `mission_created` bootstrap message already carried this discriminator;
   * the full wakeup now carries the same one.
   */
  kind: Schema.Literal("trading-harness-wakeup"),
  missionId: TradingId,
  harnessRunId: TradingId,
  cause: TradingHarnessRunCause,
  occurredAt: UnixMillis,
  /** The watch whose predicate matched, when this run was woken by a watch. */
  triggeringWatch: Schema.optional(PersistedWatch),
  /**
   * Why the runtime woke this run, when the answer is not the harness's own
   * doing. `staleness_floor` means the triggering reassessment was auto-armed
   * because nothing else could have woken the mission — nothing crossed, and
   * the thesis is the thing to reconsider. `profit_target` means the position
   * reached the strategy's declared `target.profitUsd`. That is a decision
   * point, not a close order: read the book and the momentum, then either
   * bank (close, or reduce and keep a runner) or extend — republish at the
   * next version with the ladder's base rung and a fresh basis, and say why.
   */
  wakeReason: Schema.optional(WatchArmedReason),
  /** The user message that woke the run, when the cause is `user_message`. */
  userMessage: Schema.optional(TradingText),
  marketSnapshot: AgentMarketSnapshot,
  /**
   * The live balance: what the account actually holds right now, refreshed
   * every wakeup. This is information for sizing, never a limit — the limits
   * are in `authority`.
   */
  accountSnapshot: AgentAccountSnapshot,
  /**
   * The mission's net position for `market`, always present.
   *
   * Flat is modelled as `size: 0` (the contract already treats that as a valid
   * state), so a woken run never needs a boilerplate `trading_look`
   * call to learn whether it holds anything before it can think.
   */
  position: AgentNetPosition,
  /**
   * The last 8 bars of the runtime timeframe (the interval the mandate names,
   * else `1m` — see `runtimeTimeframe` in `./strategy.ts`).
   *
   * A bounded slice of recent price action so the run can answer "what did
   * price just do?" without a `trading_look` round-trip. Deeper
   * history stays behind that tool; this never exceeds 8 bars.
   */
  recentCandles: MarketHistory,
  /**
   * What the instrument's fluctuation actually measures, on the same primary
   * timeframe, over `VOLATILITY_LOOKBACK_BARS` bars.
   *
   * This is the basis a profit target has to be derived from: ATR, realized
   * volatility, the window's swing range, and — the one to read a target off —
   * the distribution of the move price delivered over each candidate holding
   * period. It is measured on every wake rather than left to a tool call the
   * harness may skip.
   *
   * It is also the regime read. `swingHighUsd`/`swingLowUsd` are the boundaries,
   * `positionInRangePercent` says where the mark sits between them, and
   * `excursionSymmetryRatio` says whether the window has been paying longs and
   * shorts alike (ranging) or one side (trending) — so classifying the market
   * costs no tool call either.
   *
   * One timeframe is not enough to set a target from: this is the primary
   * timeframe only. `higherTimeframeVolatility` below carries the second one, so
   * the pair is already here and a `trading_look` call is only
   * needed for a third. Nothing here is netted of fees — `costContext` below
   * carries the round trip at a stated reference notional, and
   * `trading_look` prices a hypothetical size exactly.
   */
  observedVolatility: ObservedVolatility,
  /**
   * The same measurement on one higher timeframe — 15m for a mission running on
   * 1m/3m/5m, 1h above that.
   *
   * The primary-timeframe measurement above is the one a target gets read off,
   * and on 1m its longest horizon reaches an hour. That is long enough to see
   * the oscillation a range scalp rides and still not long enough to see the
   * structure a momentum move runs into, and asking the harness
   * to remember to call `trading_look` on a second timeframe every
   * time is asking it to remember. Absent only when the mission already runs on
   * the highest interval, or when the higher read failed.
   */
  higherTimeframeVolatility: Schema.optional(ObservedVolatility),
  /**
   * What the round trip on the CURRENT position costs, at the size actually
   * held, from the live fee rate and book.
   *
   * Present only while a position is open — flat, the bounded `costContext`
   * line below carries the reference round trip instead. On a profit-target
   * wake this is the number the bank-or-extend decision turns on: the unrealised
   * PnL beside it is gross, and `roundTripUsd` is what closing will take out of
   * it. Absent when the cost read failed; `degraded` marks a partial one.
   */
  positionCosts: Schema.optional(TradingCostEstimate),
  /**
   * The one cost line a flat wake carries: the estimated round trip in USD and
   * bps at a stated reference notional — the plan's intended entry notional
   * when a plan names one, else the mission's allocated capital.
   *
   * Context for the single question — is the expected move over the intended
   * hold bigger than the round trip? — and never a gate (plan 29 step 3.1).
   * Absent while a position is open (`positionCosts` prices the exit on the
   * size actually held there) and when the cost read failed.
   */
  costContext: Schema.optional(TradingCostContext),
  /**
   * Every watch still armed for this mission, with the distance from the
   * current mark for the two types that carry a level.
   *
   * Declared (and therefore rendered) BEFORE `activeStrategy`: when a wakeup
   * exceeds its budget the renderer truncates from the tail, and the armed
   * levels are the one thing a woken run cannot re-derive from
   * `trading_look` prose. The strategy echo is the re-readable part, so
   * it takes the truncation risk instead.
   */
  armedWatches: Schema.Array(WakeupArmedWatch),
  /**
   * Entry conditions the published plan names a price level for, while the
   * mission is flat, with no watch armed at that level.
   *
   * Waiting is a decision with content, and the content has to be armed to mean
   * anything: a plan that says "come back if price reaches 1899" and arms
   * nothing there is waiting blind between backstop wakes. The runtime never
   * arms these itself — predicates come from `MarketWatch`, not from prose — so
   * this is the gap, handed back to the run that can close it with one
   * `trading_watch`. Absent while a position is open, and empty when
   * every named level is armed.
   */
  unarmedEntryConditions: Schema.optional(Schema.Array(UnarmedEntryCondition)),
  /**
   * Entry conditions armed with a watch that cannot evaluate the evidence they
   * declared — a close-confirmed breakout armed as a `price_cross`, or a range
   * touch armed as a `candle_close`.
   *
   * The first is why a mission gets woken by the wick that fails: the level was
   * crossed, the candle closed back inside, and the turn spent on it could only
   * conclude nothing happened. The runtime does not re-arm these itself; it
   * reports the mismatch so the next turn can move the watch with one
   * `trading_watch` carrying `replacesWatchId`. Empty when every
   * declared confirmation matches what is armed.
   */
  misarmedEntryConditions: Schema.optional(Schema.Array(MisarmedEntryCondition)),
  /**
   * Present while the mission is flat: the whole field is open this turn, and
   * the published plan is one candidate in it rather than the incumbent.
   *
   * The doctrine has always said a flat wake re-runs the tournament
   * (`standing_rules`), but doctrine is a `trading_get_playbook` call away and
   * a waiting mission reliably spent its wake re-checking the trigger it had
   * already published — the range it could have scalped while its momentum
   * breakout never came was never scored. Nothing branches on this: it is the
   * reminder, carried where it cannot be missed, on exactly the wakes where it
   * applies. Absent while a position is open, where switching costs a round
   * trip and the incumbent DOES have seniority.
   */
  strategyReview: Schema.optional(TradingText),
  /**
   * The mirror of `strategyReview`, present while a position IS open: what
   * managing it means on this wake.
   *
   * A holding wake already carries everything the decision needs —
   * `positionCosts` prices the exit on the size actually held,
   * `peakUnrealisedPnl` and `drawdownFromPeakUsd` say what has been handed
   * back — and the turns that read them still tended to restate the thesis and
   * end. This is the instruction to spend the turn on the position instead:
   * defend it, trail it, and decide bank-or-extend against the numbers beside
   * it. Nothing branches on it.
   */
  positionReview: Schema.optional(TradingText),
  /**
   * What the levels near the mark have already done to this mission — plan 27
   * B1. Bounded to the levels nearest the current mark. Absent when the
   * mission has no recorded level events yet.
   *
   * Read it before arming or entering at a level: two `closedThrough` events
   * or a `stopOuts` entry at a boundary is the range failing there, recorded,
   * and re-arming it without saying why is how the same trap is taken twice.
   */
  levelHistory: Schema.optional(Schema.Array(LevelHistoryEntry)),
  /**
   * True while the open position's entry was quoted with NO scored setup
   * behind it — plan 27 C2. Present only while a position is open. Not a
   * verdict on the trade; it is the flag the closing review reads when it
   * asks whether disciplined entries and undisciplined ones pay differently.
   */
  enteredWithoutScoredSetup: Schema.optional(Schema.Boolean),
  /**
   * The mission's previous market-structure read — plan 27 B2. Absent until
   * the mission has called `trading_look` once.
   *
   * Compare before re-classifying: a boundary re-drawn in the same direction
   * as the last read, or a regime that was `transition` last read, is memory
   * the fresh read alone cannot carry.
   */
  previousStructureRead: Schema.optional(PreviousStructureRead),
  /**
   * The user's mandate: hard rails, fixed for the life of the mission. Sized
   * from the account value when the mission was created and deliberately not
   * re-scaled since, so a balance that moves changes what the harness can
   * afford, never what it is allowed.
   *
   * Optional on the wakeup: the composer no longer embeds the full mandate
   * (large, mostly fixed for the mission's life). A resumed run reads it via
   * `trading_look` when it needs the rails.
   */
  authority: Schema.optional(TradingAuthority),
  pendingEvents: Schema.Array(TradingDomainEventSummary),
  /**
   * The mission's current plan. Optional since plan 29 step 4.3 took the plan
   * off waking's preconditions: a mission with no plan still wakes, on the
   * same market and account snapshot, and `strategyReview` says the field is
   * absent and the turn is there to decide. Absent only on plan-less missions.
   */
  activeStrategy: Schema.optional(TradingPlanState),
  /**
   * How long ago the active plan was published, in milliseconds. Absent in
   * lockstep with `activeStrategy`.
   *
   * A thesis has a shelf life. This is the number that says "you wrote this
   * forty minutes ago on a 1m chart" without a second tool call.
   */
  strategyAgeMillis: Schema.optional(Schema.Number),
  instruction: Schema.optional(TradingText),
  /**
   * The timeframe to work on unless the instruction names another. Published on
   * every wakeup rather than only the first, so a resumed run that has lost the
   * bootstrap turn from its context still knows which candle the mission runs
   * on. See `POC_DEFAULT_TIMEFRAME`.
   *
   * Optional on the wakeup: the composer points the run at
   * `trading_look` for the mandate and authority instead of duplicating
   * them on every wake.
   */
  defaultTimeframe: Schema.optional(TradingTimeframe),
});
export type TradingHarnessWakeup = typeof TradingHarnessWakeup.Type;

/**
 * What the coordinator is asked to start a run for - spec §12.3.
 *
 * `HarnessRunRequest` is pinned in the wake-up phase (§12.3). Exactly one of
 * `triggeringWatchId` / `userMessage` is meaningful for a given `cause`; the
 * coordinator resolves the triggering watch from the registry when present.
 */
export const HarnessRunRequest = Schema.Struct({
  missionId: TradingId,
  cause: TradingHarnessRunCause,
  /** The watch whose firing woke the run, when cause is a watch or timer. */
  triggeringWatchId: Schema.optional(TradingId),
  /** The user message text, when cause is `user_message`. */
  userMessage: Schema.optional(TradingText),
});
export type HarnessRunRequest = typeof HarnessRunRequest.Type;

/**
 * The three outcomes `TradingTurnCoordinator.requestRun` may return - §12.3.
 *
 * A caller can tell whether a run actually started, was queued behind an active
 * one, or was blocked before the lease was acquired.
 */
export const HarnessRunOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    harnessRunId: TradingId,
  }),
  Schema.Struct({
    status: Schema.Literal("queued_behind_active_run"),
  }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    /** Short machine-readable reason; a failed §12.3 pre-run check. */
    reason: Schema.String,
  }),
]);
export type HarnessRunOutcome = typeof HarnessRunOutcome.Type;
