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

const body = (name: string): PublishTradingPlanBody => ({
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
    targetProfitUsd: 25,
    targetProfitBasis: {
      measurement: "excursion_quantile",
      timeframe: "5m",
      lookbackBars: 120,
      // (46.25 / 3,700) x 2,000 of notional = the 25 USD published above.
      // Publishing checks that arithmetic, so the two cannot drift apart.
      measuredMoveUsd: 46.25,
      expectedHoldBars: 10,
      referencePrice: 3_700,
      targetPriceMovePercent: 1.25,
      positionNotionalUsd: 2_000,
      historicalHitRatePercent: 50,
      rationale: "Median 10-bar upside excursion over the last 120 5m bars is 46.25 USD of price.",
    },
  },
  exitConditions: [{ description: "5m close under 3,690" }],
  abandonmentConditions: [],
  reentryConditions: [],
  currentAction: "waiting",
  explanation: "Waiting for the retest.",
});

/**
 * The same body with both `explanation` keys absent from the wire input — the
 * shape the model actually sent when `trading_publish_plan` failed with
 * `Missing key ["strategy"]["explanation"]`. It has to go through the decoder
 * to prove the schema accepts the omission, not just the publish path.
 */
const decodePlanBody = Schema.decodeUnknownSync(PublishTradingPlanBody);

const bodyWithoutExplanations = (name: string): PublishTradingPlanBody => {
  const { explanation: _top, entryPlan, ...rest } = body(name);
  const { explanation: _entry, ...entryPlanRest } = entryPlan;
  return decodePlanBody({ ...rest, entryPlan: entryPlanRest });
};

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 47 });
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

layer("trading_publish_plan (§14.3)", (it) => {
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

  // -------------------------------------------------------------------------
  // Target validation. `targetProfitUsd` is the one published number the
  // runtime acts on unprompted — it arms a `pnl_above` watch at it — so it is
  // the one worth checking before the publish lands.
  // -------------------------------------------------------------------------

  const withProtection = (
    name: string,
    protection: Partial<PublishTradingPlanBody["protection"]>,
  ): PublishTradingPlanBody => {
    const base = body(name);
    return { ...base, protection: { ...base.protection, ...protection } };
  };

  // A range scalp is published through the same tool under the same checks —
  // the target validation is mode-agnostic on purpose. What has to survive the
  // trip is the pair that says what kind of trade it is: `range_reversion` with
  // a boundary on each side, which is direction `both`.
  it.effect("round-trips a range_reversion strategy without degrading it", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;
      const base = body("ETH 1m range reversion");

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: {
          ...base,
          mode: "range_reversion",
          direction: "both",
          timeframes: ["1m"],
          belief: { ...base.belief, regime: "ranging", summary: "Range holding, $7.30 tall." },
        },
      });

      assert.equal(result.outcome, "accepted");
      const current = yield* strategies.getCurrentStrategy("mission_1");
      assert.ok(Option.isSome(current));
      const strategy = Option.getOrThrow(current);
      assert.equal(strategy.mode, "range_reversion");
      assert.equal(strategy.direction, "both");
    }),
  );

  it.effect("rejects a target published with no basis at all", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: withProtection("no basis", { targetProfitBasis: undefined }),
      });

      assert.equal(result.outcome, "rejected");
      if (result.outcome === "rejected") {
        assert.equal(result.reason, "target_not_justified");
        assert.match(result.detail ?? "", /targetProfitBasis/);
        assert.equal(result.currentVersion, 0);
      }

      // A rejected publish leaves the mission where it was.
      assert.ok(Option.isNone(yield* strategies.getCurrentStrategy("mission_1")));
    }),
  );

  it.effect("rejects a target the basis next to it does not produce", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      // The basis says (46.25 / 3,700) x 2,000 = 25; the target claims 90.
      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: withProtection("mismatched", { targetProfitUsd: 90 }),
      });

      assert.equal(result.outcome, "rejected");
      if (result.outcome === "rejected") {
        assert.equal(result.reason, "target_not_justified");
        assert.match(result.detail ?? "", /does not follow from the basis/);
      }
    }),
  );

  // The $1.70 on ~$2,000 of notional that started all this: derived correctly
  // and under the ~$2.00 it cost to open and close. The cost floor is modeled
  // from the fallback fee rate and cannot see the spread, so it reports itself
  // in-band rather than refusing the publish.
  it.effect("accepts a below-cost target but says so in the warnings", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: withProtection("too small", {
          targetProfitUsd: 1.7,
          targetProfitBasis: {
            measurement: "excursion_quantile",
            timeframe: "1m",
            lookbackBars: 120,
            measuredMoveUsd: 1.7,
            expectedHoldBars: 10,
            referencePrice: 2_000,
            targetPriceMovePercent: 0.085,
            positionNotionalUsd: 2_000,
            rationale: "10-bar p75 upside excursion on a quiet 1m window.",
          },
        }),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0] ?? "", /round-trip cost/);
      }
    }),
  );

  it.effect("accepts a justified target with no warnings", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
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
        expectedVersion: 0,
        strategy: {
          ...verbose,
          explanation: "e".repeat(5_000),
          belief: { ...verbose.belief, summary: "s".repeat(5_000) },
        },
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.strategy.explanation.length, 601);
        assert.equal(result.strategy.belief.summary.length, 601);
        // Short fields are untouched.
        assert.equal(result.strategy.entryPlan.explanation, "Enter on a retest that holds.");
        assert.deepEqual([...result.warnings].sort(), [
          "belief.summary truncated to 600 chars",
          "explanation truncated to 600 chars",
        ]);
      }
    }),
  );

  // The observed failure: the model omitted `strategy.explanation` and the
  // toolkit rejected the whole call with `Missing key`, costing the turn.
  it.effect("accepts a plan that omits its explanation, filling it from the belief", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      const result = yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: bodyWithoutExplanations("lenient"),
      });

      assert.equal(result.outcome, "accepted");
      if (result.outcome === "accepted") {
        assert.equal(result.strategy.explanation, "Breakout confirmed on rising relative volume.");
        assert.equal(
          result.strategy.entryPlan.explanation,
          "Breakout confirmed on rising relative volume.",
        );
      }
    }),
  );
  // `getCurrentStrategy` answers what the mission believes now. A harness that
  // has republished three times could not see what it believed before, which is
  // what "was the last target the right rung?" needs.
  it.effect("publishes every version it has ever published, newest first", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;

      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("first thesis"),
      });
      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 1,
        strategy: body("second thesis"),
      });

      const history = yield* strategies.listStrategyVersions("mission_1");

      assert.equal(history.length, 2);
      assert.equal(history[0]?.version, 2);
      assert.equal(history[1]?.version, 1);
      // The skeleton, not the whole strategy: enough to score a target against.
      assert.equal(history[0]?.targetProfitUsd, body("x").protection.targetProfitUsd);
      assert.equal(history[0]?.targetProfitBasis?.measurement, "excursion_quantile");
      assert.equal(history[0]?.timeframe, "5m");
      assert.ok((history[0]?.beliefSummary ?? "").length > 0);
    }),
  );

  it.effect("skips a version whose stored JSON no longer decodes", () =>
    Effect.gen(function* () {
      yield* setup;
      const strategies = yield* TradingStrategyService;
      yield* strategies.publishMomentumStrategy({
        missionId: "mission_1",
        expectedVersion: 0,
        strategy: body("readable"),
      });

      // A strategy published before a field became required still sits in this
      // table. One unreadable row should cost that row, not the history.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
        VALUES ('mission_1', 2, '{"legacy":true}', 9999)
      `;

      const history = yield* strategies.listStrategyVersions("mission_1");
      assert.equal(history.length, 1);
      assert.equal(history[0]?.version, 1);
    }),
  );
});
