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
    protection: { stopMethod: "under the last swing low", stopPrice: 3_900, targetProfitUsd: 15 },
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
    position: {
      market: "ETH",
      size: 0,
      unrealisedPnl: 0,
      cumulativeFunding: 0,
      marginUsed: 0,
      freshness: { observedAt: 1_600_000, source: "info_api", staleAfterMillis: 5_000 },
    },
    recentCandles: {
      market: "ETH",
      interval: "1m",
      candles: [
        {
          openTime: 1_599_940_000,
          closeTime: 1_600_000_000,
          open: 3_990,
          close: 4_000,
          high: 4_005,
          low: 3_985,
          volume: 12,
        },
      ],
      freshness: { observedAt: 1_600_000, source: "websocket", staleAfterMillis: 5_000 },
    },
    observedVolatility: {
      market: "ETH",
      interval: "1m",
      barsObserved: 120,
      referencePrice: 4_000,
      measuredAt: 1_600_000,
      sufficientData: true,
      atrPeriod: 14,
      atrUsd: 4,
      atrPercent: 0.1,
      realizedVolatilityPercentPerBar: 0.05,
      swingRangeUsd: 60,
      swingRangePercent: 1.5,
      swingHighUsd: 4_030,
      swingLowUsd: 3_970,
      positionInRangePercent: 50,
      excursionSymmetryRatio: 1,
      horizons: [
        {
          holdBars: 10,
          holdMinutes: 10,
          samples: 110,
          favourableUpUsd: { p25: 6, p50: 12, p75: 20 },
          favourableDownUsd: { p25: 5, p50: 11, p75: 19 },
        },
      ],
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

  it("carries the net position and the bounded recent-candle slice", () => {
    const decoded = decode(base);
    // Flat is a valid position state, not an absence of position.
    expect(decoded.position.size).toBe(0);
    expect(decoded.recentCandles.market).toBe("ETH");
    expect(decoded.recentCandles.interval).toBe("1m");
    expect(decoded.recentCandles.candles).toHaveLength(1);
    expect(decoded.recentCandles.candles[0]?.close).toBe(4_000);
  });

  it("requires the new fields rather than treating them as optional", () => {
    const { strategyAgeMillis: _age, ...withoutAge } = base;
    expect(() => decode(withoutAge)).toThrow();
    const { armedWatches: _armed, ...withoutArmed } = base;
    expect(() => decode(withoutArmed)).toThrow();
    const { position: _position, ...withoutPosition } = base;
    expect(() => decode(withoutPosition)).toThrow();
    const { recentCandles: _candles, ...withoutCandles } = base;
    expect(() => decode(withoutCandles)).toThrow();
    // A wakeup without the measurement cannot support a derived profit target,
    // which is the one thing the strategy publish will insist on.
    const { observedVolatility: _volatility, ...withoutVolatility } = base;
    expect(() => decode(withoutVolatility)).toThrow();
  });

  // The discriminator is what lets the chat timeline tell a wakeup from
  // something the operator typed. A wakeup without it would render as raw JSON,
  // which is the thing it exists to stop.
  it("refuses a payload that does not declare itself a wakeup", () => {
    const { kind: _kind, ...withoutKind } = base;
    expect(() => decode(withoutKind)).toThrow();
    expect(() => decode({ ...base, kind: "something-else" })).toThrow();
  });

  // The authority, instruction, and default timeframe are now optional: the
  // composer no longer embeds them on every wake. A payload that omits all
  // three must still decode, since the rendered text points the run at
  // `trading_get_mission` for them instead.
  it("decodes a payload that omits the now-optional mandate fields", () => {
    const { authority: _a, instruction: _i, defaultTimeframe: _d, ...slim } = base;
    const decoded = decode(slim);
    expect(decoded.authority).toBeUndefined();
    expect(decoded.instruction).toBeUndefined();
    expect(decoded.defaultTimeframe).toBeUndefined();
    // The decision-relevant snapshot is still intact.
    expect(decoded.missionId).toBe("mission_1");
    expect(decoded.observedVolatility.atrUsd).toBe(4);
  });

  // The wakeup renders into the resumed turn's context budget. This mirrors the
  // composer's compact renderer (rounded floats, sectioned key/value lines) to
  // assert the fixture's rendered length stays well under the ceiling — a guard
  // against a future field that bloats the payload past the budget.
  const roundFloat = (value: number): number =>
    !Number.isFinite(value) || Number.isInteger(value) ? value : Number(value.toPrecision(4));

  const roundFloats = (value: unknown): unknown => {
    if (typeof value === "number") return roundFloat(value);
    if (Array.isArray(value)) return value.map(roundFloats);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = roundFloats(v);
      return out;
    }
    return value;
  };

  const SKIP_KEYS = new Set([
    "freshness",
    "staleAfterMillis",
    "source",
    "feeRateSource",
    "observedAt",
  ]);

  // Mirrors the composer's compact renderer: flat records (only primitive
  // values) fold onto one line, so the cost estimate and strategy belief do not
  // dominate the payload. Kept in sync with `renderWakeup` in
  // TradingWakeupComposer so this length assertion reflects the real output.
  const isFlatRecord = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([k, v]) => !SKIP_KEYS.has(k) && (v === null || v === undefined || typeof v !== "object"),
    );

  const renderFlat = (value: Record<string, unknown>): string =>
    Object.entries(value)
      .filter(([k, v]) => !SKIP_KEYS.has(k) && v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");

  const renderCompact = (value: unknown, indent: number): string[] => {
    const pad = "  ".repeat(indent);
    if (value === null || value === undefined) return [];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [`${pad}${String(value)}`];
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return [`${pad}-`];
      const isLeaf = value.every((v) => v === null || typeof v !== "object");
      if (isLeaf) return [`${pad}${value.map(String).join(" ")}`];
      const lines: string[] = [];
      value.forEach((entry, index) => {
        if (isFlatRecord(entry)) {
          lines.push(`${pad}[${index}] ${renderFlat(entry as Record<string, unknown>)}`);
        } else {
          lines.push(`${pad}[${index}]`);
          lines.push(...renderCompact(entry, indent + 1));
        }
      });
      return lines;
    }
    if (typeof value === "object") {
      if (isFlatRecord(value)) return [`${pad}${renderFlat(value as Record<string, unknown>)}`];
      const lines: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SKIP_KEYS.has(k) || v === null || v === undefined) continue;
        if (typeof v === "object") {
          lines.push(`${pad}${k}:`);
          lines.push(...renderCompact(v, indent + 1));
        } else {
          lines.push(`${pad}${k}=${String(v)}`);
        }
      }
      return lines;
    }
    return [];
  };

  const MAX_WAKEUP_CHARS = 5_000;

  it("renders the fixture under MAX_WAKEUP_CHARS", () => {
    const decoded = decode(base);
    const rounded = roundFloats(decoded);
    const lines = ["trading-harness-wakeup"];
    for (const [key, value] of Object.entries(rounded as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      lines.push(`${key}:`);
      lines.push(...renderCompact(value, 1));
    }
    lines.push("mandate-and-authority: call trading_get_mission");
    const text = lines.join("\n");
    expect(text.length).toBeLessThan(MAX_WAKEUP_CHARS);
    // The rendered text still names the wakeup and the mission it is for.
    expect(text).toContain("missionId");
    expect(text).toContain("trading-harness-wakeup");
  });
});
