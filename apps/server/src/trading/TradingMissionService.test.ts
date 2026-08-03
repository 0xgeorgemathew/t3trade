import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";

const layer = it.layer(
  TradingMissionServiceLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const createInput = (overrides?: { readonly missionId?: string; readonly userId?: string }) => ({
  missionId: overrides?.missionId ?? "mission_1",
  userId: overrides?.userId ?? "user_1",
  tradingAccountId: "acct_1",
  instruction: "Trade ETH momentum",
  allocatedCapitalUsd: 1_000,
  harness,
});

/**
 * it.layer shares one in-memory database across the suite, so each test starts
 * by migrating and then truncating the trading tables.
 */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 37 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
});

layer("TradingMissionService", (it) => {
  it.effect("creates an ETH momentum mission with the testnet authority defaults", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const mission = yield* service.createMission(createInput());

      assert.equal(mission.id, "mission_1");
      assert.equal(mission.market, "ETH");
      assert.equal(mission.strategyFamily, "momentum");
      assert.equal(mission.status, "initializing");
      assert.equal(mission.authorityVersion, 1);
      assert.equal(mission.strategyVersion, 0);
      assert.equal(mission.authority.allocatedCapitalUsd, 1_000);
      // The testnet preset, not the spec's $1,000 worked example: 8x capital
      // gross, 20x leverage ceiling. See `testnetAuthorityDefaults`.
      assert.equal(mission.authority.maximumGrossNotionalUsd, 8_000);
      assert.equal(mission.authority.maximumLeverage, 20);
      assert.equal(mission.authority.maximumCumulativeLossUsd, 350);
      assert.equal(mission.authority.maximumPlannedRiskPerPositionUsd, 70);
      assert.deepStrictEqual(mission.authority.marginModes, ["isolated"]);
      assert.equal(mission.harness.provider, "claude");
      assert.equal(mission.control.entriesAllowed, true);
    }),
  );

  it.effect("rejects a second active mission for the same user", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput());

      const second = yield* Effect.result(
        service.createMission(createInput({ missionId: "mission_2" })),
      );

      assert.equal(second._tag, "Failure");
      if (second._tag === "Failure") {
        const error = second.failure;
        assert.equal(error._tag, "TradingMissionAlreadyActiveError");
        if (error._tag === "TradingMissionAlreadyActiveError") {
          assert.equal(error.activeMissionId, "mission_1");
          assert.equal(error.activeStatus, "initializing");
        }
      }
    }),
  );

  it.effect("allows a different user to hold their own active mission", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput());
      const other = yield* service.createMission(
        createInput({ missionId: "mission_2", userId: "user_2" }),
      );

      assert.equal(other.userId, "user_2");
    }),
  );

  it.effect("frees the mission slot once the first mission reaches a terminal", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const first = yield* service.createMission(createInput());
      yield* service.transition({
        missionId: first.id,
        to: "completed",
        expectedVersion: 1,
      });

      const second = yield* service.createMission(createInput({ missionId: "mission_2" }));
      assert.equal(second.id, "mission_2");

      const active = yield* service.findActiveMission("user_1");
      assert.ok(Option.isSome(active));
      assert.equal(Option.getOrThrow(active).id, "mission_2");
    }),
  );

  it.effect("walks the published active loop", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput());

      let version = 1;
      for (const to of ["analysing", "waiting", "executing", "position_open", "waiting"] as const) {
        const mission = yield* service.transition({
          missionId: "mission_1",
          to,
          expectedVersion: version,
        });
        assert.equal(mission.status, to);
        version += 1;
      }
    }),
  );

  it.effect("rejects an illegal transition", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      const result = yield* Effect.result(
        service.transition({ missionId: "mission_1", to: "position_open", expectedVersion: 1 }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TradingMissionTransitionError");
      }
    }),
  );

  it.effect("persists the blocked reason and refuses blocked without one", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      const missing = yield* Effect.result(
        service.transition({ missionId: "mission_1", to: "blocked", expectedVersion: 1 }),
      );
      assert.equal(missing._tag, "Failure");

      const blocked = yield* service.transition({
        missionId: "mission_1",
        to: "blocked",
        expectedVersion: 1,
        blockedReason: "cumulative_loss_limit",
      });
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.blockedReason, "cumulative_loss_limit");
    }),
  );

  it.effect("rejects a stale optimistic version", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      yield* service.transition({ missionId: "mission_1", to: "analysing", expectedVersion: 1 });

      const stale = yield* Effect.result(
        service.transition({ missionId: "mission_1", to: "waiting", expectedVersion: 1 }),
      );

      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") {
        const error = stale.failure;
        assert.equal(error._tag, "TradingMissionVersionConflictError");
        if (error._tag === "TradingMissionVersionConflictError") {
          assert.equal(error.currentVersion, 2);
          assert.equal(error.expectedVersion, 1);
        }
      }
    }),
  );

  it.effect("fails when the mission does not exist", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const result = yield* Effect.result(service.getMission("nope"));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TradingMissionNotFoundError");
      }
    }),
  );

  it.effect("reports no active mission for an unknown user", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const active = yield* service.findActiveMission("user_absent");
      assert.ok(Option.isNone(active));
    }),
  );
});
