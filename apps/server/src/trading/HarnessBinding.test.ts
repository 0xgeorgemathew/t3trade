import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";

const layer = it.layer(
  TradingMissionServiceLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 63 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
});

const createMission = Effect.gen(function* () {
  const service = yield* TradingMissionService;
  return yield* service.createMission({
    missionId: "mission_1",
    userId: "user_1",
    tradingAccountId: "acct_1",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    harness,
  });
});

layer("harness binding immutability (§10.2)", (it) => {
  it.effect("persists the binding at mission creation", () =>
    Effect.gen(function* () {
      yield* migrated;
      const mission = yield* createMission;

      assert.deepStrictEqual(mission.harness, harness);
    }),
  );

  it.effect("rejects a provider change while the mission is active", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      const mission = yield* createMission;

      const result = yield* Effect.result(
        service.updateHarnessBinding({
          missionId: mission.id,
          expectedVersion: 1,
          harness: { ...harness, provider: "codex" },
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        const error = result.failure;
        assert.equal(error._tag, "TradingHarnessBindingImmutableError");
        if (error._tag === "TradingHarnessBindingImmutableError") {
          assert.deepStrictEqual([...error.changedFields], ["provider"]);
        }
      }

      // The stored binding is untouched.
      const reread = yield* service.getMission(mission.id);
      assert.equal(reread.harness.provider, "claude");
    }),
  );

  it.effect("rejects a providerInstanceId or threadId change while active", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* createMission;

      for (const change of [
        { providerInstanceId: "instance_2" },
        { threadId: "thread_2" },
      ] as const) {
        const result = yield* Effect.result(
          service.updateHarnessBinding({
            missionId: "mission_1",
            expectedVersion: 1,
            harness: { ...harness, ...change },
          }),
        );
        assert.equal(result._tag, "Failure", `expected ${Object.keys(change)[0]} to be frozen`);
      }
    }),
  );

  it.effect("rejects a binding change in every active status, including suspended ones", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* createMission;

      // initializing -> analysing -> paused: paused still holds authority.
      yield* service.transition({ missionId: "mission_1", to: "analysing", expectedVersion: 1 });
      yield* service.transition({ missionId: "mission_1", to: "paused", expectedVersion: 2 });

      const result = yield* Effect.result(
        service.updateHarnessBinding({
          missionId: "mission_1",
          expectedVersion: 3,
          harness: { ...harness, provider: "opencode" },
        }),
      );

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("allows rebinding once the mission reaches a permanent terminal", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* createMission;

      yield* service.transition({ missionId: "mission_1", to: "revoked", expectedVersion: 1 });

      const rebound = yield* service.updateHarnessBinding({
        missionId: "mission_1",
        expectedVersion: 2,
        harness: { ...harness, provider: "codex" },
      });

      assert.equal(rebound.harness.provider, "codex");
    }),
  );

  it.effect("allows ProviderService runtime bookkeeping while the mission is active", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* createMission;

      // Session id, resume cursor, model, and availability are not identity.
      const updated = yield* service.updateHarnessBinding({
        missionId: "mission_1",
        expectedVersion: 1,
        harness: {
          ...harness,
          providerSessionId: "session_1",
          resumeCursor: "cursor_1",
          model: "claude-opus-5",
          status: "unavailable",
        },
      });

      assert.equal(updated.harness.providerSessionId, "session_1");
      assert.equal(updated.harness.resumeCursor, "cursor_1");
      assert.equal(updated.harness.status, "unavailable");
      assert.equal(updated.harness.provider, "claude");
    }),
  );

  it.effect("rejects a stale version on a binding update", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* createMission;

      yield* service.updateHarnessBinding({
        missionId: "mission_1",
        expectedVersion: 1,
        harness: { ...harness, providerSessionId: "session_1" },
      });

      const stale = yield* Effect.result(
        service.updateHarnessBinding({
          missionId: "mission_1",
          expectedVersion: 1,
          harness: { ...harness, providerSessionId: "session_2" },
        }),
      );

      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") {
        assert.equal(stale.failure._tag, "TradingMissionVersionConflictError");
      }
    }),
  );
});
