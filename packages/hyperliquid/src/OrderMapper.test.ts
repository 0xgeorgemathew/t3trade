import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import type { MarketBestBidOffer } from "@t3tools/trading-contracts/market";
import type { TradingOrderIntent, TradingWireOrder } from "@t3tools/trading-contracts/execution";

import {
  buildCancelByCloidAction,
  buildGroupedEntryWithStopAction,
  buildOrderAction,
  buildProtectiveStopAction,
  mapOrder,
  mapProtectiveStop,
} from "./OrderMapper.ts";

/** A fresh BBO with a known top-of-book (ETH bid 1891.4, ask 1891.5). */
const FRESH_BBO = (observedAt: number): MarketBestBidOffer => ({
  bidPrice: 1891.4,
  bidSize: 0.03,
  askPrice: 1891.5,
  askSize: 0.02,
  freshness: { observedAt, source: "info_api", staleAfterMillis: 2_000 },
});

const baseIntent = (overrides: Partial<TradingOrderIntent>): TradingOrderIntent => ({
  missionId: "mission_1",
  strategyVersion: 1,
  executionSequence: 0,
  actionType: "open",
  market: "ETH",
  side: "buy",
  size: 0.5,
  orderPreference: "marketable_ioc",
  limitPrice: 3_750,
  stop: { stopPrice: 3_700, plannedLossAtStopUsd: 18 },
  reduceOnly: false,
  ...overrides,
});

describe("mapOrder", () => {
  it.effect("derives a buy IOC limit from best ask + slippage", () =>
    Effect.gen(function* () {
      const order = yield* mapOrder({
        intent: baseIntent({}),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      // 1891.5 * (1 + 0.0050) = 1900.9525 → 5 sig figs.
      expect(order.side).toBe("buy");
      expect(order.timeInForce).toBe("ioc");
      expect(order.limitPrice).toBe("1901"); // 5 sig figs of 1900.9525
    }),
  );

  it.effect("derives a sell IOC limit from best bid - slippage", () =>
    Effect.gen(function* () {
      const order = yield* mapOrder({
        intent: baseIntent({ side: "sell" }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      // 1891.4 * (1 - 0.0050) = 1881.943 → 5 sig figs.
      expect(order.limitPrice).toBe("1881.9");
      expect(order.timeInForce).toBe("ioc");
    }),
  );

  it.effect("rests a GTC order at the harness limit price (no BBO read needed)", () =>
    Effect.gen(function* () {
      const order = yield* mapOrder({
        intent: baseIntent({ orderPreference: "resting_limit", limitPrice: 1_900 }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      expect(order.timeInForce).toBe("gtc");
      expect(order.limitPrice).toBe("1900");
    }),
  );

  it.effect("rejects a marketable IOC priced off a stale BBO (§15.4)", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        intent: baseIntent({}),
        // BBO observed at 0; now is 5s later — past the 2s window.
        bbo: FRESH_BBO(0),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 5_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("stale_bbo");
    }),
  );

  it.effect("rejects a buy IOC when the ask side is missing", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        intent: baseIntent({}),
        bbo: { ...FRESH_BBO(1_000), askPrice: undefined, askSize: undefined },
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("missing_best_ask");
    }),
  );

  it.effect("rejects an order below the exchange minimum notional", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        intent: baseIntent({ size: 0.0001, orderPreference: "resting_limit", limitPrice: 1_900 }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 5,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("below_min_notional");
    }),
  );

  it.effect("rests a post-only ALO order at the harness limit without crossing", () =>
    Effect.gen(function* () {
      const order = yield* mapOrder({
        // 1891 sits below both the bid (1891.4) and the ask (1891.5).
        intent: baseIntent({ orderPreference: "post_only", limitPrice: 1_891 }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      expect(order.timeInForce).toBe("alo");
      expect(order.limitPrice).toBe("1891");
    }),
  );

  it.effect("rejects a post-only buy whose limit would cross the ask", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        // A buy at exactly the best ask crosses — ALO means rest or nothing.
        intent: baseIntent({ orderPreference: "post_only", limitPrice: 1_891.5 }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("would_have_crossed");
    }),
  );

  it.effect("rejects a post-only sell whose limit would cross the bid", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        // A sell at exactly the best bid crosses.
        intent: baseIntent({ side: "sell", orderPreference: "post_only", limitPrice: 1_891.4 }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("would_have_crossed");
    }),
  );

  it.effect("rejects a post-only order priced off a stale BBO (§15.4)", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        intent: baseIntent({ orderPreference: "post_only", limitPrice: 1_891 }),
        // BBO observed at 0; now is 5s later — past the 2s window.
        bbo: FRESH_BBO(0),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 5_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("stale_bbo");
    }),
  );

  it.effect("rejects a post-only buy when the ask side is missing", () =>
    Effect.gen(function* () {
      const error = yield* mapOrder({
        intent: baseIntent({ orderPreference: "post_only", limitPrice: 1_891 }),
        bbo: { ...FRESH_BBO(1_000), askPrice: undefined, askSize: undefined },
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("missing_best_ask");
    }),
  );

  it.effect("produces a deterministic cloid from the intent", () =>
    Effect.gen(function* () {
      const a = yield* mapOrder({
        intent: baseIntent({}),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      const b = yield* mapOrder({
        intent: baseIntent({}),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      expect(a.cloid).toBe(b.cloid);
      expect(a.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    }),
  );
});

describe("buildOrderAction / buildCancelByCloidAction", () => {
  it.effect("builds an order action with insertion-order keys", () =>
    Effect.gen(function* () {
      const order = yield* mapOrder({
        intent: baseIntent({}),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      const action = buildOrderAction(order, 2);
      expect(Object.keys(action)).toEqual(["type", "orders", "grouping"]);
      expect(action.type).toBe("order");
      const leg = (action.orders as unknown[])[0] as Record<string, unknown>;
      // The full leg key sequence — hash-critical, so assert it exactly.
      // Note the cloid field is "c" inside an order leg (the cancel-by-cloid
      // action's top-level leg uses "cloid"; the order leg uses "c").
      expect(Object.keys(leg)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
      // The asset index is threaded in by the caller, never derived here — the
      // live index tracks the universe listing order (ETH resolved to 4 on
      // testnet on 2026-08-02), so 2 stands in for "whatever was passed".
      expect(leg.a).toBe(2);
      expect(leg.b).toBe(true);
      expect(leg.c).toBe(order.cloid);
      expect(leg.cloid).toBeUndefined();
      // An IOC wire order carries the PascalCase literal — not the contract's.
      expect(leg.t).toEqual({ limit: { tif: "Ioc" } });
    }),
  );

  it("maps every contract TIF to exactly one wire TIF", () => {
    const wireOrder = (timeInForce: TradingWireOrder["timeInForce"]): TradingWireOrder => ({
      cloid: "0x" + "a".repeat(32),
      coin: "ETH",
      side: "buy",
      limitPrice: "1891",
      size: "0.5",
      timeInForce,
      reduceOnly: false,
    });
    const wireTifOf = (order: TradingWireOrder): unknown =>
      ((buildOrderAction(order, 2).orders as unknown[])[0] as Record<string, unknown>).t;
    // The whole table, exactly — a fourth contract TIF must grow this list.
    expect(wireTifOf(wireOrder("ioc"))).toEqual({ limit: { tif: "Ioc" } });
    expect(wireTifOf(wireOrder("gtc"))).toEqual({ limit: { tif: "Gtc" } });
    expect(wireTifOf(wireOrder("alo"))).toEqual({ limit: { tif: "Alo" } });
  });

  it("builds a cancel-by-cloid action with insertion-order keys", () => {
    // The cancel action mirrors the order action's shape: a discriminating
    // top-level `type` and legs keyed by the numeric asset index, not the coin
    // symbol. Key order is hash-critical, so assert the full sequence exactly.
    const action = buildCancelByCloidAction(2, "0xdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(Object.keys(action)).toEqual(["type", "cancels"]);
    expect(action.type).toBe("cancelByCloid");
    const cancel = (action.cancels as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(cancel)).toEqual(["asset", "cloid"]);
    expect(cancel.asset).toBe(2);
    expect(cancel.coin).toBeUndefined();
    expect(cancel.cloid).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeef");
  });
});

describe("mapProtectiveStop — §17.2 step 6 / §17.4", () => {
  const PROTECT_CLOID = "0x" + "1".repeat(32);

  it.effect("protects a long with a sell stop below the trigger", () =>
    Effect.gen(function* () {
      const stop = yield* mapProtectiveStop({
        cloid: PROTECT_CLOID,
        coin: "ETH",
        positionSize: 0.25,
        stopPrice: 1_800,
        szDecimals: 4,
      });

      // The reducing side of a long is a sell.
      expect(stop.side).toBe("sell");
      expect(stop.triggerPrice).toBe("1800");
      // The fill limit sits BELOW the trigger so the armed order crosses;
      // a stop that cannot fill is not protection. 1800 * (1 - 0.01) = 1782.
      expect(Number(stop.limitPrice)).toBeLessThan(1_800);
      expect(Number(stop.limitPrice)).toBeCloseTo(1_782, 5);
      expect(stop.size).toBe("0.25");
    }),
  );

  it.effect("protects a short with a buy stop above the trigger", () =>
    Effect.gen(function* () {
      const stop = yield* mapProtectiveStop({
        cloid: PROTECT_CLOID,
        coin: "ETH",
        positionSize: -0.25,
        stopPrice: 1_900,
        szDecimals: 4,
      });

      expect(stop.side).toBe("buy");
      expect(Number(stop.limitPrice)).toBeGreaterThan(1_900);
    }),
  );

  it.effect("sizes from the canonical position, not from a requested size", () =>
    Effect.gen(function* () {
      // A partial fill is exactly the case where these differ (§17.3).
      const stop = yield* mapProtectiveStop({
        cloid: PROTECT_CLOID,
        coin: "ETH",
        positionSize: 0.037,
        stopPrice: 1_800,
        szDecimals: 4,
      });
      expect(stop.size).toBe("0.037");
    }),
  );

  it.effect("refuses to place protection for a flat position", () =>
    Effect.gen(function* () {
      const error = yield* mapProtectiveStop({
        cloid: PROTECT_CLOID,
        coin: "ETH",
        positionSize: 0,
        stopPrice: 1_800,
        szDecimals: 4,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("non_positive_size");
    }),
  );
});

describe("protective order actions — §17.2 step 3 / step 6", () => {
  const PROTECT_CLOID = "0x" + "1".repeat(32);

  const protectiveStop = mapProtectiveStop({
    cloid: PROTECT_CLOID,
    coin: "ETH",
    positionSize: 0.02,
    stopPrice: 1_800,
    szDecimals: 4,
  });

  it.effect("groups an entry with its linked stop under normalTpsl", () =>
    Effect.gen(function* () {
      const entry = yield* mapOrder({
        intent: baseIntent({}),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      const stop = yield* protectiveStop;
      const action = buildGroupedEntryWithStopAction(entry, stop, 2);

      expect(action.grouping).toBe("normalTpsl");
      const legs = action.orders as ReadonlyArray<Record<string, unknown>>;
      expect(legs).toHaveLength(2);

      // Parent: the entry, unchanged and not reduce-only.
      expect(Object.keys(legs[0]!)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
      expect(legs[0]!.r).toBe(false);
      expect(legs[0]!.c).toBe(entry.cloid);

      // Child: reduce-only, opposite side, trigger rather than limit. Key
      // order is hash-critical, so assert the full sequence exactly.
      expect(Object.keys(legs[1]!)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
      expect(legs[1]!.r).toBe(true);
      expect(legs[1]!.b).toBe(false);
      expect(legs[1]!.c).toBe(PROTECT_CLOID);
      expect(legs[1]!.t).toEqual({
        trigger: { isMarket: true, triggerPx: "1800", tpsl: "sl" },
      });
    }),
  );

  it.effect("carries an ALO entry leg inside a normalTpsl group", () =>
    Effect.gen(function* () {
      const entry = yield* mapOrder({
        intent: baseIntent({ orderPreference: "post_only", limitPrice: 1_891 }),
        bbo: FRESH_BBO(1_000),
        szDecimals: 4,
        allowedSlippageBps: 50,
        nowMs: 1_000,
      });
      const stop = yield* protectiveStop;
      const action = buildGroupedEntryWithStopAction(entry, stop, 2);

      const legs = action.orders as ReadonlyArray<Record<string, unknown>>;
      // The entry leg keeps the ALO time-in-force through the grouping.
      expect(legs[0]!.t).toEqual({ limit: { tif: "Alo" } });
      // The stop leg stays a market trigger — a stop is not a place to be
      // patient, whatever the entry's time-in-force is.
      expect(legs[1]!.t).toEqual({
        trigger: { isMarket: true, triggerPx: "1800", tpsl: "sl" },
      });
    }),
  );

  it.effect("builds a standalone sized stop that is nobody's child", () =>
    Effect.gen(function* () {
      const stop = yield* protectiveStop;
      const action = buildProtectiveStopAction(stop, 2);

      // `na` is load-bearing: independent protection has to survive the
      // cancellation of the parent whose children would otherwise go with it
      // (§17.3).
      expect(action.grouping).toBe("na");
      expect(action.type).toBe("order");
      const legs = action.orders as ReadonlyArray<Record<string, unknown>>;
      expect(legs).toHaveLength(1);
      expect(legs[0]!.r).toBe(true);
      expect(legs[0]!.a).toBe(2);
    }),
  );
});
