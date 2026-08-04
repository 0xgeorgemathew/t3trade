/**
 * Momentum strategy state - spec §10.5.
 *
 * This stores the harness's published conclusions, not its hidden reasoning.
 * Every execution is gated against the version recorded here.
 *
 * @module MomentumStrategy
 */
import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";
import {
  PositiveUsdAmount,
  Price,
  TradingMarket,
  TradingText,
  UnixMillis,
  UsdAmount,
} from "./primitives.ts";

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
  "Trade ETH momentum on testnet using 1m candles. Arm candle-close watches on the 1m interval so each run wakes within a minute. " +
  "State a concrete profit target in USD for every position and manage the position against it: bank it, or justify raising it.";

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

/**
 * The input form of a condition: the full object, or just a prose string.
 *
 * Providers that stringified nested params (and a harness that simply thinks
 * in prose) would send `"Exit if a 1m candle closes back above 1865.9."` where
 * the schema asked for `{ description: ... }`. The union accepts either: the
 * string branch decodes a non-empty `TradingText` into the object shape, so
 * the persisted/encoded form is always `{ description }`. Optional display
 * hints are only reachable through the object branch, which is fine — a bare
 * prose string carries no hints by definition.
 *
 * The union is ordered object-branch-first, so encoding always takes the object
 * branch: a strategy that decoded a prose string re-encodes as `{description}`,
 * which is what the persisted row, `trading_get_mission`, and the wakeup all
 * carry. The string branch is an input affordance only.
 */
const conditionStringToObject = Schema.String.pipe(
  Schema.decodeTo(
    AgentConditionDescription,
    SchemaTransformation.transformOrFail({
      // Trim and reject empty prose the way `TradingText`-as-a-field would: a
      // bare "   " is not a conclusion worth publishing.
      decode: (value) =>
        value.trim() === ""
          ? Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(value), {
                message: "a prose condition must be a non-empty string",
              }),
            )
          : Effect.succeed({ description: value.trim() }),
      encode: (value) => Effect.succeed(value.description),
    }),
  ),
);

export const AgentConditionInput = Schema.Union([
  AgentConditionDescription,
  conditionStringToObject,
]);
export type AgentConditionInput = typeof AgentConditionInput.Type;

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
  conditions: Schema.Array(AgentConditionInput),
});

const MomentumPositionManagement = Schema.Struct({
  scaleInAllowed: Schema.Boolean,
  scaleInConditions: Schema.Array(AgentConditionInput),
  partialReductionAllowed: Schema.Boolean,
  trailingMethod: Schema.optional(TradingText),
});

const MomentumProtection = Schema.Struct({
  stopMethod: TradingText,
  stopPrice: Schema.optional(Price),
  takeProfitMethod: Schema.optional(TradingText),
  takeProfitPrice: Schema.optional(Price),
  /**
   * The unrealised PnL, in USD, at which this position should be closed or
   * re-justified.
   *
   * This is the win worth banking. While a position is open the runtime arms a
   * `pnl_above` watch at it; when that watch wakes the harness, the default
   * action is to close (or reduce) and reassess. The server never auto-places a
   * take-profit order on the exchange — this is wake-and-decide, and the harness
   * may instead republish with a higher target if it judges the move still
   * extending.
   */
  targetProfitUsd: PositiveUsdAmount,
  /** Optional rationale for the chosen target. */
  targetProfitRationale: Schema.optional(TradingText),
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
  /**
   * `timeframes[0]` is the primary timeframe that drives the monitoring
   * cadence (the runtime scales its reassessment floor off it). A strategy
   * must name at least one timeframe.
   */
  timeframes: Schema.Array(TradingTimeframe).check(Schema.isNonEmpty()),

  belief: MomentumBelief,
  entryPlan: MomentumEntryPlan,
  positionManagement: MomentumPositionManagement,
  protection: MomentumProtection,

  exitConditions: Schema.Array(AgentConditionInput),
  abandonmentConditions: Schema.Array(AgentConditionInput),
  reentryConditions: Schema.Array(AgentConditionInput),

  currentAction: MomentumStrategyAction,

  explanation: TradingText,
} as const;

export const MomentumStrategyState = Schema.Struct({
  version: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  ...momentumStrategyAuthoredFields,
  updatedAt: UnixMillis,
});
export type MomentumStrategyState = typeof MomentumStrategyState.Type;
