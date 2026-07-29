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
 * A watch as persisted, bound to the strategy version that registered it.
 *
 * NOTE: fork-authored shape. §11.3 publishes the six statuses and states that a
 * watch is "bound to a strategy version", but does not publish the record's
 * field names. `watch` carries the published `MarketWatch` union verbatim.
 */
export const PersistedWatch = Schema.Struct({
  id: TradingId,
  missionId: TradingId,
  strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  watch: MarketWatch,
  status: PersistedWatchStatus,
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
});
export type PersistedWatch = typeof PersistedWatch.Type;
