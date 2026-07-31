import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinator, TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";

const layer = it.layer(
  TradingTurnCoordinatorLive.pipe(
    Layer.provideMerge(TradingMissionServiceLive),
    Layer.provideMerge(TradingStrategyServiceLive),
    Layer.provideMerge(TradingEventInboxLive),
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
  yield* runMigrations({ toMigrationInclusive: 35 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_harness_runs`;
  yield* sql`DELETE FROM trading_event_inbox`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
});

/** Create a mission with a published strategy so a run can start against it. */
const seedMission = Effect.gen(function* () {
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
      explanation: "wait for breakout",
    },
  });
  if (published.outcome !== "accepted") throw new Error("seed publish rejected");
});

layer("TradingTurnCoordinator", (it) => {
  it.effect("starts a run when no lease is held", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });

      assert.equal(outcome.status, "started");
    }),
  );

  it.effect("queues a second simultaneous request behind the active run (single lease)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;

      const coordinator = yield* TradingTurnCoordinator;

      // Fire two requests; the partial unique index guarantees at most one
      // non-terminal run, so exactly one starts and the other queues.
      const [first, second] = yield* Effect.all(
        [
          coordinator.requestRun({ missionId: "mission_1", cause: "market_watch_triggered" }),
          coordinator.requestRun({ missionId: "mission_1", cause: "scheduled_reassessment" }),
        ],
        { concurrency: "unbounded" },
      );

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, ["queued_behind_active_run", "started"]);

      // Exactly one non-terminal run row exists in the table.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_harness_runs
        WHERE mission_id = 'mission_1' AND status NOT IN ('completed', 'failed')
      `;
      assert.equal(rows[0]?.c, 1);
    }),
  );

  it.effect("blocks a run for a mission with no published strategy (except mission_created)", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Create the mission but do NOT publish a strategy.
      const missions = yield* TradingMissionService;
      yield* missions.createMission({
        missionId: "mission_1",
        userId: "local",
        tradingAccountId: "acct_1",
        instruction: "Trade ETH momentum",
        allocatedCapitalUsd: 1_000,
        harness,
      });

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });

      assert.equal(outcome.status, "blocked");
      if (outcome.status === "blocked") {
        assert.equal(outcome.reason, "no_active_strategy");
      }
    }),
  );

  it.effect("allows the mission_created cause without a published strategy", () =>
    Effect.gen(function* () {
      yield* migrated;
      const missions = yield* TradingMissionService;
      yield* missions.createMission({
        missionId: "mission_1",
        userId: "local",
        tradingAccountId: "acct_1",
        instruction: "Trade ETH momentum",
        allocatedCapitalUsd: 1_000,
        harness,
      });

      const coordinator = yield* TradingTurnCoordinator;
      const outcome = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "mission_created",
      });

      assert.equal(outcome.status, "started");
    }),
  );

  it.effect("allows a second run after the first completes (lease released)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission;
      const coordinator = yield* TradingTurnCoordinator;

      const first = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "market_watch_triggered",
      });
      assert.equal(first.status, "started");

      // Mark the first run completed — the lease is released.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE trading_harness_runs SET status = 'completed' WHERE mission_id = 'mission_1'`;

      const second = yield* coordinator.requestRun({
        missionId: "mission_1",
        cause: "scheduled_reassessment",
      });
      assert.equal(second.status, "started");
    }),
  );
});
