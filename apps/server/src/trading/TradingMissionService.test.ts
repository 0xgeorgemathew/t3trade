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
  yield* runMigrations();
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
});

/**
 * Every table `deleteMission` claims to clear, with one row per mission.
 *
 * Written as data rather than as fifteen inserts so a table added to the
 * delete without being added here fails loudly on the count, and a table added
 * to the schema without being added to the delete fails on the assertion.
 */
const MISSION_SCOPED_ROWS: ReadonlyArray<{
  readonly table: string;
  readonly columns: string;
  readonly values: string;
}> = [
  {
    table: "trading_watches",
    columns: "watch_id, strategy_version, watch_json, status, version, created_at, updated_at",
    values: '\'w1\', 1, \'{"type":"position_update","market":"ETH"}\', \'active\', 1, 0, 0',
  },
  {
    table: "trading_harness_runs",
    columns: "run_id, cause, status, started_at, created_at",
    values: "'r1', 'mission_created', 'completed', 0, 0",
  },
  {
    table: "trading_event_inbox",
    columns: "event_id, category, deduplication_key, payload_json, occurred_at, status, created_at",
    values: "'e1', 'market', 'k1', '{}', 0, 'pending', 0",
  },
  {
    table: "trading_execution_records",
    columns:
      "execution_id, strategy_version, execution_sequence, action_type, cloid, idempotency_key, market, side, size, limit_price, time_in_force, reduce_only, signer_address, status, order_results_json, created_at, updated_at",
    values:
      "'x1', 1, 1, 'entry', 'c1', 'i1', 'ETH', 'buy', 1, 100, 'Ioc', 0, '0xabc', 'settled', '[]', 0, 0",
  },
  {
    table: "trading_orders",
    columns: "cloid, order_id, market, side, limit_price, remaining_size, reduce_only, observed_at",
    values: "'c1', 1, 'ETH', 'buy', 100, 0, 0, 0",
  },
  {
    table: "trading_fills",
    columns:
      "fill_id, execution_id, cloid, order_id, market, side, filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at",
    values: "'f1', 'x1', 'c1', 1, 'ETH', 'buy', 1, 100, 0.1, 'USDC', 0, 0",
  },
  {
    table: "trading_position_snapshots",
    columns: "market, size, entry_price, unrealised_pnl, margin_used, protected_size, observed_at",
    values: "'ETH', 0, 100, 0, 0, 0, 0",
  },
  {
    table: "trading_risk_reservations",
    columns:
      "reservation_id, execution_id, cloid, action_type, reserved_risk_usd, status, reserved_at",
    values: "'rr1', 'x1', 'c1', 'entry', 5, 'released', 0",
  },
  {
    table: "trading_closed_trades",
    columns:
      "market, opened_at, closed_at, hold_millis, direction, size, entry_price, exit_price, realized_pnl, fees_paid, net_pnl, peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak, fill_count",
    values: "'ETH', 0, 60000, 60000, 'long', 1, 100, 101, 1, 0.1, 0.9, 1, 0, 0, 1",
  },
  {
    table: "trading_account_snapshots",
    columns:
      "master_address, account_value, margin_used, withdrawable, positions_json, observed_at",
    values: "'0xabc', 1000, 0, 1000, '[]', 0",
  },
  {
    table: "trading_account_observations",
    columns: "account_value, observed_at",
    values: "1000, 0",
  },
  {
    table: "momentum_strategy_versions",
    columns: "version, strategy_json, created_at",
    values: "1, '{}', 0",
  },
];

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

  // The service's pre-insert check is a race away from being wrong: two
  // concurrent creates both read "no active mission" and both insert. The
  // partial unique index from migration 035 is what actually makes the
  // invariant true, so it is asserted against a raw insert that skips the
  // service entirely — the only way to prove the database, not the read, is
  // holding the line.
  it.effect("refuses a second active mission row at the database", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      const sql = yield* SqlClient.SqlClient;

      yield* service.createMission(createInput());

      const smuggled = yield* Effect.result(sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          strategy_family, harness_json, status, control_json,
          authority_version, strategy_version, version, created_at, updated_at
        ) VALUES (
          'mission_smuggled', 'user_1', 'acct_1', 'Trade ETH momentum', 'ETH',
          'momentum', '{}', 'waiting', '{}', 1, 0, 1, 0, 0
        )
      `);

      assert.equal(smuggled._tag, "Failure");

      // And the one mission that does hold the slot is still the one the
      // service reports, deterministically.
      const active = yield* service.findActiveMission("user_1");
      assert.ok(Option.isSome(active));
      assert.equal(Option.getOrThrow(active).id, "mission_1");
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

  /**
   * The authorization query stops seeing a mission the moment it ends, which
   * left a thread whose mission had finished unable to learn anything about it.
   * This is the read that answers "what happened to mine"; it grants nothing.
   */
  it.effect("finds the last mission a thread held, terminal ones included", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const mission = yield* service.createMission(createInput());
      const version = yield* service.getMissionVersion(mission.id);
      yield* service.transition({ missionId: mission.id, to: "revoked", expectedVersion: version });

      // The binding query no longer sees it...
      assert.isTrue(Option.isNone(yield* service.findMissionByThreadId("thread_1")));

      // ...but the history read does, with the status it ended in.
      const last = yield* service.findLastMissionByThreadId("thread_1");
      assert.isTrue(Option.isSome(last));
      assert.equal(Option.getOrThrow(last).id, "mission_1");
      assert.equal(Option.getOrThrow(last).status, "revoked");
    }),
  );

  it.effect("finds nothing for a thread that never held a mission", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      assert.isTrue(Option.isNone(yield* service.findLastMissionByThreadId("thread_unknown")));
    }),
  );

  // Deletion still exists for orphans — missions whose thread is gone — and it
  // takes every table keyed to the mission with it. Settled missions with a
  // surviving thread are never deleted any more (plan 27 H1).
  it.effect("deletes every row keyed to the mission", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      for (const row of MISSION_SCOPED_ROWS) {
        yield* sql.unsafe(
          `INSERT INTO ${row.table} (mission_id, ${row.columns}) VALUES ('mission_1', ${row.values})`,
        );
      }

      yield* service.deleteMission("mission_1");

      for (const row of MISSION_SCOPED_ROWS) {
        const remaining = yield* sql.unsafe<{ readonly c: number }>(
          `SELECT COUNT(*) AS c FROM ${row.table} WHERE mission_id = 'mission_1'`,
        );
        assert.equal(remaining[0]?.c, 0, `${row.table} still holds rows for the deleted mission`);
      }

      const missions = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_missions WHERE mission_id = 'mission_1'
      `;
      assert.equal(missions[0]?.c, 0);
      const authorities = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_authority_versions WHERE mission_id = 'mission_1'
      `;
      assert.equal(authorities[0]?.c, 0);
    }),
  );

  it.effect("is a no-op for a mission that is already gone", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.deleteMission("mission_never_existed");
    }),
  );

  // The startup sweep's input: only orphans. A settled mission with a
  // surviving thread is the permanent record of what was traded (plan 27 H1).
  it.effect("lists only missions whose thread is gone", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput({ missionId: "mission_live" }));
      yield* service.createMission(createInput({ missionId: "mission_done", userId: "user_2" }));
      yield* sql`
        UPDATE trading_missions SET status = 'revoked' WHERE mission_id = 'mission_done'
      `;
      // Both missions' threads were never projected, so nothing can ever wake,
      // settle, or display either of them — terminal or not, both are orphans.
      const deletable = yield* service.listDeletableMissions();
      assert.deepEqual(deletable.map((m) => m.missionId).sort(), ["mission_done", "mission_live"]);

      // Give the live mission a thread and it stops being deletable. The
      // revoked one keeps a thread too and stops being deletable as well:
      // terminal status alone no longer qualifies.
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('p1', 'p', '/tmp/p', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at
        ) VALUES ('thread_1', 'p1', 't', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `;
      const stillDeletable = yield* service.listDeletableMissions();
      assert.deepEqual(
        stillDeletable.map((m) => m.missionId),
        [],
      );
    }),
  );
});
