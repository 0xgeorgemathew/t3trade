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
  yield* runMigrations({ toMigrationInclusive: 60 });
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
      protection: {
        stopMethod: "fixed",
        targetProfitUsd: 10,
        // Publishing checks the target against the basis it claims to come from:
        // (10 USD of price / 2,000 mark) x 2,000 of notional = 10 USD of PnL.
        targetProfitBasis: {
          measurement: "excursion_quantile",
          timeframe: "1m",
          lookbackBars: 120,
          measuredMoveUsd: 10,
          expectedHoldBars: 10,
          referencePrice: 2_000,
          targetPriceMovePercent: 0.5,
          positionNotionalUsd: 2_000,
          rationale: "10-bar p50 excursion over a 120-bar window",
        },
      },
      exitConditions: [],
      abandonmentConditions: [],
      reentryConditions: [],
      currentAction: "waiting",
      explanation: "wait for the 5m close above 3000",
      plainSummary: "ETH is pushing higher; I plan to buy once it breaks out.",
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
      const { watch, replaced } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });

      assert.equal(watch.missionId, "mission_1");
      assert.equal(watch.strategyVersion, 1);
      assert.equal(watch.status, "active");
      assert.deepStrictEqual(watch.watch, candleCloseWatch);
      assert.equal(replaced, undefined);
    }),
  );

  it.effect("cancel only affects an active watch", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const { watch: registered } = yield* watches.registerWatch({
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
      const { watch: registered } = yield* watches.registerWatch({
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

  // A watch fires once, so keeping a level standing means re-registering it —
  // and cancel-then-register leaves the side being re-levelled unwatched in
  // between, which on a fast market is the exact window that matters.
  it.effect("retires the old level and arms the new one in one transaction", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const { watch: original } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });

      const { watch: moved, replaced } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: { ...candleCloseWatch, price: 3_100 },
        replacesWatchId: original.id,
      });

      assert.equal(replaced?.id, original.id);
      assert.equal(replaced?.status, "cancelled");
      assert.notEqual(moved.id, original.id);
      assert.equal(moved.status, "active");

      // The old level is genuinely gone, not merely reported as such.
      const stillThere = yield* watches.getWatch(original.id);
      assert.equal(stillThere?.status, "cancelled");
    }),
  );

  // The harness has to be able to tell a swap from an addition: if the level it
  // meant to retire had already fired, it now holds two live conditions and
  // only one of them is the one it thinks it has.
  it.effect("reports no replacement when the named watch was already terminal", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const { watch: original } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });
      yield* watches.markTriggered(original.id);

      const { watch: added, replaced } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: { ...candleCloseWatch, price: 3_100 },
        replacesWatchId: original.id,
      });

      assert.equal(replaced, undefined);
      assert.equal(added.status, "active");
      // The triggered watch keeps its terminal status; nothing rewrote it.
      const untouched = yield* watches.getWatch(original.id);
      assert.equal(untouched?.status, "triggered");
    }),
  );

  it.effect("will not let one mission retire another mission's watch", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const watches = yield* TradingWatchService;
      const { watch: mine } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: candleCloseWatch,
      });

      // A replace naming a watch this mission does not own cancels nothing —
      // the WHERE clause is scoped to the mission, not just the watch id.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE trading_watches SET mission_id = 'mission_other' WHERE watch_id = ${mine.id}`;

      const { replaced } = yield* watches.registerWatch({
        missionId: "mission_1",
        watch: { ...candleCloseWatch, price: 3_100 },
        replacesWatchId: mine.id,
      });
      assert.equal(replaced, undefined);

      const untouched = yield* watches.getWatch(mine.id);
      assert.equal(untouched?.status, "active");
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
