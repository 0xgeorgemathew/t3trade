/**
 * Wire-schema decode tests for the Hyperliquid transport.
 *
 * The market-read schemas are proven against REAL testnet responses recorded
 * by `scripts/fixtureRecorder.ts` into `fixtures/` — not hand-written
 * approximations. Re-run the recorder to refresh them.
 *
 * The account-read schemas (clearinghouseState, openOrders) are proven against
 * an inline copy of a live testnet response captured the same way; recorded
 * account fixtures for the POC master wallet land once the funded address
 * exists (Gate 0).
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
import l2BookFixture from "../fixtures/l2Book.json" with { type: "json" };
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

  it("decodes clearinghouseState with top-level withdrawable", () => {
    // Live testnet response (captured 2026-07-31); `withdrawable` sits at the
    // top level, NOT inside marginSummary.
    const decoded = decode(WireClearinghouseStateResponse)({
      marginSummary: {
        accountValue: "1420.041001",
        totalNtlPos: "0.0",
        totalRawUsd: "1420.041001",
        totalMarginUsed: "0.0",
      },
      crossMarginSummary: {
        accountValue: "1420.041001",
        totalNtlPos: "0.0",
        totalRawUsd: "1420.041001",
        totalMarginUsed: "0.0",
      },
      crossMaintenanceMarginUsed: "0.0",
      withdrawable: "1420.041001",
      assetPositions: [],
      time: 1785486773902,
    });
    expect(decoded.withdrawable).toBe("1420.041001");
    expect(decoded.marginSummary.accountValue).toBe("1420.041001");
  });

  it("decodes a clearinghouseState position row", () => {
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

  it("decodes openOrders rows (flat, B/A sides, sz = remaining)", () => {
    const decoded = decode(WireOpenOrdersResponse)([
      {
        coin: "ETH",
        side: "B",
        limitPx: "3700.0",
        sz: "0.2",
        oid: 90_542_681,
        timestamp: 1_753_000_000_000,
        origSz: "0.3",
      },
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
    expect(decoded[0]?.side).toBe("B");
    expect(decoded[0]?.origSz).toBe("0.3");
    expect(decoded[1]?.cloid).toBe("0x9f3a");
  });
});
