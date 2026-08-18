/**
 * Market watches - spec §11.3, §12.1.
 *
 * A watch is a simple, deterministic, typed, inspectable predicate the runtime
 * can evaluate without judgment. Anything that requires weighing evidence is
 * harness responsibility and does not belong here.
 *
 * @module MarketWatch
 */
import { Schema } from "effect";
import { ACTIVE_TRADING_POLICY, type TradingPolicy } from "./policy.ts";
import { PositiveUsdAmount, Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { TradingTimeframe } from "./strategy.ts";

export const WatchPriceSource = Schema.Literals(["mark", "mid"]);
export type WatchPriceSource = typeof WatchPriceSource.Type;

export const WatchCrossDirection = Schema.Literals(["above", "below"]);
export type WatchCrossDirection = typeof WatchCrossDirection.Type;

/**
 * The market metrics a watch can hold a threshold against — plan "any
 * condition as a trigger". Everything here is a number the evaluator can
 * already read without new data plumbing: the first four come off the gateway
 * snapshot the 2s sweep takes anyway, and `volume_ratio` comes off the candle
 * deliveries the evaluator already subscribes to.
 *
 * - `funding_rate_8h`: the raw 8h funding rate (0.0001 = 1bp/8h). Signed.
 * - `open_interest`: open interest in base units, as the exchange reports it.
 * - `day_volume_usd`: 24h notional volume in USD.
 * - `spread_bps`: (ask − bid) / mid × 10 000, from the live BBO.
 * - `volume_ratio`: the just-closed bar's volume against the average of the
 *   prior bars on `interval` — 2.0 means the last bar traded twice its recent
 *   pace, which is the "wake me when volume picks up" trigger.
 */
export const WatchMetricName = Schema.Literals([
  "funding_rate_8h",
  "open_interest",
  "day_volume_usd",
  "spread_bps",
  "volume_ratio",
]);
export type WatchMetricName = typeof WatchMetricName.Type;

export const MarketWatch = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("price_cross"),
    market: TradingMarket,
    priceSource: WatchPriceSource,
    direction: WatchCrossDirection,
    price: Price,
  }),
  Schema.Struct({
    type: Schema.Literal("candle_close"),
    market: TradingMarket,
    interval: TradingTimeframe,
    direction: WatchCrossDirection,
    price: Price,
  }),
  Schema.Struct({
    type: Schema.Literal("order_update"),
    cloid: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("position_update"),
    market: TradingMarket,
  }),
  Schema.Struct({
    type: Schema.Literal("scheduled_reassessment"),
    runAt: UnixMillis,
  }),
  Schema.Struct({
    type: Schema.Literal("pnl_above"),
    market: TradingMarket,
    valueUsd: PositiveUsdAmount,
  }),
  /**
   * Fires when unrealised PnL falls to or below `valueUsd`.
   *
   * Signed, unlike `pnl_above`: the level worth watching on the way down is
   * usually a loss (`-6`), and sometimes a give-back floor under a winner
   * (`+3`). Zero is the break-even line.
   */
  Schema.Struct({
    type: Schema.Literal("pnl_below"),
    market: TradingMarket,
    valueUsd: Schema.Number,
  }),
  /**
   * Fires when unrealised PnL has fallen `drawdownUsd` from its own high-water
   * mark on this position.
   *
   * The high-water mark is durable — the reconciler maintains it on the
   * position snapshot — so this survives a restart and resets when the mission
   * goes flat. It is the watch that makes holding past a profit target safe:
   * a target wake that decides to extend can arm a give-back beneath the peak
   * instead of betting the whole open profit on the next leg.
   */
  Schema.Struct({
    type: Schema.Literal("pnl_giveback"),
    market: TradingMarket,
    drawdownUsd: PositiveUsdAmount,
  }),
  /**
   * Fires when a named market metric crosses `value` in `direction`.
   *
   * The generalisation the price and PnL watches are special cases of: the
   * model names WHICH number it is waiting on rather than being limited to the
   * mark. `interval` only means something to `volume_ratio` (the bar series the
   * ratio is measured on); the snapshot metrics ignore it.
   */
  Schema.Struct({
    type: Schema.Literal("metric_threshold"),
    market: TradingMarket,
    metric: WatchMetricName,
    direction: WatchCrossDirection,
    value: Schema.Number,
    interval: Schema.optional(TradingTimeframe),
  }),
]);
export type MarketWatch = typeof MarketWatch.Type;

// ---------------------------------------------------------------------------
// The one condition union the model writes (plan 29 step 6.3)
// ---------------------------------------------------------------------------

/**
 * What has to become true for a mission to be woken.
 *
 * `MarketWatch` above is eight sibling structs that a model had to choose
 * between before it could say what it was waiting for, and three of those
 * choices were encodings rather than decisions: `price_cross` vs
 * `candle_close` is one level with two confirmations, `pnl_above` vs
 * `pnl_below` is one number with a direction, and `order_update` vs
 * `position_update` is one event — something filled — keyed differently.
 * Picking the wrong one of a pair is not a different intention, it is the same
 * intention armed with a predicate that cannot evaluate it, which is the
 * failure `findMisarmedEntryConditions` exists to report after the fact.
 *
 * So the model names five things it can actually mean — a level, a PnL line, a
 * give-back from the peak, a fill, a time — and the encoding is derived.
 * `MarketWatch` remains the persisted and evaluated form; `toMarketWatch`
 * below is the only place the mapping lives.
 */
export const WatchCondition = Schema.Union([
  /**
   * Price reaches a level. `confirm` is the whole `price_cross` /
   * `candle_close` distinction: `touch` fires the moment the level trades,
   * `close` waits for a bar on `interval` to finish beyond it.
   */
  Schema.Struct({
    kind: Schema.Literal("price"),
    market: TradingMarket,
    direction: WatchCrossDirection,
    price: Price,
    confirm: Schema.optional(Schema.Literals(["touch", "close"])),
    /** Required by `confirm: "close"`; meaningless to `touch`. */
    interval: Schema.optional(TradingTimeframe),
    /** `touch` only. Defaults to the mark. */
    priceSource: Schema.optional(WatchPriceSource),
  }),
  /**
   * Unrealised PnL on the mission's position reaches `valueUsd`.
   *
   * Signed, in both directions: `above` must be a gain (a target below zero is
   * not a target), `below` may be either a loss line (`-6`) or a give-back
   * floor under a winner (`+3`).
   */
  Schema.Struct({
    kind: Schema.Literal("pnl"),
    market: TradingMarket,
    direction: WatchCrossDirection,
    valueUsd: Schema.Number,
  }),
  /**
   * Unrealised PnL has come `drawdownUsd` off its own high-water mark on this
   * position. Kept separate from `pnl` because it is measured against a moving
   * peak the runtime maintains, not against a level the model chose.
   */
  Schema.Struct({
    kind: Schema.Literal("giveback"),
    market: TradingMarket,
    drawdownUsd: PositiveUsdAmount,
  }),
  /**
   * Something filled. `cloid` watches one specific order; naming only `market`
   * watches the position for any size change.
   */
  Schema.Struct({
    kind: Schema.Literal("fill"),
    market: Schema.optional(TradingMarket),
    cloid: Schema.optional(Schema.String),
  }),
  /** Wake at a wall-clock time, whatever the market has done. */
  Schema.Struct({
    kind: Schema.Literal("time"),
    runAt: UnixMillis,
  }),
  /**
   * A market metric reaches a threshold — funding, open interest, day volume,
   * the spread, or the just-closed bar's volume against its own recent pace
   * (`volume_ratio`, where 2 means "a bar printed at twice the recent
   * volume"). This is how a plan waits on evidence that is not a price:
   * "remind me when volume picks up", "wake me if funding flips negative".
   *
   * `interval` names the bar series for `volume_ratio` and defaults to `1m`;
   * the snapshot metrics ignore it.
   */
  Schema.Struct({
    kind: Schema.Literal("metric"),
    market: TradingMarket,
    metric: WatchMetricName,
    direction: WatchCrossDirection,
    value: Schema.Number,
    interval: Schema.optional(TradingTimeframe),
  }),
]);
export type WatchCondition = typeof WatchCondition.Type;

/** Why a condition could not be armed as written. */
export const WatchRefusalCode = Schema.Literals([
  /** `confirm: "close"` with no `interval` to close a bar on. */
  "close_needs_interval",
  /** `direction: "above"` on a PnL line at or below zero. */
  "pnl_target_not_a_gain",
  /** A `fill` naming neither an order nor a market. */
  "fill_needs_order_or_market",
  /** The thread's mission is gone, ended, or was never there. */
  "mission_not_found",
  /**
   * The call named neither a `condition` to arm nor a `cancel` to retire — or
   * named both (plan 29 step 6.5). One call does one thing to the armed set.
   */
  "needs_condition_or_cancel",
  /**
   * A `giveback` whose threshold the position has ALREADY given back — plan 34
   * step 6.
   *
   * Such a watch is true the moment it is written, so it fires on the next
   * sweep and wakes the run seconds later to widen the same threshold again.
   * The mission this was found on armed $0.08 with $0.18 already given back
   * (fired in 8s), then $0.25 with $0.41 given back (fired in 5s): three wakes
   * in ninety seconds that did nothing but move a number.
   */
  "giveback_below_current_drawdown",
]);
export type WatchRefusalCode = typeof WatchRefusalCode.Type;

/** A condition the server declined to arm, and why. */
export interface WatchRefusal {
  readonly code: WatchRefusalCode;
  readonly detail: string;
}

/**
 * Derive the persisted predicate from what the model said it is waiting for.
 *
 * Total in the sense that matters: every input either yields a `MarketWatch`
 * or a named refusal, and nothing is guessed. The two defaults it does apply —
 * `confirm` to `touch` and `priceSource` to `mark` — are the shapes the
 * previous seven-type surface made the model spell out on every call, and
 * neither can be wrong: a level with no stated confirmation is a level, and
 * mark is the price every risk number in this system is already measured on.
 *
 * A missing `interval` under `confirm: "close"` is NOT defaulted. Guessing a
 * timeframe there is how a 1h breakout becomes a 1m wick.
 */
export function toMarketWatch(condition: WatchCondition): MarketWatch | WatchRefusal {
  switch (condition.kind) {
    case "price": {
      if ((condition.confirm ?? "touch") === "touch") {
        return {
          type: "price_cross",
          market: condition.market,
          priceSource: condition.priceSource ?? "mark",
          direction: condition.direction,
          price: condition.price,
        };
      }
      if (condition.interval === undefined) {
        return {
          code: "close_needs_interval",
          detail: 'confirm: "close" needs the interval whose bar has to close beyond the level',
        };
      }
      return {
        type: "candle_close",
        market: condition.market,
        interval: condition.interval,
        direction: condition.direction,
        price: condition.price,
      };
    }

    case "pnl": {
      if (condition.direction === "below") {
        return { type: "pnl_below", market: condition.market, valueUsd: condition.valueUsd };
      }
      if (condition.valueUsd <= 0) {
        return {
          code: "pnl_target_not_a_gain",
          detail: `an "above" PnL line has to be a gain; ${condition.valueUsd} is not`,
        };
      }
      return { type: "pnl_above", market: condition.market, valueUsd: condition.valueUsd };
    }

    case "giveback":
      return {
        type: "pnl_giveback",
        market: condition.market,
        drawdownUsd: condition.drawdownUsd,
      };

    case "fill": {
      if (condition.cloid !== undefined) return { type: "order_update", cloid: condition.cloid };
      if (condition.market !== undefined) {
        return { type: "position_update", market: condition.market };
      }
      return {
        code: "fill_needs_order_or_market",
        detail: "a fill watch needs either the cloid of one order or the market to watch",
      };
    }

    case "time":
      return { type: "scheduled_reassessment", runAt: condition.runAt };

    case "metric":
      return {
        type: "metric_threshold",
        market: condition.market,
        metric: condition.metric,
        direction: condition.direction,
        value: condition.value,
        // `volume_ratio` needs a bar series; 1m is the runtime's own default
        // timeframe and the only interval a ratio should quietly assume.
        ...(condition.metric === "volume_ratio"
          ? { interval: condition.interval ?? "1m" }
          : condition.interval === undefined
            ? {}
            : { interval: condition.interval }),
      };
  }
}

/** Whether `toMarketWatch` refused. */
export function isWatchRefusal(result: MarketWatch | WatchRefusal): result is WatchRefusal {
  return "code" in result;
}

/**
 * Read a persisted predicate back as the condition that would produce it.
 *
 * The inverse of `toMarketWatch` over its whole range, so a watch armed before
 * this union existed still reads back in the model's vocabulary. Round-tripping
 * a condition through both is the identity up to the two applied defaults.
 */
export function toWatchCondition(watch: MarketWatch): WatchCondition {
  switch (watch.type) {
    case "price_cross":
      return {
        kind: "price",
        market: watch.market,
        direction: watch.direction,
        price: watch.price,
        confirm: "touch",
        priceSource: watch.priceSource,
      };
    case "candle_close":
      return {
        kind: "price",
        market: watch.market,
        direction: watch.direction,
        price: watch.price,
        confirm: "close",
        interval: watch.interval,
      };
    case "pnl_above":
      return { kind: "pnl", market: watch.market, direction: "above", valueUsd: watch.valueUsd };
    case "pnl_below":
      return { kind: "pnl", market: watch.market, direction: "below", valueUsd: watch.valueUsd };
    case "pnl_giveback":
      return { kind: "giveback", market: watch.market, drawdownUsd: watch.drawdownUsd };
    case "order_update":
      return { kind: "fill", cloid: watch.cloid };
    case "position_update":
      return { kind: "fill", market: watch.market };
    case "scheduled_reassessment":
      return { kind: "time", runAt: watch.runAt };
    case "metric_threshold":
      return {
        kind: "metric",
        market: watch.market,
        metric: watch.metric,
        direction: watch.direction,
        value: watch.value,
        ...(watch.interval === undefined ? {} : { interval: watch.interval }),
      };
  }
}

/** Watch lifecycle - spec §11.3. */
export const PersistedWatchStatus = Schema.Literals([
  "active",
  "triggered",
  "consumed",
  "cancelled",
  "expired",
  "superseded",
]);
export type PersistedWatchStatus = typeof PersistedWatchStatus.Type;

/**
 * Who armed a watch.
 *
 * Absent means the harness armed it deliberately. `staleness_floor` means the
 * runtime armed it because the mission would otherwise have had nothing left
 * that could wake it — a wake from one of these is the cue that nothing crossed
 * and the thesis is the thing to reconsider. `profit_target` means the runtime
 * armed a `pnl_above` watch at the strategy's declared profit target while the
 * mission holds a position — a wake from it is a decision point: bank the win
 * (close, or reduce and keep a runner) if momentum is fading, or extend to the
 * ladder's next rung by republishing with a fresh basis if it is not.
 *
 * `stop_proximity` means the runtime armed a `price_cross` one ATR ahead of the
 * resting stop while the mission holds a position. A wake from it is the
 * designed moment to decide the stop deliberately — tighten, hold, or exit —
 * before the exchange decides instead.
 *
 * `stop_decision` means the runtime armed a `pnl_below` watch at ~70% of the
 * planned loss at the resting stop. A wake from it asks one question — thesis
 * broken, or noise? The answers are hold, tighten legally, or exit better
 * than the stop; the exchange stop stays resting as the backstop.
 *
 * `wake_retry` means this watch is a replacement for one that fired and was
 * consumed by a wake that then failed to reach the harness. The condition it
 * carries is the same one the harness armed; the reason records that the
 * original firing was lost, so a wake from it is not a second crossing.
 *
 * `prediction_horizon` and `prediction_invalidation` are the two the runtime
 * arms from a published plan's projection: the clock running out on the read,
 * and the level at which the read is wrong. Together they are what lets a
 * mission publish a prediction and then genuinely sleep — the pair is the only
 * thing that has to wake it before the market has said anything new. They are
 * the only reasons a plan revision sweeps (see `predictionVersion`).
 */
export const WatchArmedReason = Schema.Literals([
  "staleness_floor",
  "profit_target",
  "wake_retry",
  "stop_proximity",
  "stop_decision",
  "prediction_horizon",
  "prediction_invalidation",
]);
export type WatchArmedReason = typeof WatchArmedReason.Type;

/** The armed reasons a plan revision may sweep — see `predictionVersion`. */
export const PREDICTION_ARMED_REASONS: ReadonlyArray<WatchArmedReason> = [
  "prediction_horizon",
  "prediction_invalidation",
];

/**
 * The armed reasons that only mean anything while a position is held.
 *
 * Each of these is a question about a live trade — where its target is, how
 * close its stop is, when its thesis expires. Flat, none of them has anything
 * to ask, and a wake from one is a turn spent concluding nothing. A live
 * mission was woken 5m43s after its position closed by the target level of the
 * position that no longer existed.
 */
export const POSITION_SCOPED_ARMED_REASONS: ReadonlyArray<WatchArmedReason> = [
  "profit_target",
  "stop_proximity",
  "stop_decision",
  "prediction_horizon",
  "prediction_invalidation",
];

/**
 * The watch types that cannot be evaluated without a position.
 *
 * All three are measured against unrealised PnL, which is zero and meaningless
 * when flat. A price level is not here on purpose: a level is still a level
 * when flat, and the harness may well still want to know about it.
 */
export const POSITION_SCOPED_WATCH_TYPES: ReadonlyArray<string> = [
  "pnl_above",
  "pnl_below",
  "pnl_giveback",
];

/** Whether a watch was armed by the runtime from a plan's projection. */
export function isPredictionArmedReason(reason: WatchArmedReason | undefined): boolean {
  return reason !== undefined && PREDICTION_ARMED_REASONS.includes(reason);
}

/**
 * A watch as persisted - spec §12.1.
 *
 * `watch` carries the published `MarketWatch` union verbatim. A watch binds
 * its mission, not a plan revision (plan 29 step 4.2): publishing a revised
 * plan no longer supersedes anything, so a trigger armed under the previous
 * read keeps working unless the model cancels or replaces it itself.
 */
export const PersistedWatch = Schema.Struct({
  id: TradingId,
  missionId: TradingId,
  watch: MarketWatch,
  /**
   * The same predicate in the vocabulary the model can write (plan 29 step
   * 6.3).
   *
   * `watch` is the persisted and evaluated encoding, and after the union
   * collapsed it is no longer something a model can put in a call — a harness
   * that read back `pnl_giveback` and re-armed it under that name would be
   * writing a type `trading_watch` does not accept. Every read carries the
   * condition beside the encoding so what the model reads is what it can say.
   *
   * Derived by `toPersistedWatch`, so it is present on every row read out of
   * `trading_watches`; optional only because it is not a stored column.
   */
  condition: Schema.optional(WatchCondition),
  status: PersistedWatchStatus,
  armedReason: Schema.optional(WatchArmedReason),
  /**
   * The `strategyVersion` of the plan whose projection this watch was armed
   * for — the id of the prediction it belongs to.
   *
   * Present on runtime-armed prediction watches (see
   * {@link isPredictionArmedReason}) and absent everywhere else: a watch the
   * harness armed itself belongs to no prediction, and neither does a watch
   * from a row written before migration 069.
   *
   * This is what makes a plan revision safe to sweep. A new prediction
   * supersedes only the watches armed for an OLDER one — never a
   * `profit_target`, a stop-proximity level, or a coverage floor, all of which
   * protect a live position and outlive whatever the plan currently believes.
   */
  predictionVersion: Schema.optional(Schema.Number),
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
  /**
   * The value the predicate is currently reading (mark/mid price for
   * `price_cross`, unrealised PnL for `pnl_above`/`pnl_below`, drawdown from
   * peak for `pnl_giveback`), written back by the evaluator on every sweep it
   * observed a real value.
   *
   * Absent on rows that predate the column or on a sweep where the evaluator
   * could not read a value (flat position, gateway failure). The web renders
   * this alongside the threshold so the conditions checklist can show the live
   * number a watch is measuring against, not just a ticked/empty checkbox.
   */
  lastObservedValue: Schema.optional(Schema.Number),
  /**
   * When the evaluator last swept this watch and wrote `lastObservedValue`.
   * Absent in lockstep with `lastObservedValue`.
   */
  lastEvaluatedAt: Schema.optional(UnixMillis),
});
export type PersistedWatch = typeof PersistedWatch.Type;

/**
 * A watch as `trading_look` reports it — plan 33 fix B.
 *
 * The persisted row above is the storage shape and stays exactly as it is. What
 * the model is handed is this, for the same reason the wake renders one line
 * per armed watch: the registry read rides on every mission-scoped look, and
 * most of what it cost said nothing. `missionId` restated on every row the one
 * the look is already about; `watch` was the persisted encoding sitting beside
 * the `condition` that says the same thing in the only vocabulary
 * `trading_watch` accepts — and a harness reading back the encoding and
 * re-arming under its name would be writing a type the tool does not take.
 *
 * `id` is kept whole: it is what `cancel` and `replacesWatchId` take. The
 * lifecycle is kept whole too — `status` and both timestamps — because "armed
 * twenty minutes ago" and "fired just now" are what a look is being asked.
 *
 * `lastEvaluatedAt` is the one dropped reading: an active watch was swept
 * within the sweep cadence, and a terminal one stopped being swept at
 * `updatedAt`.
 */
export const TradingWatchRow = Schema.Struct({
  id: TradingId,
  /** The predicate, in the vocabulary `trading_watch` accepts. */
  condition: WatchCondition,
  status: PersistedWatchStatus,
  armedReason: Schema.optional(WatchArmedReason),
  /** The prediction this level belongs to, when it belongs to one. */
  predictionVersion: Schema.optional(Schema.Number),
  /** What the predicate last read, when the evaluator could read a value. */
  lastObservedValue: Schema.optional(Schema.Number),
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
});
export type TradingWatchRow = typeof TradingWatchRow.Type;

/**
 * Project a persisted watch onto the row a look returns.
 *
 * The condition is taken from the row when it carries one and derived from the
 * persisted encoding otherwise, so a row written before the column existed
 * still reports a predicate the model can re-arm.
 */
/**
 * How many characters of a watch id the model is handed.
 *
 * Eight — enough to be unique across a mission's registry, short enough to be
 * copied without being retyped. A full 36-character UUID is not just 28 extra
 * characters on every row of every wake and every look: on the mission this
 * was measured from, the model copied one back with another watch's tail
 * spliced onto it, the cancel came back `watch_not_found`, and a live
 * protection level stayed armed after the position closed (plan 35 phase 3).
 */
export const WATCH_HANDLE_CHARS = 8;

/** The short form of a watch id, as every model-facing surface renders it. */
export function watchHandle(id: string): string {
  return id.slice(0, WATCH_HANDLE_CHARS);
}

/**
 * Resolve what the model sent back onto one watch id.
 *
 * Accepts the handle it was given and the full id alike, so a run that quotes
 * either is understood. An empty result means no candidate; more than one is
 * returned so the caller can refuse by naming them rather than guessing.
 */
export function resolveWatchHandle(
  handle: string,
  ids: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const exact = ids.filter((id) => id === handle);
  if (exact.length > 0) return exact;
  return ids.filter((id) => id.startsWith(handle));
}

export function toWatchRow(persisted: PersistedWatch): TradingWatchRow {
  return {
    id: persisted.id,
    condition: persisted.condition ?? toWatchCondition(persisted.watch),
    status: persisted.status,
    ...(persisted.armedReason === undefined ? {} : { armedReason: persisted.armedReason }),
    ...(persisted.predictionVersion === undefined
      ? {}
      : { predictionVersion: persisted.predictionVersion }),
    ...(persisted.lastObservedValue === undefined
      ? {}
      : { lastObservedValue: persisted.lastObservedValue }),
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The armed-coverage floor for a mission holding a position
// ---------------------------------------------------------------------------

/**
 * Bar length, in milliseconds, for each direct timeframe.
 *
 * The floor is expressed in bars of the strategy's primary timeframe so the
 * cadence scales with how fast the market the harness is reasoning about
 * actually prints confirming candles.
 */
const BAR_MILLIS: Readonly<Record<TradingTimeframe, number>> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

const MINUTE = 60_000;

/** One bar of a timeframe, in milliseconds. */
export function timeframeBarMillis(timeframe: TradingTimeframe): number {
  return BAR_MILLIS[timeframe];
}

/**
 * The floor for a flat mission on the 1m default timeframe. Kept as a named
 * constant because the contract's tests assert against it directly. Reads the
 * policy in force so an I2 cadence change lands here without a second edit.
 */
export const WATCH_COVERAGE_FLOOR_MILLIS =
  ACTIVE_TRADING_POLICY.reassessment.flatFloorBars * BAR_MILLIS["1m"];

/**
 * How far ahead a scheduled reassessment may sit and still count as coverage.
 *
 * The floor scales with the strategy's primary timeframe and whether the
 * mission is holding a position:
 * - Holding a position: 3 bars, clamped to [2 min, 15 min]. A 1m holder
 *   reassesses inside 3 minutes, a 5m holder at 15 minutes, a 1h holder at the
 *   15-minute cap.
 * - Flat with a published thesis: the policy's flat floor (plan 27 I2) — as
 *   shipped, 10 bars clamped to [5 min, 30 min]. A 1m flat mission at 10
 *   minutes, a 5m flat mission at 30 minutes, a 1h flat mission at the cap.
 *
 * A flat 1m mission is the original case this floor existed for, and its value
 * is unchanged (10 minutes). The clamp bounds the long timeframes so a 1h
 * mission never waits an hour to notice its thesis has gone stale. The flat
 * branch reads the versioned policy because the quick-trades objective names
 * this cadence as a candidate to shorten — through D2 replay, like every
 * threshold.
 */
export function watchCoverageFloorMillis(input: {
  readonly timeframe: TradingTimeframe;
  readonly holdingPosition: boolean;
  readonly policy?: TradingPolicy;
}): number {
  const bar = BAR_MILLIS[input.timeframe];
  if (input.holdingPosition) {
    return Math.min(Math.max(3 * bar, 2 * MINUTE), 15 * MINUTE);
  }
  const reassessment = (input.policy ?? ACTIVE_TRADING_POLICY).reassessment;
  const [clampMinMinutes, clampMaxMinutes] = reassessment.flatFloorClampMinutes;
  return Math.min(
    Math.max(reassessment.flatFloorBars * bar, clampMinMinutes * MINUTE),
    clampMaxMinutes * MINUTE,
  );
}

/**
 * How short a plan's own `reassess.afterMinutes` may pull the wake cadence.
 *
 * The cadence is model-chosen and the model has no cost model for its own
 * turns: a plan that wrote `afterMinutes: 1` was asking to be woken every
 * minute forever, each wake a full harness turn. Five minutes is the flat
 * floor's own lower clamp — a thesis re-check is never more urgent than the
 * tightest cadence the runtime itself would choose.
 */
export const PLAN_REASSESS_FLOOR_MILLIS = 5 * MINUTE;

/**
 * A plan's `reassess.afterMinutes` as a wake interval measured from now.
 *
 * This is a cadence, not a deadline. It used to be read as an instant —
 * `updatedAt + afterMinutes` — and once that instant passed, "time until
 * expiry" went to zero and every settlement armed a wake at `now`: the
 * hot loop. Measured from the look that just ended, the interval is always
 * strictly positive, and a turn that examined the thesis and changed nothing
 * still counts as having looked — the deadline resets because the
 * reassessment the plan asked for just happened.
 */
export function planReassessCadenceMillis(afterMinutes: number): number {
  return Math.max(afterMinutes * MINUTE, PLAN_REASSESS_FLOOR_MILLIS);
}

/**
 * The longest a flat mission's no-op backoff may stretch its wake interval.
 */
export const NO_OP_BACKOFF_CAP_MILLIS = 60 * MINUTE;

/**
 * Stretch a flat mission's wake interval after consecutive no-op wakes.
 *
 * A scheduled wake that concludes "nothing to do" and changes nothing feeds
 * the next computation exactly the inputs of the last one — waking at the
 * same cadence buys identical turns on a market that is not moving. Each
 * consecutive no-op doubles the interval, capped at an hour; the count
 * resets the moment any real event wakes the mission instead (see
 * `consecutiveNoOpWakes` in the coordinator).
 *
 * Flat only. A mission holding a position never backs off — a slow wake on
 * live exposure is the deafness the tight holding floor exists to prevent.
 */
export function backedOffFloorMillis(baseMillis: number, consecutiveNoOps: number): number {
  const stretched = baseMillis * 2 ** Math.min(Math.max(consecutiveNoOps, 0), 6);
  return Math.max(baseMillis, Math.min(stretched, NO_OP_BACKOFF_CAP_MILLIS));
}

/**
 * The slow sanity interval for a position that *is* covered on both sides.
 *
 * The tight holding floor above exists for the deaf case: nothing armed can
 * wake the mission, so it must be woken on time alone. A position with a level
 * or a PnL line armed on each side, or a confirmed exchange stop, is not that
 * case — waking it every three bars spends a full harness turn to conclude
 * "hold". It still deserves a periodic look at whether the thesis itself is
 * still true, so this is 10× the tight floor, clamped to [15 min, 2 h].
 */
export function watchSanityBackstopMillis(timeframe: TradingTimeframe): number {
  const tight = watchCoverageFloorMillis({ timeframe, holdingPosition: true });
  return Math.min(Math.max(10 * tight, 15 * MINUTE), 120 * MINUTE);
}

/** Which directions a mission's armed watches can actually fire in. */
export interface WatchCoverage {
  /** An armed watch that fires if price rises from here. */
  readonly coversUpside: boolean;
  /** An armed watch that fires if price falls from here. */
  readonly coversDownside: boolean;
  /** An armed reassessment due within the floor. */
  readonly coversByReassessment: boolean;
}

/**
 * Read what a mission's watches can actually wake it for.
 *
 * `price_cross` and `candle_close` carry a direction and a level, so they cover
 * a side directly. A level on the wrong side of the mark does not count: a
 * "cross above 1850" armed while price is already 1860 is not upside coverage;
 * it is a condition that was true before it was written.
 *
 * PnL watches cover a side too, when the position's direction is known. A
 * `pnl_above` is a level in dollars on the winning side, `pnl_below` and
 * `pnl_giveback` are levels on the losing side, and the evaluator re-reads
 * reconciled unrealised PnL on every sweep — so a long with a loss line and a
 * target armed hears both ways it can move. Which price direction each maps to
 * comes from the sign of `positionSize`; without it they cover nothing, because
 * "winning" has no meaning.
 *
 * A confirmed exchange-native stop covering the whole position also counts as
 * losing-side coverage: the position cannot run through it without the exchange
 * acting, and the exchange acting produces a `position_update`.
 *
 * `order_update` and `position_update` on their own cover nothing. They fire on
 * a change in size — real events, but a position whose only armed watches are
 * those can watch its own mark run away and never hear about it, which is
 * exactly the session this rule exists because of.
 */
export function readWatchCoverage(input: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly markPrice: number;
  readonly nowMillis: number;
  readonly floorMillis?: number;
  /** Signed position size. Absent or zero means PnL watches cover no side. */
  readonly positionSize?: number;
  /** Absolute size covered by confirmed exchange-native protection. */
  readonly protectedSize?: number;
}): WatchCoverage {
  const active = input.watches.filter((w) => w.status === "active");
  const isLong = (input.positionSize ?? 0) > 0;
  const isShort = (input.positionSize ?? 0) < 0;

  let coversUpside = false;
  let coversDownside = false;

  /** The price direction that a gain, and a loss, would move this position. */
  const coverWinningSide = () => {
    if (isLong) coversUpside = true;
    if (isShort) coversDownside = true;
  };
  const coverLosingSide = () => {
    if (isLong) coversDownside = true;
    if (isShort) coversUpside = true;
  };

  for (const persisted of active) {
    const watch = persisted.watch;
    if (watch.type === "price_cross" || watch.type === "candle_close") {
      if (watch.direction === "above" && watch.price >= input.markPrice) coversUpside = true;
      if (watch.direction === "below" && watch.price <= input.markPrice) coversDownside = true;
      continue;
    }
    if (watch.type === "pnl_above") coverWinningSide();
    if (watch.type === "pnl_below" || watch.type === "pnl_giveback") coverLosingSide();
  }

  const size = Math.abs(input.positionSize ?? 0);
  const fullyProtected = size > 0 && (input.protectedSize ?? 0) >= size - PROTECTION_EPSILON;
  if (fullyProtected) coverLosingSide();

  return { coversUpside, coversDownside, coversByReassessment: hasReassessmentWithin(input) };
}

/**
 * Slack when comparing a protected size against the position size. Exchange
 * rounding leaves the reduce-only order a hair short of the position it covers.
 */
const PROTECTION_EPSILON = 1e-9;

/**
 * Whether an armed reassessment is due inside the floor.
 *
 * Split out of `readWatchCoverage` because a flat mission has no mark to
 * measure levels against, and this is the only part of coverage that still
 * means something without one.
 */
export function hasReassessmentWithin(input: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly nowMillis: number;
  readonly floorMillis?: number;
}): boolean {
  const floor = input.floorMillis ?? WATCH_COVERAGE_FLOOR_MILLIS;
  return input.watches.some(
    (persisted) =>
      persisted.status === "active" &&
      persisted.watch.type === "scheduled_reassessment" &&
      persisted.watch.runAt <= input.nowMillis + floor,
  );
}

/**
 * True when a mission holding a position would hear nothing: no level armed on
 * one of the two sides it could move, and no reassessment due inside the floor.
 */
export function isDeafWhileHoldingPosition(coverage: WatchCoverage): boolean {
  if (coverage.coversByReassessment) return false;
  return !(coverage.coversUpside && coverage.coversDownside);
}

// ---------------------------------------------------------------------------
// Entry conditions a waiting mission named but did not arm
// ---------------------------------------------------------------------------

/**
 * An entry condition whose published price hint has no watch armed at it.
 *
 * A decision to wait is a decision with content: "entry candidate at 1894, come
 * back if price reaches 1899" is a trigger, and a trigger that lives only in
 * prose cannot wake anything. This is the mismatch, surfaced — never acted on.
 * Watch predicates come from `MarketWatch` alone, so nothing here is auto-armed
 * from a description; it is reported to the next wake and to the UI so the gap
 * is visible where the plan is read.
 */
export const UnarmedEntryCondition = Schema.Struct({
  description: Schema.String,
  priceLevel: Price,
  timeframe: Schema.optional(TradingTimeframe),
});
export type UnarmedEntryCondition = typeof UnarmedEntryCondition.Type;

/**
 * How close an armed level has to be to a published hint to count as armed.
 *
 * 10 bps: a hint is the harness's own rounding of a level it also armed, and
 * "1899" against a watch at 1899.2 is the same decision, not an unarmed one.
 */
const ENTRY_HINT_TOLERANCE_BPS = 10;

/**
 * Find the price hints in a waiting plan's entry conditions that no active
 * price-level watch covers.
 *
 * Conditions with no `priceLevel` are skipped: there is nothing to match a
 * watch against, and a non-price trigger ("funding flips") has no watch type to
 * arm today.
 */
export function findUnarmedEntryConditions(input: {
  readonly conditions: ReadonlyArray<{
    readonly description: string;
    readonly priceLevel?: number | undefined;
    readonly timeframe?: TradingTimeframe | undefined;
  }>;
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ReadonlyArray<UnarmedEntryCondition> {
  const armedLevels = input.watches.flatMap((persisted) => {
    if (persisted.status !== "active") return [];
    const watch = persisted.watch;
    if (watch.type !== "price_cross" && watch.type !== "candle_close") return [];
    return [watch.price];
  });

  const unarmed: Array<UnarmedEntryCondition> = [];
  for (const condition of input.conditions) {
    const level = condition.priceLevel;
    if (level === undefined) continue;
    const tolerance = (Math.abs(level) * ENTRY_HINT_TOLERANCE_BPS) / 10_000;
    if (armedLevels.some((armed) => Math.abs(armed - level) <= tolerance)) continue;
    unarmed.push({
      description: condition.description,
      priceLevel: level,
      ...(condition.timeframe === undefined ? {} : { timeframe: condition.timeframe }),
    });
  }
  return unarmed;
}

// ---------------------------------------------------------------------------
// Entry conditions armed with the wrong kind of watch
// ---------------------------------------------------------------------------

/**
 * A trigger whose armed watch cannot evaluate the evidence it declared.
 *
 * The failure this catches is specific and was invisible: a close-confirmed
 * breakout armed as a `price_cross` fires on the wick that trades through the
 * level and closes back inside. The mission is woken, spends a turn, finds the
 * break failed, and re-arms — the "premature wake / stand-down / re-arm cycle"
 * with no evidence at either end that anything was wrong.
 *
 * The mirror is also wrong: a range boundary armed as a `candle_close` waits a
 * whole bar past the touch, which in a range is most of the move.
 */
export const MisarmedEntryCondition = Schema.Struct({
  description: Schema.String,
  priceLevel: Price,
  /** What the condition declared it needs. */
  confirmation: Schema.Literals(["close", "touch"]),
  /** The watch type armed at that level. */
  armedAs: Schema.Literals(["price_cross", "candle_close"]),
  /** The watch type the confirmation calls for. */
  shouldBe: Schema.Literals(["price_cross", "candle_close"]),
  mismatch: Schema.Literals(["watch_type", "timeframe", "direction"]),
});
export type MisarmedEntryCondition = typeof MisarmedEntryCondition.Type;

/**
 * Find entry conditions armed with a watch that cannot evaluate them.
 *
 * A condition with no `confirmation` is skipped: it made no claim about what
 * would confirm it, and guessing on its behalf is how a wick becomes an entry.
 * A condition with no armed watch at all is `findUnarmedEntryConditions`'s
 * finding, not this one's.
 */
export function findMisarmedEntryConditions(input: {
  readonly conditions: ReadonlyArray<{
    readonly description: string;
    readonly priceLevel?: number | undefined;
    readonly confirmation?: "close" | "touch" | undefined;
    readonly timeframe?: string | undefined;
    readonly direction?: "above" | "below" | undefined;
  }>;
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ReadonlyArray<MisarmedEntryCondition> {
  const armed = input.watches.flatMap((persisted) => {
    if (persisted.status !== "active") return [];
    const watch = persisted.watch;
    if (watch.type !== "price_cross" && watch.type !== "candle_close") return [];
    return [
      {
        type: watch.type,
        price: watch.price,
        direction: watch.direction,
        interval: watch.type === "candle_close" ? watch.interval : undefined,
      },
    ];
  });

  const misarmed: Array<MisarmedEntryCondition> = [];
  for (const condition of input.conditions) {
    const level = condition.priceLevel;
    const confirmation = condition.confirmation;
    if (level === undefined || confirmation === undefined) continue;

    const shouldBe = confirmation === "close" ? "candle_close" : "price_cross";
    const tolerance = (Math.abs(level) * ENTRY_HINT_TOLERANCE_BPS) / 10_000;
    const at = armed.filter((watch) => Math.abs(watch.price - level) <= tolerance);
    if (at.length === 0) continue;
    const matching = at.some(
      (watch) =>
        watch.type === shouldBe &&
        (condition.direction === undefined || watch.direction === condition.direction) &&
        (confirmation !== "close" ||
          condition.timeframe === undefined ||
          watch.interval === condition.timeframe),
    );
    if (matching) continue;

    const armedWatch = at[0]!;
    const mismatch =
      armedWatch.type !== shouldBe
        ? ("watch_type" as const)
        : condition.direction !== undefined && armedWatch.direction !== condition.direction
          ? ("direction" as const)
          : ("timeframe" as const);

    misarmed.push({
      description: condition.description,
      priceLevel: level,
      confirmation,
      armedAs: armedWatch.type,
      shouldBe,
      mismatch,
    });
  }
  return misarmed;
}
