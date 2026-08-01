/**
 * Raw Hyperliquid wire shapes.
 *
 * These mirror the exchange's JSON responses verbatim — objects where the
 * exchange sends objects, strings where it sends strings. The Info client and
 * WebSocket client decode into these; the gateway then maps them into the
 * domain contracts in `@t3tools/trading-contracts`.
 *
 * Every shape below was verified against live testnet responses (recorded
 * under `packages/hyperliquid/fixtures/`, replayed by `wire.test.ts`). Kept
 * permissive: fields the gateway does not read are omitted, so an
 * exchange-added field does not break decoding. Fields the gateway *does*
 * read are typed strictly.
 *
 * @module HyperliquidWire
 */
import { Schema } from "effect";

/**
 * A price/size level on the order book. The exchange sends objects, not
 * `[price, size]` pairs: `{ "px": "1891.2", "sz": "0.8315", "n": 3 }` where
 * `n` is the number of resting orders at the level.
 */
export const WireBookLevel = Schema.Struct({
  px: Schema.String,
  sz: Schema.String,
  n: Schema.Number,
});
export type WireBookLevel = typeof WireBookLevel.Type;

// -- Info: meta + asset context ----------------------------------------------

/** Perp universe entry from `meta`. */
export const WirePerpUniverse = Schema.Struct({
  name: Schema.String,
  szDecimals: Schema.Number,
  maxLeverage: Schema.Number,
  /** Isolated-margin-only market; constrains margin mode, not availability. */
  onlyIsolated: Schema.optional(Schema.Boolean),
  /** Present and true for delisted markets, which stay in the universe. */
  isDelisted: Schema.optional(Schema.Boolean),
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
  /** Mid price; null when the book is empty (delisted/dead markets). */
  midPx: Schema.NullOr(Schema.String),
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

/**
 * `allMids` over HTTP is a flat record keyed by coin (the WS `allMids` channel
 * wraps the same record in `{ mids }`; this schema is the HTTP shape).
 */
export const WireAllMidsResponse = Schema.Record(Schema.String, Schema.String);
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

/**
 * Raw candle. The exchange sends objects, not tuples: `t`/`T` are the open/
 * close times of the bar, `s` the coin, `i` the interval, `o`/`c`/`h`/`l`/`v`
 * string-encoded OHLCV, `n` the trade count.
 */
export const WireCandle = Schema.Struct({
  t: Schema.Number,
  T: Schema.Number,
  s: Schema.String,
  i: Schema.String,
  o: Schema.String,
  c: Schema.String,
  h: Schema.String,
  l: Schema.String,
  v: Schema.String,
  n: Schema.Number,
});
export type WireCandle = typeof WireCandle.Type;

/**
 * `candleSnapshot` request body. `startTime` is REQUIRED by the exchange —
 * omitting it is rejected with a deserialization error, so the gateway always
 * supplies one (derived from the interval and bar cap when the caller gave
 * none).
 */
export const WireCandleSnapshotRequest = Schema.Struct({
  coin: Schema.String,
  interval: Schema.String,
  startTime: Schema.Number,
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

/**
 * Clearinghouse state. `withdrawable` sits at the top level, NOT inside
 * `marginSummary` (verified live; `marginSummary` carries `accountValue`,
 * `totalNtlPos`, `totalRawUsd`, `totalMarginUsed`).
 */
export const WireClearinghouseStateResponse = Schema.Struct({
  marginSummary: Schema.Struct({
    accountValue: Schema.String,
    totalMarginUsed: Schema.String,
  }),
  withdrawable: Schema.String,
  assetPositions: Schema.Array(
    Schema.Struct({
      position: WirePosition,
      type: Schema.optional(Schema.String),
    }),
  ),
  time: Schema.optional(Schema.Number),
});
export type WireClearinghouseStateResponse = typeof WireClearinghouseStateResponse.Type;

// -- Info: openOrders ---------------------------------------------------------

/**
 * An open order row. Flat — there is no nested `orderState`: the exchange
 * sends `{ coin, side, limitPx, sz, oid, timestamp, origSz, cloid? }` where
 * `sz` is the remaining size and `origSz` the original size. `side` is
 * `"B"` (bid/buy) or `"A"` (ask/sell).
 */
export const WireOpenOrder = Schema.Struct({
  coin: Schema.String,
  side: Schema.Literals(["B", "A"]),
  limitPx: Schema.String,
  sz: Schema.String,
  oid: Schema.Number,
  timestamp: Schema.Number,
  origSz: Schema.optional(Schema.String),
  cloid: Schema.optional(Schema.String),
});
export type WireOpenOrder = typeof WireOpenOrder.Type;

export const WireOpenOrdersResponse = Schema.Array(WireOpenOrder);
export type WireOpenOrdersResponse = typeof WireOpenOrdersResponse.Type;

// -- Info: userFills ----------------------------------------------------------

/**
 * A fill row from `userFills`. The exchange returns one row per fill event
 * with `closedPnl`, `px`, `side`, `fee`, `coin`, and the matching order/cloid.
 * Kept permissive: only the fields the reconciler reads are typed strictly.
 */
export const WireUserFill = Schema.Struct({
  coin: Schema.String,
  side: Schema.Literals(["B", "A"]),
  px: Schema.String,
  sz: Schema.String,
  time: Schema.Number,
  closedPnl: Schema.optional(Schema.String),
  fee: Schema.String,
  oid: Schema.Number,
  cloid: Schema.optional(Schema.String),
  feeToken: Schema.optional(Schema.String),
  dir: Schema.optional(Schema.String),
  crossed: Schema.optional(Schema.Boolean),
  hash: Schema.optional(Schema.String),
  startPosition: Schema.optional(Schema.String),
});
export type WireUserFill = typeof WireUserFill.Type;

export const WireUserFillsResponse = Schema.Array(WireUserFill);
export type WireUserFillsResponse = typeof WireUserFillsResponse.Type;

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

// ---------------------------------------------------------------------------
// Exchange (write) wire shapes — POST /exchange
// ---------------------------------------------------------------------------

/**
 * One per-order status row in a grouped `order` response (§17.2 step 4).
 *
 * Hyperliquid returns one status per order in a batch; T3 records each rather
 * than assuming batch atomicity. `rsp` is the exchange's verbatim status
 * string (`ok`, `err`, `queued`, `triggered`).
 */
export const WireOrderStatusRow = Schema.Struct({
  cloid: Schema.optional(Schema.String),
  oid: Schema.optional(Schema.Number),
  rsp: Schema.String,
});
export type WireOrderStatusRow = typeof WireOrderStatusRow.Type;

/**
 * The exchange's `/exchange` response. Kept permissive: the noop returns
 * `{"status":"ok","response":{"type":"default"}}` (no `statuses`), while an
 * order returns `{"response":{"type":"ok","statuses":[...]}}`. Only
 * `response.statuses` is load-bearing for the per-order inspection (§17.2
 * step 4); everything else is accepted verbatim.
 */
export const WireExchangeResponse = Schema.Struct({
  /** "ok" | "err" — top-level acceptance for some action types (noop). */
  status: Schema.optional(Schema.String),
  /** "default" | "ok" | "err" — the response variant. */
  response: Schema.Union([
    Schema.Struct({
      type: Schema.String,
      statuses: Schema.optional(Schema.Array(Schema.Union([Schema.String, WireOrderStatusRow]))),
    }),
    // The noop returns response: {type: "default"} with no statuses.
    Schema.Struct({
      type: Schema.String,
    }),
  ]),
  /// "order" | "cancel" | "noop" | … — echoes the action type.
  type: Schema.optional(Schema.String),
});
export type WireExchangeResponse = typeof WireExchangeResponse.Type;
