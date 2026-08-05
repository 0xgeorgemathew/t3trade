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
  /** Realised PnL the exchange attributed to this fill (§16.2 closedPnl). */
  closedPnl: Schema.Number,
  /**
   * Where the fill sat in the position's life, as the exchange labelled it:
   * "Open Long", "Close Long", "Open Short", "Close Short", or a reversal like
   * "Long > Short". Absent on fills recorded before this was carried.
   *
   * The receipt needs it because `side` alone does not say what happened — a
   * sell opens a short and closes a long — and the receipt list is capped at
   * three orders, so the UI cannot recover it by walking the position itself.
   */
  direction: Schema.optional(Schema.String),
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
  markPrice: Schema.optional(Schema.Number),
  unrealisedPnl: Schema.Number,
  marginUsed: Schema.Number,
  protectedSize: Schema.Number,
  /** Exchange liquidation price, surfaced to the position card. */
  liquidationPrice: Schema.optional(Schema.Number),
  observedAt: IsoDateTime,
});
export type TradingPositionView = typeof TradingPositionView.Type;

/**
 * One OHLCV bar for the chart. Volume and trade count are dropped on
 * purpose — the chart draws neither, so carrying them is bandwidth for
 * nothing on a 15s poll.
 */
export const TradingChartCandle = Schema.Struct({
  /** Epoch millis, start of the bar. */
  openTime: Schema.Number,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  close: Schema.Number,
});
export type TradingChartCandle = typeof TradingChartCandle.Type;

/**
 * Candles plus the snapshot figures for one market. The chart needs both a
 * price series and the current mark/funding/OI/volume/change to render its
 * header and footer rows, so they travel together. `null` never appears in
 * this struct: a failed read yields `null` for the whole RPC response (the
 * service never serves a half-populated chart).
 */
export const TradingMarketChartView = Schema.Struct({
  market: TrimmedNonEmptyString,
  interval: Schema.Literals(["1m", "3m", "5m", "15m", "1h"]),
  candles: Schema.Array(TradingChartCandle),
  markPrice: Schema.Number,
  change24hPercent: Schema.Number,
  fundingRate8h: Schema.Number,
  openInterest: Schema.Number,
  dayVolumeUsd: Schema.Number,
  /** When the gateway last confirmed these figures. */
  observedAt: IsoDateTime,
});
export type TradingMarketChartView = typeof TradingMarketChartView.Type;

/**
 * The completion summary card's figures (§14.7 risk chrome).
 *
 * Aggregated across ALL of the mission's fills, not the three the receipt list
 * shows: a summary that only counted recent fills would understate a mission
 * that traded more than three times.
 */
export const TradingMissionResultView = Schema.Struct({
  /** Realised PnL the exchange attributed to this mission's fills. */
  realizedPnlUsd: Schema.Number,
  /** Trading fees already paid. Always a cost, never netted into PnL twice. */
  feesPaidUsd: Schema.Number,
  fillCount: NonNegativeInt,
  /** First and last fill, for the mission's traded duration. */
  firstFillAt: Schema.NullOr(IsoDateTime),
  lastFillAt: Schema.NullOr(IsoDateTime),
});
export type TradingMissionResultView = typeof TradingMissionResultView.Type;

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
  /**
   * The market's live mark price.
   *
   * Read from the exchange rather than from the position, because the position
   * snapshot's mark is cleared the moment the mission goes flat — and a waiting
   * mission is exactly the one whose surfaces need to say where the market is.
   * Absent when the exchange read failed; never a stale carry-forward.
   */
  marketPrice: Schema.optional(Schema.Number),
  /**
   * The leverage the exchange has this mission's market configured at, e.g. 20.
   *
   * Mission-level rather than on the position, because it is a setting and not a
   * measurement: it is the same for the position that just closed and the one
   * about to open, and the receipts that quote it are read after the position
   * they belong to is gone. Absent until the first reconcile has seen one.
   */
  leverage: Schema.optional(Schema.Number),
  /** Realised result across every fill, for the completion summary card. */
  result: TradingMissionResultView,

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
  /** Omit to have the server resolve the mandate from the live account value. */
  allocatedCapitalUsd: Schema.optional(Schema.Number),
  createdAt: IsoDateTime,
});

/**
 * The §14.7 controls that are pure §11.1 status transitions.
 *
 * Pause, resume, and revoke change what the mission is allowed to do next and
 * touch no exchange state, so they resolve to a target status in the decider.
 * The four controls that DO touch live exchange state are separate — see
 * `TradingMissionRiskControlCommand`.
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

/**
 * The §14.7 controls that reach the exchange.
 *
 * Modelled apart from the lifecycle controls because they are not status
 * transitions: each one submits signed actions and only then reports what the
 * mission became. Their defining property (§14.7) is that a workspace button
 * invokes them directly — no harness turn, and availability that does not
 * depend on the bound harness being online.
 */
export const TradingRiskControl = Schema.Literals([
  "cancel_entries",
  "reduce_position",
  "close_position",
  "close_and_revoke",
]);
export type TradingRiskControl = typeof TradingRiskControl.Type;

/** The four reduction sizes the workspace offers (§14.7). */
export const TradingReductionPercent = Schema.Literals([25, 50, 75, 100]);
export type TradingReductionPercent = typeof TradingReductionPercent.Type;

export const TradingMissionRiskControlCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.risk-control"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  control: TradingRiskControl,
  /** Required by `reduce_position`, meaningless for the others. */
  reductionPercent: Schema.optional(TradingReductionPercent),
  createdAt: IsoDateTime,
});

export const DispatchableTradingCommand = Schema.Union([
  TradingMissionCreateCommand,
  TradingMissionControlCommand,
  TradingMissionRiskControlCommand,
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
  /**
   * The operator's explicit mandate size, or absent for "resolve it from the
   * live account balance at creation time" — see `MissionCapital`. Optional
   * rather than a sentinel number so the two cases stay distinguishable in the
   * event stream: a mission created without a stated capital records that it
   * was created without one.
   */
  allocatedCapitalUsd: Schema.optional(Schema.Number),
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

/**
 * A user pressed a §14.7 risk-reducing button. The reactor runs it through
 * `TradingControlService`; this event is the request, not the outcome.
 */
export const TradingMissionRiskControlRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  control: TradingRiskControl,
  reductionPercent: Schema.optional(TradingReductionPercent),
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
  "trading.mission-risk-control-requested",
  "trading.mission-status-changed",
  "trading.mission-strategy-published",
  "trading.mission-watch-registered",
  "trading.mission-watch-cancelled",
  "trading.mission-watch-fired",
  "trading.mission-run-started",
  "trading.execution-requested",
] as const;
