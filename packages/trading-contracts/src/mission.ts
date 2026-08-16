/**
 * Harness binding, trading mission, and harness run - spec §10.2, §10.3, §11.2.
 *
 * A harness turn is temporary; a mission is durable. The binding is immutable
 * for the life of an active POC mission, and only one `TradingHarnessRun` may
 * own a mission's decision lease at a time.
 *
 * @module TradingMission
 */
import { Schema } from "effect";
import { TradingAuthority } from "./authority.ts";
import { TradingId, TradingMarket, TradingText, UnixMillis } from "./primitives.ts";
import { TradingPlanState } from "./strategy.ts";

export const TradingProvider = Schema.Literals(["codex", "claude", "opencode"]);
export type TradingProvider = typeof TradingProvider.Type;

export const TradingHarnessStatus = Schema.Literals(["available", "unavailable"]);
export type TradingHarnessStatus = typeof TradingHarnessStatus.Type;

export const TradingHarnessBinding = Schema.Struct({
  provider: TradingProvider,
  providerInstanceId: TradingId,
  providerSessionId: Schema.optional(TradingId),
  resumeCursor: Schema.optional(Schema.String),
  threadId: TradingId,
  model: Schema.optional(Schema.String),
  status: TradingHarnessStatus,
});
export type TradingHarnessBinding = typeof TradingHarnessBinding.Type;

export const TradingMissionStatus = Schema.Literals([
  "initializing",
  "analysing",
  "waiting",
  "executing",
  "position_open",
  "paused",
  "agent_unavailable",
  "blocked",
  "revoked",
  "completed",
]);
export type TradingMissionStatus = typeof TradingMissionStatus.Type;

export const TradingMissionBlockedReason = Schema.Literals([
  "cumulative_loss_limit",
  "protection_failure",
  "account_unavailable",
  "reconciliation_failure",
]);
export type TradingMissionBlockedReason = typeof TradingMissionBlockedReason.Type;

export const TradingMissionControl = Schema.Struct({
  entriesAllowed: Schema.Boolean,
  reentryAllowed: Schema.Boolean,
  pauseAfterPositionClose: Schema.Boolean,
});
export type TradingMissionControl = typeof TradingMissionControl.Type;

export const TradingMission = Schema.Struct({
  id: TradingId,
  userId: TradingId,
  tradingAccountId: TradingId,

  instruction: TradingText,
  market: TradingMarket,
  harness: TradingHarnessBinding,

  authority: TradingAuthority,
  strategy: Schema.optional(TradingPlanState),

  status: TradingMissionStatus,
  blockedReason: Schema.optional(TradingMissionBlockedReason),

  control: TradingMissionControl,

  authorityVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  lastHarnessRunId: Schema.optional(TradingId),
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
});
export type TradingMission = typeof TradingMission.Type;

/** Why a harness run was started - spec §11.2. */
export const TradingHarnessRunCause = Schema.Literals([
  "mission_created",
  "market_watch_triggered",
  "scheduled_reassessment",
  "order_updated",
  "position_updated",
  "user_message",
  "mission_resumed",
]);
export type TradingHarnessRunCause = typeof TradingHarnessRunCause.Type;

export const TradingHarnessRunStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting_for_tool",
  "completed",
  "failed",
]);
export type TradingHarnessRunStatus = typeof TradingHarnessRunStatus.Type;

export const TradingHarnessRun = Schema.Struct({
  id: TradingId,
  missionId: TradingId,

  cause: TradingHarnessRunCause,
  status: TradingHarnessRunStatus,

  startedAt: Schema.optional(UnixMillis),
  completedAt: Schema.optional(UnixMillis),
});
export type TradingHarnessRun = typeof TradingHarnessRun.Type;
