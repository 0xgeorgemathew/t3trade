/**
 * Trading plan state - spec §10.5, reshaped position-centric (plan 29 step 4.1).
 *
 * This stores the harness's published conclusions, not its hidden reasoning.
 * The document is eight fields - market, intent, entry, stop, target,
 * invalidation, reassess, because. The plan carries no version of its own and
 * nothing gates on one: revising replaces the plan in place, and the current
 * plan is simply the newest row in `trading_plan_history`.
 *
 * @module TradingPlan
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
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
  "Work on 1m candles unless your own read says otherwise, and arm each watch on that interval so a run wakes within a minute — the watch TYPE is the playbook's call, not this note's: a breakout confirms on the close, a range boundary triggers on the touch. One gate decides whether a trade is worth taking: is the expected move over your intended hold bigger than the round trip is worth? If not, stand down and say so in one line. The reading that answers it is `microstructure.volatilityRatio`: the recent pace against the whole window's, so 0.4 means the last twenty minutes have moved at 40% of the two-hour pace and the move you need is probably not there. Time the entry with `bookImbalance` (positive is bid-heavy, over the same levels a side) and `aggressorFlow` (the share of volume closing near bar highs, over `bars` that actually traded), and read both against `liquidity` — a lopsided ratio across a thin book is where a crossing order walks.";

/**
 * Prose the harness may leave out, decoded as an empty string.
 *
 * A required key the harness omits is not a smaller mistake than a wrong value:
 * the Effect toolkit rejects the whole `trading_plan` call with
 * `Missing key`, which costs the turn and tells the user nothing useful. The
 * one field typed this way (`because`) is prose the harness has been observed
 * omitting. A weaker constraint needs no migration — every persisted row still
 * decodes.
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
 * which is what the persisted row, `trading_look`, and the wakeup all
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
 * What the plan intends to do about a position — plan 29 step 4.1.
 *
 * Three values, one per state a mission can be in relative to the market:
 * `long` and `short` name the position the plan is working toward, and
 * `stand_aside` is the explicit no-position intent — this is where stand-downs
 * live now. Telemetry keys on it (`intent === "stand_aside"`), entry sizing
 * hints and take-profit placement skip when it is set, and the wakeup carries
 * it as the plan's headline.
 *
 * Conditionality is prose, not a fourth value: a plan whose entry depends on
 * something publishes `intent: "long"` with the dependency written in the
 * trigger and in `because`. `both` was always that case wearing an enum value.
 */
export const TradingPlanIntent = Schema.Literals(["long", "short", "stand_aside"]);
export type TradingPlanIntent = typeof TradingPlanIntent.Type;

export const OrderPreference = Schema.Literals(["marketable_ioc", "resting_limit", "post_only"]);
export type OrderPreference = typeof OrderPreference.Type;

/**
 * How urgently the harness wants an order to land — the vocabulary it is given
 * in place of a time-in-force.
 *
 * `now` crosses the spread and takes liquidity; `patient` rests at the near
 * side as a maker order that may never fill. The execution layer maps urgency
 * to an order preference and then to a wire time-in-force (`ioc` or `alo`); the
 * harness never names either, and the execution result reports the TIF that
 * actually went out.
 */
export const TradingUrgency = Schema.Literals(["now", "patient"]);
export type TradingUrgency = typeof TradingUrgency.Type;

/** `now` crosses (a marketable IOC); `patient` rests post-only (ALO on the wire). */
export function urgencyToOrderPreference(urgency: TradingUrgency): OrderPreference {
  return urgency === "patient" ? "post_only" : "marketable_ioc";
}

/**
 * The two phases a mission is in, derived from what it holds.
 *
 * The plan document used to carry a nine-value `currentAction` the model named
 * itself; nothing branched on more than "is it waiting-like", and the honest
 * source for that is the position: flat is waiting on a trigger, holding is
 * managing an exposure. See {@link planPhase}.
 */
export type TradingPlanPhase = "waiting" | "holding";

/**
 * Which phase the mission is in, from the signed position size.
 *
 * This is plan 29 step 4.4's collapse, arrived early because the gates that
 * used to read `currentAction` (unarmed-entry reporting on the wakeup and in
 * the web client) need somewhere to read. Flat — `size === 0`, the same test
 * the wakeup composer uses — means waiting; any non-zero size means holding.
 */
export function planPhase(positionSize: number): TradingPlanPhase {
  return positionSize === 0 ? "waiting" : "holding";
}

/**
 * The entry leg: what has to happen before size goes on, and how urgently.
 *
 * `triggers` are prose conditions (a bare string or the object form — see
 * {@link AgentConditionInput}); the optional hints a trigger may carry are what
 * the near-miss detectors read, so a plan that names a level can be told it
 * armed nothing there. `urgency` is the only order-shape knob the model ever
 * sees — the execution layer maps it to a preference and a wire time-in-force.
 * There is deliberately no `orderPreference` here: that vocabulary is the
 * server's, and the plan never names a time-in-force again.
 */
export const TradingPlanEntry = Schema.Struct({
  triggers: Schema.Array(AgentConditionInput),
  /** How urgently entries under this plan should land; defaults to `now`. */
  urgency: TradingUrgency.pipe(Schema.withDecodingDefault(Effect.succeed("now"))),
  initialNotionalUsd: Schema.optional(UsdAmount),
  maximumIntendedNotionalUsd: Schema.optional(UsdAmount),
});
export type TradingPlanEntry = typeof TradingPlanEntry.Type;

/**
 * The stop leg: how the position is protected. Stops are market orders on the
 * wire; the price and planned-loss fields are the plan's own statement of
 * both, unchanged from the `protection` struct they used to live in.
 */
export const TradingPlanStop = Schema.Struct({
  method: TradingText,
  price: Schema.optional(Price),
  maximumPlannedLossUsd: Schema.optional(UsdAmount),
});
export type TradingPlanStop = typeof TradingPlanStop.Type;

/**
 * The target leg: what the position is aiming at. A plan may state it as a
 * USD rung, a price, or both; a stand-aside plan states neither.
 *
 * `profitUsd` is the conservative rung the runtime arms a `pnl_above` watch at
 * and the resting reduce-only ALO is priced from (see
 * {@link takeProfitLimitPrice}) — both unchanged from when these fields lived
 * under `protection`.
 */
export const TradingPlanTarget = Schema.Struct({
  profitUsd: Schema.optional(PositiveUsdAmount),
  price: Schema.optional(Price),
  method: Schema.optional(TradingText),
});
export type TradingPlanTarget = typeof TradingPlanTarget.Type;

/**
 * How long an untriggered plan stays fresh, in minutes — plan 29 step 4.1.
 *
 * After this long without an entry the plan should prompt a reassessment
 * rather than sit armed forever (step 4.6 honors it; for now it is carried,
 * bounded, and displayed). Required on the document, but `afterMinutes`
 * decodes to a default when omitted so a row written without one stays sane.
 */
export const DEFAULT_REASSESS_AFTER_MINUTES = 90;

/**
 * The plan's prediction: where this read says price is going, by when, and
 * what would prove it wrong.
 *
 * This is the unit the whole loop turns on. A plan without one is a plan the
 * runtime cannot arm anything for; a plan with one gets two watches armed
 * against it automatically — a horizon wake at `byMinutes` and an
 * invalidation wake at `invalidationPrice` — so the mission sleeps until the
 * market either runs the clock out or says the read was wrong. The plan's own
 * `strategyVersion` is the prediction's id, which is how a fired watch names
 * the prediction it belongs to.
 *
 * - `direction` is the claim itself. `price` alone leaves it to be inferred
 *   from a mark that has already moved by the time anything reads it.
 * - `price` is the point estimate; `zone` is the band around it when the read
 *   is honestly a range rather than a number. `price` stays required so
 *   everything downstream has one line to draw.
 * - `byMinutes` is the horizon, measured from publish.
 * - `invalidationPrice` is the level at which this read is wrong — not the
 *   stop (which is where the money is protected), but where the thesis stops
 *   being the thesis. It sits on the opposite side of the mark from `price`.
 *
 * The web draws it as a dotted line from the live mark into the chart's
 * future gutter, with the armed watches around it, so the operator sees in
 * one picture what the mission expects AND what wakes it if the market
 * disagrees. Optional on the plan: a stand-aside plan states none — a
 * prediction invented to fill the field would be armed and drawn as if it
 * were believed.
 */
export const TradingPlanProjection = Schema.Struct({
  direction: Schema.Literals(["long", "short"]),
  price: Price,
  /** The honest band around `price`, when the read is a range. `low <= high`. */
  zone: Schema.optional(Schema.Struct({ low: Price, high: Price })),
  byMinutes: Schema.Number.check(Schema.isGreaterThan(0)),
  invalidationPrice: Price,
});
export type TradingPlanProjection = typeof TradingPlanProjection.Type;

/**
 * Which way the mark has to cross `invalidationPrice` for the read to be
 * wrong: a long read is invalidated by price falling through it, a short read
 * by price rising through it.
 */
export function projectionInvalidationDirection(
  projection: TradingPlanProjection,
): "above" | "below" {
  return projection.direction === "long" ? "below" : "above";
}

/**
 * The prediction as one line: what it claims, by when, and what would end it.
 *
 * Shared rather than rendered per surface, because the lean wake and the panel
 * are both saying the same sentence and a run that reads one then the other
 * should not have to reconcile two phrasings of its own prediction.
 */
export function describeProjection(projection: TradingPlanProjection): string {
  const where =
    projection.zone === undefined
      ? `${projection.price}`
      : `${projection.price} (${projection.zone.low}-${projection.zone.high})`;
  return `${projection.direction} to ${where} within ${projection.byMinutes}m; wrong ${projectionInvalidationDirection(projection)} ${projection.invalidationPrice}`;
}

export const TradingPlanReassess = Schema.Struct({
  afterMinutes: Schema.Number.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REASSESS_AFTER_MINUTES)),
  ),
});
export type TradingPlanReassess = typeof TradingPlanReassess.Type;

/**
 * The price a resting reduce-only take-profit limit rests at (plan 29 step
 * 2.5), derived from the plan's own target fields and the position.
 *
 * `target.price`, when the plan published one, IS the price. Otherwise the
 * plan states its target as a USD rung (`target.profitUsd` — `targetProfitUsd`
 * before plan 29 step 4.1), and the price is derived from the position's
 * entry, direction-aware: a long banks by selling ABOVE its entry, a short by
 * buying BELOW it. Getting the sign wrong is not a cosmetic defect; it would
 * rest a reduce-only limit on the losing side of the position where it fills
 * immediately at a loss.
 *
 * Returns `null` when no usable target exists — no published price, no rung a
 * positive entry price and size can price, or no position to derive a
 * direction from. The caller treats `null` as "withdraw any resting
 * take-profit", never as "keep whatever is there".
 */
export function takeProfitLimitPrice(input: {
  /** The plan's `target.price`, when it published one. */
  readonly takeProfitPrice: number | null | undefined;
  /** The plan's conservative target rung, in USD of profit. */
  readonly targetProfitUsd: number | null | undefined;
  /** Signed canonical position size; positive long, negative short. */
  readonly positionSize: number;
  /** The position's canonical entry price; null when the exchange reports none. */
  readonly entryPrice: number | null | undefined;
}): number | null {
  if (!(input.positionSize > 0) && !(input.positionSize < 0)) return null;

  if (input.takeProfitPrice !== null && input.takeProfitPrice !== undefined) {
    return input.takeProfitPrice > 0 ? input.takeProfitPrice : null;
  }

  if (input.targetProfitUsd === null || input.targetProfitUsd === undefined) return null;
  if (!(input.targetProfitUsd > 0)) return null;
  if (input.entryPrice === null || input.entryPrice === undefined) return null;
  if (!(input.entryPrice > 0)) return null;
  const move = input.targetProfitUsd / Math.abs(input.positionSize);
  if (!(move > 0)) return null;
  return input.positionSize > 0 ? input.entryPrice + move : input.entryPrice - move;
}

/**
 * Every `TradingPlanState` field the harness authors — eight, one per line a
 * position-centric plan needs (plan 29 step 4.1): what market, which way,
 * how in, how out on the downside, how out on the upside, what would change
 * the read, how long the plan stays fresh, and why any of it.
 *
 * Everything the twenty-field document carried that was not one of those is
 * either prose inside `because` (strategy names, indicators, regime,
 * evidence, alternatives, the ladder beyond the conservative rung) or a
 * runtime decision that never belonged in the document (exits, re-entries,
 * position management, the model naming its own action).
 *
 * `updatedAt` is excluded because the server assigns it on publish; see
 * `PublishTradingPlanBody` in `./tools.ts`.
 */
export const tradingPlanAuthoredFields = {
  market: TradingMarket,

  intent: TradingPlanIntent,

  entry: TradingPlanEntry,

  stop: TradingPlanStop,

  target: TradingPlanTarget,

  /**
   * What would end the thesis without a trade: regime flips, the level the
   * read turns on fails, time runs out. Prose — the old
   * `abandonmentConditions` without the condition machinery. Exits and
   * re-entries are runtime decisions made against a live position, not plan
   * fields, and are gone.
   */
  invalidation: Schema.Array(TradingText),

  reassess: TradingPlanReassess,

  /**
   * The prediction this plan IS: direction, price, horizon, and the level
   * that would prove it wrong — see {@link TradingPlanProjection}. Publishing
   * one arms the horizon and invalidation wakes automatically, so the loop
   * has something to wait on without the plan spelling out the triggers.
   */
  projection: Schema.optional(TradingPlanProjection),

  /**
   * The narrative: why this plan, in plain language — the strategy and its
   * indicators, the regime read, the evidence, and what the plan in plain
   * terms is trying to do. Absorbs `belief.summary`, `belief.regime`,
   * `belief.evidence[]`, `explanation`, `plainSummary` and the target
   * rationale.
   *
   * Decoded as `""` when omitted — a required key the harness leaves out is
   * not a smaller mistake than a wrong value, and rejecting the whole publish
   * over it costs the turn. Same trade-off the old prose fields made.
   */
  because: OmittableProse,
} as const;

/**
 * The persisted plan document — the eight authored fields plus `updatedAt`.
 *
 * No `version`: the plan carries no version number of its own. Its rows in
 * `trading_plan_history` number themselves for the journal's ordering, and
 * nothing in the runtime points at one — the current plan is simply the
 * newest row.
 */
export const TradingPlanState = Schema.Struct({
  ...tradingPlanAuthoredFields,
  updatedAt: UnixMillis,
});
export type TradingPlanState = typeof TradingPlanState.Type;
