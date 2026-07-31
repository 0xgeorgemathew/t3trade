/**
 * Raw Hyperliquid wire shapes.
 *
 * These mirror the exchange's JSON responses verbatim — arrays where the
 * exchange sends arrays, strings where it sends strings. The Info client and
 * WebSocket client decode into these; the gateway then maps them into the
 * domain contracts in `@t3tools/trading-contracts`.
 *
 * Kept permissive (fields the gateway does not read are omitted, so an
 * exchange-added field does not break decoding). Fields the gateway *does*
 * read are typed strictly.
 *
 * @module HyperliquidWire
 */
import { Schema } from "effect";

/** A price/size level on the order book: `[price, size]`. */
export const WireBookLevel = Schema.Tuple([Schema.String, Schema.String]);
export type WireBookLevel = typeof WireBookLevel.Type;

// -- Info: meta + asset context ----------------------------------------------

/** Perp universe entry from `meta`. */
export const WirePerpUniverse = Schema.Struct({
  name: Schema.String,
  szDecimals: Schema.Number,
  maxLeverage: Schema.Number,
  /** Whether the market is currently active. */
  onlyIsolated: Schema.optional(Schema.Boolean),
});
export type WirePerpUniverse = typeof WirePerpUniverse.Type;

/** `meta` response: universe array. */
export const WireMetaResponse = Schema.Struct({
  universe: Schema.Array(WirePerpUniverse),
});
export type WireMetaResponse = typeof WireMetaResponse.Type;

/**
 * Perp asset context. `meta` returns `{ universe }`; the asset contexts come
 * back from `assetCtxs` as a parallel array — index `i` in `assetCtxs`
 * corresponds to index `i` in `universe`. This parallel-array contract is why
 * the asset index must be resolved from live metadata, never hard-coded (§10.6).
 */
export const WireAssetContext = Schema.Struct({
  /** Mark price. */
  markPx: Schema.String,
  /** Mid price. */
  midPx: Schema.String,
  /** Oracle price. */
  oraclePx: Schema.String,
  /** 8-hour funding rate; may be negative. */
  funding: Schema.String,
  /** Open interest in base units. */
  openInterest: Schema.String,
  /** 24h notional volume in USD. */
  dayNtlVlm: Schema.String,
  /** Prev-day close, for 24h change. */
  prevDayPx: Schema.String,
});
export type WireAssetContext = typeof WireAssetContext.Type;

/**
 * `metaAndAssetCtxs` returns `[meta, assetCtxs]` as a 2-tuple of parallel
 * arrays. The asset index for a coin is its position in `meta.universe`, which
 * is the same position in `assetCtxs`.
 */
export const WireMetaAndAssetCtxsResponse = Schema.Tuple([
  WireMetaResponse,
  Schema.Array(WireAssetContext),
]);
export type WireMetaAndAssetCtxsResponse = typeof WireMetaAndAssetCtxsResponse.Type;

// -- Info: allMids ------------------------------------------------------------

export const WireAllMidsResponse = Schema.Struct({
  mids: Schema.Record(Schema.String, Schema.String),
});
export type WireAllMidsResponse = typeof WireAllMidsResponse.Type;

// -- Info: l2Book --------------------------------------------------------------

export const WireL2BookResponse = Schema.Struct({
  coin: Schema.String,
  /** `[bids, asks]`, each an array of levels. */
  levels: Schema.Tuple([Schema.Array(WireBookLevel), Schema.Array(WireBookLevel)]),
  time: Schema.Number,
});
export type WireL2BookResponse = typeof WireL2BookResponse.Type;

// -- Info: candleSnapshot -----------------------------------------------------

/** Raw candle: `[time, open, high, low, close, volume]`. */
export const WireCandle = Schema.Tuple([
  Schema.Number,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);
export type WireCandle = typeof WireCandle.Type;

/** `candleSnapshot` request body. */
export const WireCandleSnapshotRequest = Schema.Struct({
  coin: Schema.String,
  interval: Schema.String,
  startTime: Schema.optional(Schema.Number),
  endTime: Schema.optional(Schema.Number),
});
export type WireCandleSnapshotRequest = typeof WireCandleSnapshotRequest.Type;

export const WireCandleSnapshotResponse = Schema.Array(WireCandle);
export type WireCandleSnapshotResponse = typeof WireCandleSnapshotResponse.Type;

// -- Info: clearinghouseState -------------------------------------------------

/** A position row in clearinghouse state. */
export const WirePosition = Schema.Struct({
  coin: Schema.String,
  szi: Schema.String,
  entryPx: Schema.String,
  unrealizedPnl: Schema.String,
  cumulativeFunding: Schema.optional(Schema.String),
  marginUsed: Schema.String,
});
export type WirePosition = typeof WirePosition.Type;

export const WireClearinghouseStateResponse = Schema.Struct({
  marginSummary: Schema.Struct({
    accountValue: Schema.String,
    totalMarginUsed: Schema.String,
    withdrawable: Schema.String,
  }),
  assetPositions: Schema.Array(
    Schema.Struct({
      position: WirePosition,
      type: Schema.optional(Schema.String),
    }),
  ),
});
export type WireClearinghouseStateResponse = typeof WireClearinghouseStateResponse.Type;

// -- Info: openOrders ---------------------------------------------------------

export const WireOpenOrder = Schema.Struct({
  coin: Schema.String,
  side: Schema.Union([
    Schema.Literal("B"),
    Schema.Literal("A"),
    Schema.Literal("buy"),
    Schema.Literal("sell"),
  ]),
  limitPx: Schema.String,
  sz: Schema.String,
  oid: Schema.Number,
  cloid: Schema.optional(Schema.String),
  orderState: Schema.Struct({
    status: Schema.String,
    timestamp: Schema.Number,
  }),
});
export type WireOpenOrder = typeof WireOpenOrder.Type;

export const WireOpenOrdersResponse = Schema.Array(WireOpenOrder);
export type WireOpenOrdersResponse = typeof WireOpenOrdersResponse.Type;

// -- WebSocket ----------------------------------------------------------------

/** The subscription payload, shared by subscribe and unsubscribe. */
export const WireWsSubscription = Schema.Struct({
  type: Schema.String,
  coin: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.String),
});

/** Outbound subscribe message. */
export const WireWsSubscribe = Schema.Struct({
  method: Schema.Literal("subscribe"),
  subscription: WireWsSubscription,
});
export type WireWsSubscribe = typeof WireWsSubscribe.Type;

/** Outbound unsubscribe message. */
export const WireWsUnsubscribe = Schema.Struct({
  method: Schema.Literal("unsubscribe"),
  subscription: WireWsSubscription,
});
export type WireWsUnsubscribe = typeof WireWsUnsubscribe.Type;

/**
 * Inbound WS message envelope.
 *
 * `channel` names the subscription type; `data` is the raw payload. The
 * WebSocket client does not decode `data` here — it is decoded per-channel in
 * the gateway where the domain schema applies.
 */
export const WireWsMessage = Schema.Struct({
  channel: Schema.String,
  data: Schema.Unknown,
});
export type WireWsMessage = typeof WireWsMessage.Type;
