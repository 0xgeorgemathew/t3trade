/**
 * Market-read contracts - spec §10.6 (un-pinned, first implemented here) + §13.
 *
 * The spec publishes these types as "referenced by HyperliquidGateway" but
 * deliberately leaves their field lists to the implementing phase. Phase 2 is
 * that phase, so the field lists below are the pin. They are grounded in the
 * spec's known-content notes (mark, mid, oracle, funding, open interest, day
 * volume, BBO with freshness) and on the live Hyperliquid perp-asset-context
 * and order-book shapes.
 *
 * Freshness is not decoration: §13 makes staleness a hard gate. BBO stale after
 * 2s blocks marketable IOC pricing; asset context stale after 5s triggers a
 * refresh. Every read carries its own freshness stamp so the caller can refuse
 * stale data rather than silently degrade.
 *
 * @module MarketReads
 */
import { Schema } from "effect";
import { Price, TradingMarket, UnixMillis, UsdAmount } from "./primitives.ts";
import { TradingTimeframe } from "./strategy.ts";

// -- §13 freshness windows ---------------------------------------------------

/**
 * Exchange-native staleness windows - spec §13.
 *
 * These are the bounds the gateway stamps onto reads. They are values, not
 * configuration the operator tunes: the no-local-synthesis rule means every
 * value comes straight from the exchange, and §13 fixes how long a value is
 * trusted before it must be re-read.
 */
export const MARKET_FRESHNESS = {
  /** §13: BBO is stale after 2 seconds; stale BBO blocks marketable IOC pricing. */
  bboStaleAfterMillis: 2_000,
  /** §13: asset context (mark/mid/oracle/funding/OI/day-volume) stale after 5s. */
  assetContextStaleAfterMillis: 5_000,
  /** §13: one tool response is bounded to 500 bars of history. */
  candleHistoryMaxBars: 500,
} as const;

// -- freshness metadata ------------------------------------------------------

/** Where a stamped value came from. `reconciled` = post-reconnect Info refresh. */
export const FreshnessSource = Schema.Literals(["info_api", "websocket", "reconciled"]);
export type FreshnessSource = typeof FreshnessSource.Type;

/**
 * Freshness stamp attached to every exchange read.
 *
 * `staleAfterMillis` is the §13 window for this value; the caller compares
 * `observedAt + staleAfterMillis` against current time to decide staleness.
 */
export const FreshnessMeta = Schema.Struct({
  observedAt: UnixMillis,
  source: FreshnessSource,
  staleAfterMillis: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type FreshnessMeta = typeof FreshnessMeta.Type;

// -- resolved market ---------------------------------------------------------

/**
 * The five exchange-native candle intervals - spec §13 no-local-synthesis rule.
 *
 * Aliased to `TradingTimeframe` because the strategy timeframes and the
 * exchange-native candle intervals are the same five literals for the POC, and
 * §13 forbids synthesising any of them from a smaller interval. If Hyperliquid
 * ever serves an interval outside this set, split this alias.
 */
export const MarketCandleInterval = TradingTimeframe;
export type MarketCandleInterval = typeof MarketCandleInterval.Type;

/**
 * Canonical market identifiers resolved from live perp metadata - spec §10.6.
 *
 * The asset index is resolved at runtime from `meta` + `assetCtxs`; it must
 * never be hard-coded (the grep/lint gate in the hyperliquid package enforces
 * this). `szDecimals` governs size normalisation; `maxLeverage` bounds the
 * authority.
 */
export const ResolvedMarket = Schema.Struct({
  symbol: TradingMarket,
  /** Runtime-resolved perp asset index — never hard-coded (§10.6). */
  assetIndex: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Exchange size decimals for this market. */
  szDecimals: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Maximum exchange leverage advertised for this market. */
  maxLeverage: Schema.Number.check(Schema.isGreaterThan(0)),
  /** Whether the market is accepting new positions. */
  available: Schema.Boolean,
});
export type ResolvedMarket = typeof ResolvedMarket.Type;

// -- best bid / offer --------------------------------------------------------

/**
 * Top-of-book. Each side is optional because the exchange `bbo` channel models
 * a level as `WsLevel | null`; a genuinely one-sided book is valid.
 *
 * Carries its own freshness stamp because §13 ages BBO faster (2s) than the
 * surrounding asset context (5s).
 */
export const MarketBestBidOffer = Schema.Struct({
  bidPrice: Schema.optional(Price),
  bidSize: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  askPrice: Schema.optional(Price),
  askSize: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  freshness: FreshnessMeta,
});
export type MarketBestBidOffer = typeof MarketBestBidOffer.Type;

// -- market snapshot ---------------------------------------------------------

/**
 * Fields shared by the gateway snapshot and the agent-facing snapshot.
 *
 * `change24hPercent` is computed by the gateway, not read verbatim from the
 * exchange, so it lives only on `AgentMarketSnapshot`.
 */
const marketSnapshotFields = {
  market: TradingMarket,
  markPrice: Price,
  midPrice: Price,
  oraclePrice: Price,
  /** 8-hour funding rate; may be negative. */
  fundingRate8h: Schema.Number,
  /** Open interest in base units, as returned by perp asset context. */
  openInterest: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** 24h notional volume in USD. */
  dayVolumeUsd: UsdAmount,
  bestBidOffer: MarketBestBidOffer,
  /** Freshness of the asset-context fields. BBO freshness is on `bestBidOffer`. */
  freshness: FreshnessMeta,
} as const;

/**
 * Gateway-level market snapshot - spec §10.6, referenced by HyperliquidGateway.
 */
export const MarketSnapshot = Schema.Struct(marketSnapshotFields);
export type MarketSnapshot = typeof MarketSnapshot.Type;

/**
 * Agent-facing market snapshot - spec §10.6 + §14.2 `trading_get_market_snapshot`.
 *
 * Extends the raw snapshot with the one computed feature the harness and the
 * chat header need: the 24h change. It is derived by the gateway, never read
 * verbatim from the exchange.
 *
 * There was a `sparkline` here too, and it was always `[]` — the gateway had no
 * candle series to fill it from and nothing else ever wrote it. A field that is
 * empty on every wakeup is not a bounded snapshot of anything; candle history
 * has its own tool.
 */
export const AgentMarketSnapshot = Schema.Struct({
  ...marketSnapshotFields,
  /** 24h percentage change, derived from prior-day open to current mark. */
  change24hPercent: Schema.Number,
});
export type AgentMarketSnapshot = typeof AgentMarketSnapshot.Type;

// -- candle history ----------------------------------------------------------

/** A single OHLCV candle - domain shape, not the exchange wire array. */
export const MarketCandle = Schema.Struct({
  openTime: UnixMillis,
  closeTime: UnixMillis,
  open: Price,
  close: Price,
  high: Price,
  low: Price,
  volume: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Trade count, when the exchange supplies it. */
  trades: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type MarketCandle = typeof MarketCandle.Type;

/**
 * Bounded candle history request - spec §10.6.
 *
 * The gateway clamps the returned bar count to `MARKET_FRESHNESS.candleHistoryMaxBars`
 * (§13). `startTime`/`endTime` are optional; when omitted the gateway returns
 * the most recent window up to the cap.
 */
export const MarketHistoryRequest = Schema.Struct({
  market: TradingMarket,
  interval: MarketCandleInterval,
  startTime: Schema.optional(UnixMillis),
  endTime: Schema.optional(UnixMillis),
  /** Caller-requested cap; the gateway clamps to the §13 maximum of 500. */
  maxBars: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type MarketHistoryRequest = typeof MarketHistoryRequest.Type;

/**
 * Bounded candle history response - spec §10.6.
 *
 * `finalisedClose` marks the close of the most-recently closed candle, which
 * §13 says is processed at most once (the candle-close watch fires on it).
 */
export const MarketHistory = Schema.Struct({
  market: TradingMarket,
  interval: MarketCandleInterval,
  candles: Schema.Array(MarketCandle),
  /** Close time of the most recent finalised candle in the response, if any. */
  finalisedClose: Schema.optional(UnixMillis),
  freshness: FreshnessMeta,
});
export type MarketHistory = typeof MarketHistory.Type;

// -- order book --------------------------------------------------------------

/** A single price level on the order book. */
export const OrderBookLevel = Schema.Struct({
  price: Price,
  size: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OrderBookLevel = typeof OrderBookLevel.Type;

/**
 * Order book for execution-critical reads - spec §10.6 / §14.2.
 *
 * Hyperliquid serves at most 20 levels per side via `l2Book`; both sides are
 * returned in price-descending (bids) / price-ascending (asks) order. The BBO
 * is derived from level 0 and carries the 2s freshness window.
 */
export const OrderBook = Schema.Struct({
  market: TradingMarket,
  bids: Schema.Array(OrderBookLevel),
  asks: Schema.Array(OrderBookLevel),
  bestBidOffer: MarketBestBidOffer,
  freshness: FreshnessMeta,
});
export type OrderBook = typeof OrderBook.Type;
