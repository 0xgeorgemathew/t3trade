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
import { AgentAccountSnapshot } from "./account-snapshot.ts";
import { TradingAuthority } from "./authority.ts";
import { AgentMarketSnapshot } from "./market.ts";
import { TradingHarnessRunCause } from "./mission.ts";
import { TradingId, TradingText, UnixMillis } from "./primitives.ts";
import { MomentumStrategyState, TradingTimeframe } from "./strategy.ts";
import { PersistedWatch, WatchArmedReason } from "./watch.ts";

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
 * The authoritative mission snapshot a resumed run starts with - spec §12.2.
 *
 * The harness does not receive unbounded market data or a free-form prompt. It
 * receives the cause, the triggering watch or user message, and a fresh,
 * versioned snapshot of market, account, active strategy, authority, and the
 * coalesced pending events the run was started with.
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
   * the thesis is the thing to reconsider.
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
  activeStrategy: MomentumStrategyState,
  /**
   * How long ago the active strategy was published, in milliseconds.
   *
   * A thesis has a shelf life and the harness cannot read one from a version
   * number. This is the number that says "you wrote this forty minutes ago on a
   * 1m chart" without a second tool call.
   */
  strategyAgeMillis: Schema.Number,
  /**
   * Every watch still armed for this mission, with the distance from the
   * current mark for the two types that carry a level.
   */
  armedWatches: Schema.Array(WakeupArmedWatch),
  /**
   * The user's mandate: hard rails, fixed for the life of the mission. Sized
   * from the account value when the mission was created and deliberately not
   * re-scaled since, so a balance that moves changes what the harness can
   * afford, never what it is allowed.
   */
  authority: TradingAuthority,
  pendingEvents: Schema.Array(TradingDomainEventSummary),
  instruction: TradingText,
  /**
   * The timeframe to work on unless the instruction names another. Published on
   * every wakeup rather than only the first, so a resumed run that has lost the
   * bootstrap turn from its context still knows which candle the mission runs
   * on. See `POC_DEFAULT_TIMEFRAME`.
   */
  defaultTimeframe: TradingTimeframe,
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
