import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import type { MarketBestBidOffer } from "@t3tools/trading-contracts/market";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";

import { buildCancelByCloidAction, buildOrderAction, mapOrder } from "./OrderMapper.ts";

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
      expect(a.cloid).toMatch(/^[0-9a-f]{32}$/);
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
      expect(Object.keys(action)).toEqual(["orders", "grouping"]);
      const leg = (action.orders as unknown[])[0] as Record<string, unknown>;
      // The asset index is threaded in (ETH = 2 on testnet), never copied.
      expect(leg.a).toBe(2);
      expect(leg.b).toBe(true);
      expect(leg.cloid).toBe(order.cloid);
    }),
  );

  it("builds a cancel-by-cloid action", () => {
    const action = buildCancelByCloidAction("ETH", "deadbeefdeadbeefdeadbeefdeadbeef");
    expect(Object.keys(action)).toEqual(["cancels"]);
    const cancel = (action.cancels as unknown[])[0] as Record<string, unknown>;
    expect(cancel.coin).toBe("ETH");
    expect(cancel.cloid).toBe("deadbeefdeadbeefdeadbeefdeadbeef");
  });
});
