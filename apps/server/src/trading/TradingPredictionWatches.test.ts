import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { TradingHarnessBinding, TradingPlanState } from "./Schemas.ts";
import { armPredictionWatches } from "./TradingPredictionWatches.ts";
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

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 69 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM trading_plan_history`;
});

const basePlan = {
  market: "ETH",
  intent: "long",
  entry: { triggers: [], urgency: "now" },
  stop: { method: "fixed" },
  target: { profitUsd: 10 },
  invalidation: [],
  reassess: { afterMinutes: 90 },
  because: "the 5m is holding above the reclaim",
} as const;

/** Publish a plan and return the version and the plan the server stored. */
const publish = Effect.fn("publish")(function* (input: {
  readonly expectedMissionVersion: number;
  readonly projection?: TradingPlanState["projection"];
}) {
  const strategies = yield* TradingStrategyService;
  const published = yield* strategies.publishPlan({
    missionId: "mission_1",
    expectedMissionVersion: input.expectedMissionVersion,
    strategy: {
      ...basePlan,
      ...(input.projection === undefined ? {} : { projection: input.projection }),
    },
  });
  if (published.outcome !== "accepted") {
    throw new Error(`publish was rejected: ${published.reason}`);
  }
  return published;
});

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
});

/** Every watch the mission holds, newest first. */
const listWatches = Effect.gen(function* () {
  const strategies = yield* TradingStrategyService;
  return yield* strategies.listWatches("mission_1");
});

const LONG_READ = {
  direction: "long",
  price: 3_100,
  byMinutes: 30,
  invalidationPrice: 2_950,
} as const;

layer("TradingPredictionWatches", (it) => {
  it.effect("arms a horizon and an invalidation watch from a published projection", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const published = yield* publish({ expectedMissionVersion: 1, projection: LONG_READ });

      yield* armPredictionWatches({
        missionId: "mission_1",
        version: published.version,
        plan: published.strategy,
      });

      const watches = yield* listWatches;
      assert.equal(watches.length, 2);

      const horizon = watches.find((w) => w.armedReason === "prediction_horizon");
      assert.isDefined(horizon);
      assert.deepStrictEqual(horizon?.watch, {
        type: "scheduled_reassessment",
        runAt: published.strategy.updatedAt + 30 * 60_000,
      });
      assert.equal(horizon?.predictionVersion, published.version);

      const invalidation = watches.find((w) => w.armedReason === "prediction_invalidation");
      assert.isDefined(invalidation);
      // A long read is invalidated by price falling THROUGH the level. The
      // direction being wrong would arm a watch that fires the moment the
      // trade starts working.
      assert.deepStrictEqual(invalidation?.watch, {
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "below",
        price: 2_950,
      });
      assert.equal(invalidation?.predictionVersion, published.version);
    }),
  );

  it.effect("invalidates a short read from above", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const published = yield* publish({
        expectedMissionVersion: 1,
        projection: { direction: "short", price: 2_900, byMinutes: 20, invalidationPrice: 3_080 },
      });

      yield* armPredictionWatches({
        missionId: "mission_1",
        version: published.version,
        plan: published.strategy,
      });

      const invalidation = (yield* listWatches).find(
        (w) => w.armedReason === "prediction_invalidation",
      );
      assert.deepStrictEqual(invalidation?.watch, {
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3_080,
      });
    }),
  );

  // The whole point of `prediction_version`: a revision retires the read it
  // replaced and NOTHING else.
  it.effect("supersedes the previous prediction's watches and spares everything else", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const first = yield* publish({ expectedMissionVersion: 1, projection: LONG_READ });
      yield* armPredictionWatches({
        missionId: "mission_1",
        version: first.version,
        plan: first.strategy,
      });

      // Protection for a live position, armed by the runtime under its own
      // reasons. A revision must not touch either.
      const watchService = yield* TradingWatchService;
      yield* watchService.registerWatch({
        missionId: "mission_1",
        watch: { type: "pnl_above", market: "ETH", valueUsd: 10 },
        armedReason: "profit_target",
      });
      yield* watchService.registerWatch({
        missionId: "mission_1",
        watch: {
          type: "price_cross",
          market: "ETH",
          priceSource: "mark",
          direction: "below",
          price: 2_900,
        },
        armedReason: "stop_proximity",
      });

      const second = yield* publish({
        expectedMissionVersion: 2,
        projection: { direction: "long", price: 3_200, byMinutes: 45, invalidationPrice: 3_010 },
      });
      yield* armPredictionWatches({
        missionId: "mission_1",
        version: second.version,
        plan: second.strategy,
      });

      const watches = yield* listWatches;
      const active = watches.filter((w) => w.status === "active");

      // The new pair, plus the two protective watches, and nothing else.
      assert.deepStrictEqual(active.map((w) => w.armedReason).sort(), [
        "prediction_horizon",
        "prediction_invalidation",
        "profit_target",
        "stop_proximity",
      ]);
      for (const watch of active.filter((w) => w.predictionVersion !== undefined)) {
        assert.equal(watch.predictionVersion, second.version);
      }

      // The first read's pair is gone — retired, not cancelled, so the panel
      // can say a plan replaced it rather than that someone disarmed it.
      const settled = watches.filter((w) => w.status !== "active");
      assert.equal(settled.length, 2);
      assert.deepStrictEqual(new Set(settled.map((w) => w.status)), new Set(["superseded"]));
      for (const watch of settled) {
        assert.equal(watch.predictionVersion, first.version);
      }
    }),
  );

  // A level that did not move should not churn: retiring it and writing an
  // identical one fills the watch stream with rows describing nothing.
  it.effect("rolls an unchanged invalidation level forward in place", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const first = yield* publish({ expectedMissionVersion: 1, projection: LONG_READ });
      yield* armPredictionWatches({
        missionId: "mission_1",
        version: first.version,
        plan: first.strategy,
      });
      const originalId = (yield* listWatches).find(
        (w) => w.armedReason === "prediction_invalidation",
      )?.id;

      // Same invalidation, further target, longer horizon.
      const second = yield* publish({
        expectedMissionVersion: 2,
        projection: { direction: "long", price: 3_400, byMinutes: 60, invalidationPrice: 2_950 },
      });
      yield* armPredictionWatches({
        missionId: "mission_1",
        version: second.version,
        plan: second.strategy,
      });

      const invalidations = (yield* listWatches).filter(
        (w) => w.armedReason === "prediction_invalidation",
      );
      assert.equal(invalidations.length, 1, "the unchanged level kept its row");
      assert.equal(invalidations[0]?.id, originalId);
      assert.equal(invalidations[0]?.status, "active");
      assert.equal(invalidations[0]?.predictionVersion, second.version);
    }),
  );

  // A stand-aside plan believes nothing, so it arms nothing — and the level
  // the previous read would have woken on goes with it.
  it.effect("arms nothing for a plan with no projection, and still sweeps", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const first = yield* publish({ expectedMissionVersion: 1, projection: LONG_READ });
      yield* armPredictionWatches({
        missionId: "mission_1",
        version: first.version,
        plan: first.strategy,
      });

      const second = yield* publish({ expectedMissionVersion: 2 });
      yield* armPredictionWatches({
        missionId: "mission_1",
        version: second.version,
        plan: second.strategy,
      });

      const watches = yield* listWatches;
      assert.equal(watches.filter((w) => w.status === "active").length, 0);
      assert.equal(watches.filter((w) => w.status === "superseded").length, 2);
    }),
  );
});
