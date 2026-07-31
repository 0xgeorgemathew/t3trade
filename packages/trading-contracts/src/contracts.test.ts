import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import { TradingAccount } from "./account.ts";
import {
  accountFreshness,
  AgentAccountSnapshot,
  AgentNetPosition,
  AgentOpenOrder,
} from "./account-snapshot.ts";
import { pocAuthorityDefaults, pocRiskPolicyDefaults, TradingAuthority } from "./authority.ts";
import { MissionInboxEvent } from "./events.ts";
import {
  AgentMarketSnapshot,
  MARKET_FRESHNESS,
  MarketHistory,
  MarketHistoryRequest,
  OrderBook,
  ResolvedMarket,
} from "./market.ts";
import { TradingHarnessRun, TradingMission } from "./mission.ts";
import { MomentumStrategyState } from "./strategy.ts";
import {
  TradingGetMissionResult,
  TradingPublishMomentumStrategyInput,
  TradingPublishMomentumStrategyResult,
} from "./tools.ts";
import { MarketWatch, PersistedWatch } from "./watch.ts";

const decodeAccount = Schema.decodeUnknownSync(TradingAccount);
const decodeAuthority = Schema.decodeUnknownSync(TradingAuthority);
const decodeMission = Schema.decodeUnknownSync(TradingMission);
const decodeStrategy = Schema.decodeUnknownSync(MomentumStrategyState);
const decodeWatch = Schema.decodeUnknownSync(MarketWatch);
const decodePersistedWatch = Schema.decodeUnknownSync(PersistedWatch);
const decodeInboxEvent = Schema.decodeUnknownSync(MissionInboxEvent);
const decodeHarnessRun = Schema.decodeUnknownSync(TradingHarnessRun);
const decodePublishInput = Schema.decodeUnknownSync(TradingPublishMomentumStrategyInput);
const decodePublishResult = Schema.decodeUnknownSync(TradingPublishMomentumStrategyResult);
const decodeGetMissionResult = Schema.decodeUnknownSync(TradingGetMissionResult);
const decodeResolvedMarket = Schema.decodeUnknownSync(ResolvedMarket);
const decodeAgentMarketSnapshot = Schema.decodeUnknownSync(AgentMarketSnapshot);
const decodeMarketHistoryRequest = Schema.decodeUnknownSync(MarketHistoryRequest);
const decodeMarketHistory = Schema.decodeUnknownSync(MarketHistory);
const decodeOrderBook = Schema.decodeUnknownSync(OrderBook);
const decodeAgentAccountSnapshot = Schema.decodeUnknownSync(AgentAccountSnapshot);
const decodeAgentNetPosition = Schema.decodeUnknownSync(AgentNetPosition);
const decodeAgentOpenOrder = Schema.decodeUnknownSync(AgentOpenOrder);

const account: TradingAccount = {
  id: "acct_1",
  userId: "user_1",
  environment: "hyperliquid_testnet",
  masterWallet: {
    privyWalletId: "privy_master_1",
    address: "0xabc",
    ownership: "user",
  },
  executionWallet: {
    privyWalletId: "privy_exec_1",
    address: "0xdef",
    hyperliquidAgentName: "t3-trades-1",
    status: "approved",
    approvedAt: 1_753_000_000_000,
  },
  status: "ready",
  createdAt: 1_753_000_000_000,
  updatedAt: 1_753_000_000_000,
};

const strategy: MomentumStrategyState = {
  version: 1,
  name: "ETH 5m breakout continuation",
  market: "ETH",
  mode: "breakout_continuation",
  direction: "long",
  timeframes: ["5m", "15m"],
  belief: {
    summary: "Breakout confirmed on 1.6x relative volume.",
    regime: "trending",
    confidence: 0.7,
    evidence: ["5m close 3748.9", "relative volume 1.6x"],
  },
  entryPlan: {
    explanation: "Enter on a retest that holds.",
    initialNotionalUsd: 1_115,
    maximumIntendedNotionalUsd: 3_000,
    orderPreference: "marketable_ioc",
    conditions: [{ description: "Retest of 3,718 holds", timeframe: "5m", priceLevel: 3_718.4 }],
  },
  positionManagement: {
    scaleInAllowed: true,
    scaleInConditions: [{ description: "New 5m high on rising volume" }],
    partialReductionAllowed: true,
    trailingMethod: "fixed stop for the POC",
  },
  protection: {
    stopMethod: "Below the last accepted swing low",
    stopPrice: 3_652,
    maximumPlannedLossUsd: 19.9,
  },
  exitConditions: [{ description: "5m close under 3,690", timeframe: "5m", priceLevel: 3_690 }],
  abandonmentConditions: [{ description: "Regime flips to mean-reverting" }],
  reentryConditions: [{ description: "Fresh breakout above 3,760" }],
  currentAction: "holding",
  explanation: "Long 0.30 ETH, protected at 3,652.",
  updatedAt: 1_753_000_000_000,
};

const mission: TradingMission = {
  id: "mission_1",
  userId: "user_1",
  tradingAccountId: "acct_1",
  instruction: "Trade ETH momentum",
  market: "ETH",
  strategyFamily: "momentum",
  harness: {
    provider: "claude",
    providerInstanceId: "instance_1",
    providerSessionId: "session_1",
    threadId: "thread_1",
    status: "available",
  },
  authority: pocAuthorityDefaults(1_000),
  strategy,
  status: "position_open",
  control: {
    entriesAllowed: true,
    reentryAllowed: true,
    pauseAfterPositionClose: false,
  },
  strategyVersion: 1,
  authorityVersion: 1,
  lastHarnessRunId: "run_1",
  createdAt: 1_753_000_000_000,
  updatedAt: 1_753_000_000_000,
};

describe("trading contracts decode published shapes", () => {
  it("decodes a TradingAccount", () => {
    expect(decodeAccount(account)).toMatchObject({
      environment: "hyperliquid_testnet",
      masterWallet: { ownership: "user" },
    });
  });

  it("rejects a master-wallet address without the 0x prefix", () => {
    expect(() =>
      decodeAccount({
        ...account,
        masterWallet: { ...account.masterWallet, address: "abc" },
      }),
    ).toThrow();
  });

  it("decodes the POC authority and risk policy defaults", () => {
    expect(decodeAuthority(pocAuthorityDefaults(1_000))).toMatchObject({
      maximumLeverage: 3,
      marginModes: ["isolated"],
    });
    expect(pocRiskPolicyDefaults.positivePnlExpandsLossBudget).toBe(false);
  });

  it("decodes a full TradingMission including nested authority and strategy", () => {
    const decoded = decodeMission(mission);
    expect(decoded.status).toBe("position_open");
    expect(decoded.strategy?.mode).toBe("breakout_continuation");
    expect(decoded.authority.allowDirectionReversal).toBe(false);
  });

  it("rejects a mission status outside the §11.1 set", () => {
    expect(() => decodeMission({ ...mission, status: "liquidating" })).toThrow();
  });

  it("decodes a MomentumStrategyState", () => {
    expect(decodeStrategy(strategy).timeframes).toEqual(["5m", "15m"]);
  });

  it("decodes every MarketWatch variant", () => {
    const decode = decodeWatch;
    expect(
      decode({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3_800,
      }).type,
    ).toBe("price_cross");
    expect(
      decode({
        type: "candle_close",
        market: "ETH",
        interval: "5m",
        direction: "below",
        price: 3_690,
      }).type,
    ).toBe("candle_close");
    expect(decode({ type: "order_update", cloid: "0x9f3a" }).type).toBe("order_update");
    expect(decode({ type: "position_update", market: "ETH" }).type).toBe("position_update");
    expect(decode({ type: "scheduled_reassessment", runAt: 1_753_000_000_000 }).type).toBe(
      "scheduled_reassessment",
    );
  });

  it("decodes a PersistedWatch in each §11.3 status", () => {
    const statuses = [
      "active",
      "triggered",
      "consumed",
      "cancelled",
      "expired",
      "superseded",
    ] as const;
    for (const status of statuses) {
      const decoded = decodePersistedWatch({
        id: `watch_${status}`,
        missionId: "mission_1",
        strategyVersion: 3,
        watch: { type: "position_update", market: "ETH" },
        status,
        createdAt: 1_753_000_000_000,
        updatedAt: 1_753_000_000_000,
      });
      expect(decoded.status).toBe(status);
    }
  });

  it("decodes a MissionInboxEvent", () => {
    expect(
      decodeInboxEvent({
        id: "event_1",
        missionId: "mission_1",
        category: "market",
        deduplicationKey: "candle_close:5m:1753000000000",
        payload: { close: 3_748.9 },
        status: "pending",
        occurredAt: 1_753_000_000_000,
      }).category,
    ).toBe("market");
  });

  it("decodes a TradingHarnessRun", () => {
    expect(
      decodeHarnessRun({
        id: "run_1",
        missionId: "mission_1",
        cause: "mission_created",
        status: "running",
        startedAt: 1_753_000_000_000,
      }).cause,
    ).toBe("mission_created");
  });
});

describe("§14.3 mission tool contracts", () => {
  it("accepts a publish input whose body omits server-assigned fields", () => {
    const { version: _version, updatedAt: _updatedAt, ...body } = strategy;
    const decoded = decodePublishInput({
      missionId: "mission_1",
      expectedVersion: 0,
      strategy: body,
    });
    expect(decoded.expectedVersion).toBe(0);
    expect("version" in decoded.strategy).toBe(false);
  });

  it("decodes both publish outcomes", () => {
    const decode = decodePublishResult;
    expect(
      decode({
        outcome: "accepted",
        strategy,
        strategyVersion: 1,
        supersededWatchIds: ["watch_1"],
      }).outcome,
    ).toBe("accepted");
    expect(
      decode({ outcome: "rejected", reason: "stale_strategy_version", currentVersion: 4 }).outcome,
    ).toBe("rejected");
  });

  it("decodes a trading_get_mission result", () => {
    const decoded = decodeGetMissionResult({
      mission,
      authority: mission.authority,
      authorityVersion: 1,
      strategy,
      strategyVersion: 1,
      watches: [],
      control: mission.control,
      harness: mission.harness,
    });
    expect(decoded.watches).toEqual([]);
  });
});

describe("§10.6 market- and account-read contracts (Phase 2 pin)", () => {
  const resolvedMarket: ResolvedMarket = {
    symbol: "ETH",
    assetIndex: 1,
    szDecimals: 4,
    maxLeverage: 40,
    available: true,
  };

  it("decodes a ResolvedMarket and rejects a negative asset index", () => {
    expect(decodeResolvedMarket(resolvedMarket).assetIndex).toBe(1);
    expect(() => decodeResolvedMarket({ ...resolvedMarket, assetIndex: -1 })).toThrow();
  });

  it("decodes an AgentMarketSnapshot with BBO freshness", () => {
    const decoded = decodeAgentMarketSnapshot({
      market: "ETH",
      markPrice: 3_750,
      midPrice: 3_750.5,
      oraclePrice: 3_749,
      fundingRate8h: 0.00012,
      openInterest: 12_500,
      dayVolumeUsd: 1_200_000,
      bestBidOffer: {
        bidPrice: 3_750.1,
        bidSize: 2.4,
        askPrice: 3_750.9,
        askSize: 1.8,
        freshness: { observedAt: 1_753_000_000_000, source: "websocket", staleAfterMillis: 2_000 },
      },
      freshness: { observedAt: 1_753_000_000_000, source: "websocket", staleAfterMillis: 5_000 },
      change24hPercent: 1.4,
      sparkline: [3_700, 3_720, 3_750],
    });
    expect(decoded.bestBidOffer.freshness.staleAfterMillis).toBe(
      MARKET_FRESHNESS.bboStaleAfterMillis,
    );
  });

  it("clamps the candle history request to the §13 500-bar cap at the gateway, not the contract", () => {
    // The contract accepts any positive maxBars; the gateway clamps. Verify the
    // request shape decodes with and without an explicit cap.
    expect(decodeMarketHistoryRequest({ market: "ETH", interval: "5m" }).interval).toBe("5m");
    expect(
      decodeMarketHistoryRequest({ market: "ETH", interval: "15m", maxBars: 250 }).maxBars,
    ).toBe(250);
  });

  it("decodes a MarketHistory and surfaces the finalised close", () => {
    const decoded = decodeMarketHistory({
      market: "ETH",
      interval: "1h",
      candles: [
        {
          openTime: 1_753_000_000_000,
          closeTime: 1_753_003_600_000,
          open: 3_740,
          close: 3_750,
          high: 3_755,
          low: 3_735,
          volume: 120,
        },
      ],
      finalisedClose: 1_753_003_600_000,
      freshness: { observedAt: 1_753_003_600_000, source: "info_api", staleAfterMillis: 5_000 },
    });
    expect(decoded.finalisedClose).toBe(1_753_003_600_000);
  });

  it("decodes an OrderBook and allows a one-sided book (null levels)", () => {
    const decoded = decodeOrderBook({
      market: "ETH",
      bids: [{ price: 3_750, size: 1.2 }],
      asks: [],
      bestBidOffer: {
        bidPrice: 3_750,
        bidSize: 1.2,
        freshness: { observedAt: 1_753_000_000_000, source: "websocket", staleAfterMillis: 2_000 },
      },
      freshness: { observedAt: 1_753_000_000_000, source: "websocket", staleAfterMillis: 2_000 },
    });
    expect(decoded.asks).toEqual([]);
    expect(decoded.bestBidOffer.askPrice).toBeUndefined();
  });

  it("decodes an AgentAccountSnapshot keyed by the master-wallet address", () => {
    const decoded = decodeAgentAccountSnapshot({
      address: "0xabc",
      accountValue: 1_000,
      marginUsed: 250,
      withdrawable: 750,
      positions: [
        {
          market: "ETH",
          size: 0.3,
          entryPrice: 3_718.4,
          unrealisedPnl: 9.5,
          cumulativeFunding: -0.4,
          marginUsed: 250,
        },
      ],
      freshness: accountFreshness(1_753_000_000_000, "info_api"),
    });
    expect(decoded.address).toBe("0xabc");
    expect(decoded.positions[0]?.market).toBe("ETH");
  });

  it("decodes an AgentNetPosition with a signed (short) size", () => {
    const decoded = decodeAgentNetPosition({
      market: "ETH",
      size: -0.3,
      entryPrice: 3_718.4,
      unrealisedPnl: -9.5,
      cumulativeFunding: 0.4,
      marginUsed: 250,
      freshness: accountFreshness(1_753_000_000_000, "websocket"),
    });
    expect(decoded.size).toBe(-0.3);
  });

  it("decodes an AgentOpenOrder keyed by canonical identity", () => {
    const decoded = decodeAgentOpenOrder({
      market: "ETH",
      orderId: 90_542_681,
      side: "buy",
      limitPrice: 3_700,
      size: 0.3,
      remainingSize: 0.3,
      status: "open",
      createdAt: 1_753_000_000_000,
    });
    expect(decoded.orderId).toBe(90_542_681);
  });
});

describe("subpath exports", () => {
  it("maps every domain-area module to a subpath whose types and import agree", () => {
    const exportMap = packageJson.exports as Record<string, { types: string; import: string }>;

    expect(Object.keys(exportMap).sort()).toEqual(
      [
        ".",
        "./primitives",
        "./account",
        "./authority",
        "./mission",
        "./strategy",
        "./watch",
        "./events",
        "./tools",
        "./market",
        "./account-snapshot",
      ].sort(),
    );

    // Source-first package: each subpath serves the raw .ts for both types and
    // import, mirroring packages/shared. Module names are lowercase, optionally
    // hyphenated (e.g. account-snapshot).
    for (const [subpath, target] of Object.entries(exportMap)) {
      expect(target.types, subpath).toBe(target.import);
      expect(target.import, subpath).toMatch(/^\.\/src\/[a-zA-Z-]+\.ts$/);
    }
  });
});
