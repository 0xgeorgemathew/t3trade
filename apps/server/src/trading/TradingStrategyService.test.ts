import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { PublishTradingPlanBody } from "./Schemas.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";

const layer = it.layer(
  Layer.mergeAll(TradingMissionServiceLive, TradingStrategyServiceLive).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

/** A plan body as the eight-field document defines it (plan 29 step 4.1). */
const body = (because: string): PublishTradingPlanBody => ({
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [{ description: "Retest of 3,718 holds" }],
    urgency: "now",
  },
  stop: { method: "Below the last accepted swing low", price: 3_652 },
  target: { profitUsd: 25 },
  invalidation: [],
  reassess: { afterMinutes: 90 },
  because,
});

/**
 * The same body with `because` absent from the wire input — the shape a model
 * that skips narrative sends. It has to go through the decoder to prove the
 * schema accepts the omission, not just the publish path.
 */
const decodePlanBody = Schema.decodeUnknownSync(PublishTradingPlanBody);

const bodyWithoutBecause = (because: string): PublishTradingPlanBody => {
  const { because: _dropped, ...rest } = body(because);
  return decodePlanBody(rest);
};

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 63 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_plan_history`;
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

/** The mission row's optimistic-lock version — what a publish must quote. */
const missionVersion = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  return yield* missions.getMissionVersion("mission_1");
});

const insertWatch = (input: { readonly watchId: string; readonly status: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_watches (
        watch_id, mission_id, watch_json, status, version,
        created_at, updated_at
      ) VALUES (
        ${input.watchId}, 'mission_1',
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

layer("trading_publish_plan (§14.3)", (it) => {
  it.effect("accepts the first publish and appends the first history row", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("first thesis: breakout"),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.strategy.intent, "long");
        assert.equal(result.strategy.because, "first thesis: breakout");
        // The document carries no version of its own; the history row does.
        assert.equal("version" in result.strategy, false);
        // The server stamps updatedAt from the clock; the harness never sends it.
        assert.equal(typeof result.strategy.updatedAt, "number");
      }

      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.ok(Option.isSome(current));
      assert.equal(Option.getOrThrow(current).because, "first thesis: breakout");
    }),
  );

  it.effect("bumps the mission row's optimistic-lock version on acceptance", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      assert.equal(yield* missionVersion, 1);
      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("v1 thesis"),
      });
      assert.equal(yield* missionVersion, 2);

      // The revision goes through on the fresh version, and bumps it again.
      const second = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 2,
        strategy: body("v2 thesis"),
      });
      assert.equal(second.outcome, "accepted");
      assert.equal(yield* missionVersion, 3);

      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.equal(Option.getOrThrow(current).because, "v2 thesis");
    }),
  );

  // THE headline test of plan 29 step 4.2: a revision revises the plan in
  // place, and the triggers armed under the previous read keep working. The
  // model cancels or replaces what it no longer wants; the publish does not
  // decide that for it.
  it.effect("watches survive a plan revision", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("v1"),
      });

      yield* insertWatch({ watchId: "watch_active", status: "active" });
      yield* insertWatch({ watchId: "watch_triggered", status: "triggered" });
      yield* insertWatch({ watchId: "watch_cancelled", status: "cancelled" });

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 2,
        strategy: body("v2"),
      });

      assert.equal(result.outcome, "accepted");
      assert.equal(yield* watchStatus("watch_active"), "active");
      assert.equal(yield* watchStatus("watch_triggered"), "triggered");
      assert.equal(yield* watchStatus("watch_cancelled"), "cancelled");
    }),
  );

  it.effect("rejects a stale mission version without overwriting current state", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("v1 thesis"),
      });

      const stale = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        // The publish above bumped the row to 2; quoting the version read
        // before it is the stale case.
        expectedMissionVersion: 1,
        strategy: body("stale overwrite"),
      });

      assert.equal(stale.outcome, "rejected");
      if (stale.outcome === "rejected") {
        assert.equal(stale.reason, "stale_mission_state");
        assert.equal(stale.currentVersion, 2);
      }

      // The accepted v1 still stands.
      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.equal(Option.getOrThrow(current).because, "v1 thesis");
    }),
  );

  it.effect("rejects a version ahead of the server's", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const ahead = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 7,
        strategy: body("from the future"),
      });

      assert.equal(ahead.outcome, "rejected");
      if (ahead.outcome === "rejected") {
        assert.equal(ahead.reason, "stale_mission_state");
        assert.equal(ahead.currentVersion, 1);
      }
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
        expectedMissionVersion: 2,
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
          expectedMissionVersion: 1,
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

  it.effect("moves the mission out of analysing on publish", () =>
    Effect.gen(function* () {
      yield* setup;
      const missions = yield* TradingMissionService;
      const strategies = yield* TradingStrategyService;

      // The reactor's first-run advance leaves a fresh mission in analysing.
      yield* missions.transition({
        missionId: "mission_1",
        to: "analysing",
        expectedVersion: yield* missionVersion,
      });

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: yield* missionVersion,
        strategy: body("done analysing"),
      });

      const mission = yield* missions.getMission("mission_1");
      assert.equal(mission.status, "waiting");
    }),
  );

  // -------------------------------------------------------------------------
  // The target leg. `target.profitUsd` is the one published number the runtime
  // acts on unprompted — it arms a `pnl_above` watch at it — so it is the one
  // worth checking before the publish lands.
  // -------------------------------------------------------------------------

  const withTarget = (
    because: string,
    target: Partial<PublishTradingPlanBody["target"]>,
  ): PublishTradingPlanBody => {
    const base = body(because);
    return { ...base, target: { ...base.target, ...target } };
  };

  // A short plan and a stand-aside publish through the same tool under the same
  // checks — the intent is mode-agnostic on purpose. What has to survive the
  // trip is what the plan says it is: the side it works, or standing aside.
  it.effect("round-trips a short plan and a stand-aside plan without degrading either", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const short = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: {
          ...body("fading the extended leg"),
          intent: "short",
        },
      });
      assert.equal(short.outcome, "accepted");

      const aside = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: yield* missionVersion,
        strategy: {
          ...withTarget("costs exceed the move on offer", {}),
          intent: "stand_aside",
          entry: { triggers: [], urgency: "now" },
          target: {},
        },
      });
      assert.equal(aside.outcome, "accepted");

      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.ok(Option.isSome(current));
      const strategy = Option.getOrThrow(current);
      assert.equal(strategy.intent, "stand_aside");
      assert.equal(strategy.target.profitUsd, undefined);
    }),
  );

  // Plan 29 step 3.2: the target-basis ceremony is gone. Nothing grades where
  // the target came from any more — a target with no derivation beside it, or
  // one that disagrees with its own reasoning, publishes like any other, and
  // the next wake is where the number is weighed.
  it.effect("publishes a target no derivation stands beside", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: withTarget("no derivation beside the rung", { profitUsd: 90 }),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.deepEqual(result.warnings, []);
      }
    }),
  );

  // The $1.70 on ~$2,000 of notional that started all this: derived correctly
  // and under the ~$2.00 it cost to open and close. Cost is not graded at
  // publish any more (plan 29 step 3.1) — a below-cost target rides through
  // clean, and the observation's cost context is where it is weighed.
  it.effect("accepts a below-cost target with no cost warning", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: withTarget("too small for the round trip", { profitUsd: 1.7 }),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.warnings.length, 0);
      }
    }),
  );

  it.effect("accepts a justified target with no warnings", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("justified"),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.deepEqual(result.warnings, []);
      }
    }),
  );

  // The plan rides on every wakeup for the mission's life, so unbounded prose
  // here is unbounded prose there — which is what made every wake for a
  // verbose mission fail on size.
  it.effect("clips long prose to the published bound and says which fields it clipped", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const verbose = body("verbose");
      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: {
          ...verbose,
          because: "b".repeat(5_000),
          entry: {
            ...verbose.entry,
            triggers: [{ description: "d".repeat(5_000) }],
          },
        },
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.strategy.because.length, 601);
        assert.equal(result.strategy.entry.triggers[0]?.description.length, 601);
        // Short fields are untouched.
        assert.equal(result.strategy.stop.method, "Below the last accepted swing low");
        assert.deepEqual([...result.warnings].sort(), [
          "because truncated to 600 chars",
          "entry.triggers[0].description truncated to 600 chars",
        ]);
      }
    }),
  );

  // The observed failure, in its new shape: the model omits the narrative and
  // the toolkit would have rejected the whole call with `Missing key`, costing
  // the turn. `because` decodes as "" instead.
  it.effect("accepts a plan that omits because, decoding it as empty prose", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: bodyWithoutBecause("lenient"),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.strategy.because, "");
      }
    }),
  );

  // `getCurrentStrategy` answers what the mission believes now. A harness that
  // has republished three times could not see what it believed before, which is
  // what "was the last target the right rung?" needs.
  it.effect("publishes every plan it has ever published, newest first", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("first thesis"),
      });
      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: yield* missionVersion,
        strategy: body("second thesis"),
      });

      const history = yield* strategies.listStrategyVersions("mission_1");

      assert.equal(history.length, 2);
      assert.equal(history[0]?.version, 2);
      assert.equal(history[1]?.version, 1);
      // The skeleton, not the whole plan: enough to score a target against.
      assert.equal(history[0]?.targetProfitUsd, body("x").target.profitUsd);
      assert.equal(history[0]?.intent, "long");
      assert.equal(history[0]?.because, "second thesis");
    }),
  );

  it.effect("skips a plan whose stored JSON no longer decodes", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;
      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedMissionVersion: 1,
        strategy: body("readable"),
      });

      // A plan published before a field became required still sits in this
      // table. One unreadable row should cost that row, not the history.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_plan_history (mission_id, version, strategy_json, created_at)
        VALUES ('mission_1', 2, '{"legacy":true}', 9999)
      `;

      const history = yield* strategies.listStrategyVersions("mission_1");
      assert.equal(history.length, 1);
      assert.equal(history[0]?.version, 1);
    }),
  );
});
