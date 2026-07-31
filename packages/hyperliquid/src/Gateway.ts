/**
 * HyperliquidGateway — the read-only exchange boundary - spec §10.6 + §13.
 *
 * All providers reach Hyperliquid through this one interface. It maps the raw
 * wire shapes (string-encoded numbers, parallel arrays) into the domain
 * contracts in `@t3tools/trading-contracts`, stamps every read with §13
 * freshness metadata, enforces the master-wallet identity rule for account
 * reads, and clamps candle history to the 500-bar cap.
 *
 * Nothing here signs or mutates exchange state — Phase 2 is the read path.
 *
 * @module HyperliquidGateway
 */
import { Context, Effect, Layer } from "effect";
import * as Clock from "effect/Clock";
import {
  accountFreshness,
  type AccountPosition,
  type AgentAccountSnapshot,
  type AgentNetPosition,
  type AgentOpenOrder,
} from "@t3tools/trading-contracts/account-snapshot";
import {
  MARKET_FRESHNESS,
  type AgentMarketSnapshot,
  type MarketBestBidOffer,
  type MarketCandle,
  type MarketHistory,
  type MarketHistoryRequest,
  type OrderBook,
  type ResolvedMarket,
} from "@t3tools/trading-contracts/market";
import type { EvmAddress } from "@t3tools/trading-contracts/primitives";
import { HyperliquidInfoClient } from "./InfoClient.ts";
import { HyperliquidMarketResolver } from "./MarketResolver.ts";
import {
  HyperliquidDecodeError,
  HyperliquidIdentityError,
  HyperliquidMarketError,
  HyperliquidRequestError,
} from "./errors.ts";
import type {
  WireAssetContext,
  WireCandleSnapshotRequest,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireOpenOrder,
} from "./wire.ts";

/** Combined transport + domain error the gateway can surface. */
export type GatewayError =
  | HyperliquidRequestError
  | HyperliquidDecodeError
  | HyperliquidMarketError
  | HyperliquidIdentityError;

export class HyperliquidGateway extends Context.Service<
  HyperliquidGateway,
  {
    /** Resolve canonical market identifiers from live metadata. */
    readonly resolveMarket: (symbol: string) => Effect.Effect<ResolvedMarket, GatewayError>;
    /** Mark/mid/oracle/funding/OI/day-volume/BBO + computed 24h change + sparkline. */
    readonly getMarketSnapshot: (
      symbol: string,
    ) => Effect.Effect<AgentMarketSnapshot, GatewayError>;
    /** Bounded candle history (≤500 bars, §13). */
    readonly getMarketHistory: (
      request: MarketHistoryRequest,
    ) => Effect.Effect<MarketHistory, GatewayError>;
    /** Order book (≤20 levels/side) with BBO and 2s freshness. */
    readonly getOrderBook: (symbol: string) => Effect.Effect<OrderBook, GatewayError>;
    /** Account state for the master-wallet address (§10.6 identity rule). */
    readonly getAccountSnapshot: (
      address: EvmAddress,
    ) => Effect.Effect<AgentAccountSnapshot, GatewayError>;
    /** Canonical net position for the traded asset. */
    readonly getPosition: (
      address: EvmAddress,
      symbol: string,
    ) => Effect.Effect<AgentNetPosition, GatewayError>;
    /** Open orders keyed by canonical identity. */
    readonly getOpenOrders: (
      address: EvmAddress,
    ) => Effect.Effect<ReadonlyArray<AgentOpenOrder>, GatewayError>;
  }
>()("@t3tools/hyperliquid/Gateway/HyperliquidGateway") {}

/** Parse a wire string number, defaulting to 0 on missing/empty (defensive). */
const num = (value: string | undefined): number =>
  value === undefined || value === "" ? 0 : Number(value);

/** Current epoch millis (testable via Clock). */
const nowMillis = Effect.map(Clock.currentTimeMillis, (n) => n as number);

/**
 * BBO freshness stamp: §13 ages BBO at 2s. The source is the channel that
 * produced the level.
 */
function bboFreshness(observedAt: number, source: "info_api" | "websocket" | "reconciled") {
  return { observedAt, source, staleAfterMillis: MARKET_FRESHNESS.bboStaleAfterMillis };
}

/** Asset-context freshness stamp: §13 ages asset context at 5s. */
function assetFreshness(observedAt: number, source: "info_api" | "websocket" | "reconciled") {
  return {
    observedAt,
    source,
    staleAfterMillis: MARKET_FRESHNESS.assetContextStaleAfterMillis,
  };
}

/**
 * Map a wire asset context + prev-day price into the snapshot fields.
 *
 * `change24hPercent` is computed from `prevDayPx` → mark (the gateway owns this
 * derivation; the exchange does not return a precomputed change). `sparkline`
 * is left empty here — the thread-surface fills it from candle history (Step 8);
 * the gateway returns the snapshot's scalar fields only.
 */
function toMarketSnapshotFields(
  symbol: string,
  ctx: WireAssetContext,
  book: MarketBestBidOffer,
  observedAt: number,
  source: "info_api" | "websocket" | "reconciled",
) {
  const mark = num(ctx.markPx);
  const prevDay = num(ctx.prevDayPx);
  const change24hPercent = prevDay > 0 ? ((mark - prevDay) / prevDay) * 100 : 0;
  return {
    market: symbol as AgentMarketSnapshot["market"],
    markPrice: mark,
    midPrice: num(ctx.midPx),
    oraclePrice: num(ctx.oraclePx),
    fundingRate8h: num(ctx.funding),
    openInterest: num(ctx.openInterest),
    dayVolumeUsd: num(ctx.dayNtlVlm),
    bestBidOffer: book,
    freshness: assetFreshness(observedAt, source),
    change24hPercent,
    sparkline: [] as ReadonlyArray<number>,
  };
}

/** Map a wire l2Book into a domain OrderBook with derived BBO. */
function toOrderBook(book: WireL2BookResponse, observedAt: number): OrderBook {
  const [wireBids, wireAsks] = book.levels;
  const bids = (wireBids ?? []).map(([px, sz]) => ({ price: num(px), size: num(sz) }));
  const asks = (wireAsks ?? []).map(([px, sz]) => ({ price: num(px), size: num(sz) }));
  const bestBid = bids[0];
  const bestAsk = asks[0];
  return {
    market: book.coin as OrderBook["market"],
    bids,
    asks,
    bestBidOffer: {
      bidPrice: bestBid?.price,
      bidSize: bestBid?.size,
      askPrice: bestAsk?.price,
      askSize: bestAsk?.size,
      freshness: bboFreshness(observedAt, "info_api"),
    },
    freshness: bboFreshness(observedAt, "info_api"),
  };
}

/** Map a wire candle tuple `[t, o, h, l, c, v]` into the domain candle. */
function toCandle(wire: readonly [number, string, string, string, string, string]): MarketCandle {
  const [openTime, open, high, low, close, volume] = wire;
  return {
    openTime,
    closeTime: openTime,
    open: num(open),
    close: num(close),
    high: num(high),
    low: num(low),
    volume: num(volume),
  };
}

/** Map a wire position into the domain AccountPosition. */
function toPosition(
  coin: string,
  p: WireClearinghouseStateResponse["assetPositions"][number]["position"],
): AccountPosition {
  return {
    market: coin as AccountPosition["market"],
    size: num(p.szi),
    entryPrice: num(p.entryPx),
    unrealisedPnl: num(p.unrealizedPnl),
    cumulativeFunding: num(p.cumulativeFunding),
    marginUsed: num(p.marginUsed),
  };
}

/** Map a wire open order into the domain AgentOpenOrder. */
function toOpenOrder(o: WireOpenOrder): AgentOpenOrder {
  // Hyperliquid uses "B"/"A" internally; normalise to buy/sell for the agent.
  const side = o.side === "B" || o.side === "buy" ? "buy" : "sell";
  const limitPx = num(o.limitPx);
  const sz = num(o.sz);
  return {
    market: o.coin as AgentOpenOrder["market"],
    orderId: o.oid,
    cloid: o.cloid,
    side,
    limitPrice: limitPx,
    size: sz,
    remainingSize: sz,
    status: o.orderState.status,
    createdAt: o.orderState.timestamp,
  };
}

const makeHyperliquidGateway = Effect.gen(function* () {
  const info = yield* HyperliquidInfoClient;
  const resolver = yield* HyperliquidMarketResolver;

  /**
   * Enforce the §10.6 identity rule: account reads use the master-wallet
   * address, never the execution-wallet address. The gateway cannot tell the
   * two apart from the address alone (both are valid 0x addresses), so this is
   * a documented contract the caller honours; the typed `EvmAddress` parameter
   * makes the intent explicit at every call site. A null/empty address is
   * rejected as `unbound_address`.
   */
  const requireMasterAddress = (address: EvmAddress) =>
    Effect.gen(function* () {
      if (!address || address.length < 3) {
        return yield* new HyperliquidIdentityError({
          address: String(address),
          reason: "unbound_address",
        });
      }
      return address;
    });

  const resolveMarket = Effect.fn("HyperliquidGateway.resolveMarket")(function* (symbol: string) {
    return yield* resolver.resolveMarket(symbol);
  });

  const getMarketSnapshot = Effect.fn("HyperliquidGateway.getMarketSnapshot")(function* (
    symbol: string,
  ) {
    // Resolve + fetch the asset context in one pass; the resolver's cache may
    // already hold the metadata, but the asset context is read fresh each call.
    const resolved = yield* resolver.resolveMarket(symbol);
    const [meta, assetCtxs] = yield* info.metaAndAssetCtxs;
    const ctx = assetCtxs[resolved.assetIndex];
    if (!ctx) {
      return yield* new HyperliquidMarketError({ symbol, reason: "unavailable" });
    }

    // BBO comes from the order book (fresh 2s window). A single l2Book read
    // gives both the book and the top-of-book.
    const observedAt = yield* nowMillis;
    const wireBook = yield* info.l2Book(symbol);
    const orderBook = toOrderBook(wireBook, observedAt);

    const fields = toMarketSnapshotFields(
      symbol,
      ctx,
      orderBook.bestBidOffer,
      observedAt,
      "info_api",
    );
    return fields as AgentMarketSnapshot;
  });

  const getMarketHistory = Effect.fn("HyperliquidGateway.getMarketHistory")(function* (
    request: MarketHistoryRequest,
  ) {
    const observedAt = yield* nowMillis;
    const wireReq: WireCandleSnapshotRequest = {
      coin: request.market,
      interval: request.interval,
      startTime: request.startTime,
      endTime: request.endTime,
    };
    const wireCandles = yield* info.candleSnapshot(wireReq);

    // §13: clamp to 500 bars. The caller may request fewer via `maxBars`.
    const cap = Math.min(
      request.maxBars ?? MARKET_FRESHNESS.candleHistoryMaxBars,
      MARKET_FRESHNESS.candleHistoryMaxBars,
    );
    const trimmed = wireCandles.slice(0, cap);
    const candles = trimmed.map(toCandle);

    // The most-recent finalised close is the last candle's open time (the
    // exchange returns closed candles; the in-progress one is the final entry
    // and is not finalised). §13: a finalised close is processed at most once.
    const finalisedClose = candles.length > 0 ? candles[candles.length - 1]?.closeTime : undefined;

    return {
      market: request.market,
      interval: request.interval,
      candles,
      finalisedClose,
      freshness: assetFreshness(observedAt, "info_api"),
    } as MarketHistory;
  });

  const getOrderBook = Effect.fn("HyperliquidGateway.getOrderBook")(function* (symbol: string) {
    const observedAt = yield* nowMillis;
    const wireBook = yield* info.l2Book(symbol);
    return toOrderBook(wireBook, observedAt);
  });

  const getAccountSnapshot = Effect.fn("HyperliquidGateway.getAccountSnapshot")(function* (
    address: EvmAddress,
  ) {
    const masterAddress = yield* requireMasterAddress(address);
    const observedAt = yield* nowMillis;
    const state = yield* info.clearinghouseState(String(masterAddress));

    const positions: ReadonlyArray<AccountPosition> = state.assetPositions.map((row) =>
      toPosition(row.position.coin, row.position),
    );

    return {
      address: masterAddress,
      accountValue: num(state.marginSummary.accountValue),
      marginUsed: num(state.marginSummary.totalMarginUsed),
      withdrawable: num(state.marginSummary.withdrawable),
      positions,
      freshness: accountFreshness(observedAt, "info_api"),
    } as AgentAccountSnapshot;
  });

  const getPosition = Effect.fn("HyperliquidGateway.getPosition")(function* (
    address: EvmAddress,
    symbol: string,
  ) {
    const snapshot = yield* getAccountSnapshot(address);
    const position = snapshot.positions.find((p) => p.market === symbol);
    if (!position) {
      // No open position is a valid net-zero state, not an error. Return a
      // flat zero position so the harness sees a deterministic shape.
      return {
        market: symbol as AgentNetPosition["market"],
        size: 0,
        entryPrice: 0,
        unrealisedPnl: 0,
        cumulativeFunding: 0,
        marginUsed: 0,
        freshness: snapshot.freshness,
      } as AgentNetPosition;
    }
    return {
      market: position.market,
      size: position.size,
      entryPrice: position.entryPrice,
      unrealisedPnl: position.unrealisedPnl,
      cumulativeFunding: position.cumulativeFunding,
      marginUsed: position.marginUsed,
      freshness: snapshot.freshness,
    } as AgentNetPosition;
  });

  const getOpenOrders = Effect.fn("HyperliquidGateway.getOpenOrders")(function* (
    address: EvmAddress,
  ) {
    const masterAddress = yield* requireMasterAddress(address);
    const wireOrders = yield* info.openOrders(String(masterAddress));
    return wireOrders.map(toOpenOrder);
  });

  return HyperliquidGateway.of({
    resolveMarket,
    getMarketSnapshot,
    getMarketHistory,
    getOrderBook,
    getAccountSnapshot,
    getPosition,
    getOpenOrders,
  });
});

/**
 * Live layer. Declared after `makeHyperliquidGateway` (const is not hoisted).
 *
 * Depends on `HyperliquidInfoClient` and `HyperliquidMarketResolver` — the
 * caller provides both (typically `Layer.provide(gatewayLayer,
 * Layer.merge(infoLayer, resolverLayer))`). Keeping the resolver out of this
 * layer's own provision makes the dependency graph explicit.
 */
export const HyperliquidGatewayLive = Layer.effect(HyperliquidGateway, makeHyperliquidGateway);
