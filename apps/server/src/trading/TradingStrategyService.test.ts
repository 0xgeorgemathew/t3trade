import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { PublishMomentumStrategyBody } from "./Schemas.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";

const layer = it.layer(
  Layer.mergeAll(TradingMissionServiceLive, TradingStrategyServiceLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

const body = (name: string): PublishMomentumStrategyBody => ({
  name,
  market: "ETH",
  mode: "breakout_continuation",
  direction: "long",
  timeframes: ["5m"],
  belief: {
    summary: "Breakout confirmed on rising relative volume.",
    regime: "trending",
    evidence: ["5m close 3748.9"],
  },
  entryPlan: {
    explanation: "Enter on a retest that holds.",
    orderPreference: "marketable_ioc",
    conditions: [{ description: "Retest of 3,718 holds" }],
  },
  positionManagement: {
    scaleInAllowed: true,
    scaleInConditions: [],
    partialReductionAllowed: true,
  },
  protection: {
    stopMethod: "Below the last accepted swing low",
    stopPrice: 3_652,
  },
  exitConditions: [{ description: "5m close under 3,690" }],
  abandonmentConditions: [],
  reentryConditions: [],
  currentAction: "waiting",
  explanation: "Waiting for the retest.",
});

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 37 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
  yield* sql`DELETE FROM trading_watches`;

  const missions = yield* TradingMissionService;
  return yield* missions.createMission({
    missionId: "mission_1",
    userId: "user_1",
    tradingAccountId: "acct_1",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    harness: {
      provider: "claude",
      providerInstanceId: "instance_1",
      threadId: "thread_1",
      status: "available",
    },
  });
});

const insertWatch = (input: {
  readonly watchId: string;
  readonly strategyVersion: number;
  readonly status: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_watches (
        watch_id, mission_id, strategy_version, watch_json, status, version,
        created_at, updated_at
      ) VALUES (
        ${input.watchId}, 'mission_1', ${input.strategyVersion},
        '{"type":"position_update","market":"ETH"}', ${input.status}, 1,
        1753000000000, 1753000000000
      )
    `;
  });

const watchStatus = (watchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM trading_watches WHERE watch_id = ${watchId}
    `;
    return rows[0]?.status;
  });

layer("trading_publish_momentum_strategy (§14.3)", (it) => {
  it.effect("accepts the first publish at expected version 0 and assigns version 1", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("v1"),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.strategyVersion, 1);
        assert.equal(result.strategy.version, 1);
        assert.equal(result.strategy.name, "v1");
        // The server stamps updatedAt from the clock; the harness never sends it.
        assert.equal(typeof result.strategy.updatedAt, "number");
      }

      const missions = yield* TradingMissionService;
      const mission = yield* missions.getMission("mission_1");
      assert.equal(mission.strategyVersion, 1);
    }),
  );

  it.effect("increments the version on each accepted publish", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      for (const expectedVersion of [0, 1, 2]) {
        const result = yield* strategies.publishMomentumStrategy({
          missionId: "mission_1",
          expectedVersion,
          strategy: body(`v${expectedVersion + 1}`),
        });
        assert.equal(result.outcome, "accepted");
        if (result.outcome === "accepted") {
          assert.equal(result.strategyVersion, expectedVersion + 1);
        }
      }

      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.ok(Option.isSome(current));
      assert.equal(Option.getOrThrow(current).version, 3);
      assert.equal(Option.getOrThrow(current).name, "v3");
    }),
  );

  it.effect("rejects a stale expected version without overwriting current state", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("v1"),
      });

      const stale = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("stale overwrite"),
      });

      assert.equal(stale.outcome, "rejected");
      if (stale.outcome === "rejected") {
        assert.equal(stale.reason, "stale_strategy_version");
        assert.equal(stale.currentVersion, 1);
      }

      // The accepted v1 still stands.
      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.equal(Option.getOrThrow(current).name, "v1");
      assert.equal(Option.getOrThrow(current).version, 1);
    }),
  );

  it.effect("rejects a version ahead of the server's", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const ahead = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 7,
        strategy: body("from the future"),
      });

      assert.equal(ahead.outcome, "rejected");
      if (ahead.outcome === "rejected") {
        assert.equal(ahead.reason, "stale_strategy_version");
        assert.equal(ahead.currentVersion, 0);
      }
    }),
  );

  it.effect("supersedes active watches bound to the prior version", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("v1"),
      });

      yield* insertWatch({ watchId: "watch_v1", strategyVersion: 1, status: "active" });

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 1,
        strategy: body("v2"),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.deepStrictEqual([...result.supersededWatchIds], ["watch_v1"]);
      }
      assert.equal(yield* watchStatus("watch_v1"), "superseded");
    }),
  );

  it.effect("leaves non-active watches in their existing status", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("v1"),
      });

      yield* insertWatch({ watchId: "watch_triggered", strategyVersion: 1, status: "triggered" });
      yield* insertWatch({ watchId: "watch_consumed", strategyVersion: 1, status: "consumed" });
      yield* insertWatch({ watchId: "watch_cancelled", strategyVersion: 1, status: "cancelled" });
      yield* insertWatch({ watchId: "watch_active", strategyVersion: 1, status: "active" });

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 1,
        strategy: body("v2"),
      });

      if (result.outcome === "accepted") {
        assert.deepStrictEqual([...result.supersededWatchIds], ["watch_active"]);
      }
      assert.equal(yield* watchStatus("watch_triggered"), "triggered");
      assert.equal(yield* watchStatus("watch_consumed"), "consumed");
      assert.equal(yield* watchStatus("watch_cancelled"), "cancelled");
      assert.equal(yield* watchStatus("watch_active"), "superseded");
    }),
  );

  it.effect("does not supersede watches already bound to the new version", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      // A watch registered against version 2 must survive the publish of 2.
      yield* insertWatch({ watchId: "watch_v2", strategyVersion: 2, status: "active" });

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("v1"),
      });

      if (result.outcome === "accepted") {
        assert.deepStrictEqual([...result.supersededWatchIds], []);
      }
      assert.equal(yield* watchStatus("watch_v2"), "active");
    }),
  );

  it.effect("rejects publishing to a revoked mission", () =>
    Effect.gen(function* () {
      yield* setup;
      const missions = yield* TradingMissionService;
      const strategies = yield* TradingStrategyService;

      yield* missions.transition({ missionId: "mission_1", to: "revoked", expectedVersion: 1 });

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("after revoke"),
      });

      assert.equal(result.outcome, "rejected");
      if (result.outcome === "rejected") {
        assert.equal(result.reason, "mission_not_active");
      }
    }),
  );

  it.effect("fails when the mission does not exist", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* Effect.result(
        strategies.publishMomentumStrategy({
          missionId: "nope",
          expectedVersion: 0,
          strategy: body("orphan"),
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TradingMissionNotFoundError");
      }
    }),
  );

  it.effect("reports no strategy before the first publish", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.ok(Option.isNone(current));
    }),
  );
});
