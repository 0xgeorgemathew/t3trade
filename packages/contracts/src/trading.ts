/**
 * Trading orchestration contracts.
 *
 * The trading extension raises its commands and events on T3's existing
 * orchestration engine rather than a second one, so these follow the
 * `orchestration.ts` member shape exactly: a `type` literal, a `commandId`, the
 * `threadId` the mission's harness is bound to, and an ISO `createdAt`.
 *
 * Timestamps here are ISO strings because this is the upstream read-model
 * boundary. The trading tables store INTEGER epoch millis (migration 035), and
 * the trading projector converts between the two. The one deliberate exception
 * is the embedded `MomentumStrategyState` and `PersistedWatch` payloads: those
 * are published spec contracts carried verbatim, millis and all, so the shape
 * the harness published is the shape the UI reads.
 *
 * @module TradingOrchestration
 */
import {
  MomentumStrategyState,
  PersistedWatch,
  TradingAuthority,
  TradingHarnessBinding,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
} from "@t3tools/trading-contracts";
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const TradingMissionId = Schema.String.pipe(Schema.brand("TradingMissionId"));
export type TradingMissionId = typeof TradingMissionId.Type;

// -- read model --------------------------------------------------------------

/**
 * A mission as the workspace UI reads it: the mandate, the published strategy,
 * and the watches, in one row so a client never has to join them itself.
 */
export const OrchestrationTradingMission = Schema.Struct({
  id: TradingMissionId,
  threadId: ThreadId,
  userId: TrimmedNonEmptyString,
  tradingAccountId: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  market: TrimmedNonEmptyString,
  strategyFamily: TrimmedNonEmptyString,

  status: TradingMissionStatus,
  blockedReason: Schema.NullOr(TradingMissionBlockedReason),

  authority: TradingAuthority,
  authorityVersion: NonNegativeInt,

  strategy: Schema.NullOr(MomentumStrategyState),
  strategyVersion: NonNegativeInt,

  watches: Schema.Array(PersistedWatch),

  control: TradingMissionControl,
  harness: TradingHarnessBinding,

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationTradingMission = typeof OrchestrationTradingMission.Type;

export const TradingMissionSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  missions: Schema.Array(OrchestrationTradingMission),
  updatedAt: IsoDateTime,
});
export type TradingMissionSnapshot = typeof TradingMissionSnapshot.Type;

// -- client-dispatchable commands -------------------------------------------

export const TradingMissionCreateCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.create"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  tradingAccountId: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  allocatedCapitalUsd: Schema.Number,
  createdAt: IsoDateTime,
});

/**
 * The §14.7 controls that are meaningful before execution exists.
 *
 * `cancel_entries`, `reduce_position`, `close_position`, and
 * `close_and_revoke` all touch live exchange state and wait for the execution
 * phases; only pause, resume, and revoke are deterministic in Phase 1.
 */
export const TradingMissionControlCommand = Schema.Struct({
  type: Schema.Literals([
    "trading.mission.pause",
    "trading.mission.resume",
    "trading.mission.revoke",
  ]),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  createdAt: IsoDateTime,
});

export const DispatchableTradingCommand = Schema.Union([
  TradingMissionCreateCommand,
  TradingMissionControlCommand,
]);
export type DispatchableTradingCommand = typeof DispatchableTradingCommand.Type;

// -- server-raised commands --------------------------------------------------

/**
 * A transition the server decided: a watch fired, a harness run ended, a
 * deterministic safety condition tripped. §11.1 legality is enforced by
 * `TradingMissionService.transition`, which is the only writer of mission
 * status; this command records the transition it performed.
 */
export const TradingMissionStatusSetCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.status-set"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  status: TradingMissionStatus,
  blockedReason: Schema.optional(TradingMissionBlockedReason),
  createdAt: IsoDateTime,
});

export const TradingMissionStrategyPublishedCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.strategy-published"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  strategyVersion: NonNegativeInt,
  supersededWatchIds: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

export const InternalTradingCommand = Schema.Union([
  TradingMissionStatusSetCommand,
  TradingMissionStrategyPublishedCommand,
]);
export type InternalTradingCommand = typeof InternalTradingCommand.Type;

// -- event payloads ----------------------------------------------------------

/**
 * A client asked for a mission. Nothing is persisted yet: `TradingMissionReactor`
 * performs the write and then raises `trading.mission.status-set`, so the
 * projection only ever reflects state the domain accepted.
 */
export const TradingMissionCreateRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  tradingAccountId: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  allocatedCapitalUsd: Schema.Number,
  requestedAt: IsoDateTime,
});

/**
 * A user pressed a §14.7 control. The reactor runs the transition through
 * `TradingMissionService`, which is where §11.1 legality is enforced — the
 * request itself is not a promise that it will be accepted.
 */
export const TradingMissionControlRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  control: Schema.Literals([
    "trading.mission.pause",
    "trading.mission.resume",
    "trading.mission.revoke",
  ]),
  targetStatus: TradingMissionStatus,
  requestedAt: IsoDateTime,
});

export const TradingMissionStatusChangedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  status: TradingMissionStatus,
  blockedReason: Schema.NullOr(TradingMissionBlockedReason),
  updatedAt: IsoDateTime,
});

export const TradingMissionStrategyPublishedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  strategyVersion: NonNegativeInt,
  supersededWatchIds: Schema.Array(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const TRADING_EVENT_TYPES = [
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-status-changed",
  "trading.mission-strategy-published",
] as const;
