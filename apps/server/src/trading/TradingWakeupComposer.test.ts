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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

import { pocAuthorityDefaults } from "@t3tools/trading-contracts/authority";
import { VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";

import { estimateTradingCosts } from "@t3tools/trading-contracts/costs";

import type { TradingPlanState, PersistedWatch, TradingMission } from "./Schemas.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import {
  MAX_WAKEUP_CHARS,
  TradingWakeupComposer,
  TradingWakeupComposerLive,
} from "./TradingWakeupComposer.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

const MARK = 4_000;
const NOW = 2_000_000;

const strategy = {
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [{ description: "reclaim of the prior high" }],
    urgency: "now",
    initialNotionalUsd: 200,
    maximumIntendedNotionalUsd: 400,
  },
  stop: { method: "under the last swing low", price: 3_900 },
  target: { profitUsd: 15 },
  invalidation: ["a close under 3900"],
  reassess: { afterMinutes: 90 },
  because: "long the reclaim: higher lows on the 1m in a trending regime",
  updatedAt: NOW - 900_000,
} as unknown as TradingPlanState;

const mission = {
  id: "mission_1",
  userId: "user_1",
  tradingAccountId: "acct_1",
  instruction: "trade the 1m",
  market: "ETH",
  status: "position_open",
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

/** The notional the cost estimator was asked to price, or null for a size-based call. */
let costedNotional: number | null = null;

/**
 * How the stub book behaves this test: served, or a read that blows up.
 *
 * "blows up" is deliberately a synchronous throw rather than a typed failure —
 * that is the shape a broken gateway actually takes, and the shape a plain
 * error-channel recovery would NOT have caught.
 */
let bookBehaviour: "served" | "throws" = "served";

const stubGateway = Layer.succeed(HyperliquidGateway)({
  getOrderBook: () => {
    if (bookBehaviour === "throws") throw new Error("l2Book unreachable");
    return Effect.succeed({
      market: "ETH",
      // Three to one on the bid, at one price, so the imbalance is 0.5 exactly.
      bids: [{ price: MARK, size: 3 }],
      asks: [{ price: MARK, size: 1 }],
      bestBidOffer: { bidPrice: MARK, bidSize: 3, askPrice: MARK, askSize: 1, freshness },
      freshness,
    } as never);
  },
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
 * actually holds, and prices the reference notional while flat.
 */
const stubCosts = Layer.succeed(TradingCostEstimator)({
  estimate: (input: {
    readonly sizeEth?: number | undefined;
    readonly notionalUsd?: number | undefined;
  }) =>
    Effect.sync(() => {
      costedSize = input.sizeEth ?? null;
      costedNotional = input.notionalUsd ?? null;
      // The real arithmetic on a one-level book: the wakeup is encoded through
      // the contract schema, so a partial estimate would not survive the trip.
      return estimateTradingCosts({
        market: "ETH",
        sizeEth: input.sizeEth ?? (input.notionalUsd === undefined ? 0 : input.notionalUsd / MARK),
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
  listWatchesForRead: () => Effect.succeed(armed),
} as unknown as TradingStrategyService["Service"]);

const layer = it.layer(
  TradingWakeupComposerLive.pipe(
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(stubCosts),
    Layer.provideMerge(stubMissions),
    Layer.provideMerge(stubWatches),
    Layer.provideMerge(stubStrategies),
    // The level-history and prior-read echoes read local tables; an empty
    // in-memory database exercises the absent-fields path.
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const composeFull = (input?: {
  readonly triggeringWatchId?: string;
  readonly activeStrategy?: TradingPlanState;
  /** Pass `true` to compose the wakeup of a mission with no plan at all. */
  readonly planless?: boolean;
  readonly instruction?: string;
}) =>
  Effect.gen(function* () {
    const composer = yield* TradingWakeupComposer;
    return yield* composer.compose({
      mission:
        input?.instruction === undefined ? mission : { ...mission, instruction: input.instruction },
      harnessRunId: "run_1",
      cause: "scheduled_reassessment",
      occurredAt: NOW,
      ...(input?.triggeringWatchId === undefined
        ? {}
        : { triggeringWatchId: input.triggeringWatchId }),
      pendingEvents: [],
      ...(input?.planless === true ? {} : { activeStrategy: input?.activeStrategy ?? strategy }),
    });
  });

const compose = (triggeringWatchId?: string) =>
  composeFull(triggeringWatchId === undefined ? {} : { triggeringWatchId }).pipe(
    Effect.map((composed) => composed.wakeup),
  );

layer("TradingWakeupComposer", (it) => {
  // An alert wake is the alert, not the market: the fired watch, the position,
  // the review line, and a pointer at trading_look. Injecting the full
  // snapshot on every firing is how a mission's context filled after a
  // handful of wakes.
  it.effect("renders a watch-fire wake lean, pointing at trading_look for the rest", () =>
    Effect.gen(function* () {
      const composer = yield* TradingWakeupComposer;
      const composed = yield* composer.compose({
        mission,
        harnessRunId: "run_1",
        cause: "market_watch_triggered",
        occurredAt: NOW,
        triggeringWatchId: "watch_up",
        pendingEvents: [],
        activeStrategy: strategy,
      });
      // What fired, and where to get everything else.
      assert.include(composed.text, "triggeringWatch");
      assert.include(composed.text, "call trading_look");
      assert.include(composed.text, "alert wake");
      // What is deliberately NOT attached.
      assert.notInclude(composed.text, "recentCandles");
      assert.notInclude(composed.text, "observedVolatility");
      assert.notInclude(composed.text, "microstructure");
      // The structured wakeup is still the full one — only the text is lean.
      assert.equal(composed.wakeup.recentCandles.candles.length, 5);
      // And it is genuinely small.
      assert.isBelow(composed.text.length, 2_000);
    }),
  );

  it.effect("keeps the full snapshot on a scheduled reassessment", () =>
    Effect.gen(function* () {
      const composed = yield* composeFull({});
      assert.include(composed.text, "recentCandles");
      assert.include(composed.text, "observedVolatility");
    }),
  );

  // The projection is the one thing the model must never be without — a plan
  // that lacks one is told so on every wake until it republishes.
  it.effect("nags for a projection when the plan has none, and only then", () =>
    Effect.gen(function* () {
      // The fixture plan carries no projection: every wake says so.
      const bare = yield* compose();
      assert.include(bare.strategyReview ?? "", "NO PROJECTION ON FILE");

      // The same plan with one on file wakes without the nag.
      const projected = yield* composeFull({
        activeStrategy: { ...strategy, projection: { price: MARK + 12, byMinutes: 15 } },
      }).pipe(Effect.map((composed) => composed.wakeup));
      assert.notInclude(projected.strategyReview ?? "", "NO PROJECTION ON FILE");
    }),
  );

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

  it.effect("carries the net position and a bounded 8-bar slice of the primary timeframe", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();
      // Flat is a real position, not a missing one.
      assert.equal(wakeup.position.size, 0);
      // The primary timeframe is strategy.timeframes[0] ("1m"); the slice is capped at 8.
      assert.equal(wakeup.recentCandles.interval, "1m");
      assert.equal(wakeup.recentCandles.candles.length, 5);
    }),
  );

  it.effect("measures the volatility a profit target has to be derived from", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();
      const measured = wakeup.observedVolatility;

      // Measured over the full read, not the 8 bars the wakeup shows.
      assert.equal(measured.barsObserved, VOLATILITY_LOOKBACK_BARS);
      assert.equal(measured.interval, "1m");
      assert.equal(measured.sufficientData, true);
      // Every bar spans MARK ± 5, so the true range is 10 on each of them.
      assert.closeTo(measured.atrUsd, 10, 1e-6);
      // Two horizons only: the wakeup trims the default six-point distribution
      // to the near/far pair a target check needs.
      assert.equal(measured.horizons.length, 2);
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
      // The higher timeframe is trimmed to the same two horizons as the primary.
      assert.equal(wakeup.higherTimeframeVolatility?.horizons.length, 2);
    }),
  );

  it.effect("re-opens the whole field on a flat wake, and only on a flat wake", () =>
    Effect.gen(function* () {
      positionSize = 0;
      const flat = yield* compose();
      assert.include(flat.strategyReview ?? "", "range_reversion");

      // Holding, the incumbent has seniority: a switch costs a round trip.
      positionSize = -1.25;
      const holding = yield* compose();
      positionSize = 0;
      assert.isUndefined(holding.strategyReview);
    }),
  );

  // Plan 29 step 4.6: an untriggered plan goes stale on its own. Past
  // `reassess.afterMinutes` since `updatedAt`, the review says so ahead of
  // anything else, flat or holding.
  it.effect("marks an expired plan stale in the review", () =>
    Effect.gen(function* () {
      positionSize = 0;
      // A 5 min window, published ~6.7 min before the wake.
      const stale = {
        ...strategy,
        reassess: { afterMinutes: 5 },
        updatedAt: NOW - 400_000,
      } as TradingPlanState;
      const { wakeup } = yield* composeFull({ activeStrategy: stale });

      assert.include(wakeup.strategyReview ?? "", "has gone stale");
      assert.include(wakeup.strategyReview ?? "", "reassess");
    }),
  );

  it.effect("does not mark a fresh plan stale", () =>
    Effect.gen(function* () {
      positionSize = 0;
      const wakeup = yield* compose();
      assert.notInclude(wakeup.strategyReview ?? "", "gone stale");
    }),
  );

  it.effect("marks a stale plan on a holding wake too", () =>
    Effect.gen(function* () {
      positionSize = -1.25;
      const stale = {
        ...strategy,
        reassess: { afterMinutes: 5 },
        updatedAt: NOW - 400_000,
      } as TradingPlanState;
      const { wakeup } = yield* composeFull({ activeStrategy: stale });
      positionSize = 0;

      assert.include(wakeup.positionReview ?? "", "has gone stale");
    }),
  );

  // Plan 29 step 4.3: a plan-less mission wakes on the same market snapshot,
  // with a decision prompt where the plan echo would be. No field that a plan
  // would carry becomes required; the budget discipline is unchanged.
  it.effect("composes a coherent plan-less wakeup", () =>
    Effect.gen(function* () {
      positionSize = 0;
      const { wakeup, text } = yield* composeFull({ planless: true });
      positionSize = 0;

      assert.isUndefined(wakeup.activeStrategy);
      assert.isUndefined(wakeup.strategyAgeMillis);
      assert.isUndefined(wakeup.unarmedEntryConditions);
      assert.isUndefined(wakeup.misarmedEntryConditions);
      // The snapshot half is all still there.
      assert.equal(wakeup.marketSnapshot.market, "ETH");
      assert.isArray(wakeup.armedWatches);
      assert.isArray(wakeup.recentCandles.candles);
      // The decision prompt says the mission has no plan and what to do.
      assert.include(wakeup.strategyReview ?? "", "NO PLAN ACTIVE");
      assert.include(wakeup.strategyReview ?? "", "trading_plan");
      assert.isBelow(text.length, 5_000);
    }),
  );

  it.effect("a plan-less holding wake still gets the management brief", () =>
    Effect.gen(function* () {
      positionSize = -1.25;
      const { wakeup } = yield* composeFull({ planless: true });
      positionSize = 0;
      assert.isUndefined(wakeup.activeStrategy);
      assert.include(wakeup.positionReview ?? "", "HOLDING");
      assert.isUndefined(wakeup.strategyReview);
    }),
  );

  it.effect("hands a holding wake the management brief instead", () =>
    Effect.gen(function* () {
      positionSize = 0;
      assert.isUndefined((yield* compose()).positionReview);

      positionSize = -1.25;
      const holding = yield* compose();
      positionSize = 0;
      const review = holding.positionReview ?? "";
      // The three things a holding turn is for: what banking is worth, what
      // has already been handed back, and moving the stop off the entry.
      assert.include(review, "positionCosts");
      assert.include(review, "drawdownFromPeakUsd");
      // Plan 29 step 6.3: the brief names the condition the model can write.
      assert.include(review, "giveback");
    }),
  );

  it.effect("feeds the runtime's 1m bars even when the plan reasons on a longer interval", () =>
    Effect.gen(function* () {
      requestedIntervals = [];
      // The failure this exists for: a plan that named `timeframes: ["15m"]`
      // used to make the runtime read 15m bars and measure 15m volatility, so
      // the 1m structure the entry actually turns on was never in front of it.
      // The plan no longer names timeframes (plan 29 step 4.1) — the mandate
      // is the only source, and an unmandated mission gets 1m plus the fixed
      // 15m pairing.
      const composed = yield* composeFull({});

      assert.equal(composed.wakeup.recentCandles.interval, "1m");
      assert.equal(composed.wakeup.observedVolatility.interval, "1m");
      // The higher read still happens — the fixed pairing, not the plan's.
      assert.equal(composed.wakeup.higherTimeframeVolatility?.interval, "15m");
      assert.deepEqual([...requestedIntervals].sort(), ["15m", "1m"]);
    }),
  );

  it.effect("works the interval the mandate names when it names one", () =>
    Effect.gen(function* () {
      requestedIntervals = [];
      const composed = yield* composeFull({
        instruction: "scalp ETH on the 5m while the New York session is open",
      });

      assert.equal(composed.wakeup.recentCandles.interval, "5m");
      assert.equal(composed.wakeup.higherTimeframeVolatility?.interval, "1h");
    }),
  );

  it.effect("carries the one cost line while flat, priced at the plan's intended entry", () =>
    Effect.gen(function* () {
      positionSize = 0;
      costedSize = null;
      costedNotional = null;
      const wakeup = yield* compose();

      // No position: nothing to price on a size. The plan names a $200 intended
      // entry notional, and the flat line prices that, not a position.
      assert.equal(wakeup.positionCosts, undefined);
      assert.equal(costedSize, null);
      assert.equal(costedNotional, 200);

      const context = wakeup.costContext;
      assert.ok(context !== undefined);
      assert.equal(context.referenceNotionalUsd, 200);
      // Two taker fills at 5 bps on $200 (0.20) plus the $2 spread crossed on
      // 0.05 ETH twice (0.10): 0.30, which is 15 bps of the reference notional.
      assert.closeTo(context.roundTripUsd, 0.3, 1e-9);
      assert.closeTo(context.roundTripBps, 15, 1e-9);
    }),
  );

  it.effect("prices the flat cost line at the allocated capital when no plan notional exists", () =>
    Effect.gen(function* () {
      positionSize = 0;
      costedNotional = null;
      const wakeup = yield* composeFull({
        activeStrategy: {
          ...strategy,
          entry: {
            ...strategy.entry,
            initialNotionalUsd: undefined,
          },
        } as unknown as TradingPlanState,
      }).pipe(Effect.map((composed) => composed.wakeup));

      assert.equal(costedNotional, 1_000);
      assert.equal(wakeup.costContext?.referenceNotionalUsd, 1_000);
    }),
  );

  it.effect("prices the round trip on the size actually held", () =>
    Effect.gen(function* () {
      positionSize = -1.25;
      costedSize = null;
      costedNotional = null;
      const wakeup = yield* compose();
      positionSize = 0;

      // Two taker fills at 5 bps on 1.25 x 4,000 of notional, plus the spread
      // crossed twice: 5.00 + 2.50.
      assert.closeTo(wakeup.positionCosts?.roundTripUsd ?? 0, 7.5, 1e-9);
      // A short is costed at its absolute size: the round trip does not care
      // which way round the two fills go.
      assert.equal(costedSize, 1.25);
      // Holding, the real exit on the real size replaces the flat reference
      // line — the wake carries one cost figure, priced on what is held.
      assert.equal(costedNotional, null);
      assert.equal(wakeup.costContext, undefined);
    }),
  );

  /**
   * The same plan, waiting to enter, with two named trigger levels. Flat is
   * the waiting phase now (`planPhase`) — there is no `currentAction` to name.
   */
  const waitingStrategy = {
    ...(strategy as unknown as Record<string, unknown>),
    entry: {
      ...(strategy.entry as unknown as Record<string, unknown>),
      triggers: [
        // Armed: `watch_up` sits at 4,040.
        { description: "reclaim of the prior high", priceLevel: 4_040, timeframe: "1m" },
        // Named in prose only.
        { description: "give up on a loss of 3,900", priceLevel: 3_900 },
      ],
    },
  } as unknown as TradingPlanState;

  it.effect("names the entry levels a waiting plan published but never armed", () =>
    Effect.gen(function* () {
      positionSize = 0;
      const wakeup = yield* composeFull({ activeStrategy: waitingStrategy }).pipe(
        Effect.map((composed) => composed.wakeup),
      );

      assert.deepEqual(
        wakeup.unarmedEntryConditions?.map((c) => c.priceLevel),
        [3_900],
      );
    }),
  );

  it.effect("says nothing about entry levels while a position is open", () =>
    Effect.gen(function* () {
      positionSize = 1;
      const wakeup = yield* composeFull({ activeStrategy: waitingStrategy }).pipe(
        Effect.map((composed) => composed.wakeup),
      );
      positionSize = 0;

      assert.equal(wakeup.unarmedEntryConditions, undefined);
    }),
  );

  it.effect("renders an ordinary wakeup untouched", () =>
    Effect.gen(function* () {
      const { text } = yield* composeFull();
      assert.isBelow(text.length, MAX_WAKEUP_CHARS);
      assert.notInclude(text, "…");
      assert.notInclude(text, "[truncated:");
      // The plan's own prose survives verbatim when it fits.
      assert.include(text, "long the reclaim");
    }),
  );

  it.effect("composes a verbose plan by trimming it, never by failing", () =>
    Effect.gen(function* () {
      // The failure this pins: one plan authored with 10k-char prose used to
      // make every wake for that mission's life fail with `wakeup_too_large`,
      // which left the mission deaf while still holding a position.
      const verbose = {
        ...strategy,
        because: "b".repeat(10_000),
        invalidation: Array.from({ length: 20 }, (_, i) => `invalidation ${i} ${"x".repeat(500)}`),
        entry: {
          ...strategy.entry,
          triggers: Array.from({ length: 20 }, (_, i) => ({
            description: `trigger ${i} ${"t".repeat(500)}`,
          })),
        },
      } as unknown as TradingPlanState;

      const { text } = yield* composeFull({ activeStrategy: verbose });

      assert.isAtMost(text.length, MAX_WAKEUP_CHARS);
      // The trim marker is what tells the run the plan it sees is a projection.
      assert.include(text, "…");
      assert.include(text, "more)");
      // The facts a run cannot re-derive from a tool call survive the trim.
      assert.include(text, "marketSnapshot");
    }),
  );
  // -- the book, plan 29 step 7.1 --------------------------------------------

  it.effect("carries the book imbalance on every wake", () =>
    Effect.gen(function* () {
      const wakeup = yield* compose();
      // Three on the bid against one on the ask, at one price: (3 - 1) / 4.
      assert.equal(wakeup.microstructure?.bookImbalance?.imbalance, 0.5);
      assert.equal(wakeup.microstructure?.bookImbalance?.levels, 1);
      // The tape reading rides the same field, from the same history the
      // volatility measurement was taken over.
      assert.equal(wakeup.microstructure?.aggressorFlow?.bars, 15);
      // Spread and near-touch depth come off the same book. This database has
      // no sample table, so the change fields are absent — which is the point:
      // "nothing to compare against" is stated by their absence, never by a
      // zero that would read as "unchanged".
      assert.isDefined(wakeup.microstructure?.liquidity?.spreadBps);
      assert.isUndefined(wakeup.microstructure?.liquidity?.depthChangePercent);
    }),
  );

  it.effect("reads the same book a look reads, from one read", () =>
    Effect.gen(function* () {
      const composer = yield* TradingWakeupComposer;
      const facts = yield* composer.observe({ mission, occurredAt: NOW });
      const wakeup = yield* compose();
      // `trading_look` returns `facts`; the wake renders the same value. If the
      // two ever diverged, a look and a wake would quote different books.
      assert.deepEqual(facts.microstructure, wakeup.microstructure);
      assert.equal(facts.orderBook?.bids[0]?.size, 3);
    }),
  );

  it.effect("a book read that throws costs the book fields and nothing else", () =>
    Effect.gen(function* () {
      bookBehaviour = "throws";
      const wakeup = yield* compose().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            bookBehaviour = "served";
          }),
        ),
      );

      // The book reading is gone...
      assert.equal(wakeup.microstructure?.bookImbalance, undefined);
      // ...and the tape reading, which the book read never fed, is not.
      assert.isDefined(wakeup.microstructure?.aggressorFlow);
      // ...and everything the wake is actually defined by survived it.
      assert.equal(wakeup.marketSnapshot.markPrice, MARK);
      assert.equal(wakeup.position.size, 0);
      assert.isAbove(wakeup.recentCandles.candles.length, 0);
      assert.isDefined(wakeup.observedVolatility);
    }),
  );
});
