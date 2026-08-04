/**
 * What a woken run is told, beyond the fact that it was woken.
 *
 * The snapshot used to carry the triggering watch and nothing about the rest of
 * the mission's armed state, so a resumed run had to call `trading_list_watches`
 * and do the distance arithmetic itself before it could tell a near miss from a
 * level it armed an hour ago. These tests pin the three additions that closed
 * that: the armed-watch list with distances, the thesis's age, and the reason
 * the runtime woke it when the runtime is the one that armed the wake.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

import { pocAuthorityDefaults } from "@t3tools/trading-contracts/authority";
import { VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";

import type { MomentumStrategyState, PersistedWatch, TradingMission } from "./Schemas.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWakeupComposer, TradingWakeupComposerLive } from "./TradingWakeupComposer.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

const MARK = 4_000;
const NOW = 2_000_000;

const strategy = {
  version: 3,
  name: "ETH 1m trend continuation",
  market: "ETH",
  mode: "breakout_continuation",
  direction: "long",
  timeframes: ["1m"],
  belief: { summary: "higher lows", regime: "trending", confidence: 0.6, evidence: ["1m close"] },
  entryPlan: {
    explanation: "enter on a reclaim",
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
  explanation: "long the reclaim",
  updatedAt: NOW - 900_000,
} as unknown as MomentumStrategyState;

const mission = {
  id: "mission_1",
  userId: "user_1",
  tradingAccountId: "acct_1",
  instruction: "trade the 1m",
  market: "ETH",
  strategyFamily: "momentum",
  status: "position_open",
  strategyVersion: 3,
  authorityVersion: 1,
  authority: pocAuthorityDefaults(1_000),
  control: {},
  harness: { threadId: "thread_1" },
  createdAt: 0,
  updatedAt: 0,
} as unknown as TradingMission;

const watch = (id: string, body: PersistedWatch["watch"], overrides?: Partial<PersistedWatch>) =>
  ({
    id,
    missionId: "mission_1",
    strategyVersion: 3,
    watch: body,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as PersistedWatch;

/** The floor's own reassessment: the wake it produces has to name itself. */
const flooredWatch = watch(
  "watch_floor",
  { type: "scheduled_reassessment", runAt: NOW + 60_000 },
  { armedReason: "staleness_floor" },
);

const armed: ReadonlyArray<PersistedWatch> = [
  watch("watch_up", {
    type: "price_cross",
    market: "ETH",
    priceSource: "mark",
    direction: "above",
    price: 4_040,
  }),
  watch(
    "watch_stale",
    { type: "price_cross", market: "ETH", priceSource: "mark", direction: "below", price: 3_960 },
    { status: "triggered" },
  ),
  flooredWatch,
];

const freshness = { observedAt: NOW, source: "websocket", staleAfterMillis: 2_000 };

const stubGateway = Layer.succeed(HyperliquidGateway)({
  getMarketSnapshot: () =>
    Effect.succeed({
      market: "ETH",
      markPrice: MARK,
      midPrice: MARK,
      oraclePrice: MARK,
      fundingRate8h: 0.0001,
      openInterest: 10,
      dayVolumeUsd: 1_000,
      bestBidOffer: { bidPrice: 3_999, bidSize: 1, askPrice: 4_001, askSize: 1, freshness },
      freshness,
      change24hPercent: 1.2,
    } as never),
  getAccountSnapshot: () =>
    Effect.succeed({
      address: "0x00000000000000000000000000000000000000ff",
      accountValue: 1_000,
      marginUsed: 0,
      withdrawable: 1_000,
      positions: [],
      freshness,
    } as never),
  getPosition: () =>
    Effect.succeed({
      market: "ETH",
      size: 0,
      unrealisedPnl: 0,
      cumulativeFunding: 0,
      marginUsed: 0,
      freshness,
    } as never),
  getMarketHistory: (request: { market: string; interval: string; maxBars?: number }) =>
    Effect.succeed({
      market: request.market,
      interval: request.interval,
      // Echo the cap the composer asked for, as a window that actually moves:
      // a flat series would let a broken volatility measurement pass.
      candles: Array.from({ length: request.maxBars ?? 0 }, (_, i) => ({
        openTime: i,
        closeTime: i,
        open: MARK,
        close: i % 2 === 0 ? MARK + 5 : MARK - 5,
        high: MARK + 5,
        low: MARK - 5,
        volume: 1,
      })),
      freshness,
    } as never),
} as unknown as HyperliquidGateway["Service"]);

const stubMissions = Layer.succeed(TradingMissionService)({
  getMasterWalletAddress: () => Effect.succeed("0x00000000000000000000000000000000000000ff"),
} as unknown as TradingMissionService["Service"]);

const stubWatches = Layer.succeed(TradingWatchService)({
  getWatch: (id: string) => Effect.succeed(armed.find((w) => w.id === id) ?? null),
} as unknown as TradingWatchService["Service"]);

const stubStrategies = Layer.succeed(TradingStrategyService)({
  listWatches: () => Effect.succeed(armed),
} as unknown as TradingStrategyService["Service"]);

const layer = it.layer(
  TradingWakeupComposerLive.pipe(
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(stubMissions),
    Layer.provideMerge(stubWatches),
    Layer.provideMerge(stubStrategies),
  ),
);

const compose = (triggeringWatchId?: string) =>
  Effect.gen(function* () {
    const composer = yield* TradingWakeupComposer;
    const { wakeup } = yield* composer.compose({
      mission,
      harnessRunId: "run_1",
      cause: "scheduled_reassessment",
      occurredAt: NOW,
      ...(triggeringWatchId === undefined ? {} : { triggeringWatchId }),
      pendingEvents: [],
      activeStrategy: strategy,
    });
    return wakeup;
  });

layer("TradingWakeupComposer", (it) => {
  it.effect("publishes the active watches with their distance from the mark", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();

      // The triggered one is not armed and does not belong in the list.
      assert.deepEqual(
        wakeup.armedWatches.map((w) => w.watch.id),
        ["watch_up", "watch_floor"],
      );
      const level = wakeup.armedWatches[0];
      assert.equal(level?.distanceUsd, 40);
      assert.closeTo(level?.distanceBps ?? 0, 100, 1e-6);
      // A reassessment carries no level, so it carries no distance.
      assert.equal(wakeup.armedWatches[1]?.distanceUsd, undefined);
    }),
  );

  it.effect("publishes how old the thesis is", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();
      assert.equal(wakeup.strategyAgeMillis, 900_000);
    }),
  );

  it.effect("names the staleness floor when the floor is what woke the run", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose("watch_floor");
      assert.equal(wakeup.wakeReason, "staleness_floor");
      assert.equal(wakeup.triggeringWatch?.id, "watch_floor");
    }),
  );

  it.effect("leaves the wake reason off for a watch the harness armed itself", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose("watch_up");
      assert.equal(wakeup.wakeReason, undefined);
    }),
  );

  it.effect("carries the net position and a bounded 20-bar slice of the primary timeframe", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();
      // Flat is a real position, not a missing one.
      assert.equal(wakeup.position.size, 0);
      // The primary timeframe is strategy.timeframes[0] ("1m"); the slice is capped at 20.
      assert.equal(wakeup.recentCandles.interval, "1m");
      assert.equal(wakeup.recentCandles.candles.length, 20);
    }),
  );

  it.effect("measures the volatility a profit target has to be derived from", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();
      const measured = wakeup.observedVolatility;

      // Measured over the full read, not the 20 bars the wakeup shows.
      assert.equal(measured.barsObserved, VOLATILITY_LOOKBACK_BARS);
      assert.equal(measured.interval, "1m");
      assert.equal(measured.sufficientData, true);
      // Every bar spans MARK ± 5, so the true range is 10 on each of them.
      assert.closeTo(measured.atrUsd, 10, 1e-6);
      assert.ok(measured.horizons.length > 0);
    }),
  );
});
