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

import { estimateTradingCosts } from "@t3tools/trading-contracts/costs";

import type { TradingPlanState, PersistedWatch, TradingMission } from "./Schemas.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
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
} as unknown as TradingPlanState;

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

/** The size the exchange reports as held. Mutated by the enrichment tests. */
let positionSize = 0;

/** Intervals the composer asked for candles on, in call order. */
let requestedIntervals: Array<string> = [];

/** The size the cost estimator was asked to price, or null when it was not called. */
let costedSize: number | null = null;

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
      size: positionSize,
      unrealisedPnl: 0,
      cumulativeFunding: 0,
      marginUsed: 0,
      freshness,
    } as never),
  getMarketHistory: (request: { market: string; interval: string; maxBars?: number }) =>
    Effect.sync(() => {
      requestedIntervals.push(request.interval);
      return {
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
      } as never;
    }),
} as unknown as HyperliquidGateway["Service"]);

/**
 * A cost estimate that only has to be recognisable. The arithmetic is proven in
 * `costs.test.ts`; what these tests pin is that the composer prices the size it
 * actually holds, and does not price anything while flat.
 */
const stubCosts = Layer.succeed(TradingCostEstimator)({
  estimate: (input: { readonly sizeEth?: number | undefined }) =>
    Effect.sync(() => {
      costedSize = input.sizeEth ?? null;
      // The real arithmetic on a one-level book: the wakeup is encoded through
      // the contract schema, so a partial estimate would not survive the trip.
      return estimateTradingCosts({
        market: "ETH",
        sizeEth: input.sizeEth ?? 0,
        referencePrice: MARK,
        takerFeeBpsPerSide: 5,
        feeRateSource: "hyperliquid_user_fees",
        bids: [{ price: 3_999, size: 100 }],
        asks: [{ price: 4_001, size: 100 }],
        measuredAt: NOW,
        freshness: freshness as never,
      });
    }),
} as unknown as TradingCostEstimator["Service"]);

const stubMissions = Layer.succeed(TradingMissionService)({
  getMasterWalletAddress: () => Effect.succeed("0x00000000000000000000000000000000000000ff"),
  // No high-water mark recorded: the composer publishes the exchange's position
  // untouched. The enriched case has its own test below.
  readPeakUnrealisedPnl: () => Effect.succeed(null),
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
    Layer.provideMerge(stubCosts),
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
  it.effect("pairs the primary timeframe with the one above it", () =>
    Effect.gen(function* () {
      requestedIntervals = [];
      const wakeup = yield* compose();

      // A 1m mission gets 15m as its second read — the pair a target needs,
      // without the harness having to remember to ask for it.
      assert.deepEqual([...requestedIntervals].sort(), ["15m", "1m"]);
      assert.equal(wakeup.higherTimeframeVolatility?.interval, "15m");
      assert.equal(wakeup.higherTimeframeVolatility?.barsObserved, VOLATILITY_LOOKBACK_BARS);
    }),
  );

  it.effect("prices no round trip while the mission is flat", () =>
    Effect.gen(function* () {
      positionSize = 0;
      costedSize = null;
      const wakeup = yield* compose();

      assert.equal(wakeup.positionCosts, undefined);
      // Not merely absent from the wakeup — never asked for. There is no size to
      // cost, and `trading_estimate_costs` owns the hypothetical.
      assert.equal(costedSize, null);
    }),
  );

  it.effect("prices the round trip on the size actually held", () =>
    Effect.gen(function* () {
      positionSize = -1.25;
      costedSize = null;
      const wakeup = yield* compose();
      positionSize = 0;

      // Two taker fills at 5 bps on 1.25 x 4,000 of notional, plus the spread
      // crossed twice: 5.00 + 2.50.
      assert.closeTo(wakeup.positionCosts?.roundTripUsd ?? 0, 7.5, 1e-9);
      // A short is costed at its absolute size: the round trip does not care
      // which way round the two fills go.
      assert.equal(costedSize, 1.25);
    }),
  );
});
