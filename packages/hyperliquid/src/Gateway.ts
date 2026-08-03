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
  type MarketCandleInterval,
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
  WireCandle,
  WireCandleSnapshotRequest,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireFrontendOpenOrder,
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
    /** Mark/mid/oracle/funding/OI/day-volume/BBO + computed 24h change. */
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
    /**
     * The master wallet's current taker (cross) fee rate in basis points, plus
     * the millisecond timestamp the rate was observed. The caller applies a
     * staleness window; on a stale/unreadable read it falls back to the
     * authority's `fallbackTakerFeeBpsPerSide`.
     */
    readonly getTakerFeeRateBps: (
      address: EvmAddress,
    ) => Effect.Effect<{ feeBps: number; observedAt: number }, GatewayError>;
  }
>()("@t3tools/hyperliquid/Gateway/HyperliquidGateway") {}

/** Parse a wire string number, defaulting to 0 on missing/empty (defensive). */
const num = (value: string | null | undefined): number =>
  value === undefined || value === null || value === "" ? 0 : Number(value);

/** Millis per exchange-native candle interval (§13: the five supported intervals). */
const INTERVAL_MILLIS: Record<MarketCandleInterval, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

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
 * derivation; the exchange does not return a precomputed change).
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
    // midPx is null when the book is empty; fall back to mark so the snapshot
    // stays well-formed (the POC market always has a book).
    midPrice: ctx.midPx === null ? mark : num(ctx.midPx),
    oraclePrice: num(ctx.oraclePx),
    fundingRate8h: num(ctx.funding),
    openInterest: num(ctx.openInterest),
    dayVolumeUsd: num(ctx.dayNtlVlm),
    bestBidOffer: book,
    freshness: assetFreshness(observedAt, source),
    change24hPercent,
  };
}

/** Map a wire l2Book into a domain OrderBook with derived BBO. */
function toOrderBook(book: WireL2BookResponse, observedAt: number): OrderBook {
  const [wireBids, wireAsks] = book.levels;
  const bids = (wireBids ?? []).map((level) => ({ price: num(level.px), size: num(level.sz) }));
  const asks = (wireAsks ?? []).map((level) => ({ price: num(level.px), size: num(level.sz) }));
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

/** Map a wire candle object into the domain candle (`t`/`T` = open/close time). */
function toCandle(wire: WireCandle): MarketCandle {
  return {
    openTime: wire.t,
    closeTime: wire.T,
    open: num(wire.o),
    close: num(wire.c),
    high: num(wire.h),
    low: num(wire.l),
    volume: num(wire.v),
    trades: wire.n,
  };
}

/** Map a wire position into the domain AccountPosition. */
function toPosition(
  coin: string,
  p: WireClearinghouseStateResponse["assetPositions"][number]["position"],
): AccountPosition {
  return {
    market: coin,
    size: num(p.szi),
    entryPrice: num(p.entryPx),
    unrealisedPnl: num(p.unrealizedPnl),
    cumulativeFunding: num(p.cumulativeFunding),
    marginUsed: num(p.marginUsed),
    liquidationPx: p.liquidationPx != null ? num(p.liquidationPx) : undefined,
  };
}

/** Map a wire open order into the domain AgentOpenOrder. */
/**
 * Map a `frontendOpenOrders` row to the agent contract.
 *
 * Hyperliquid sides are "B" (bid) / "A" (ask); normalise to buy/sell. `sz` is
 * the remaining size, `origSz` the original size.
 *
 * The protective fields are read conservatively: absent means "not confirmable
 * as protection". A stop that the exchange did not describe as reduce-only and
 * triggering must never be counted toward protected size (§17.2 step 7), so
 * the defaults have to fail closed rather than assume.
 */
function toOpenOrder(o: WireFrontendOpenOrder): AgentOpenOrder {
  const remaining = num(o.sz);
  const triggerPrice = num(o.triggerPx);
  return {
    market: o.coin,
    orderId: o.oid,
    cloid: o.cloid ?? undefined,
    side: o.side === "B" ? "buy" : "sell",
    limitPrice: num(o.limitPx),
    size: o.origSz === undefined ? remaining : num(o.origSz),
    remainingSize: remaining,
    // The endpoint only lists resting orders, so every row is open.
    status: "open",
    createdAt: o.timestamp,
    reduceOnly: o.reduceOnly ?? false,
    isTrigger: o.isTrigger ?? false,
    // "0.0" on a non-trigger order; `Price` is strictly positive, so drop it.
    triggerPrice: triggerPrice > 0 ? triggerPrice : undefined,
    orderType: o.orderType,
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
    // One fresh metaAndAssetCtxs read serves both the index and the context.
    // Resolving the index from the same response it pairs with removes any
    // chance of the resolver's cache and this fetch disagreeing about indices
    // (§10.6: the parallel-array pairing must come from one payload).
    const [meta, assetCtxs] = yield* info.metaAndAssetCtxs;
    const assetIndex = meta.universe.findIndex((entry) => entry.name === symbol);
    if (assetIndex === -1) {
      return yield* new HyperliquidMarketError({ symbol, reason: "not_found" });
    }
    const ctx = assetCtxs[assetIndex];
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

    // §13: clamp to 500 bars. The caller may request fewer via `maxBars`.
    const cap = Math.min(
      request.maxBars ?? MARKET_FRESHNESS.candleHistoryMaxBars,
      MARKET_FRESHNESS.candleHistoryMaxBars,
    );

    // The exchange requires startTime. When the caller omits it, ask for the
    // most recent `cap` bars ending now (§10.6: "the most recent window up to
    // the cap").
    const startTime = request.startTime ?? observedAt - INTERVAL_MILLIS[request.interval] * cap;

    const wireReq: WireCandleSnapshotRequest = {
      coin: request.market,
      interval: request.interval,
      startTime,
      endTime: request.endTime,
    };
    const wireCandles = yield* info.candleSnapshot(wireReq);

    // Candles arrive oldest→newest; keep the most recent `cap` bars.
    const candles = wireCandles.slice(-cap).map(toCandle);

    // §13: a finalised close is processed at most once. The newest candle is
    // usually still in progress (its close time is in the future), so the
    // most-recent finalised close is the last candle that has actually closed.
    const finalisedClose = candles.findLast((candle) => candle.closeTime <= observedAt)?.closeTime;

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
      withdrawable: num(state.withdrawable),
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
      // flat position so the harness sees a deterministic shape — with no
      // entry price, because a flat account has none. Reporting `0` here made
      // every `trading_get_position` call fail to encode while flat, which is
      // exactly when the harness asks.
      const flat: AgentNetPosition = {
        market: symbol,
        size: 0,
        unrealisedPnl: 0,
        cumulativeFunding: 0,
        marginUsed: 0,
        freshness: snapshot.freshness,
      };
      return flat;
    }
    const open: AgentNetPosition = {
      market: position.market,
      size: position.size,
      entryPrice: position.entryPrice,
      unrealisedPnl: position.unrealisedPnl,
      cumulativeFunding: position.cumulativeFunding,
      marginUsed: position.marginUsed,
      freshness: snapshot.freshness,
    };
    return open;
  });

  const getOpenOrders = Effect.fn("HyperliquidGateway.getOpenOrders")(function* (
    address: EvmAddress,
  ) {
    const masterAddress = yield* requireMasterAddress(address);

    // §17.2 step 7: protection is confirmed from trigger + reduce-only flags,
    // which only `frontendOpenOrders` carries.
    const wireOrders = yield* info.frontendOpenOrders(String(masterAddress));
    return wireOrders.map(toOpenOrder);
  });

  const getTakerFeeRateBps = Effect.fn("HyperliquidGateway.getTakerFeeRateBps")(function* (
    address: EvmAddress,
  ) {
    const masterAddress = yield* requireMasterAddress(address);
    const fees = yield* info.userFees(String(masterAddress));
    // userCrossRate is a decimal string (e.g. "0.00045"); convert to bps once.
    const feeBps = Number(fees.userCrossRate) * 10_000;
    const observedAt = yield* nowMillis;
    return { feeBps, observedAt };
  });

  return HyperliquidGateway.of({
    resolveMarket,
    getMarketSnapshot,
    getMarketHistory,
    getOrderBook,
    getAccountSnapshot,
    getPosition,
    getOpenOrders,
    getTakerFeeRateBps,
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
