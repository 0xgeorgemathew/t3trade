/**
 * Mission and strategy tool contracts - spec §14.3.
 *
 * Tools accept intent-level inputs. Publishing is a versioned, side-effecting
 * operation: `trading_publish_plan` requires an expected current
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
import type { MarketStructure } from "./momentum.ts";
import type { TradingTradeHistory } from "./history.ts";
import type { TargetCalibration } from "./calibration.ts";
import { ObservedVolatility } from "./volatility.ts";
import { TradingHarnessBinding, TradingMission, TradingMissionControl } from "./mission.ts";
import { Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { StopAdjustmentJustification, StopAdjustmentRefusalCode } from "./stopAdjustment.ts";
import { TradingOrderIntent, TradingOrderTimeInForce } from "./execution.ts";
import { FailureRecovery } from "./recovery.ts";
import { tradingPlanAuthoredFields, TradingPlanState } from "./strategy.ts";
import { MarketWatch, PersistedWatch } from "./watch.ts";
import { Playbook, TradingPlaybookName } from "./playbook.ts";

export const TRADING_GET_MISSION_TOOL = "trading_get_mission";
export const TRADING_PUBLISH_PLAN_TOOL = "trading_publish_plan";

// -- §14.2 read-tool names (Phase 2) -----------------------------------------

export const TRADING_RESOLVE_MARKET_TOOL = "trading_resolve_market";
export const TRADING_GET_MARKET_SNAPSHOT_TOOL = "trading_get_market_snapshot";
export const TRADING_GET_MARKET_HISTORY_TOOL = "trading_get_market_history";
export const TRADING_GET_ORDER_BOOK_TOOL = "trading_get_order_book";
export const TRADING_MEASURE_VOLATILITY_TOOL = "trading_measure_volatility";
export const TRADING_ESTIMATE_COSTS_TOOL = "trading_estimate_costs";
export const TRADING_GET_MARKET_STRUCTURE_TOOL = "trading_get_market_structure";
export const TRADING_GET_TRADE_HISTORY_TOOL = "trading_get_trade_history";
export const TRADING_GET_TARGET_CALIBRATION_TOOL = "trading_get_target_calibration";
export const TRADING_GET_ACCOUNT_STATE_TOOL = "trading_get_account_state";
export const TRADING_GET_POSITION_TOOL = "trading_get_position";
export const TRADING_GET_OPEN_ORDERS_TOOL = "trading_get_open_orders";
export const TRADING_GET_PLAYBOOK_TOOL = "trading_get_playbook";
export const TRADING_ADJUST_STOP_TOOL = "trading_adjust_stop";
/**
 * The whole position lifecycle, not just entries.
 *
 * `intent.actionType` selects between `open`, `scale_in`, `reduce`, `close`,
 * `cancel`, and `modify_stop`, so the older name below described one of six
 * things it does. A harness reading a tool list picks by name before it reads
 * the description, and "request entry" is the wrong name to pick `close` from.
 */
export const TRADING_EXECUTE_TOOL = "trading_execute";

/**
 * The original name, kept as an alias so nothing that already learned it
 * breaks. Identical parameters, identical behaviour, same handler.
 */
export const TRADING_REQUEST_ENTRY_TOOL = "trading_request_entry";

// -- shared tool rejection ---------------------------------------------------

/**
 * Why a trading tool refused to act at all.
 *
 * These are distinct from `trading_publish_plan`'s in-band
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

// -- trading_get_mission -----------------------------------------------------

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
 * `trading_get_mission` returns the CURRENT plan, so a mission that has
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
});
export type TradingBoundMissionResult = typeof TradingBoundMissionResult.Type;

/**
 * What `trading_get_mission` answers on a thread no live mission owns.
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

// -- trading_publish_plan ----------------------------------------------------

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
   * (`trading_get_mission` returns it as `missionVersion`). A publish against
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

/**
 * One execution, named either by a server-cut quote or by a hand-built intent.
 *
 * `quoteId` is the whole call for an entry: `trading_quote_entry` already
 * derived the strategy version, the authority version, the lease-owning run,
 * the sequence, the crossing limit price, and a size inside every ceiling, so
 * repeating them here is four more chances to be refused for a reason that has
 * nothing to do with the market.
 *
 * The legacy intent fields remain decodable so old clients receive a precise
 * migration refusal instead of a schema error. They are no longer executable:
 * every live action uses a quote or its dedicated server-owned tool.
 */
export const TradingRequestEntryInput = Schema.Struct({
  ...missionBound,
  /** A quote from `trading_quote_entry`. Supplies every field below. */
  quoteId: Schema.optional(TradingId),
  intent: Schema.optional(TradingOrderIntent),
  expectedAuthorityVersion: Schema.optional(Schema.Number),
  activeHarnessRunId: Schema.optional(TradingId),
}).check(
  Schema.makeFilter((input) => {
    const quoteForm = input.quoteId !== undefined;
    const intentFields = [
      input.intent,
      input.expectedAuthorityVersion,
      input.activeHarnessRunId,
    ].filter((value) => value !== undefined).length;
    if (quoteForm && intentFields > 0) return "quoteId cannot be combined with a full intent.";
    if (!quoteForm && intentFields !== 3) {
      return "Give quoteId alone, or all legacy intent fields together.";
    }
    return true;
  }),
);
export type TradingRequestEntryInput = typeof TradingRequestEntryInput.Type;

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

// `trading_execute` is the same call under the name that describes it. The
// aliases are exported separately so a caller reads the name it is using.
/**
 * The live execution tool's intentionally tiny input.
 *
 * `TradingRequestEntryInput` remains above as a decoder for callers on the old
 * wire shape, but advertising those fields to a harness invites it to choose a
 * form the server must refuse. The published tool accepts only the token whose
 * server-owned intent has already cleared preview.
 */
export const TradingExecuteInput = Schema.Struct({
  ...missionBound,
  quoteId: TradingId,
});
export type TradingExecuteInput = typeof TradingExecuteInput.Type;
export const TradingExecuteResult = TradingRequestEntryResult;
export type TradingExecuteResult = TradingRequestEntryResult;

// -- trading_adjust_stop (plan 24 §5.2) --------------------------------------

/**
 * The refusals that are about the mission rather than the policy.
 *
 * `checkStopAdjustment` answers "is this move within the rules"; these are the
 * cases where the question could not be asked at all — nothing to adjust, no
 * price to measure against, or a harness reasoning against a superseded plan.
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
// Watches are registered against the mission's current strategy version. A
// cancel only affects an active watch; triggered/consumed/superseded watches
// keep their terminal status. The handler resolves the bound mission through
// the same `resolveBoundCall` path as the §14.2/§14.3 tools.

export const TRADING_REGISTER_WATCH_TOOL = "trading_register_watch";
export const TRADING_SCHEDULE_REASSESSMENT_TOOL = "trading_schedule_reassessment";
export const TRADING_LIST_WATCHES_TOOL = "trading_list_watches";
export const TRADING_CANCEL_WATCH_TOOL = "trading_cancel_watch";

export const TradingRegisterWatchInput = Schema.Struct({
  ...missionBound,
  watch: MarketWatch,
  /**
   * An active watch to retire as this one is armed, in a single transaction.
   *
   * A watch fires once and is terminal, so keeping a level standing means
   * re-registering it — and doing that as cancel-then-register leaves the side
   * being re-levelled unwatched in between. This closes that window.
   */
  replacesWatchId: Schema.optional(TradingId),
});
export type TradingRegisterWatchInput = typeof TradingRegisterWatchInput.Type;

export const TradingRegisterWatchResult = Schema.Struct({
  watch: PersistedWatch,
  /**
   * The watch `replacesWatchId` actually cancelled.
   *
   * Absent when none was named — and, importantly, also absent when the one
   * named was already terminal. That case is the harness's cue that the level
   * it meant to retire had already fired or been superseded, so what it just
   * armed is an addition, not a swap.
   */
  replaced: Schema.optional(PersistedWatch),
});
export type TradingRegisterWatchResult = typeof TradingRegisterWatchResult.Type;

export const TradingScheduleReassessmentInput = Schema.Struct({
  ...missionBound,
  /** Epoch millis at which the mission should be reassessed. */
  runAt: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type TradingScheduleReassessmentInput = typeof TradingScheduleReassessmentInput.Type;

export const TradingScheduleReassessmentResult = PersistedWatch;
export type TradingScheduleReassessmentResult = PersistedWatch;

export const TradingListWatchesInput = Schema.Struct({ ...missionBound });
export type TradingListWatchesInput = typeof TradingListWatchesInput.Type;

export const TradingListWatchesResult = Schema.Array(PersistedWatch);
export type TradingListWatchesResult = ReadonlyArray<PersistedWatch>;

export const TradingCancelWatchInput = Schema.Struct({
  ...missionBound,
  watchId: TradingId,
});
export type TradingCancelWatchInput = typeof TradingCancelWatchInput.Type;

export const TradingCancelWatchRejection = Schema.Literals(["watch_not_found", "watch_not_active"]);
export type TradingCancelWatchRejection = typeof TradingCancelWatchRejection.Type;

export const TradingCancelWatchResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("cancelled"),
    watch: PersistedWatch,
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: TradingCancelWatchRejection,
  }),
]);
export type TradingCancelWatchResult = typeof TradingCancelWatchResult.Type;
