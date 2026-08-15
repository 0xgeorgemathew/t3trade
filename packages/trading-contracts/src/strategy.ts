/**
 * Trading plan state - spec §10.5.
 *
 * This stores the harness's published conclusions, not its hidden reasoning.
 * Every execution is gated against the version recorded here.
 *
 * @module TradingPlan
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { PublishedStandDownCode } from "./decision.ts";
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

/** Longest first, so "15m" is never matched as "5m" inside a mandate. */
const TIMEFRAMES_LONGEST_FIRST: ReadonlyArray<TradingTimeframe> = ["15m", "1h", "5m", "3m", "1m"];

/**
 * The timeframe the user's own mandate names, if it names one.
 *
 * A mandate is free text, so this is a literal scan for the five intervals the
 * contracts define — "scalp ETH on the 5m" resolves to `5m`, and anything that
 * names none resolves to nothing. It reads the FIRST interval mentioned, which
 * is the one a sentence like "trade the 5m, confirm on 15m" means.
 */
export function mandatedTimeframe(instruction: string): TradingTimeframe | undefined {
  const text = instruction.toLowerCase();
  let earliest: { readonly at: number; readonly timeframe: TradingTimeframe } | undefined;
  for (const timeframe of TIMEFRAMES_LONGEST_FIRST) {
    const at = text.indexOf(timeframe);
    if (at === -1) continue;
    if (earliest === undefined || at < earliest.at) earliest = { at, timeframe };
  }
  return earliest?.timeframe;
}

/**
 * The timeframe the runtime works a mission on: the mandate's, or `1m`.
 *
 * Deliberately NOT the plan's own `timeframes[0]`. The wakeup's candles, its
 * volatility measurement, and the staleness floor that decides how often a flat
 * mission is re-woken all key off this one value, so a plan that named 15m as
 * its thesis timeframe had the runtime feeding it 15m bars and re-waking it
 * every thirty minutes — the 1m structure that the entry actually turns on was
 * never in front of it, and it could not have seen a setup form and expire
 * between two wakes. The published `timeframes[0]` still says what the plan is
 * reasoning on, and rides the wakeup as the paired higher timeframe when it is
 * longer than this one.
 *
 * A user who names an interval in the mandate gets it; nobody else has stated a
 * preference, so they get the fastest interval the exchange serves directly.
 */
export function runtimeTimeframe(instruction: string): TradingTimeframe {
  return mandatedTimeframe(instruction) ?? POC_DEFAULT_TIMEFRAME;
}

/**
 * The operating note every auto-created mission carries alongside its mandate.
 *
 * This used to be `POC_DEFAULT_INSTRUCTION`, a whole mandate ("Trade ETH on
 * testnet using 1m candles…") that `AutoMissionConfig` resolved as the default
 * instruction and `TradingAutoMission` then never read — the first message on a
 * thread is the mandate, so the configured instruction reached no mission and
 * the knob that set it did nothing. Two things had drifted at once: the
 * documented default was not in force, and the sentence that WAS documented
 * told every mission to arm candle-close watches, which the range playbook
 * explicitly flags as misarmed at a boundary.
 *
 * What is left is the part a user's own mandate will never state and the
 * playbooks elaborate on: which interval the loop turns on, and the one gate
 * every trade answers to — whether the expected move over the intended hold is
 * bigger than the round trip is worth. It names the timeframe
 * even though every wakeup already carries `defaultTimeframe`, because a
 * harness weighs a direct instruction more heavily than a field in a snapshot,
 * and the two agreeing is what keeps the loop turning once a minute rather than
 * once every fifteen.
 *
 * It names no market and no direction: those belong to the mandate the user
 * writes, and a standing note that contradicted it would be the same drift
 * again in the other direction.
 */
export const POC_STANDING_INSTRUCTION =
  "Work on 1m candles unless your own read says otherwise, and arm each watch on that interval so a run wakes within a minute — the watch TYPE is the playbook's call, not this note's: a breakout confirms on the close, a range boundary triggers on the touch. One gate decides whether a trade is worth taking: is the expected move over your intended hold bigger than the round trip is worth? If not, stand down and say so in one line.";

/**
 * Prose the harness may leave out, decoded as an empty string.
 *
 * A required key the harness omits is not a smaller mistake than a wrong value:
 * the Effect toolkit rejects the whole `trading_publish_plan` call with
 * `Missing key`, which costs the turn and tells the user nothing useful. Both
 * fields typed this way are ones the harness has been observed omitting, and
 * both are prose the publish path can fill from the belief summary. A weaker
 * constraint needs no migration — every persisted row still decodes.
 */
const OmittableProse = TradingText.pipe(Schema.withDecodingDefault(Effect.succeed("")));

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
  /**
   * Whether this trigger is only true on a bar close.
   *
   * `close` is a breakout: the momentum and ORB playbooks both require a candle
   * to CLOSE through the level, so a `price_cross` watch armed at it wakes the
   * mission on the wick that fails — the exact false start the doctrine names.
   * `touch` is a range boundary, where the price is the trigger and waiting for
   * the close gives the edge back.
   *
   * Nothing arms from this — watch predicates come from `MarketWatch` alone.
   * What it does is make the mismatch checkable: see
   * `findMisarmedEntryConditions`.
   */
  confirmation: Schema.optional(Schema.Literals(["close", "touch"])),
  /** Crossing direction the armed watch must use, when known. */
  direction: Schema.optional(Schema.Literals(["above", "below"])),
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
              new SchemaIssue.InvalidValue({
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

export const MomentumOrderPreference = Schema.Literals([
  "marketable_ioc",
  "resting_limit",
  "post_only",
]);
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

/**
 * The actions that mean "not in the market and not on the way in".
 *
 * A plan in one of these states is waiting for something, so the levels its
 * entry conditions name are triggers it should have armed — see
 * `findUnarmedEntryConditions`. `entering` is excluded: an order is already
 * going in and the trigger has already been decided.
 */
const WAITING_LIKE_ACTIONS: ReadonlySet<MomentumStrategyAction> = new Set([
  "analysing",
  "waiting",
  "reassessing",
]);

export function isWaitingLikeAction(action: MomentumStrategyAction): boolean {
  return WAITING_LIKE_ACTIONS.has(action);
}

const MomentumBelief = Schema.Struct({
  summary: TradingText,
  regime: TradingText,
  confidence: Schema.optional(Schema.Number),
  evidence: Schema.Array(TradingText),
});

const MomentumEntryPlan = Schema.Struct({
  /**
   * Optional on input, always present on the decoded value.
   *
   * A required key the harness omits is not a smaller mistake than a wrong
   * value — the Effect toolkit rejects the whole `trading_publish_plan` call
   * with `Missing key`, which costs the turn and tells the user nothing. This
   * is one of the two prose keys the harness has actually been observed
   * omitting; the publish handler fills an empty one from the belief summary.
   */
  explanation: OmittableProse,
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
 * One candidate the tournament considered and did not run — or the one it did.
 *
 * Plan 27 E3: the publish carries the field so a declined strategy leaves a
 * record next to the chosen one, and the UI can render the comparison as a
 * plain list. `direction: "none"` is the no-trade candidate every tournament
 * includes.
 */
export const ConsideredAlternative = Schema.Struct({
  /** The playbook or setup kind considered, e.g. "range_reversion". */
  strategy: TradingText,
  direction: Schema.Literals(["long", "short", "none"]),
  verdict: Schema.Literals(["chosen", "viable_not_best", "fails_gates", "no_setup"]),
  /** One line on expectancy after costs — the arithmetic, not a mood. */
  reason: TradingText,
});
export type ConsideredAlternative = typeof ConsideredAlternative.Type;

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

  /**
   * Why this accepted publish declined to enter. Omit when the plan carries a
   * viable setup or an open position. Explicit attribution is what lets the
   * decision funnel distinguish a quiet market from a move eaten by costs.
   */
  standDownCode: Schema.optional(PublishedStandDownCode),

  /** See `MomentumEntryPlan.explanation` — optional in, always present out. */
  explanation: OmittableProse,

  /**
   * The plan in plain language — 2-4 sentences a non-trader can follow, no
   * tool or field names, no scores. It must answer: what is the market doing,
   * what is planned and in which direction, what triggers it, and roughly
   * what is risked versus expected.
   *
   * Doctrine requires it on every publish (the tool description states the
   * constraints); the schema decodes an omitted one as `""` so strategies
   * persisted before the field existed still decode — same trade-off as
   * `explanation` above.
   */
  plainSummary: OmittableProse,

  /**
   * The tournament's losing candidates, one row each — see
   * {@link ConsideredAlternative}. Optional: a publish that ran no tournament
   * (a pure stand-down on unreadable data, say) has nothing to record here.
   */
  alternativesConsidered: Schema.optional(Schema.Array(ConsideredAlternative)),
} as const;

export const TradingPlanState = Schema.Struct({
  version: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  ...tradingPlanAuthoredFields,
  updatedAt: UnixMillis,
});
export type TradingPlanState = typeof TradingPlanState.Type;
