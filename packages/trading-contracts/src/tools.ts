/**
 * Mission and strategy tool contracts - spec §14.3.
 *
 * Tools accept intent-level inputs. Publishing is a versioned, side-effecting
 * operation: `trading_publish_momentum_strategy` requires an expected current
 * version, and a stale expected-version publish is rejected rather than
 * silently overwriting current state.
 *
 * Scope note: §14.1/§14.2/§14.4-§14.7 name their tools but publish no input or
 * output schemas, and execution is out of scope for this phase. Only the two
 * §14.3 mission tools are modeled here.
 *
 * @module TradingTools
 */
import { Schema } from "effect";
import { TradingAuthority } from "./authority.ts";
import { TradingHarnessBinding, TradingMission, TradingMissionControl } from "./mission.ts";
import { TradingId } from "./primitives.ts";
import { momentumStrategyAuthoredFields, MomentumStrategyState } from "./strategy.ts";
import { PersistedWatch } from "./watch.ts";

export const TRADING_GET_MISSION_TOOL = "trading_get_mission";
export const TRADING_PUBLISH_MOMENTUM_STRATEGY_TOOL = "trading_publish_momentum_strategy";

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
