/**
 * TradingCalibrationService - the loop grading its own targets.
 *
 * Every published target carries a claim about how attainable it is, and until
 * now nothing compared the claim to the outcome. A mission could publish p50
 * targets that were reached a fifth of the time indefinitely; the two knobs
 * that would fix that — which rung the target is read off, and how far above
 * cost the floor sits — had no evidence behind them either.
 *
 * The arithmetic is pure and lives in `@t3tools/trading-contracts/calibration`.
 * This is only the read: the mission's closed trades joined to the target and
 * the claimed hit rate of the strategy version each was closed under.
 *
 * @module TradingCalibrationService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  calibrateTargets,
  type CalibrationTrade,
  type TargetCalibration,
} from "@t3tools/trading-contracts/calibration";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface TradingCalibrationServiceShape {
  readonly read: (input: {
    readonly missionId: string;
  }) => Effect.Effect<TargetCalibration, PersistenceSqlError>;
}

export class TradingCalibrationService extends Context.Service<
  TradingCalibrationService,
  TradingCalibrationServiceShape
>()("t3/trading/TradingCalibrationService") {}

interface TradeRow {
  readonly mission_id: string;
  readonly strategy_version: number | null;
  readonly target_profit_usd: number | null;
  readonly peak_unrealised_pnl: number;
  readonly trough_unrealised_pnl: number;
  readonly net_pnl: number;
  readonly claimed_hit_rate: number | null;
  readonly stop_noise_floor_multiple: number | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read: TradingCalibrationServiceShape["read"] = (input) =>
    Effect.gen(function* () {
      // The claimed hit rate lives inside the strategy version's basis, so the
      // join is to the version the trade closed under — not the current one,
      // which is the whole point: a target is graded against the claim made
      // when it was set.
      //
      // The read spans the whole trading account, not just this mission (plan
      // 27 H4): settled missions keep their rows now, and a stop-placement
      // sample stuck at n=1 per mission was never going to say anything. The
      // sibling missions found here belong to the same account as the one the
      // calibration was asked about.
      const rows = yield* sql<TradeRow>`
        SELECT
          t.mission_id,
          t.strategy_version,
          t.target_profit_usd,
          t.peak_unrealised_pnl,
          t.trough_unrealised_pnl,
          t.net_pnl,
          t.stop_noise_floor_multiple,
          json_extract(
            v.strategy_json,
            '$.protection.targetProfitBasis.historicalHitRatePercent'
          ) AS claimed_hit_rate
        FROM trading_closed_trades t
        LEFT JOIN trading_missions m ON m.mission_id = t.mission_id
        LEFT JOIN momentum_strategy_versions v
          ON v.mission_id = t.mission_id AND v.version = t.strategy_version
        WHERE t.mission_id = ${input.missionId}
           OR m.trading_account_id = (
                SELECT trading_account_id FROM trading_missions
                WHERE mission_id = ${input.missionId}
              )
        ORDER BY t.closed_at DESC
      `.pipe(Effect.mapError(toPersistenceSqlError("TradingCalibrationService.read")));

      const now = yield* Clock.currentTimeMillis;
      const trades: ReadonlyArray<CalibrationTrade> = rows.map((row) => {
        // A strategy version number only means something inside its own
        // mission, so a sibling mission's trade must not land in this
        // mission's per-version entries. Stripped of its version and target it
        // still counts where cross-mission evidence is valid: the
        // stop-placement review, which `calibrateTargets` runs over ALL
        // trades.
        const foreign = row.mission_id !== input.missionId;
        return {
          strategyVersion: foreign ? null : row.strategy_version,
          targetProfitUsd: foreign ? null : row.target_profit_usd,
          peakUnrealisedPnlUsd: row.peak_unrealised_pnl,
          troughUnrealisedPnlUsd: row.trough_unrealised_pnl,
          netPnlUsd: row.net_pnl,
          claimedHitRatePercent: foreign ? null : row.claimed_hit_rate,
          stopNoiseFloorMultiple: row.stop_noise_floor_multiple,
          // Post-close candles are not read here; the avoidable-stop share
          // grades on the noise floor alone until the re-cross measurement is
          // worth taking (plan 27 Phase H keeps the rows it will need).
          reEnteredWithinReviewBars: null,
        };
      });

      return calibrateTargets({ missionId: input.missionId, measuredAt: now, trades });
    });

  return { read } satisfies TradingCalibrationServiceShape;
});

export const TradingCalibrationServiceLive = Layer.effect(TradingCalibrationService, make);
