/**
 * Trading plan state - spec §10.5.
 *
 * This stores the harness's published conclusions, not its hidden reasoning.
 * Every execution is gated against the version recorded here.
 *
 * @module TradingPlan
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
 * It is the mandate only — what the harness is being asked to do and on what
 * cadence — not the doctrine for how. The procedure (the regime read, the range
 * scalp, the momentum derivation, the standing rules) lives in the
 * `trading_get_playbook` tool, where the harness reads one playbook at a time
 * rather than carrying all of it on every wakeup.
 *
 * It names the timeframe even though every wakeup already carries
 * `defaultTimeframe`: a harness weighs a direct instruction more heavily than a
 * field in a snapshot, and the two agreeing is what keeps the loop turning once
 * a minute rather than once every fifteen. Arming the watches on the same
 * interval is the other half — a 1m read with a 15m watch still waits fifteen
 * minutes to wake.
 */
export const POC_DEFAULT_INSTRUCTION =
  "Trade ETH on testnet using 1m candles. Arm candle-close watches on the 1m interval so each run wakes within a minute. Read the regime before you look for a trade.";

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

/**
 * The shape of the trade a plan is making, as a free-text label the harness
 * names for its strategy. The closed enum this used to be (the four
 * continuation modes plus `range_reversion`) widened to free text because
 * nothing in the runtime branches on the value — the only two reads are a
 * passthrough copy in `TradingStrategyService` and a generic display in the
 * web client — so a closed list was a restraint with no enforcement behind
 * it. The five old values remain valid (they are strings).
 */
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

/**
 * Which measurement a profit target was read off - see `./volatility.ts`.
 *
 * `excursion_quantile` is the one to reach for by default: it is the move price
 * actually delivered over a holding period of this length in the recent window,
 * so a target set at its median has a hit rate behind it. The other three are
 * single-number summaries of the same window.
 */
export const ProfitTargetMeasurement = Schema.Literals([
  "atr",
  "realized_volatility",
  "swing_range",
  "excursion_quantile",
]);
export type ProfitTargetMeasurement = typeof ProfitTargetMeasurement.Type;

/**
 * The arithmetic that produced `targetProfitUsd`, published alongside it.
 *
 * This is the harness showing its work, not a form the server grades. The
 * target is a measurement carried through three steps — measured move →
 * percentage price move → USD on the notional — and recording all three is
 * what lets a later turn, and the user, see whether the number came from the
 * data or from nowhere.
 */
export const ProfitTargetBasis = Schema.Struct({
  measurement: ProfitTargetMeasurement,
  /** The interval the measurement was taken on. */
  timeframe: TradingTimeframe,
  /** Bars the measurement looked back over. */
  lookbackBars: Schema.Number,
  /**
   * The move that measurement says the instrument produces over
   * `expectedHoldBars`, in USD of price.
   */
  measuredMoveUsd: Schema.Number,
  /** How long the position is expected to be held, in bars of `timeframe`. */
  expectedHoldBars: Schema.Number,
  /** The price the target move is measured from — normally the current mark. */
  referencePrice: Price,
  /** The target as a percentage price move from `referencePrice`. */
  targetPriceMovePercent: Schema.Number,
  /** Margin x leverage: the notional `targetProfitUsd` is earned on. */
  positionNotionalUsd: Schema.Number,
  /**
   * Share of historical windows of `expectedHoldBars` bars in which the move
   * was available, when the measurement reports one (the excursion quantiles
   * do: a median is 50).
   */
  historicalHitRatePercent: Schema.optional(Schema.Number),
  /** Which measurement, over what lookback, and why the target is attainable. */
  rationale: TradingText,
  /**
   * Set when the harness judges the window too quiet to support a target worth
   * taking. Nothing downstream keys off it — it is how the harness records that
   * it stood down rather than invented a number.
   */
  insufficientVolatility: Schema.optional(Schema.Boolean),
});
export type ProfitTargetBasis = typeof ProfitTargetBasis.Type;

export const MomentumProtection = Schema.Struct({
  stopMethod: TradingText,
  stopPrice: Schema.optional(Price),
  takeProfitMethod: Schema.optional(TradingText),
  takeProfitPrice: Schema.optional(Price),
  /**
   * The unrealised PnL, in USD, at which this position should be closed or
   * re-justified — the conservative rung of the published ladder.
   *
   * While a position is open the runtime arms a `pnl_above` watch at it. That
   * wake is a decision point, not an instruction to close: the harness reads the
   * book and the momentum and either banks (close, or reduce and keep a
   * runner) or extends (republish at the next version with the base rung and a
   * fresh basis). Treating it as an automatic close is what turns a deliberately
   * conservative estimate into a hard cap on every win.
   *
   * The number is gross of fees and funding — `pnl_above` fires on the
   * exchange's unrealised PnL — so it has to clear the round trip on its own.
   * The server never auto-places a take-profit order on the exchange; this is
   * wake-and-decide throughout.
   */
  targetProfitUsd: PositiveUsdAmount,
  /**
   * Where `targetProfitUsd` came from — the measurement, the lookback, and the
   * arithmetic. Read back to the harness on the next wake so it can tell
   * whether the move it was waiting for is still the move the market is
   * producing.
   *
   * Required on publish: `checkProfitTarget` (see `./costs.ts`) rejects a
   * strategy whose target has no basis, or one the basis does not produce. It
   * stays optional in the schema so strategies persisted before the check
   * existed still decode.
   */
  targetProfitBasis: Schema.optional(ProfitTargetBasis),
  /**
   * The target ladder in prose: the conservative rung (published as
   * `targetProfitUsd`), the base rung the position is extended to on a
   * profit-target wake that still looks like momentum, and the extension rung
   * bounded by the nearest structure — each net of the round-trip cost.
   *
   * Only one number can be armed as a watch, so this is where the other two
   * live. Without them, the wake that fires at the conservative rung arrives
   * with nowhere to extend to.
   */
  targetProfitRationale: Schema.optional(TradingText),
  maximumPlannedLossUsd: Schema.optional(UsdAmount),
});

/**
 * Every `TradingPlanState` field the harness authors.
 *
 * `version` and `updatedAt` are excluded because the server assigns them on
 * publish; see `PublishTradingPlanBody` in `./tools.ts`.
 */
export const tradingPlanAuthoredFields = {
  name: TradingText,
  market: TradingMarket,

  mode: TradingText,

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

export const TradingPlanState = Schema.Struct({
  version: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  ...tradingPlanAuthoredFields,
  updatedAt: UnixMillis,
});
export type TradingPlanState = typeof TradingPlanState.Type;
