/**
 * Momentum strategy state - spec §10.5.
 *
 * This stores the harness's published conclusions, not its hidden reasoning.
 * Every execution is gated against the version recorded here.
 *
 * @module MomentumStrategy
 */
import { Schema } from "effect";
import { Price, TradingMarket, TradingText, UnixMillis, UsdAmount } from "./primitives.ts";

export const TradingTimeframe = Schema.Literals(["1m", "3m", "5m", "15m", "1h"]);
export type TradingTimeframe = typeof TradingTimeframe.Type;

/**
 * A condition the harness published in prose, with optional structured hints -
 * spec §10.5.
 *
 * `description` carries the authoritative conclusion; the three optional fields
 * are display hints only and are never used to make a runtime decision — watch
 * predicates come from `MarketWatch`, never from a condition description.
 */
export const AgentConditionDescription = Schema.Struct({
  description: TradingText,
  timeframe: Schema.optional(TradingTimeframe),
  priceLevel: Schema.optional(Price),
  invalidatedBy: Schema.optional(TradingText),
});
export type AgentConditionDescription = typeof AgentConditionDescription.Type;

export const MomentumStrategyMode = Schema.Literals([
  "breakout_continuation",
  "breakdown_continuation",
  "pullback_continuation",
  "volatility_expansion",
]);
export type MomentumStrategyMode = typeof MomentumStrategyMode.Type;

export const MomentumStrategyDirection = Schema.Literals(["long", "short", "both", "conditional"]);
export type MomentumStrategyDirection = typeof MomentumStrategyDirection.Type;

export const MomentumOrderPreference = Schema.Literals(["marketable_ioc", "resting_limit"]);
export type MomentumOrderPreference = typeof MomentumOrderPreference.Type;

export const MomentumStrategyAction = Schema.Literals([
  "analysing",
  "waiting",
  "entering",
  "holding",
  "scaling",
  "reducing",
  "exiting",
  "reassessing",
  "abandoning",
]);
export type MomentumStrategyAction = typeof MomentumStrategyAction.Type;

const MomentumBelief = Schema.Struct({
  summary: TradingText,
  regime: TradingText,
  confidence: Schema.optional(Schema.Number),
  evidence: Schema.Array(TradingText),
});

const MomentumEntryPlan = Schema.Struct({
  explanation: TradingText,
  initialNotionalUsd: Schema.optional(UsdAmount),
  maximumIntendedNotionalUsd: Schema.optional(UsdAmount),
  orderPreference: MomentumOrderPreference,
  conditions: Schema.Array(AgentConditionDescription),
});

const MomentumPositionManagement = Schema.Struct({
  scaleInAllowed: Schema.Boolean,
  scaleInConditions: Schema.Array(AgentConditionDescription),
  partialReductionAllowed: Schema.Boolean,
  trailingMethod: Schema.optional(TradingText),
});

const MomentumProtection = Schema.Struct({
  stopMethod: TradingText,
  stopPrice: Schema.optional(Price),
  takeProfitMethod: Schema.optional(TradingText),
  takeProfitPrice: Schema.optional(Price),
  maximumPlannedLossUsd: Schema.optional(UsdAmount),
});

/**
 * Every `MomentumStrategyState` field the harness authors.
 *
 * `version` and `updatedAt` are excluded because the server assigns them on
 * publish; see `PublishMomentumStrategyBody` in `./tools.ts`.
 */
export const momentumStrategyAuthoredFields = {
  name: TradingText,
  market: TradingMarket,

  mode: MomentumStrategyMode,

  direction: MomentumStrategyDirection,
  timeframes: Schema.Array(TradingTimeframe),

  belief: MomentumBelief,
  entryPlan: MomentumEntryPlan,
  positionManagement: MomentumPositionManagement,
  protection: MomentumProtection,

  exitConditions: Schema.Array(AgentConditionDescription),
  abandonmentConditions: Schema.Array(AgentConditionDescription),
  reentryConditions: Schema.Array(AgentConditionDescription),

  currentAction: MomentumStrategyAction,

  explanation: TradingText,
} as const;

export const MomentumStrategyState = Schema.Struct({
  version: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  ...momentumStrategyAuthoredFields,
  updatedAt: UnixMillis,
});
export type MomentumStrategyState = typeof MomentumStrategyState.Type;
