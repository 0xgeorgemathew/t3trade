import * as NodeServices from "@effect/platform-node/NodeServices";
import { fakeWebSocketClientLayer } from "@t3tools/hyperliquid/InfoClientTest";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { WsDelivery } from "@t3tools/hyperliquid/WebSocketClient";
import type { AgentMarketSnapshot } from "@t3tools/trading-contracts/market";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { TradingHarnessBinding, MarketWatch } from "./Schemas.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingWatchService, TradingWatchServiceLive } from "./TradingWatchService.ts";
import { WatchEvaluator, WatchEvaluatorLive } from "./WatchEvaluator.ts";

/**
 * A stub engine that swallows dispatches. The evaluator announces
 * `trading.mission.watch-fired` here; the real engine-driven resume path is
 * proven in the Step 5 integration test.
 */
const stubEngine = Layer.succeed(OrchestrationEngineService, {
  dispatch: () => Effect.succeed({ sequence: 0 }),
  streamDomainEvents: Effect.never,
  latestSequence: 0,
} as unknown as (typeof OrchestrationEngineService)["Service"]);

/**
 * A fixed close time far enough in the past that the evaluator's `observedAt`
 * is always after it (finalised), and a far-future time that is always after
 * `observedAt` (not finalised).
 */
const PAST_CLOSE = 1_700_000_000_000; // 2023-11-14
const FUTURE_CLOSE = 9_999_999_999_999; // ~2286
/**
 * The "now" the evaluator observes: after PAST_CLOSE (finalised) and before
 * FUTURE_CLOSE (not finalised). `it.effect` runs under a TestClock at epoch 0,
 * so each test advances it to here before evaluating.
 */
const NOW = PAST_CLOSE + 60_000;

const freshness = {
  observedAt: PAST_CLOSE,
  source: "info_api",
  staleAfterMillis: 2_000,
} as const;

/** The fresh snapshot the stub gateway serves: mark 3_100, mid 3_090. */
const stubSnapshot: AgentMarketSnapshot = {
  market: "ETH",
  markPrice: 3_100,
  midPrice: 3_090,
  oraclePrice: 3_095,
  fundingRate8h: 0.0001,
  openInterest: 1_000,
  dayVolumeUsd: 1_000_000,
  bestBidOffer: { bidPrice: 3_089, bidSize: 1, askPrice: 3_091, askSize: 1, freshness },
  freshness,
  change24hPercent: 1.2,
  sparkline: [3_000, 3_100],
};

const unusedRead = () => Effect.die("not used by WatchEvaluator tests");

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: unusedRead,
  getMarketSnapshot: () => Effect.succeed(stubSnapshot),
  getMarketHistory: unusedRead,
  getOrderBook: unusedRead,
  getAccountSnapshot: unusedRead,
  getPosition: unusedRead,
  getOpenOrders: unusedRead,
} as unknown as (typeof HyperliquidGateway)["Service"]);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const candleCloseWatch: MarketWatch = {
  type: "candle_close",
  market: "ETH",
  interval: "5m",
  direction: "above",
  price: 3_000,
};

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 37 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
  yield* sql`DELETE FROM trading_event_inbox`;
});

/** Create the mission, publish strategy v1, and register `watch`. */
const seed = (watch: MarketWatch) =>
  Effect.gen(function* () {
    const missions = yield* TradingMissionService;
    yield* missions.createMission({
      missionId: "mission_1",
      userId: "local",
      tradingAccountId: "acct_1",
      instruction: "Trade ETH momentum",
      allocatedCapitalUsd: 1_000,
      harness,
    });
    const strategies = yield* TradingStrategyService;
    const published = yield* strategies.publishMomentumStrategy({
      missionId: "mission_1",
      expectedVersion: 0,
      strategy: {
        name: "ETH breakout",
        market: "ETH",
        mode: "breakout_continuation",
        direction: "long",
        timeframes: ["5m"],
        belief: { summary: "bullish", regime: "trending", evidence: [] },
        entryPlan: { explanation: "enter", orderPreference: "marketable_ioc", conditions: [] },
        positionManagement: {
          scaleInAllowed: false,
          scaleInConditions: [],
          partialReductionAllowed: false,
        },
        protection: { stopMethod: "fixed" },
        exitConditions: [],
        abandonmentConditions: [],
        reentryConditions: [],
        currentAction: "waiting",
        explanation: "wait for the 5m close above 3000",
      },
    });
    if (published.outcome !== "accepted") throw new Error("seed publish rejected");

    const watches = yield* TradingWatchService;
    return yield* watches.registerWatch({ missionId: "mission_1", watch });
  });

/** Build a WS delivery for a 5m candle that closed at `closePrice` at `closeTime`. */
const candleDelivery = (closeTime: number, closePrice: number): WsDelivery => ({
  subscription: { type: "candle", coin: "ETH", interval: "5m" },
  channel: "candle",
  data: [
    {
      t: closeTime - 300_000,
      T: closeTime,
      s: "ETH",
      i: "5m",
      o: 3050,
      c: closePrice,
      h: 3150,
      l: 3040,
      v: 100,
      n: 50,
    },
  ],
});

/**
 * The test layer: trading services provided to the evaluator. No WS fake is
 * needed because the tests drive evaluation synchronously via
 * `evaluateDelivery` / `sweep`, which is exactly what the forked consumers call
 * — so this proves the same fires-exactly-once invariant without racing a
 * forked fiber.
 */
const layer = it.layer(
  WatchEvaluatorLive.pipe(
    Layer.provideMerge(TradingMissionServiceLive),
    Layer.provideMerge(TradingStrategyServiceLive),
    Layer.provideMerge(TradingWatchServiceLive),
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(fakeWebSocketClientLayer([])),
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(stubEngine),
  ),
);

layer("WatchEvaluator", (it) => {
  it.effect(
    "fires a matching candle-close watch exactly once when the same closed candle is replayed",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const watch = yield* seed(candleCloseWatch);
        yield* TestClock.setTime(NOW);
        const evaluator = yield* WatchEvaluator;

        // Deliver the same finalised candle twice; the evaluator must fire once.
        yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 3_100));
        yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 3_100));
        yield* evaluator.drain;

        const inbox = yield* TradingEventInbox;
        const claimed = yield* inbox.claimPending("mission_1");
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.deduplicationKey, `candle_close:${watch.id}:${PAST_CLOSE}`);
        assert.equal(claimed[0]?.summary, "5m candle closed 3100 (above 3000)");

        const strategies = yield* TradingStrategyService;
        const [persisted] = yield* strategies.listWatches("mission_1");
        assert.equal(persisted?.status, "triggered");
      }),
  );

  it.effect("does not fire a candle-close watch whose close is still in the future", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seed(candleCloseWatch);
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.evaluateDelivery(candleDelivery(FUTURE_CLOSE, 3_100));
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
    }),
  );

  it.effect("does not fire a candle-close watch whose close is below the threshold", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seed(candleCloseWatch);
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 2_900));
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
    }),
  );

  it.effect("fires a price-cross watch once against the fresh gateway snapshot", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Stub mark price is 3_100, so "mark above 3_000" matches.
      const watch = yield* seed({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3_000,
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      // Two sweeps; the triggered watch must not fire a second time.
      yield* evaluator.sweep;
      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `price_cross:${watch.id}`);
      assert.equal(claimed[0]?.category, "market");

      const strategies = yield* TradingStrategyService;
      const [persisted] = yield* strategies.listWatches("mission_1");
      assert.equal(persisted?.status, "triggered");
    }),
  );

  it.effect("does not fire a price-cross watch whose level has not been reached", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Stub mid price is 3_090, below the 3_200 threshold.
      yield* seed({
        type: "price_cross",
        market: "ETH",
        priceSource: "mid",
        direction: "above",
        price: 3_200,
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
    }),
  );

  it.effect("fires a due scheduled reassessment as a timer event, but not an undue one", () =>
    Effect.gen(function* () {
      yield* migrated;
      const due = yield* seed({ type: "scheduled_reassessment", runAt: PAST_CLOSE });
      const watches = yield* TradingWatchService;
      yield* watches.registerWatch({
        missionId: "mission_1",
        watch: { type: "scheduled_reassessment", runAt: FUTURE_CLOSE },
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `scheduled_reassessment:${due.id}`);
      assert.equal(claimed[0]?.category, "timer");
    }),
  );
});
