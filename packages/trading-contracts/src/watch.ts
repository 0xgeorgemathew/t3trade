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
import { Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
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
 * and the thesis is the thing to reconsider.
 */
export const WatchArmedReason = Schema.Literals(["staleness_floor"]);
export type WatchArmedReason = typeof WatchArmedReason.Type;

/**
 * A watch as persisted, bound to the strategy version that registered it -
 * spec §12.1.
 *
 * `watch` carries the published `MarketWatch` union verbatim; `strategyVersion`
 * is what makes a watch supersedable when the harness publishes v(n+1).
 */
export const PersistedWatch = Schema.Struct({
  id: TradingId,
  missionId: TradingId,
  strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  watch: MarketWatch,
  status: PersistedWatchStatus,
  armedReason: Schema.optional(WatchArmedReason),
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
});
export type PersistedWatch = typeof PersistedWatch.Type;

// ---------------------------------------------------------------------------
// The armed-coverage floor for a mission holding a position
// ---------------------------------------------------------------------------

/**
 * How far ahead a scheduled reassessment may sit and still count as coverage.
 *
 * Ten minutes is ten bars on the POC's 1m default timeframe: long enough that
 * a mission with well-placed watches is never woken for nothing, short enough
 * that a mission whose thesis has quietly gone stale gets one turn to notice
 * before the move is over.
 */
export const WATCH_COVERAGE_FLOOR_MILLIS = 10 * 60 * 1000;

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
