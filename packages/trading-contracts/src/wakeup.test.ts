import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { pocAuthorityDefaults } from "./authority.ts";
import { TradingHarnessWakeup, describeArmedWatch } from "./wakeup.ts";
import type { PersistedWatch } from "./watch.ts";

const persist = (watch: PersistedWatch["watch"], armedReason?: "staleness_floor"): PersistedWatch =>
  ({
    id: "watch_1",
    missionId: "mission_1",
    strategyVersion: 1,
    watch,
    status: "active",
    ...(armedReason === undefined ? {} : { armedReason }),
    createdAt: 1_000,
    updatedAt: 1_000,
  }) as PersistedWatch;

describe("describeArmedWatch", () => {
  it("measures an upside cross as the distance still to travel up", () => {
    const described = describeArmedWatch(
      persist({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 4_040,
      }),
      4_000,
    );
    expect(described.distanceUsd).toBe(40);
    expect(described.distanceBps).toBeCloseTo(100, 6);
  });

  it("measures a downside cross as the distance still to travel down", () => {
    const described = describeArmedWatch(
      persist({
        type: "candle_close",
        market: "ETH",
        interval: "1m",
        direction: "below",
        price: 3_960,
      }),
      4_000,
    );
    expect(described.distanceUsd).toBe(40);
    expect(described.distanceBps).toBeCloseTo(100, 6);
  });

  it("reports a level the market has already passed as a negative distance", () => {
    const described = describeArmedWatch(
      persist({
        type: "price_cross",
        market: "ETH",
        priceSource: "mid",
        direction: "above",
        price: 3_900,
      }),
      4_000,
    );
    expect(described.distanceUsd).toBe(-100);
  });

  it("leaves the level-free watch types without a distance", () => {
    const described = describeArmedWatch(
      persist({ type: "position_update", market: "ETH" }),
      4_000,
    );
    expect(described.distanceUsd).toBeUndefined();
    expect(described.distanceBps).toBeUndefined();
  });
});

describe("TradingHarnessWakeup", () => {
  const decode = Schema.decodeUnknownSync(TradingHarnessWakeup);

  const strategy = {
    version: 3,
    name: "ETH 1m trend continuation",
    market: "ETH",
    mode: "breakout_continuation",
    direction: "long",
    timeframes: ["1m"],
    belief: {
      summary: "Higher lows on the 1m.",
      regime: "trending",
      confidence: 0.6,
      evidence: ["1m close 4000"],
    },
    entryPlan: {
      explanation: "Enter on a reclaim.",
      initialNotionalUsd: 200,
      maximumIntendedNotionalUsd: 400,
      orderPreference: "marketable_ioc",
      conditions: [{ description: "reclaim of the prior high" }],
    },
    positionManagement: {
      scaleInAllowed: false,
      scaleInConditions: [],
      partialReductionAllowed: true,
    },
    protection: { stopMethod: "under the last swing low", stopPrice: 3_900 },
    exitConditions: [{ description: "a close under 3900" }],
    abandonmentConditions: [],
    reentryConditions: [],
    currentAction: "holding",
    explanation: "Long the 1m reclaim.",
    updatedAt: 1_000_000,
  };

  const base = {
    kind: "trading-harness-wakeup",
    missionId: "mission_1",
    harnessRunId: "run_1",
    cause: "scheduled_reassessment",
    occurredAt: 1_600_000,
    wakeReason: "staleness_floor",
    marketSnapshot: {
      market: "ETH",
      markPrice: 4_000,
      midPrice: 4_000,
      oraclePrice: 4_000,
      fundingRate8h: 0.0001,
      openInterest: 10,
      dayVolumeUsd: 1_000,
      bestBidOffer: {
        bidPrice: 3_999,
        bidSize: 1,
        askPrice: 4_001,
        askSize: 1,
        freshness: { observedAt: 1_600_000, source: "websocket", staleAfterMillis: 2_000 },
      },
      freshness: { observedAt: 1_600_000, source: "websocket", staleAfterMillis: 5_000 },
      change24hPercent: 1.2,
    },
    accountSnapshot: {
      address: "0x00000000000000000000000000000000000000ff",
      accountValue: 1_000,
      marginUsed: 0,
      withdrawable: 1_000,
      positions: [],
      observedAt: 1_600_000,
      freshness: { observedAt: 1_600_000, source: "info_api", staleAfterMillis: 5_000 },
    },
    activeStrategy: strategy,
    strategyAgeMillis: 600_000,
    armedWatches: [
      {
        watch: persist({ type: "scheduled_reassessment", runAt: 1_700_000 }, "staleness_floor"),
      },
    ],
    authority: pocAuthorityDefaults(1_000),
    pendingEvents: [],
    instruction: "trade the 1m",
    defaultTimeframe: "1m",
  };

  it("round-trips the enriched snapshot", () => {
    const decoded = decode(base);
    expect(decoded.strategyAgeMillis).toBe(600_000);
    expect(decoded.wakeReason).toBe("staleness_floor");
    expect(decoded.armedWatches).toHaveLength(1);
    expect(decoded.armedWatches[0]?.watch.armedReason).toBe("staleness_floor");
    expect(decoded.kind).toBe("trading-harness-wakeup");
  });

  it("requires the new fields rather than treating them as optional", () => {
    const { strategyAgeMillis: _age, ...withoutAge } = base;
    expect(() => decode(withoutAge)).toThrow();
    const { armedWatches: _armed, ...withoutArmed } = base;
    expect(() => decode(withoutArmed)).toThrow();
  });

  // The discriminator is what lets the chat timeline tell a wakeup from
  // something the operator typed. A wakeup without it would render as raw JSON,
  // which is the thing it exists to stop.
  it("refuses a payload that does not declare itself a wakeup", () => {
    const { kind: _kind, ...withoutKind } = base;
    expect(() => decode(withoutKind)).toThrow();
    expect(() => decode({ ...base, kind: "something-else" })).toThrow();
  });
});
