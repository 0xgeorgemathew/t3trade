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
import { PositiveUsdAmount, Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { TradingTimeframe } from "./strategy.ts";

export const WatchPriceSource = Schema.Literals(["mark", "mid"]);
export type WatchPriceSource = typeof WatchPriceSource.Type;

export const WatchCrossDirection = Schema.Literals(["above", "below"]);
export type WatchCrossDirection = typeof WatchCrossDirection.Type;

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
]);
export type MarketWatch = typeof MarketWatch.Type;

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
 * `wake_retry` means this watch is a replacement for one that fired and was
 * consumed by a wake that then failed to reach the harness. The condition it
 * carries is the same one the harness armed; the reason records that the
 * original firing was lost, so a wake from it is not a second crossing.
 */
export const WatchArmedReason = Schema.Literals(["staleness_floor", "profit_target", "wake_retry"]);
export type WatchArmedReason = typeof WatchArmedReason.Type;

/**
 * A watch as persisted, bound to the strategy version that registered it -
 * spec §12.1.
 *
 * `watch` carries the published `MarketWatch` union verbatim; `strategyVersion`
 * is what makes a watch supersedable when the harness publishes v(n+1).
 *
 * Version 0 means the watch was armed before the first strategy publish. It is
 * not a degenerate case: like any other watch, the publish of v1 supersedes it.
 * Allowing 0 here is what lets `trading_register_watch` succeed for a mission
 * whose bootstrap turn registers coverage before it has published anything.
 */
export const PersistedWatch = Schema.Struct({
  id: TradingId,
  missionId: TradingId,
  strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  watch: MarketWatch,
  status: PersistedWatchStatus,
  armedReason: Schema.optional(WatchArmedReason),
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

/**
 * The floor for a flat mission on the 1m default timeframe. Kept as a named
 * constant because the contract's tests assert against it directly.
 */
export const WATCH_COVERAGE_FLOOR_MILLIS = 10 * BAR_MILLIS["1m"];

/**
 * How far ahead a scheduled reassessment may sit and still count as coverage.
 *
 * The floor scales with the strategy's primary timeframe and whether the
 * mission is holding a position:
 * - Holding a position: 3 bars, clamped to [2 min, 15 min]. A 1m holder
 *   reassesses inside 3 minutes, a 5m holder at 15 minutes, a 1h holder at the
 *   15-minute cap.
 * - Flat with a published thesis: 10 bars, clamped to [5 min, 30 min]. A 1m
 *   flat mission at 10 minutes, a 5m flat mission at 30 minutes, a 1h flat
 *   mission at the 30-minute cap.
 *
 * A flat 1m mission is the original case this floor existed for, and its value
 * is unchanged (10 minutes). The clamp bounds the long timeframes so a 1h
 * mission never waits an hour to notice its thesis has gone stale.
 */
export function watchCoverageFloorMillis(input: {
  readonly timeframe: TradingTimeframe;
  readonly holdingPosition: boolean;
}): number {
  const bar = BAR_MILLIS[input.timeframe];
  if (input.holdingPosition) {
    return Math.min(Math.max(3 * bar, 2 * MINUTE), 15 * MINUTE);
  }
  return Math.min(Math.max(10 * bar, 5 * MINUTE), 30 * MINUTE);
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
 * Only `price_cross` and `candle_close` carry a direction and a level, so only
 * they can cover a side. `order_update` and `position_update` fire on a change
 * in size — real events, but a position whose only armed watches are those can
 * watch its own mark run away and never hear about it, which is exactly the
 * session this rule exists because of.
 *
 * A level on the wrong side of the mark does not count either. A "cross above
 * 1850" armed while price is already 1860 is not upside coverage; it is a
 * condition that was true before it was written.
 */
export function readWatchCoverage(input: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly markPrice: number;
  readonly nowMillis: number;
  readonly floorMillis?: number;
}): WatchCoverage {
  const active = input.watches.filter((w) => w.status === "active");

  let coversUpside = false;
  let coversDownside = false;

  for (const persisted of active) {
    const watch = persisted.watch;
    if (watch.type === "price_cross" || watch.type === "candle_close") {
      if (watch.direction === "above" && watch.price >= input.markPrice) coversUpside = true;
      if (watch.direction === "below" && watch.price <= input.markPrice) coversDownside = true;
    }
  }

  return { coversUpside, coversDownside, coversByReassessment: hasReassessmentWithin(input) };
}

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
