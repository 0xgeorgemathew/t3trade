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
  MarketWatch,
  MomentumStrategyState,
  PersistedWatch,
  PersistedWatchStatus,
  TradingAuthority,
  TradingHarnessBinding,
  TradingHarnessRunCause,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  TradingOrderIntent,
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

// -- execution read-model views (PROMPT-04 Step 10) --------------------------

/**
 * The order-intent card: a single in-flight execution record the UI shows while
 * an order is being signed/submitted/inspected. Null once the execution settles.
 */
export const TradingExecutionView = Schema.Struct({
  executionId: Schema.String,
  cloid: Schema.String,
  actionType: Schema.String,
  side: Schema.Literals(["buy", "sell"]),
  market: Schema.String,
  size: Schema.Number,
  limitPrice: Schema.Number,
  timeInForce: Schema.Literals(["ioc", "gtc"]),
  reduceOnly: Schema.Boolean,
  status: Schema.String,
  updatedAt: IsoDateTime,
});
export type TradingExecutionView = typeof TradingExecutionView.Type;

/**
 * A fill receipt: one reconciled fill the UI shows per execution (timestamp,
 * order id/cloid, average fill, fees).
 */
export const TradingFillView = Schema.Struct({
  cloid: Schema.optional(Schema.String),
  orderId: Schema.Number,
  market: Schema.String,
  side: Schema.Literals(["buy", "sell"]),
  filledSize: Schema.Number,
  avgFillPrice: Schema.Number,
  feeUsd: Schema.Number,
  tradedAt: IsoDateTime,
});
export type TradingFillView = typeof TradingFillView.Type;

/**
 * The live position card: entry, mark (unrealised PnL), size, stop
 * (protectedSize), from reconciled projections. Null when flat.
 */
export const TradingPositionView = Schema.Struct({
  market: Schema.String,
  size: Schema.Number,
  entryPrice: Schema.optional(Schema.Number),
  unrealisedPnl: Schema.Number,
  marginUsed: Schema.Number,
  protectedSize: Schema.Number,
  /** Exchange liquidation price, surfaced to the position card. */
  liquidationPrice: Schema.optional(Schema.Number),
  observedAt: IsoDateTime,
});
export type TradingPositionView = typeof TradingPositionView.Type;

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

  // PROMPT-04 execution surfaces. Optional so a mission without execution
  // history still decodes — the UI renders the cards only when present.
  /** The order-intent card while an execution is in flight (§10). */
  inFlightExecution: Schema.NullOr(TradingExecutionView),
  /** Recent fill receipts (§10), newest first. */
  recentFills: Schema.Array(TradingFillView),
  /** The live position card from reconciled projections (§10). Null when flat. */
  position: Schema.NullOr(TradingPositionView),

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

/**
 * A watch was registered or cancelled - spec §11.3, §12.1.
 *
 * The watch registry is the writer; this command records the outcome so the
 * workspace sees the new watch (or the cancellation) on the ordered WS push
 * path rather than polling.
 */
export const TradingMissionWatchRegisteredCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.watch-registered"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  /** The full persisted watch, as the registry accepted it. */
  watch: PersistedWatch,
  createdAt: IsoDateTime,
});

export const TradingMissionWatchCancelledCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.watch-cancelled"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  watchId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * A watch predicate matched - spec §11.3, §12.1.
 *
 * Raised by the watch evaluator after it flips a watch to `triggered` and
 * persists the inbox event. The turn coordinator consumes this to decide
 * whether to acquire the lease and wake the bound session.
 */
export const TradingMissionWatchFiredCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.watch-fired"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  watchId: TrimmedNonEmptyString,
  /** The deduplication key the inbox event was persisted under. */
  deduplicationKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * A harness run started - spec §11.2, §12.3.
 *
 * The turn coordinator raises this once the seven pre-run checks pass and the
 * lease is acquired, so the projection reflects the active run.
 */
export const TradingMissionRunStartedCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.run-started"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  harnessRunId: TrimmedNonEmptyString,
  cause: TradingHarnessRunCause,
  createdAt: IsoDateTime,
});

/**
 * A harness entry request to place a signed order (§17.2).
 *
 * Server-raised (not client-dispatchable): the harness publishes its decision
 * lease proof, and `TradingMissionReactor` runs the §17.2 write side — preview,
 * persist-before-signing, sign in the nonce lane, submit, inspect, reconcile.
 * Carries the `TradingOrderIntent` verbatim plus the authority version + harness
 * run that own the decision lease, so preview can reject a stale run before it
 * mutates durable state (§18 optimistic versioning).
 */
export const TradingExecutionRequestedCommand = Schema.Struct({
  type: Schema.Literal("trading.execution.requested"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  intent: TradingOrderIntent,
  /** The authority version the harness saw when it decided; preview rejects a mismatch. */
  expectedAuthorityVersion: NonNegativeInt,
  /** The harness run that owns the decision lease for this mission. */
  activeHarnessRunId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const InternalTradingCommand = Schema.Union([
  TradingMissionStatusSetCommand,
  TradingMissionStrategyPublishedCommand,
  TradingMissionWatchRegisteredCommand,
  TradingMissionWatchCancelledCommand,
  TradingMissionWatchFiredCommand,
  TradingMissionRunStartedCommand,
  TradingExecutionRequestedCommand,
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

export const TradingMissionWatchRegisteredPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  watch: PersistedWatch,
  updatedAt: IsoDateTime,
});

export const TradingMissionWatchCancelledPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  watchId: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const TradingMissionWatchFiredPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  watchId: TrimmedNonEmptyString,
  deduplicationKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const TradingMissionRunStartedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  harnessRunId: TrimmedNonEmptyString,
  cause: TradingHarnessRunCause,
  updatedAt: IsoDateTime,
});

/**
 * A harness asked the reactor to execute an order. The reactor runs the §17.2
 * write side (preview → submit → reconcile); this event is the question, the
 * reactor's status-set + persisted records are the answer.
 */
export const TradingExecutionRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  intent: TradingOrderIntent,
  expectedAuthorityVersion: NonNegativeInt,
  activeHarnessRunId: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
});

export const TRADING_EVENT_TYPES = [
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-status-changed",
  "trading.mission-strategy-published",
  "trading.mission-watch-registered",
  "trading.mission-watch-cancelled",
  "trading.mission-watch-fired",
  "trading.mission-run-started",
  "trading.execution-requested",
] as const;
