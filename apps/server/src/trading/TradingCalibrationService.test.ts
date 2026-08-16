/**
 * The read behind the calibration: closed trades joined to the claim each was
 * taken under.
 *
 * The arithmetic is proven in `calibration.test.ts`. What this pins is the
 * join — that a trade is graded against the hit rate the strategy version
 * claimed WHEN IT CLOSED, not against whatever the mission believes now, which
 * is the only thing that makes the verdict mean anything after a republish.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MIN_CALIBRATION_TRADES } from "@t3tools/trading-contracts/calibration";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  TradingCalibrationService,
  TradingCalibrationServiceLive,
} from "./TradingCalibrationService.ts";

const layer = it.layer(
  TradingCalibrationServiceLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const MISSION = "mission_calibration";

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // 60 adds the stop-placement columns the read now selects.
  yield* runMigrations({ toMigrationInclusive: 65 });
  yield* sql`DELETE FROM trading_closed_trades`;
  yield* sql`DELETE FROM trading_plan_history`;
  yield* sql`DELETE FROM trading_missions`;
});

/** A mission row, for the account-wide read (plan 27 H4) to join through. */
const insertMission = (missionId: string, tradingAccountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json,
        authority_version, version, created_at, updated_at
      ) VALUES (
        ${missionId}, ${`${missionId}_user`}, ${tradingAccountId}, 'trade', 'ETH',
        '{"threadId":"t"}', 'revoked', '{}', 1, 1, 0, 0
      )
    `;
  });

/** A strategy version carrying a published target. */
const insertStrategy = (version: number, targetProfitUsd: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Written as text: the calibration read pulls the target out of this
    // column, so the row only has to carry that.
    const json = `{"target":{"profitUsd":${targetProfitUsd}}}`;
    yield* sql`
      INSERT INTO trading_plan_history (mission_id, version, strategy_json, created_at)
      VALUES (${MISSION}, ${version}, ${json}, ${version * 1_000})
    `;
  });

const insertTrade = (input: {
  readonly closedAt: number;
  readonly strategyVersion: number | null;
  readonly targetProfitUsd: number | null;
  readonly peak: number;
  readonly netPnl: number;
  readonly missionId?: string;
  readonly stopNoiseFloorMultiple?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_closed_trades (
        mission_id, market, opened_at, closed_at, hold_millis, direction, size,
        entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
        peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak,
        fill_count, strategy_version, target_profit_usd, stop_noise_floor_multiple
      ) VALUES (
        ${input.missionId ?? MISSION}, 'ETH', 0, ${input.closedAt}, 60000, 'long', 1,
        3000, 3010, ${input.netPnl + 1}, 1, ${input.netPnl},
        ${input.peak}, -2, 0, 2, ${input.strategyVersion}, ${input.targetProfitUsd},
        ${input.stopNoiseFloorMultiple ?? null}
      )
    `;
  });

layer("TradingCalibrationService", (it) => {
  it.effect("grades each trade against the version it closed under", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertStrategy(1, 10);
      yield* insertStrategy(2, 30);

      // Five trades under v1, all of which touched its $10 target.
      for (let i = 0; i < MIN_CALIBRATION_TRADES; i++) {
        yield* insertTrade({
          closedAt: 1_000 + i,
          strategyVersion: 1,
          targetProfitUsd: 10,
          peak: 12,
          netPnl: 5,
        });
      }
      // Five under v2, none of which came near its $30 one.
      for (let i = 0; i < MIN_CALIBRATION_TRADES; i++) {
        yield* insertTrade({
          closedAt: 2_000 + i,
          strategyVersion: 2,
          targetProfitUsd: 30,
          peak: 8,
          netPnl: -1,
        });
      }

      const calibration = yield* TradingCalibrationService;
      const read = yield* calibration.read({ missionId: MISSION });

      // Newest version first. Nothing publishes a claimed hit rate any more
      // (the basis went with plan 29 step 3.2), so every verdict grades the
      // observed rate alone — grouped by the version it closed under.
      assert.equal(read.entries[0]?.strategyVersion, 2);
      assert.equal(read.entries[0]?.claimedHitRatePercent, undefined);
      assert.equal(read.entries[0]?.observedHitRatePercent, 0);
      assert.equal(read.entries[0]?.verdict, "as_claimed");

      assert.equal(read.entries[1]?.strategyVersion, 1);
      assert.equal(read.entries[1]?.claimedHitRatePercent, undefined);
      assert.equal(read.entries[1]?.observedHitRatePercent, 100);
      assert.equal(read.entries[1]?.verdict, "as_claimed");

      assert.equal(read.tradeCount, MIN_CALIBRATION_TRADES * 2);
      assert.equal(read.overallReachedTargetPercent, 50);
    }),
  );

  it.effect("states when no claimed hit rate was published", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertStrategy(1, 10);
      for (let i = 0; i < MIN_CALIBRATION_TRADES; i++) {
        yield* insertTrade({
          closedAt: 1_000 + i,
          strategyVersion: 1,
          targetProfitUsd: 10,
          peak: 12,
          netPnl: 5,
        });
      }

      const calibration = yield* TradingCalibrationService;
      const read = yield* calibration.read({ missionId: MISSION });

      assert.equal(read.entries[0]?.claimedHitRatePercent, undefined);
      assert.equal(read.entries[0]?.observedHitRatePercent, 100);
      assert.match(read.entries[0]?.note ?? "", /no claimed hit rate was published/);
    }),
  );

  it.effect("survives a trade whose strategy version no longer exists", () =>
    Effect.gen(function* () {
      yield* migrated;
      // The join is a LEFT JOIN on purpose: a trade outlives the row it points
      // at if the versions table is ever pruned, and losing the claim should
      // cost the claim, not the read.
      for (let i = 0; i < MIN_CALIBRATION_TRADES; i++) {
        yield* insertTrade({
          closedAt: 1_000 + i,
          strategyVersion: 7,
          targetProfitUsd: 10,
          peak: 12,
          netPnl: 5,
        });
      }

      const calibration = yield* TradingCalibrationService;
      const read = yield* calibration.read({ missionId: MISSION });

      assert.equal(read.entries[0]?.strategyVersion, 7);
      assert.equal(read.entries[0]?.claimedHitRatePercent, undefined);
      assert.equal(read.entries[0]?.observedHitRatePercent, 100);
    }),
  );

  // Plan 27 H4: settled sibling missions keep their rows now, and their trades
  // are the sample that stops per-mission stop-placement reads from being
  // permanently `insufficient_sample` at n=1.
  it.effect("counts a sibling mission's stops without stealing its versions", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertMission(MISSION, "acct_1");
      yield* insertMission("mission_sibling", "acct_1");
      yield* insertMission("mission_stranger", "acct_other");
      yield* insertStrategy(1, 10);

      // This mission measured one stop of its own...
      yield* insertTrade({
        closedAt: 1_000,
        strategyVersion: 1,
        targetProfitUsd: 10,
        peak: 12,
        netPnl: 5,
        stopNoiseFloorMultiple: 2.0,
      });
      // ...the sibling on the same account measured four more, all inside the
      // noise floor and losing...
      for (let i = 0; i < 4; i++) {
        yield* insertTrade({
          closedAt: 2_000 + i,
          missionId: "mission_sibling",
          strategyVersion: 9,
          targetProfitUsd: 30,
          peak: 2,
          netPnl: -3,
          stopNoiseFloorMultiple: 0.5,
        });
      }
      // ...and another account's mission is nobody's business here.
      yield* insertTrade({
        closedAt: 3_000,
        missionId: "mission_stranger",
        strategyVersion: 2,
        targetProfitUsd: 10,
        peak: 12,
        netPnl: 5,
        stopNoiseFloorMultiple: 0.1,
      });

      const calibration = yield* TradingCalibrationService;
      const read = yield* calibration.read({ missionId: MISSION });

      // The sibling's strategy version never becomes an entry: a version
      // number means nothing outside its own mission.
      assert.deepEqual(
        read.entries.map((entry) => entry.strategyVersion),
        [1],
      );
      assert.equal(read.tradeCount, 1);

      // But its measured stops complete the account-wide sample: 5 measured,
      // 4 inside the floor, and all 4 losers avoidable.
      assert.equal(read.stopPlacement.measuredTrades, 5);
      assert.equal(read.stopPlacement.stopsInsideNoiseFloorPercent, 80);
      assert.equal(read.stopPlacement.avoidableStopPercent, 100);
    }),
  );

  it.effect("answers a mission that has never closed a trade without recommending anything", () =>
    Effect.gen(function* () {
      yield* migrated;
      const calibration = yield* TradingCalibrationService;
      const read = yield* calibration.read({ missionId: MISSION });

      assert.equal(read.tradeCount, 0);
      assert.deepEqual([...read.entries], []);
      assert.match(read.recommendation, /not enough to calibrate/);
    }),
  );
});
