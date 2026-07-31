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
import { momentumStrategyAuthoredFields, MomentumStrategyState } from "./strategy.ts";
import { PersistedWatch } from "./watch.ts";

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
  missionId: TradingId,
});
export type TradingGetMissionInput = typeof TradingGetMissionInput.Type;

/** Current mission, authority, strategy, watches, and control flags. */
export const TradingGetMissionResult = Schema.Struct({
  mission: TradingMission,
  authority: TradingAuthority,
  authorityVersion: Schema.Number,
  strategy: Schema.optional(MomentumStrategyState),
  strategyVersion: Schema.Number,
  watches: Schema.Array(PersistedWatch),
  control: TradingMissionControl,
  harness: TradingHarnessBinding,
});
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
  missionId: TradingId,
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

/** Shared mission-binding field on every read tool input. */
const missionBound = {
  missionId: TradingId,
} as const;

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
