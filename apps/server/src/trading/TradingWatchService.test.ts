import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { TradingHarnessBinding, MarketWatch } from "./Schemas.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingWatchService, TradingWatchServiceLive } from "./TradingWatchService.ts";

const layer = it.layer(
  Layer.mergeAll(
    TradingMissionServiceLive,
    TradingStrategyServiceLive,
    TradingWatchServiceLive,
  ).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

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

/** Shared in-memory database; each test migrates then truncates the trading tables. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 43 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
});

/** Create a mission and publish strategy v1 so a watch can bind to it. */
const seedMission = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.createMission({
    missionId: "mission_1",
    userId: "user_1",
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
      entryPlan: {
        explanation: "enter on breakout",
        orderPreference: "marketable_ioc",
        conditions: [],
      },
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
  if (published.outcome !== "accepted") {
    throw new Error(`seed publish was rejected: ${published.reason}`);
  }
});

layer("TradingWatchService", (it) => {
  it.effect("registers a watch bound to the current strategy version", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const watch = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });

      assert.equal(watch.missionId, "mission_1");
      assert.equal(watch.strategyVersion, 1);
      assert.equal(watch.status, "active");
      assert.deepStrictEqual(watch.watch, candleCloseWatch);
    }),
  );

  it.effect("cancel only affects an active watch", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const registered = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });

      const cancelled = yield* watches.cancelWatch({
        missionId: "mission_1",
        watchId: registered.id,
      });
      assert.notStrictEqual(cancelled, null);
      assert.equal(cancelled?.status, "cancelled");

      // A second cancel is a no-op: the watch is already terminal.
      const second = yield* watches.cancelWatch({
        missionId: "mission_1",
        watchId: registered.id,
      });
      assert.strictEqual(second, null);
    }),
  );

  it.effect("markTriggered flips an active watch and is a no-op once triggered", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const registered = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });

      const triggered = yield* watches.markTriggered(registered.id);
      assert.notStrictEqual(triggered, null);
      assert.equal(triggered?.status, "triggered");

      // Re-firing a triggered watch does nothing — it is already terminal.
      const again = yield* watches.markTriggered(registered.id);
      assert.strictEqual(again, null);
    }),
  );

  it.effect("rejects registering a watch for a missing mission", () =>
    Effect.gen(function* () {
      yield* migrated;

      const watches = yield* TradingWatchService;
      const result = yield* Effect.result(
        watches.registerWatch({ missionId: "nope", watch: candleCloseWatch }),
      );
      assert.equal(result._tag, "Failure");
    }),
  );
});
