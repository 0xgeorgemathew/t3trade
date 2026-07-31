/**
 * Wire-schema decode tests for the Hyperliquid transport.
 *
 * These prove the schemas accept the exchange's actual JSON shapes. They are
 * the unit-level proof that the decode boundary is correct; the live smoke
 * suite (Step 9) proves the same shapes against the real testnet.
 *
 * @module HyperliquidWireTests
 */
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  WireAllMidsResponse,
  WireCandleSnapshotResponse,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireMetaAndAssetCtxsResponse,
  WireOpenOrdersResponse,
} from "./wire.ts";

const decode = <A>(schema: Schema.Schema<A>) => Schema.decodeUnknownSync(schema);

describe("Hyperliquid wire schemas decode exchange responses", () => {
  it("decodes metaAndAssetCtxs parallel arrays", () => {
    const decoded = decode(WireMetaAndAssetCtxsResponse)([
      {
        universe: [
          { name: "ETH", szDecimals: 4, maxLeverage: 40 },
          { name: "BTC", szDecimals: 5, maxLeverage: 20 },
        ],
      },
      [
        {
          markPx: "3750.1",
          midPx: "3750.5",
          oraclePx: "3749.0",
          funding: "0.00012",
          openInterest: "12500.5",
          dayNtlVlm: "1200000.0",
          prevDayPx: "3700.0",
        },
        {
          markPx: "95000.0",
          midPx: "95001.0",
          oraclePx: "94998.0",
          funding: "-0.00005",
          openInterest: "320.1",
          dayNtlVlm: "50000000.0",
          prevDayPx: "94500.0",
        },
      ],
    ]);
    expect(decoded[0].universe[0]?.name).toBe("ETH");
    // Asset index 0 ↔ universe index 0 (the parallel-array contract, §10.6).
    expect(decoded[1][0]?.markPx).toBe("3750.1");
  });

  it("decodes allMids keyed by coin", () => {
    const decoded = decode(WireAllMidsResponse)({ mids: { ETH: "3750.5", BTC: "95001.0" } });
    expect(decoded.mids.ETH).toBe("3750.5");
  });

  it("decodes l2Book with [bids, asks] level arrays", () => {
    const decoded = decode(WireL2BookResponse)({
      coin: "ETH",
      levels: [
        [
          ["3750.1", "1.2"],
          ["3750.0", "0.8"],
        ],
        [
          ["3750.9", "1.8"],
          ["3751.0", "0.4"],
        ],
      ],
      time: 1_753_000_000_000,
    });
    expect(decoded.levels[0]?.[0]).toEqual(["3750.1", "1.2"]);
    expect(decoded.levels[1]?.[0]).toEqual(["3750.9", "1.8"]);
  });

  it("decodes candleSnapshot array of [time, o, h, l, c, v] tuples", () => {
    const decoded = decode(WireCandleSnapshotResponse)([
      [1_753_000_000_000, "3740.0", "3755.0", "3735.0", "3750.0", "120.5"],
      [1_753_000_060_000, "3750.0", "3760.0", "3748.0", "3758.0", "95.2"],
    ]);
    expect(decoded[0]?.[0]).toBe(1_753_000_000_000);
    expect(decoded[0]?.[4]).toBe("3750.0");
  });

  it("decodes clearinghouseState with margin summary and asset positions", () => {
    const decoded = decode(WireClearinghouseStateResponse)({
      marginSummary: { accountValue: "1000.0", totalMarginUsed: "250.0", withdrawable: "750.0" },
      assetPositions: [
        {
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
    expect(decoded.marginSummary.accountValue).toBe("1000.0");
    expect(decoded.assetPositions[0]?.position.coin).toBe("ETH");
  });

  it("decodes openOrders with both B/A and buy/sell side literals", () => {
    const decoded = decode(WireOpenOrdersResponse)([
      {
        coin: "ETH",
        side: "B",
        limitPx: "3700.0",
        sz: "0.3",
        oid: 90_542_681,
        orderState: { status: "open", timestamp: 1_753_000_000_000 },
      },
      {
        coin: "ETH",
        side: "sell",
        limitPx: "3800.0",
        sz: "0.3",
        oid: 90_542_682,
        cloid: "0x9f3a",
        orderState: { status: "open", timestamp: 1_753_000_000_000 },
      },
    ]);
    expect(decoded[0]?.side).toBe("B");
    expect(decoded[1]?.cloid).toBe("0x9f3a");
  });
});
