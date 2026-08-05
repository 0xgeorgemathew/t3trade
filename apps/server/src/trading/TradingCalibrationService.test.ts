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
  yield* runMigrations({ toMigrationInclusive: 47 });
  yield* sql`DELETE FROM trading_closed_trades`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
});

/** A strategy version carrying the hit rate its basis claimed. */
const insertStrategy = (version: number, targetProfitUsd: number, claimedHitRate: number | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Written as text: the calibration read pulls two fields out of this column
    // with `json_extract`, so the row only has to carry those.
    const basis = claimedHitRate === null ? "{}" : `{"historicalHitRatePercent":${claimedHitRate}}`;
    const json = `{"protection":{"targetProfitUsd":${targetProfitUsd},"targetProfitBasis":${basis}}}`;
    yield* sql`
      INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
      VALUES (${MISSION}, ${version}, ${json}, ${version * 1_000})
    `;
  });

const insertTrade = (input: {
  readonly closedAt: number;
  readonly strategyVersion: number | null;
  readonly targetProfitUsd: number | null;
  readonly peak: number;
  readonly netPnl: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_closed_trades (
        mission_id, market, opened_at, closed_at, hold_millis, direction, size,
        entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
        peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak,
        fill_count, strategy_version, target_profit_usd
      ) VALUES (
        ${MISSION}, 'ETH', 0, ${input.closedAt}, 60000, 'long', 1,
        3000, 3010, ${input.netPnl + 1}, 1, ${input.netPnl},
        ${input.peak}, -2, 0, 2, ${input.strategyVersion}, ${input.targetProfitUsd}
      )
    `;
  });

layer("TradingCalibrationService", (it) => {
  it.effect("grades each trade against the claim of the version it closed under", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertStrategy(1, 10, 50);
      yield* insertStrategy(2, 30, 25);

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

      // Newest version first.
      assert.equal(read.entries[0]?.strategyVersion, 2);
      assert.equal(read.entries[0]?.claimedHitRatePercent, 25);
      assert.equal(read.entries[0]?.observedHitRatePercent, 0);
      assert.equal(read.entries[0]?.verdict, "optimistic");

      assert.equal(read.entries[1]?.strategyVersion, 1);
      assert.equal(read.entries[1]?.claimedHitRatePercent, 50);
      assert.equal(read.entries[1]?.observedHitRatePercent, 100);
      assert.equal(read.entries[1]?.verdict, "conservative");

      assert.equal(read.tradeCount, MIN_CALIBRATION_TRADES * 2);
      assert.equal(read.overallReachedTargetPercent, 50);
    }),
  );

  it.effect("reads no claim from a basis that published none", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertStrategy(1, 10, null);
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
      assert.match(read.entries[0]?.note ?? "", /claimed no hit rate/);
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
