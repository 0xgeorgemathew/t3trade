/**
 * Mission and strategy tool contracts - spec §14.3.
 *
 * Tools accept intent-level inputs. Publishing is a versioned, side-effecting
 * operation: `trading_plan` requires an expected current
 * version, and a stale expected-version publish is rejected rather than
 * silently overwriting current state.
 *
 * §14.3 publishes `TradingPublishPlanInput` and
 * `TradingPublishPlanResult` in full; both are mirrored here
 * field-for-field.
 *
 * Scope note: §14.1/§14.2/§14.4-§14.7 name their tools but publish no input or
 * output schemas, and execution is out of scope for this phase. Only the two
 * §14.3 mission tools are modeled here.
 *
 * @module TradingTools
 */
import { Schema } from "effect";
import { AgentAccountSnapshot, AgentNetPosition, AgentOpenOrder } from "./account-snapshot.ts";
import { TradingAuthority } from "./authority.ts";
import {
  AgentMarketSnapshot,
  MarketCandleInterval,
  MarketHistory,
  MarketHistoryRequest,
  OrderBook,
  ResolvedMarket,
} from "./market.ts";
import type { TradingCostEstimate } from "./costs.ts";
import type { MarketStructure } from "./marketStructure.ts";
import type { TradingTradeHistory } from "./history.ts";
import { TargetCalibration } from "./calibration.ts";
import { ObservedVolatility } from "./volatility.ts";
import { TradingHarnessBinding, TradingMission, TradingMissionControl } from "./mission.ts";
import { Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { StopAdjustmentJustification, StopAdjustmentRefusalCode } from "./stopAdjustment.ts";
import { TradingOrderTimeInForce } from "./execution.ts";
import { EntrySizeConstraint } from "./entry.ts";
import { TradingExitRefusalCode } from "./exit.ts";
import { FailureRecovery } from "./recovery.ts";
import { tradingPlanAuthoredFields, TradingPlanState } from "./strategy.ts";
import { PersistedWatch, WatchCondition, WatchRefusalCode } from "./watch.ts";
import { Playbook, TradingPlaybookName } from "./playbook.ts";

// Renamed from `trading_plan` — plan 29 step 6.5. The behaviour is
// unchanged: the same eight authored fields, the same mission-version guard,
// the same publish aftermath. What went is the verb the model had to spell out
// to reach the plan at all.
export const TRADING_PLAN_TOOL = "trading_plan";

// The twelve read-tool names that used to live here retired into
// `TRADING_LOOK_TOOL` (./observation.ts) — plan 29 step 6.1.

// `trading_get_target_calibration` retired off the hot path — plan 29 step
// 6.5. The grading is a read of the mission's own closed trades, so it rides
// `trading_look` as `mission.targetCalibration` instead of costing a turn a
// tool call to ask a question the one read was already answering.
export const TRADING_GET_PLAYBOOK_TOOL = "trading_get_playbook";
// `trading_adjust_stop` retired into `trading_exit`'s `move_stop` action —
// plan 29 step 6.5. The policy it answered to did not move; only the name did.

// `trading_execute` and its `trading_request_entry` alias retired into
// `TRADING_ENTER_TOOL` (./entry.ts) — plan 29 step 6.2. Both existed to spend
// a quote the harness had just been handed; with the quote gone, entering is
// one call and its name is what it does.

// -- shared tool rejection ---------------------------------------------------

/**
 * Why a trading tool refused to act at all.
 *
 * These are distinct from `trading_plan`'s in-band
 * `outcome: "rejected"`, which reports a *published* result the harness can
 * retry against. A `TradingToolRejectedError` means the call never reached the
 * mission: the credential did not carry the capability, the calling thread is
 * not the thread an active mission is bound to (§10.2), or the market read the
 * answer is made of could not be taken.
 *
 * Fork-owned: the spec names the tools and their payloads but does not publish
 * a tool-level failure type.
 */
export const TradingToolRejectionReason = Schema.Literals([
  "capability_not_granted",
  "thread_not_bound_to_mission",
  "mission_not_bound_to_thread",
  "mission_not_found",
  /** A required exchange read failed. The tool has nothing to answer with, and
      saying so is better than the opaque crash a defect produces. */
  "market_data_unavailable",
]);
export type TradingToolRejectionReason = typeof TradingToolRejectionReason.Type;

export class TradingToolRejectedError extends Schema.TaggedErrorClass<TradingToolRejectedError>()(
  "TradingToolRejectedError",
  {
    reason: TradingToolRejectionReason,
    /** The thread whose MCP credential made the call. */
    threadId: Schema.String,
    /** The mission the call named, when it named one. */
    missionId: Schema.optional(Schema.String),
  },
) {
  /**
   * The MCP tool boundary passes a *declared* failure's message through
   * verbatim and collapses anything else to a generic internal-error string, so
   * this message is what makes the rejection legible to the harness. Keep the
   * tag and every field in it.
   */
  override get message(): string {
    const mission = this.missionId === undefined ? "" : `, mission=${this.missionId}`;
    return `TradingToolRejectedError: ${this.reason} (thread=${this.threadId}${mission})`;
  }
}

// -- trading_look -----------------------------------------------------

export const TradingGetMissionInput = Schema.Struct({
  /**
   * Optional since the calling thread is bound to exactly one mission; omit it
   * and the call acts on the bound mission. A wrong `missionId` is still
   * rejected with `mission_not_bound_to_thread`.
   */
  missionId: Schema.optional(TradingId),
});
export type TradingGetMissionInput = typeof TradingGetMissionInput.Type;

/**
 * An execution this mission has written but the exchange has not yet answered.
 *
 * While one of these exists, preview item 16 refuses every new intent. The
 * harness could previously see only the refusal, never the thing causing it,
 * so the same summary is published here too.
 */
export const TradingPendingExecution = Schema.Struct({
  cloid: Schema.String,
  actionType: Schema.String,
  status: Schema.String,
  /** How long it has sat in a non-terminal status, in milliseconds. */
  ageMillis: Schema.Number,
});
export type TradingPendingExecution = typeof TradingPendingExecution.Type;

/**
 * One plan version the mission published, as its own history reads it.
 *
 * `trading_look` returns the CURRENT plan, so a mission that has
 * republished four times can see only its latest thesis — and "did the last
 * three targets work?" was a question with no way to ask it. This is the
 * skeleton of each: what it intended, what it targeted, and why.
 */
export const PublishedStrategySummary = Schema.Struct({
  version: Schema.Number,
  publishedAt: UnixMillis,
  /** The plan's intent that version — `long`, `short`, or `stand_aside`. */
  intent: Schema.String,
  /** The conservative target rung that version named, when it named one. */
  targetProfitUsd: Schema.optional(Schema.Number),
  /** The narrative that version was published on. */
  because: Schema.optional(Schema.String),
});
export type PublishedStrategySummary = typeof PublishedStrategySummary.Type;

/** Current mission, authority, strategy, watches, and control flags. */
export const TradingBoundMissionResult = Schema.Struct({
  /** Discriminates this from the unbound-thread answer below. */
  bound: Schema.Literal(true),
  mission: TradingMission,
  authority: TradingAuthority,
  authorityVersion: Schema.Number,
  strategy: Schema.optional(TradingPlanState),
  /**
   * The mission row's optimistic-lock version (plan 29 step 4.2). Publishing
   * a plan refuses a stale `expectedMissionVersion`, and this is the number
   * the harness compares against — the mission no longer carries a
   * strategy-version counter of its own.
   */
  missionVersion: Schema.Number,
  watches: Schema.Array(PersistedWatch),
  control: TradingMissionControl,
  harness: TradingHarnessBinding,
  /** Executions written but not yet answered — what a lock rejection means. */
  pendingExecutions: Schema.Array(TradingPendingExecution),
  /**
   * Every plan this mission has published, newest first.
   *
   * `strategy` above is only the current one. Without the rest, a harness that
   * has republished three times cannot see what it previously believed, what it
   * targeted, or on what basis — which makes "was the last target the right
   * rung?" unanswerable from inside the loop.
   */
  strategyHistory: Schema.Array(PublishedStrategySummary),
  /**
   * Those targets, graded against what the mission's trades actually reached —
   * plan 29 step 6.5, where `trading_get_target_calibration` came off the hot
   * path.
   *
   * Here rather than in a tool of its own because it answers a question the
   * one read was already half-answering: `strategyHistory` says what was
   * targeted, and this says whether any of it was reachable. Absent until the
   * mission has a closed trade to grade, so a mission that has not traded
   * carries nothing extra.
   */
  targetCalibration: Schema.optional(TargetCalibration),
});
export type TradingBoundMissionResult = typeof TradingBoundMissionResult.Type;

/**
 * What `trading_look` answers on a thread no live mission owns.
 *
 * A mission that ends — revoked, completed — stops matching the binding query,
 * and every tool on the thread then failed with `thread_not_bound_to_mission`,
 * including the reads that would have explained why. The agent could not learn
 * that its own mission had finished. This says so, names the terminal status it
 * finished in, and points at the mission that took the slot if one did.
 */
export const TradingUnboundMissionResult = Schema.Struct({
  bound: Schema.Literal(false),
  /** The last mission this thread was bound to, when there was one. */
  lastMission: Schema.optional(TradingMission),
  /** The mission that holds the active slot now, when a newer one does. */
  activeMissionId: Schema.optional(TradingId),
});
export type TradingUnboundMissionResult = typeof TradingUnboundMissionResult.Type;

export const TradingGetMissionResult = Schema.Union([
  TradingBoundMissionResult,
  TradingUnboundMissionResult,
]);
export type TradingGetMissionResult = typeof TradingGetMissionResult.Type;

// -- trading_plan ----------------------------------------------------

/**
 * The plan body the harness publishes — the eight authored fields of the
 * position-centric document (plan 29 step 4.1): `market`, `intent`, `entry`,
 * `stop`, `target`, `invalidation`, `reassess`, `because`.
 *
 * `updatedAt` is assigned by the server on acceptance, so the harness does not
 * supply it. The accepted plan's identity in `trading_plan_history` is the
 * row itself; the document carries no version number.
 */
export const PublishTradingPlanBody = Schema.Struct(tradingPlanAuthoredFields);
export type PublishTradingPlanBody = typeof PublishTradingPlanBody.Type;

export const TradingPublishPlanInput = Schema.Struct({
  /** Optional — omit to act on the mission this session is bound to. */
  missionId: Schema.optional(TradingId),
  /**
   * The mission row's optimistic-lock version as the harness last read it
   * (`trading_look` returns it as `missionVersion`). A publish against
   * a mission that has moved on is refused — plan 29 step 4.2 re-keyed this
   * guard from the retired strategy-version counter onto the mission row's
   * own version, keeping the strength without the version semantics.
   */
  expectedMissionVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  strategy: PublishTradingPlanBody,
});
export type TradingPublishPlanInput = typeof TradingPublishPlanInput.Type;

export const PublishTradingPlanRejection = Schema.Literals([
  "stale_mission_state",
  "mission_not_active",
]);
export type PublishTradingPlanRejection = typeof PublishTradingPlanRejection.Type;

export const TradingPublishPlanResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("accepted"),
    strategy: TradingPlanState,
    /**
     * Things wrong with the published strategy that did not stop the publish —
     * today, prose the server clipped to its published bound.
     *
     * In-band rather than a rejection: the plan is usable, and the harness is
     * told what changed.
     */
    warnings: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: PublishTradingPlanRejection,
    /** The mission version the server actually holds, so the harness can retry. */
    currentVersion: Schema.Number,
    /** What specifically was wrong, when the reason alone does not say. */
    detail: Schema.optional(Schema.String),
  }),
]);
export type TradingPublishPlanResult = typeof TradingPublishPlanResult.Type;

// -- §14.2 read-only market-data tools (Phase 2) -----------------------------
//
// Every read tool takes a `missionId` so the handler can authorize the call
// against the mission bound to the calling thread (the same `resolveBoundCall`
// path the §14.3 tools use). The master-wallet address used for account reads
// comes from the mission's trading account — the harness never supplies it.
// Market-symbol inputs reuse the POC `TradingMarket` literal ("ETH"); when the
// POC widens to more markets, the literal widens with it.

/**
 * Shared mission-binding field on every read tool input.
 *
 * `missionId` is optional: the calling thread is bound to exactly one mission,
 * so omitting it resolves to that mission. A wrong `missionId` is still
 * rejected with `mission_not_bound_to_thread`.
 */
const missionBound = {
  missionId: Schema.optional(TradingId),
} as const;

export const TradingRequestEntryResult = Schema.Struct({
  /**
   * The execution record this request wrote, when it wrote one.
   *
   * Absent for the two outcomes that have no record: a request refused before
   * signing, and a request still in flight when the tool gave up waiting.
   * `TradingId` is a non-empty string, so reporting those as `""` made the
   * result unencodable — and an unencodable result reaches the harness as a
   * generic internal error, hiding the refusal reason it most needed to read.
   */
  executionId: Schema.optional(TradingId),
  /**
   * What actually became of the request.
   *
   * Mirrors the persisted execution record's own status rather than
   * flattening it: `accepted` used to be reported for a record that had been
   * cancelled or had failed, which tells the harness it has a live order when
   * it has none.
   *
   * - `submitted` — still in flight when the tool stopped waiting;
   * - `accepted` — acknowledged and resting on the book;
   * - `filled`, `cancelled`, `rejected`, `failed` — the record's terminal word;
   * - `succeeded` — a deterministic action with no order of its own (a
   *   `cancel`, a `modify_stop`) that did what it was asked.
   */
  status: Schema.Literals([
    "submitted",
    "accepted",
    "filled",
    "cancelled",
    "rejected",
    "failed",
    "succeeded",
  ]),
  cloid: Schema.String,
  orderResults: Schema.Array(Schema.Unknown),
  budget: Schema.Struct({
    remainingCumulativeLossUsd: Schema.Number,
    exhausted: Schema.Boolean,
  }),
  /**
   * Why the request ended the way it did — the refusal reason for a
   * `rejected`, the record's exchange status for an `accepted`, and for a
   * `submitted` the fact that the outcome is not yet known.
   *
   * `status` alone cannot distinguish "refused at preview, no order exists"
   * from "the exchange rejected the order", and a harness that cannot tell
   * those apart cannot decide what to do next.
   */
  detail: Schema.optional(Schema.String),
  /**
   * Signed canonical position size after a `reduce` or `close`, read from the
   * reconciled snapshot the post-submit convergence wrote.
   *
   * A scale-out that reports only "accepted" leaves the harness to guess how
   * much it still holds, and the guess is what it then sizes its stop against.
   */
  remainingSize: Schema.optional(Schema.Number),
  /**
   * The limit price the server actually placed, not the one the intent named.
   *
   * A `marketable_ioc` limit is derived from the fresh BBO ± the configured
   * slippage allowance, so the intent's `limitPrice` and the order's are two
   * different numbers. Reporting only the intent's is what left a standing gap
   * between the fills T3 reported and the price column in the Hyperliquid UI.
   */
  limitPrice: Schema.optional(Schema.Number),
  /**
   * The time-in-force the order actually went out with — `ioc` when it crossed,
   * `alo` when it rested as maker, `gtc` for a resting limit.
   *
   * The harness asks in urgency, never in TIF; this is the server's answer for
   * what that urgency became on the wire, so what was done can be told apart
   * from what was asked. Absent when no order was placed (a refusal, or an
   * outcome still unknown).
   */
  timeInForce: Schema.optional(TradingOrderTimeInForce),
  /**
   * Size-weighted average price of the fills recorded under this execution's
   * cloid, when any filled. This is what the position was actually opened or
   * closed at — the limit above is only the bound it could not cross.
   */
  avgFillPrice: Schema.optional(Schema.Number),
  /**
   * Whether this outcome is worth trying again, and what to do if it is not.
   *
   * Every failure used to arrive as the same thing — a turn that did not trade
   * — so a rate-limited read and an authority that forbids the direction were
   * indistinguishable, and standing down was the only response available to
   * both. This says which one happened. `retryable` is never true for anything
   * that spent a nonce: an unknown submission is settled by reading state, not
   * by sending it again.
   */
  recovery: Schema.optional(FailureRecovery),
});
export type TradingRequestEntryResult = typeof TradingRequestEntryResult.Type;

/**
 * What `trading_enter` reports back: the execution outcome, plus what the
 * server decided on the way to it.
 *
 * The sizing fields are the half the retired quote used to return in its own
 * call. They are not decoration: a harness that asked for one size and got
 * another has to know which ceiling bound it before it sizes the next
 * decision, and `notes` carries the things that are true of the entry without
 * stopping it — a size under the mandate's own floor, a target the ceilings
 * cannot fund.
 */
export const TradingEnterResult = Schema.Struct({
  ...TradingRequestEntryResult.fields,
  /** Size the server actually sent, in base units. Absent on a refusal. */
  size: Schema.optional(Schema.Number),
  /** Which ceiling produced that size. `requested` means none did. */
  constrainedBy: Schema.optional(EntrySizeConstraint),
  /** Notional at the entry price, in USD. */
  notionalUsd: Schema.optional(Schema.Number),
  /** Planned loss if the stop is hit, at the size that went out. */
  plannedLossAtStopUsd: Schema.optional(Schema.Number),
  /** Round trip at this size, so the target can be held against it. */
  estimatedRoundTripCostUsd: Schema.optional(Schema.Number),
  /**
   * The largest size that would have cleared, when a smaller one would.
   * Absent when the refusal is not about size at all.
   */
  feasibleSize: Schema.optional(Schema.Number),
  /** True of this entry, but not reasons to refuse it. */
  notes: Schema.optional(Schema.Array(Schema.String)),
});
export type TradingEnterResult = typeof TradingEnterResult.Type;

// -- trading_exit's move_stop (plan 24 §5.2) --------------------------------

/**
 * The refusals that are about the mission rather than the policy.
 *
 * `checkStopAdjustment` answers "is this move within the rules"; these are the
 * cases where the question could not be asked at all — nothing to adjust, no
 * price to measure against, or a harness reasoning against a plan the mission
 * has since revised.
 */
export const TradingAdjustStopRefusalContext = Schema.Literals([
  "no_position",
  "no_resting_stop",
  /** The plan has been revised since the harness last read it. */
  "stale_plan",
  "market_data_unavailable",
  /** The policy passed but the exchange replacement did not confirm. */
  "replacement_failed",
]);
export type TradingAdjustStopRefusalContext = typeof TradingAdjustStopRefusalContext.Type;

/**
 * Move the stop on an open position, inside the policy.
 *
 * The same `replaceProtection` path `trading_execute` `modify_stop` takes, with
 * `checkStopAdjustment`'s rules in front of it: the risk envelope the entry was
 * approved with, a per-call step cap measured in ATR, a noise floor, the
 * breakeven ratchet, and a rate limit. Everything the server needs to check
 * those — the ATR included — it measures itself.
 */
export const TradingAdjustStopInput = Schema.Struct({
  ...missionBound,
  market: TradingMarket,
  newStopPrice: Price,
  justification: StopAdjustmentJustification,
  /**
   * The `updatedAt` of the plan the harness last read (plan 29 step 4.2
   * re-keyed this staleness guard off the retired strategy-version counter).
   * A move asked against a plan the server has since revised is refused — the
   * revision may itself have moved the stop.
   */
  expectedPlanUpdatedAt: UnixMillis,
  // Execution identity is allocated from current server state after the
  // adjustment policy accepts; the harness supplies none of it.
});
export type TradingAdjustStopInput = typeof TradingAdjustStopInput.Type;

export const TradingAdjustStopResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("adjusted"),
    previousStop: Schema.Number,
    newStop: Schema.Number,
    /** Distance from the current mark to the new stop. */
    stopDistanceUsd: Schema.Number,
    /** What the position now loses if it stops out. */
    plannedLossAtStopUsd: Schema.Number,
    /** Adjustments left on this position before the budget refuses. */
    remainingAdjustments: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    refusalCode: Schema.Union([StopAdjustmentRefusalCode, TradingAdjustStopRefusalContext]),
    /** The stop still resting, unchanged. */
    previousStop: Schema.Number,
    /** What was asked for, so the harness can see the two numbers together. */
    newStop: Schema.Number,
    /** Which bound was hit, in the numbers the rule is expressed in. */
    detail: Schema.String,
  }),
]);
export type TradingAdjustStopResult = typeof TradingAdjustStopResult.Type;

/**
 * What one `trading_exit` call answers with.
 *
 * A union rather than a widened struct, because the two halves report
 * genuinely different things: three actions send an order and report the
 * execution record, and `move_stop` reports where the stop now rests. The
 * `status` literals do not overlap, so the discriminator is unambiguous.
 */
export const TradingExitResult = Schema.Union([
  TradingRequestEntryResult,
  ...TradingAdjustStopResult.members,
  Schema.Struct({
    status: Schema.Literal("refused_request"),
    reason: TradingExitRefusalCode,
    detail: Schema.String,
    recovery: FailureRecovery,
  }),
]);
export type TradingExitResult = typeof TradingExitResult.Type;

export const TradingResolveMarketInput = Schema.Struct({
  ...missionBound,
  market: Schema.String,
});
export type TradingResolveMarketInput = typeof TradingResolveMarketInput.Type;

export const TradingGetMarketSnapshotInput = Schema.Struct({
  ...missionBound,
  market: Schema.String,
});
export type TradingGetMarketSnapshotInput = typeof TradingGetMarketSnapshotInput.Type;

export const TradingGetMarketHistoryInput = Schema.Struct({
  ...missionBound,
  ...MarketHistoryRequest.fields,
});
export type TradingGetMarketHistoryInput = typeof TradingGetMarketHistoryInput.Type;

export const TradingGetOrderBookInput = Schema.Struct({
  ...missionBound,
  market: Schema.String,
});
export type TradingGetOrderBookInput = typeof TradingGetOrderBookInput.Type;

/**
 * Measure the fluctuation a market is producing, on any interval.
 *
 * The wakeup already carries this for the mission's primary timeframe; the tool
 * exists for the other two questions — a different interval, or a longer
 * lookback than the wakeup's window.
 */
export const TradingMeasureVolatilityInput = Schema.Struct({
  ...missionBound,
  // The measurement reads candles, so the symbol is the one a history request
  // takes — the POC `TradingMarket` literal, not a free-form string.
  market: TradingMarket,
  interval: MarketCandleInterval,
  /** Bars to measure over. Defaults to `VOLATILITY_LOOKBACK_BARS`, capped at the §13 500. */
  lookbackBars: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Holding periods, in bars, to report the move distribution for. */
  holdBars: Schema.optional(Schema.Array(Schema.Number.check(Schema.isGreaterThan(0)))),
});
export type TradingMeasureVolatilityInput = typeof TradingMeasureVolatilityInput.Type;

export type TradingMeasureVolatilityResult = ObservedVolatility;

/**
 * Cost a round trip before committing to a target or a size.
 *
 * Exactly one of `sizeEth` / `notionalUsd` names the position to cost; giving
 * both is accepted and `sizeEth` wins, since the size is what the book is
 * actually walked for.
 */
export const TradingEstimateCostsInput = Schema.Struct({
  ...missionBound,
  market: TradingMarket,
  /** Position size in base units (ETH). */
  sizeEth: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Position size in USD of notional — converted at the current mark. */
  notionalUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type TradingEstimateCostsInput = typeof TradingEstimateCostsInput.Type;

export type TradingEstimateCostsResult = TradingCostEstimate;

/**
 * Read the directional structure across several timeframes at once.
 *
 * Volatility says how far this market moves; this says which way, whether the
 * range is expanding, where the last leg started, and what structure the next
 * one runs into. Defaults to `MOMENTUM_TIMEFRAMES` — asking for one timeframe
 * is allowed and defeats the point, since the answer worth having is whether
 * they agree.
 */
export const TradingGetMarketStructureInput = Schema.Struct({
  ...missionBound,
  market: TradingMarket,
  /** Intervals to measure. Defaults to 1m, 5m, 15m, and 1h. */
  intervals: Schema.optional(Schema.Array(MarketCandleInterval)),
  /** Bars per interval. Defaults to `MOMENTUM_LOOKBACK_BARS`, capped at the §13 500. */
  lookbackBars: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type TradingGetMarketStructureInput = typeof TradingGetMarketStructureInput.Type;

export type TradingGetMarketStructureResult = MarketStructure;

/**
 * Read this mission's own completed orders and what they were worth.
 *
 * The mission's fills were persisted from the start and readable only by the
 * workspace; the harness could not see the trades it had already made. Without
 * that it has no way to score a thesis against its outcome, which is the whole
 * of the cooldown step.
 */
export const TradingGetTradeHistoryInput = Schema.Struct({
  ...missionBound,
  /** Completed orders to return, newest first. Defaults to 20, capped at 100. */
  limit: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type TradingGetTradeHistoryInput = typeof TradingGetTradeHistoryInput.Type;

export type TradingGetTradeHistoryResult = TradingTradeHistory;

/**
 * Score the targets this mission published against what its trades actually
 * reached.
 *
 * The one read that can tell the harness its own habit is wrong: a p50 target
 * reached a fifth of the time is not bad luck, it is a target read off the
 * wrong rung.
 */
export const TradingGetTargetCalibrationInput = Schema.Struct({ ...missionBound });
export type TradingGetTargetCalibrationInput = typeof TradingGetTargetCalibrationInput.Type;

export type TradingGetTargetCalibrationResult = TargetCalibration;

/** Account-state and position tools take only the missionId; the address is server-resolved. */
export const TradingGetAccountStateInput = Schema.Struct({ ...missionBound });
export type TradingGetAccountStateInput = typeof TradingGetAccountStateInput.Type;

export const TradingGetPositionInput = Schema.Struct({
  ...missionBound,
  market: Schema.String,
});
export type TradingGetPositionInput = typeof TradingGetPositionInput.Type;

export const TradingGetOpenOrdersInput = Schema.Struct({ ...missionBound });
export type TradingGetOpenOrdersInput = typeof TradingGetOpenOrdersInput.Type;

/**
 * Read one named playbook.
 *
 * The doctrine the harness used to carry inside `POC_DEFAULT_INSTRUCTION`, split
 * into one mode per strategy and reachable by name. The result is the procedure the harness
 * reads in the turn it decides what to do — it never reaches a database and is
 * the same for every mission.
 */
export const TradingGetPlaybookInput = Schema.Struct({
  ...missionBound,
  name: TradingPlaybookName,
});
export type TradingGetPlaybookInput = typeof TradingGetPlaybookInput.Type;

export type TradingGetPlaybookResult = Playbook;

// Result types are the §10.6 read contracts verbatim — no wrapper.
export type TradingResolveMarketResult = ResolvedMarket;
export type TradingGetMarketSnapshotResult = AgentMarketSnapshot;
export type TradingGetMarketHistoryResult = MarketHistory;
export type TradingGetOrderBookResult = OrderBook;
export type TradingGetAccountStateResult = AgentAccountSnapshot;
export type TradingGetPositionResult = AgentNetPosition;
export type TradingGetOpenOrdersResult = ReadonlyArray<AgentOpenOrder>;

// -- §14.4 watch tools (Phase 3) ---------------------------------------------
//
// Watches are registered against the mission, not a plan revision (plan 29
// step 4.2). A cancel only affects an active watch; already-terminal watches
// keep their terminal status. The handler resolves the bound mission through
// the same `resolveBoundCall` path as the §14.2/§14.3 tools.

export const TRADING_WATCH_TOOL = "trading_watch";

/**
 * Arm one condition, or retire one armed watch.
 *
 * Both, because they are one operation on one set: cancelling is a `watch`
 * shape, and having a second tool for the retirement half meant the model had
 * to learn two names for the registry it can already read off `trading_look`
 * (plan 29 step 6.5). Exactly one of `condition` and `cancel` per call —
 * neither, or both, is refused rather than guessed at.
 */
export const TradingWatchInput = Schema.Struct({
  ...missionBound,
  /** What has to become true. One union, five kinds (plan 29 step 6.3). */
  condition: Schema.optional(WatchCondition),
  /**
   * An active watch to retire outright. Only an active watch can be
   * cancelled: one that already fired, or was already cancelled, is terminal.
   *
   * Distinct from `replacesWatchId`, which retires a watch *as* another is
   * armed. This one leaves the side unwatched, which is sometimes exactly
   * what is meant.
   */
  cancel: Schema.optional(TradingId),
  /**
   * An active watch to retire as this one is armed, in a single transaction.
   *
   * A watch fires once and is terminal, so keeping a level standing means
   * re-arming it — and doing that as cancel-then-arm leaves the side being
   * re-levelled unwatched in between. This closes that window.
   */
  replacesWatchId: Schema.optional(TradingId),
});
export type TradingWatchInput = typeof TradingWatchInput.Type;

/**
 * Why a `cancel` did not retire a watch.
 *
 * Kept apart from `WatchRefusalCode` because it is not a rule about a
 * condition: nothing was malformed, the watch named is simply not one that can
 * be cancelled.
 */
export const TradingCancelWatchRejection = Schema.Literals(["watch_not_found", "watch_not_active"]);
export type TradingCancelWatchRejection = typeof TradingCancelWatchRejection.Type;

/**
 * What arming a condition did.
 *
 * A refusal is an outcome rather than a thrown error for the same reason
 * `trading_enter`'s is (plan 29 step 6.2): the harness's next move depends on
 * which kind of refusal it was, and that answer has to survive as data. The
 * `recovery` it carries is the same three-way answer as everywhere else —
 * a rule refuses this, read what is actually true, or try again.
 */
export const TradingWatchResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("armed"),
    watch: PersistedWatch,
    /**
     * The watch `replacesWatchId` actually cancelled.
     *
     * Absent when none was named — and, importantly, also absent when the one
     * named was already terminal. That case is the harness's cue that the
     * level it meant to retire had already fired or been cancelled, so what it
     * just armed is an addition, not a swap.
     */
    replaced: Schema.optional(PersistedWatch),
  }),
  /** What `cancel` retired. The watch is returned in its cancelled state. */
  Schema.Struct({
    outcome: Schema.Literal("cancelled"),
    watch: PersistedWatch,
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: TradingCancelWatchRejection,
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    reason: WatchRefusalCode,
    detail: Schema.String,
    recovery: FailureRecovery,
  }),
]);
export type TradingWatchResult = typeof TradingWatchResult.Type;

// `trading_list_watches` retired into `trading_look` — plan 29 step 6.5. The
// registry rides `mission.watches` on the one read, bounded by
// `listWatchesForRead`, so a separate list call was a second name for a thing
// the model already had in front of it.
