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
 * The timeframe a mission works on unless its instruction says otherwise.
 *
 * Every interval in `TradingTimeframe` is subscribed and readable, so the
 * harness has always been free to pick. Left with no stated preference it
 * reached for 5m and 15m, which put ten to fifteen minutes between a decision
 * and the candle that could confirm it. `1m` is the shortest direct interval
 * (§13 forbids synthesising one from a smaller one), so it is the fastest the
 * mission loop can honestly turn.
 *
 * This is a default, not a constraint: it is published to the harness in every
 * wakeup and nothing rejects a strategy that names another timeframe.
 */
export const POC_DEFAULT_TIMEFRAME: TradingTimeframe = "1m";

/**
 * The instruction a mission gets when its creator does not write one.
 *
 * It names the timeframe even though every wakeup already carries
 * `defaultTimeframe`: a harness weighs a direct instruction more heavily than a
 * field in a snapshot, and the two agreeing is what keeps the loop turning once
 * a minute rather than once every fifteen. Arming the watches on the same
 * interval is the other half — a 1m read with a 15m watch still waits fifteen
 * minutes to wake.
 */
export const POC_DEFAULT_INSTRUCTION =
  "Trade ETH momentum on testnet using 1m candles. Arm candle-close watches on the 1m interval so each run wakes within a minute.";

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
