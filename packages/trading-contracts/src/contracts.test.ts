import { Schema } from "effect";
import { assert, describe, expect, it } from "vite-plus/test";

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
import {
  AgentConditionInput,
  mandatedTimeframe,
  runtimeTimeframe,
  TradingPlanState,
} from "./strategy.ts";
import {
  TradingGetMissionResult,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
} from "./tools.ts";
import { TradingEnterInput } from "./entry.ts";
import { MarketWatch, PersistedWatch } from "./watch.ts";
import {
  TradingCloid,
  TradingExecutionRecord,
  TradingFill,
  TradingLossBudget,
  TradingOrderIntent,
  TradingRiskReservation,
} from "./execution.ts";

const decodeAccount = Schema.decodeUnknownSync(TradingAccount);
const decodeAuthority = Schema.decodeUnknownSync(TradingAuthority);
const decodeMission = Schema.decodeUnknownSync(TradingMission);
const decodeStrategy = Schema.decodeUnknownSync(TradingPlanState);
const decodeWatch = Schema.decodeUnknownSync(MarketWatch);
const decodePersistedWatch = Schema.decodeUnknownSync(PersistedWatch);
const decodeInboxEvent = Schema.decodeUnknownSync(MissionInboxEvent);
const decodeHarnessRun = Schema.decodeUnknownSync(TradingHarnessRun);
const decodePublishInput = Schema.decodeUnknownSync(TradingPublishPlanInput);
const decodePublishResult = Schema.decodeUnknownSync(TradingPublishPlanResult);
const decodeGetMissionResult = Schema.decodeUnknownSync(TradingGetMissionResult);
const decodeEnter = Schema.decodeUnknownSync(TradingEnterInput);
const decodeResolvedMarket = Schema.decodeUnknownSync(ResolvedMarket);
const decodeAgentMarketSnapshot = Schema.decodeUnknownSync(AgentMarketSnapshot);
const decodeMarketHistoryRequest = Schema.decodeUnknownSync(MarketHistoryRequest);
const decodeMarketHistory = Schema.decodeUnknownSync(MarketHistory);
const decodeOrderBook = Schema.decodeUnknownSync(OrderBook);
const decodeAgentAccountSnapshot = Schema.decodeUnknownSync(AgentAccountSnapshot);
const decodeAgentNetPosition = Schema.decodeUnknownSync(AgentNetPosition);
const decodeAgentOpenOrder = Schema.decodeUnknownSync(AgentOpenOrder);
const decodeOrderIntent = Schema.decodeUnknownSync(TradingOrderIntent);
const decodeExecutionRecord = Schema.decodeUnknownSync(TradingExecutionRecord);
const decodeFill = Schema.decodeUnknownSync(TradingFill);
const decodeReservation = Schema.decodeUnknownSync(TradingRiskReservation);
const decodeLossBudget = Schema.decodeUnknownSync(TradingLossBudget);
const decodeCloid = Schema.decodeUnknownSync(TradingCloid);

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

const strategy: TradingPlanState = {
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [{ description: "Retest of 3,718 holds", timeframe: "5m", priceLevel: 3_718.4 }],
    urgency: "now",
    initialNotionalUsd: 1_115,
    maximumIntendedNotionalUsd: 3_000,
  },
  stop: {
    method: "Below the last accepted swing low",
    price: 3_652,
    maximumPlannedLossUsd: 19.9,
  },
  target: { profitUsd: 25 },
  invalidation: ["Regime flips to mean-reverting"],
  reassess: { afterMinutes: 90 },
  because:
    "ETH has been climbing and just broke above a level it kept failing at, on 1.6x relative " +
    "volume in a trending regime. Long a small position; sell if it falls back below 3,652, " +
    "risking about $20 to make $25.",
  updatedAt: 1_753_000_000_000,
};

const mission: TradingMission = {
  id: "mission_1",
  userId: "user_1",
  tradingAccountId: "acct_1",
  instruction: "Trade ETH momentum",
  market: "ETH",
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
    expect(decoded.strategy?.intent).toBe("long");
    expect(decoded.authority.allowDirectionReversal).toBe(false);
  });

  it("rejects a mission status outside the §11.1 set", () => {
    expect(() => decodeMission({ ...mission, status: "liquidating" })).toThrow();
  });

  it("decodes a TradingPlanState", () => {
    const decoded = decodeStrategy(strategy);
    expect(decoded.entry.triggers[0]?.priceLevel).toBe(3_718.4);
    expect(decoded.stop.price).toBe(3_652);
    expect(decoded.target.profitUsd).toBe(25);
  });

  it("decodes a stand-aside plan as the no-position intent", () => {
    // Standing aside is an intent value now, not a code bolted onto a trade
    // plan: a declined entry is `stand_aside` with the reasoning in `because`.
    const standAside = decodeStrategy({
      ...strategy,
      intent: "stand_aside",
      entry: { ...strategy.entry, triggers: [], urgency: "now" },
      target: {},
    });
    expect(standAside.intent).toBe("stand_aside");
    expect(standAside.target.profitUsd).toBeUndefined();
  });

  it("defaults an omitted entry urgency to now and keeps a stated one", () => {
    const { urgency: _urgency, ...withoutUrgency } = strategy.entry;
    const omitted = decodeStrategy({ ...strategy, entry: withoutUrgency });
    expect(omitted.entry.urgency).toBe("now");

    const patient = decodeStrategy({
      ...strategy,
      entry: { ...strategy.entry, urgency: "patient" },
    });
    expect(patient.entry.urgency).toBe("patient");
  });

  it("drops an order preference named on the entry leg", () => {
    // The model never names a time-in-force (plan 29 step 4.1): `urgency` is
    // the only knob. A harness that still sends `orderPreference` (an old
    // habit) gets it silently ignored rather than echoed anywhere — it cannot
    // influence the execution path.
    const decoded = decodeStrategy({
      ...strategy,
      entry: { ...strategy.entry, orderPreference: "post_only" },
    });
    expect("orderPreference" in decoded.entry).toBe(false);
    expect(decoded.entry.urgency).toBe("now");
  });

  it("defaults a reassess window that omitted its minutes", () => {
    const decoded = decodeStrategy({ ...strategy, reassess: {} });
    expect(decoded.reassess.afterMinutes).toBe(90);
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
    const { updatedAt: _updatedAt, ...body } = strategy;
    const decoded = decodePublishInput({
      missionId: "mission_1",
      expectedMissionVersion: 0,
      strategy: body,
    });
    expect(decoded.expectedMissionVersion).toBe(0);
    expect("updatedAt" in decoded.strategy).toBe(false);
  });

  it("decodes both publish outcomes", () => {
    const decode = decodePublishResult;
    expect(
      decode({
        outcome: "accepted",
        strategy,
        warnings: [],
      }).outcome,
    ).toBe("accepted");
    expect(
      decode({ outcome: "rejected", reason: "stale_mission_state", currentVersion: 4 }).outcome,
    ).toBe("rejected");
  });

  it("decodes a trading_look result", () => {
    const decoded = decodeGetMissionResult({
      bound: true,
      mission,
      authority: mission.authority,
      authorityVersion: 1,
      strategy,
      missionVersion: 2,
      watches: [],
      control: mission.control,
      harness: mission.harness,
      pendingExecutions: [
        { cloid: "0xblocking", actionType: "open", status: "submitted", ageMillis: 45_000 },
      ],
      strategyHistory: [
        {
          version: 1,
          publishedAt: 1_000,
          intent: "long",
          targetProfitUsd: 12,
          because: "higher lows on the 1m",
        },
      ],
    });
    assert(decoded.bound);
    expect(decoded.watches).toEqual([]);
    // The lock a `no_conflicting_execution_pending` rejection names.
    expect(decoded.pendingExecutions[0]?.cloid).toBe("0xblocking");
    // What the mission believed before it believed the current thing.
    expect(decoded.strategyHistory[0]?.targetProfitUsd).toBe(12);
  });

  it("decodes the unbound answer a thread gets once its mission has ended", () => {
    const decoded = decodeGetMissionResult({
      bound: false,
      lastMission: { ...mission, status: "revoked" },
      activeMissionId: "mission_2",
    });
    assert(!decoded.bound);
    expect(decoded.lastMission?.status).toBe("revoked");
    expect(decoded.activeMissionId).toBe("mission_2");
  });

  it("decodes an unbound answer for a thread that never held a mission", () => {
    const decoded = decodeGetMissionResult({ bound: false });
    assert(!decoded.bound);
    expect(decoded.lastMission).toBeUndefined();
  });

  it("accepts an omitted missionId (the bound mission resolves it at the handler)", () => {
    // `missionId` is optional on every trading tool input: the calling thread
    // is bound to exactly one mission, so the argument is a check, not a route.
    const decoded = decodePublishInput({
      expectedMissionVersion: 1,
      strategy: (() => {
        const { updatedAt: _u, ...body } = strategy;
        return body;
      })(),
    });
    expect(decoded.missionId).toBeUndefined();
  });

  it("takes an entry in the harness's own vocabulary and refuses a hand-built intent", () => {
    // Market, side, stop — and urgency, never a time-in-force. Everything the
    // retired two-step made the harness carry between calls is the server's.
    const entered = decodeEnter({
      market: "ETH",
      side: "buy",
      stopPrice: 1_990,
      urgency: "patient",
    });
    expect(entered.stopPrice).toBe(1_990);
    expect(entered.urgency).toBe("patient");
    // Urgency defaults rather than being asked for twice.
    expect(decodeEnter({ market: "ETH", side: "buy", stopPrice: 1_990 }).urgency).toBe("now");
    // A size named two ways is a size the server would have to pick between.
    expect(() =>
      decodeEnter({ market: "ETH", side: "buy", stopPrice: 1_990, sizeEth: 1, notionalUsd: 2_000 }),
    ).toThrow();
    // The intent fields are not part of the input at all.
    expect("limitPrice" in decodeEnter({ market: "ETH", side: "buy", stopPrice: 1_990 })).toBe(
      false,
    );
  });

  it("decodes a prose-string condition into the object shape", () => {
    const decodeCondition = Schema.decodeUnknownSync(AgentConditionInput);
    // A bare prose string where the schema asked for `{ description }`.
    expect(decodeCondition("Exit if a 1m candle closes back above 1865.9.")).toEqual({
      description: "Exit if a 1m candle closes back above 1865.9.",
    });
    // The full object shape still passes through.
    expect(
      decodeCondition({ description: "Range high is lost on a 15m close.", timeframe: "15m" }),
    ).toEqual({
      description: "Range high is lost on a 15m close.",
      timeframe: "15m",
    });
    // Empty prose is rejected — a bare "   " is not a conclusion.
    expect(() => decodeCondition("   ")).toThrow();
  });

  it("round-trips a strategy whose entry triggers are bare prose strings", () => {
    // The authored/input form accepts prose strings; the persisted form is the
    // object shape. A strategy published with prose triggers decodes and
    // re-encodes as objects, so the near-miss detectors keep their hints.
    const { updatedAt: _u, ...body } = strategy;
    const decoded = decodePublishInput({
      missionId: "mission_1",
      expectedMissionVersion: 1,
      strategy: {
        ...body,
        entry: { ...body.entry, triggers: ["Enter on a finalized 1m close above 3760."] },
      },
    });
    expect(decoded.strategy.entry.triggers).toEqual([
      { description: "Enter on a finalized 1m close above 3760." },
    ]);
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

  it("decodes an AgentAccountSnapshot holding a market the mission cannot trade", () => {
    // The clearinghouse reports the whole wallet. When `market` was the "ETH"
    // literal, one BTC position made the snapshot undecodable — and since the
    // snapshot rides inside every wakeup payload, that killed the wake itself
    // rather than the one position nobody asked about.
    const decoded = decodeAgentAccountSnapshot({
      address: "0xabc",
      accountValue: 1_000,
      marginUsed: 250,
      withdrawable: 750,
      positions: [
        {
          market: "BTC",
          size: 0.01,
          entryPrice: 61_400,
          unrealisedPnl: -2.5,
          cumulativeFunding: 0,
          marginUsed: 250,
        },
      ],
      freshness: accountFreshness(1_753_000_000_000, "info_api"),
    });
    expect(decoded.positions[0]?.market).toBe("BTC");
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
      reduceOnly: false,
      isTrigger: false,
    });
    expect(decoded.orderId).toBe(90_542_681);
  });
});

describe("TradingOrderIntent", () => {
  const stop = { stopPrice: 3_700, plannedLossAtStopUsd: 18 };
  const intent = {
    missionId: "mission_1",
    executionSequence: 0,
    actionType: "open",
    market: "ETH",
    side: "buy",
    size: 0.5,
    orderPreference: "marketable_ioc",
    limitPrice: 3_750,
    stop,
    reduceOnly: false,
  } as const;

  it("decodes a valid position-increasing entry intent", () => {
    const decoded = decodeOrderIntent(intent);
    expect(decoded.side).toBe("buy");
    expect(decoded.stop?.stopPrice).toBe(3_700);
  });

  it("decodes a reduce-only exit that carries no stop", () => {
    // A close is the exit; it plans no new loss and needs no stop. The
    // mandatory-stop gate (§16.3 item 17) is what refuses a stopless
    // *increase* — see protection.test.ts.
    const decoded = decodeOrderIntent({
      ...intent,
      actionType: "close",
      side: "sell",
      stop: undefined,
      reduceOnly: true,
    });
    expect(decoded.stop).toBeUndefined();
  });

  it("rejects a non-positive size", () => {
    expect(() => decodeOrderIntent({ ...intent, size: 0 })).toThrow();
  });
});

describe("TradingCloid", () => {
  it("accepts a 0x-prefixed 32-char lowercase hex string", () => {
    expect(decodeCloid("0x0123456789abcdef0123456789abcdef")).toBe(
      "0x0123456789abcdef0123456789abcdef",
    );
  });

  it("rejects a bare cloid with no 0x prefix", () => {
    // The exchange validates `len(cloid[2:]) == 32` and silently stores a bare
    // cloid as null — accepted on submission, then unjoinable to its own fill.
    expect(() => decodeCloid("0123456789abcdef0123456789abcdef")).toThrow();
  });

  it("rejects a cloid of the wrong length", () => {
    expect(() => decodeCloid("0123456789abcdef")).toThrow();
  });
});

describe("TradingExecutionRecord", () => {
  const record = {
    executionId: "exec_1",
    missionId: "mission_1",
    executionSequence: 0,
    actionType: "open",
    cloid: "0x0123456789abcdef0123456789abcdef",
    idempotencyKey: "idem_1",
    market: "ETH",
    side: "buy",
    size: 0.5,
    limitPrice: 3_750,
    timeInForce: "ioc",
    reduceOnly: false,
    signerAddress: "0xabc",
    status: "previewed",
    orderResults: [],
    createdAt: 1_753_000_000_000,
    updatedAt: 1_753_000_000_000,
  } as const;

  it("decodes a previewed execution record before signing", () => {
    expect(decodeExecutionRecord(record).status).toBe("previewed");
  });

  it("rejects an unknown execution status", () => {
    expect(() => decodeExecutionRecord({ ...record, status: "pending" })).toThrow();
  });
});

describe("TradingFill", () => {
  const fill = {
    fillId: "fill_1",
    missionId: "mission_1",
    orderId: 90_542_681,
    market: "ETH",
    side: "buy",
    filledSize: 0.5,
    avgFillPrice: 3_748,
    feeUsd: 0.0187,
    feeToken: "USDC",
    closedPnl: 0,
    tradedAt: 1_753_000_000_000,
    observedAt: 1_753_000_000_000,
  } as const;

  it("decodes a reconciled fill", () => {
    expect(decodeFill(fill).filledSize).toBe(0.5);
  });

  it("rejects a non-positive filled size", () => {
    expect(() => decodeFill({ ...fill, filledSize: 0 })).toThrow();
  });
});

describe("TradingRiskReservation", () => {
  const reservation = {
    reservationId: "res_1",
    missionId: "mission_1",
    executionId: "exec_1",
    cloid: "0x0123456789abcdef0123456789abcdef",
    actionType: "open",
    reservedRiskUsd: 20,
    status: "reserved",
    reservedAt: 1_753_000_000_000,
  } as const;

  it("decodes a reserved pending-entry reservation", () => {
    expect(decodeReservation(reservation).status).toBe("reserved");
  });

  it("accepts a released reservation with a release timestamp", () => {
    expect(
      decodeReservation({ ...reservation, status: "released", releasedAt: 1_753_000_001_000 })
        .releasedAt,
    ).toBe(1_753_000_001_000);
  });
});

describe("TradingLossBudget", () => {
  const budget = {
    maximumCumulativeLossUsd: 100,
    closedPnlUsd: -12,
    netFundingUsd: -0.5,
    allPaidTradingFeesUsd: 1.2,
    realizedMissionResultUsd: -13.7,
    realizedLossUsedUsd: 13.7,
    openPositionRiskUsd: 18,
    pendingEntryRiskUsd: 20,
    lossBudgetUsedUsd: 51.7,
    remainingCumulativeLossUsd: 48.3,
    exhausted: false,
    observedAt: 1_753_000_000_000,
  } as const;

  it("decodes a non-exhausted budget", () => {
    expect(decodeLossBudget(budget).remainingCumulativeLossUsd).toBe(48.3);
  });

  it("accepts an exhausted budget at zero remaining", () => {
    expect(
      decodeLossBudget({ ...budget, remainingCumulativeLossUsd: 0, exhausted: true }).exhausted,
    ).toBe(true);
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
        "./execution",
        "./loss-accounting",
        "./protection",
        "./stop-adjustment",
        "./wakeup",
        "./volatility",
        "./observation",
        "./costs",
        "./market-structure",
        "./history",
        "./calibration",
        "./playbook",
        "./decision",
        "./entry",
        "./exit",
        "./recovery",
        "./policy",
        "./replay",
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

describe("the timeframe the runtime works a mission on", () => {
  it("reads the interval a mandate names, longest token first", () => {
    // "15m" must never be read as the "5m" inside it.
    expect(mandatedTimeframe("scalp ETH on the 15m")).toBe("15m");
    expect(mandatedTimeframe("trade the 5m, confirm on 15m")).toBe("5m");
    expect(mandatedTimeframe("trade BTC with momentum entries")).toBeUndefined();
  });

  it("falls back to 1m rather than to whatever the plan published", () => {
    // The 2026-08-14 failure: plans published `timeframes: ["15m"]` and the
    // runtime followed them, so a flat mission was re-woken every 30 minutes
    // on 15m bars and never saw the 1m structure it was trading.
    expect(runtimeTimeframe("trade BTC, momentum only")).toBe("1m");
    expect(runtimeTimeframe("work the 1h")).toBe("1h");
  });
});
