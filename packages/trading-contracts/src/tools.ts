/**
 * Mission and strategy tool contracts - spec §14.3.
 *
 * Tools accept intent-level inputs. Publishing is a versioned, side-effecting
 * operation: `trading_publish_momentum_strategy` requires an expected current
 * version, and a stale expected-version publish is rejected rather than
 * silently overwriting current state.
 *
 * §14.3 publishes `TradingPublishMomentumStrategyInput` and
 * `TradingPublishMomentumStrategyResult` in full; both are mirrored here
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
  MarketHistory,
  MarketHistoryRequest,
  OrderBook,
  ResolvedMarket,
} from "./market.ts";
import { TradingHarnessBinding, TradingMission, TradingMissionControl } from "./mission.ts";
import { TradingId } from "./primitives.ts";
import { TradingOrderIntent } from "./execution.ts";
import { momentumStrategyAuthoredFields, MomentumStrategyState } from "./strategy.ts";
import { MarketWatch, PersistedWatch } from "./watch.ts";

export const TRADING_GET_MISSION_TOOL = "trading_get_mission";
export const TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL = "trading_publish_momentum_strategy";

// -- §14.2 read-tool names (Phase 2) -----------------------------------------

export const TRADING_RESOLVE_MARKET_TOOL = "trading_resolve_market";
export const TRADING_GET_MARKET_SNAPSHOT_TOOL = "trading_get_market_snapshot";
export const TRADING_GET_MARKET_HISTORY_TOOL = "trading_get_market_history";
export const TRADING_GET_ORDER_BOOK_TOOL = "trading_get_order_book";
export const TRADING_GET_ACCOUNT_STATE_TOOL = "trading_get_account_state";
export const TRADING_GET_POSITION_TOOL = "trading_get_position";
export const TRADING_GET_OPEN_ORDERS_TOOL = "trading_get_open_orders";
export const TRADING_REQUEST_ENTRY_TOOL = "trading_request_entry";

// -- shared tool rejection ---------------------------------------------------

/**
 * Why a trading tool refused to act at all.
 *
 * These are distinct from `trading_publish_momentum_strategy`'s in-band
 * `outcome: "rejected"`, which reports a *published* result the harness can
 * retry against. A `TradingToolRejectedError` means the call never reached the
 * mission: the credential did not carry the capability, or the calling thread
 * is not the thread an active mission is bound to (§10.2).
 *
 * Fork-owned: the spec names the tools and their payloads but does not publish
 * a tool-level failure type.
 */
export const TradingToolRejectionReason = Schema.Literals([
  "capability_not_granted",
  "thread_not_bound_to_mission",
  "mission_not_bound_to_thread",
  "mission_not_found",
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

/** Current mission, authority, strategy, watches, and control flags. */
export const TradingBoundMissionResult = Schema.Struct({
  /** Discriminates this from the unbound-thread answer below. */
  bound: Schema.Literal(true),
  mission: TradingMission,
  authority: TradingAuthority,
  authorityVersion: Schema.Number,
  strategy: Schema.optional(MomentumStrategyState),
  strategyVersion: Schema.Number,
  watches: Schema.Array(PersistedWatch),
  control: TradingMissionControl,
  harness: TradingHarnessBinding,
  /** Executions written but not yet answered — what a lock rejection means. */
  pendingExecutions: Schema.Array(TradingPendingExecution),
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

// -- trading_publish_momentum_strategy ---------------------------------------

/**
 * The strategy body the harness publishes.
 *
 * `version` and `updatedAt` are assigned by the server on acceptance, so the
 * harness supplies neither: the accepted version is always
 * `expectedVersion + 1`.
 */
export const PublishMomentumStrategyBody = Schema.Struct(momentumStrategyAuthoredFields);
export type PublishMomentumStrategyBody = typeof PublishMomentumStrategyBody.Type;

export const TradingPublishMomentumStrategyInput = Schema.Struct({
  /** Optional — omit to act on the mission this session is bound to. */
  missionId: Schema.optional(TradingId),
  /** The strategy version the harness believes is current. 0 before any publish. */
  expectedVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  strategy: PublishMomentumStrategyBody,
});
export type TradingPublishMomentumStrategyInput = typeof TradingPublishMomentumStrategyInput.Type;

export const PublishMomentumStrategyRejection = Schema.Literals([
  "stale_strategy_version",
  "mission_not_active",
]);
export type PublishMomentumStrategyRejection = typeof PublishMomentumStrategyRejection.Type;

export const TradingPublishMomentumStrategyResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("accepted"),
    strategy: MomentumStrategyState,
    strategyVersion: Schema.Number,
    /** Watches bound to the prior version, marked superseded by this publish. */
    supersededWatchIds: Schema.Array(TradingId),
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: PublishMomentumStrategyRejection,
    /** The version the server actually holds, so the harness can retry. */
    currentVersion: Schema.Number,
  }),
]);
export type TradingPublishMomentumStrategyResult = typeof TradingPublishMomentumStrategyResult.Type;

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

export const TradingRequestEntryInput = Schema.Struct({
  ...missionBound,
  intent: TradingOrderIntent,
  expectedAuthorityVersion: Schema.Number,
  activeHarnessRunId: TradingId,
});
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
   * Size-weighted average price of the fills recorded under this execution's
   * cloid, when any filled. This is what the position was actually opened or
   * closed at — the limit above is only the bound it could not cross.
   */
  avgFillPrice: Schema.optional(Schema.Number),
});
export type TradingRequestEntryResult = typeof TradingRequestEntryResult.Type;

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
});
export type TradingRegisterWatchInput = typeof TradingRegisterWatchInput.Type;

export const TradingRegisterWatchResult = PersistedWatch;
export type TradingRegisterWatchResult = PersistedWatch;

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
