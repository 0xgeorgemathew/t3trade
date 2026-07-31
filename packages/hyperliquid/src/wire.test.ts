/**
 * Wire-schema decode tests for the Hyperliquid transport.
 *
 * Every schema — market reads AND account reads — is proven against REAL
 * testnet responses recorded by `scripts/fixtureRecorder.ts` into `fixtures/`,
 * not hand-written approximations. The account fixtures come from the funded
 * Gate-0 master wallet (recorded 2026-07-31 with a live BTC isolated position
 * and a resting bid). Re-run the recorder to refresh them.
 *
 * Hand-written literals remain only for wire shapes the live account cannot
 * currently produce: a position row without the isolated-leverage extras, and
 * an ask-side order carrying a client order id (`cloid`).
 *
 * @module HyperliquidWireTests
 */
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import allMidsFixture from "../fixtures/allMids.json" with { type: "json" };
import candles15m from "../fixtures/candles.15m.json" with { type: "json" };
import candles1h from "../fixtures/candles.1h.json" with { type: "json" };
import candles1m from "../fixtures/candles.1m.json" with { type: "json" };
import candles3m from "../fixtures/candles.3m.json" with { type: "json" };
import candles5m from "../fixtures/candles.5m.json" with { type: "json" };
import clearinghouseFixture from "../fixtures/clearinghouseState.json" with { type: "json" };
import l2BookFixture from "../fixtures/l2Book.json" with { type: "json" };
import openOrdersFixture from "../fixtures/openOrders.json" with { type: "json" };
import metaFixture from "../fixtures/metaAndAssetCtxs.json" with { type: "json" };
import {
  WireAllMidsResponse,
  WireCandleSnapshotResponse,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireMetaAndAssetCtxsResponse,
  WireOpenOrdersResponse,
} from "./wire.ts";

const decode = Schema.decodeUnknownSync;

describe("Hyperliquid wire schemas decode recorded testnet responses", () => {
  it("decodes the recorded metaAndAssetCtxs parallel arrays", () => {
    const [meta, assetCtxs] = decode(WireMetaAndAssetCtxsResponse)(metaFixture);
    // The parallel-array contract (§10.6): one context per universe entry.
    expect(assetCtxs.length).toBe(meta.universe.length);
    expect(meta.universe.length).toBeGreaterThan(0);
    expect(meta.universe.some((entry) => entry.name === "ETH")).toBe(true);
    // Dead markets carry a null midPx on the live exchange; the schema must
    // accept it or the whole decode (and every dependent read) fails.
    expect(assetCtxs.some((ctx) => ctx.midPx === null)).toBe(true);
  });

  it("decodes the recorded allMids flat record keyed by coin", () => {
    const decoded = decode(WireAllMidsResponse)(allMidsFixture);
    expect(Object.keys(decoded).length).toBeGreaterThan(0);
    expect(typeof decoded.ETH).toBe("string");
  });

  it("decodes the recorded l2Book with {px, sz, n} object levels", () => {
    const decoded = decode(WireL2BookResponse)(l2BookFixture);
    const [bids, asks] = decoded.levels;
    expect(bids.length).toBeGreaterThan(0);
    expect(asks.length).toBeGreaterThan(0);
    expect(typeof bids[0]?.px).toBe("string");
    expect(typeof bids[0]?.sz).toBe("string");
  });

  it.each([
    { interval: "1m", fixture: candles1m },
    { interval: "3m", fixture: candles3m },
    { interval: "5m", fixture: candles5m },
    { interval: "15m", fixture: candles15m },
    { interval: "1h", fixture: candles1h },
  ])(
    "decodes the recorded $interval candleSnapshot (§13 exchange-native interval)",
    ({ interval, fixture }) => {
      const decoded = decode(WireCandleSnapshotResponse)(fixture);
      expect(decoded.length).toBeGreaterThan(0);
      for (const candle of decoded) {
        expect(candle.i).toBe(interval);
        // t/T bracket the bar: open time strictly before close time.
        expect(candle.t).toBeLessThan(candle.T);
      }
    },
  );

  it("decodes the recorded clearinghouseState with a live position row", () => {
    const decoded = decode(WireClearinghouseStateResponse)(clearinghouseFixture);
    // `withdrawable` sits at the top level, NOT inside marginSummary.
    expect(Number(decoded.withdrawable)).toBeGreaterThan(0);
    expect(Number(decoded.marginSummary.accountValue)).toBeGreaterThan(0);
    // The recorded account holds a real BTC isolated position, so the decode
    // covers a populated assetPositions row (extra live-only fields like
    // `leverage` and `cumFunding` must not break it).
    const position = decoded.assetPositions[0]?.position;
    expect(position?.coin).toBe("BTC");
    expect(Number(position?.szi)).toBeGreaterThan(0);
    expect(Number(position?.marginUsed)).toBeGreaterThan(0);
  });

  it("decodes a minimal position row without the isolated-leverage extras", () => {
    // Hand-written: the live account can't produce a bare row (its position
    // always carries the isolated-leverage fields the schema ignores).
    const decoded = decode(WireClearinghouseStateResponse)({
      marginSummary: { accountValue: "1000.0", totalMarginUsed: "250.0" },
      withdrawable: "750.0",
      assetPositions: [
        {
          type: "oneWay",
          position: {
            coin: "ETH",
            szi: "0.3",
            entryPx: "3718.4",
            unrealizedPnl: "9.5",
            cumulativeFunding: "-0.4",
            marginUsed: "250.0",
          },
        },
      ],
    });
    expect(decoded.assetPositions[0]?.position.coin).toBe("ETH");
  });

  it("decodes the recorded openOrders row (flat, sz = remaining)", () => {
    const decoded = decode(WireOpenOrdersResponse)(openOrdersFixture);
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded[0]?.side).toBe("B");
    expect(typeof decoded[0]?.limitPx).toBe("string");
    expect(decoded[0]?.origSz).toBe(decoded[0]?.sz);
  });

  it("decodes an ask-side order carrying a cloid", () => {
    // Hand-written: the live account's resting order is a plain bid with no
    // client order id, so the A-side and cloid branches need a literal.
    const decoded = decode(WireOpenOrdersResponse)([
      {
        coin: "ETH",
        side: "A",
        limitPx: "3800.0",
        sz: "0.3",
        oid: 90_542_682,
        timestamp: 1_753_000_000_000,
        origSz: "0.3",
        cloid: "0x9f3a",
      },
    ]);
    expect(decoded[0]?.side).toBe("A");
    expect(decoded[0]?.cloid).toBe("0x9f3a");
  });
});
