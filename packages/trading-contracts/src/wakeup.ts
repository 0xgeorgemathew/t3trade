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
import { PersistedWatch } from "./watch.ts";

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
  missionId: TradingId,
  harnessRunId: TradingId,
  cause: TradingHarnessRunCause,
  occurredAt: UnixMillis,
  /** The watch whose predicate matched, when this run was woken by a watch. */
  triggeringWatch: Schema.optional(PersistedWatch),
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
