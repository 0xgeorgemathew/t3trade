/**
 * TradingBudgetReader — assembles the §16.2 loss-budget snapshot from the
 * migration-037 reconciled tables.
 *
 * `evaluateLossBudget` (in trading-contracts) is pure; it takes already-
 * reconciled inputs. This reader is the single place that gathers those
 * inputs for one mission: realised PnL + paid fees from `trading_fills`,
 * open-position risk from `trading_position_snapshots`, and pending-entry
 * risk from `trading_risk_reservations`. The reactor and preview both call
 * it so the budget they enforce is the same budget the reconciler wrote.
 *
 * Local tables are themselves reconciled truth (the reconciler wrote them
 * from canonical exchange state), so reading here does not violate "local
 * state never outranks Hyperliquid" — the reconciler is what made them
 * canonical.
 *
 * @module TradingBudgetReader
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { LossBudgetInput } from "@t3tools/trading-contracts/loss-accounting";

/** A small typed row we read back from `trading_fills`. */
interface FillBudgetRow {
  readonly closed_pnl: number | null;
  readonly fee_usd: number;
}

/** A typed row from `trading_position_snapshots`, joined to the stop on the mission's latest execution record. */
interface PositionBudgetRow {
  readonly market: string;
  readonly size: number;
  readonly entry_price: number | null;
  readonly observed_at: number | null;
  /** Stop from the mission's latest execution record carrying one (Task 1 column). */
  readonly stop_price: number | null;
}

/** A typed row from `trading_risk_reservations`. */
interface ReservationBudgetRow {
  readonly action_type: string;
  readonly reserved_risk_usd: number;
  readonly status: string;
}

export interface TradingBudgetReaderShape {
  /**
   * Read the §16.2 budget inputs for one mission: realised PnL/fees from
   * fills, open-position risk, and pending-entry risk from reservations.
   * `maximumCumulativeLossUsd` is supplied by the caller (from the mission
   * authority) since it is policy, not reconciled state.
   */
  readonly read: (input: {
    readonly missionId: string;
    readonly maximumCumulativeLossUsd: number;
  }) => Effect.Effect<LossBudgetInput, PersistenceSqlReadError>;
}

export class TradingBudgetReader extends Context.Service<
  TradingBudgetReader,
  TradingBudgetReaderShape
>()("t3/trading/TradingBudgetReader") {}

export class PersistenceSqlReadError extends Error {
  readonly _tag = "PersistenceSqlReadError";
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

const sqlFail = (stage: string) => (cause: unknown) =>
  new PersistenceSqlReadError(`TradingBudgetReader ${stage} failed`, cause);

export const makeTradingBudgetReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read: TradingBudgetReaderShape["read"] = (input) =>
    Effect.gen(function* () {
      // Realised PnL + paid fees from reconciled fills. Funding is not yet
      // tracked per-fill in the POC schema (no funding_rows table), so
      // netFundingUsd is zero until a funding source is wired. Paid fees are
      // the sum of `fee_usd`; closedPnl is the sum of fill `closedPnl`.
      const fills = yield* sql<FillBudgetRow>`
        SELECT closed_pnl, fee_usd FROM trading_fills WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("fills")));
      const closedPnlUsd = fills.reduce((sum, f) => sum + (f.closed_pnl ?? 0), 0);
      const allPaidTradingFeesUsd = fills.reduce((sum, f) => sum + f.fee_usd, 0);

      // Open-position risk. The stop price is threaded from the mission's
      // latest execution record that carries one (Task 1 column). Without a
      // stop, `openPositionRisk` cannot compute a directional loss-to-stop, so
      // we pass `undefined` and the contract floors the term at zero — we do
      // NOT fabricate a stop (a fabricated 0 made longs book the full notional
      // as risk, exhausting the budget instantly).
      //
      // The exit-fee and slippage-reserve terms are still zero here. Task 5
      // wires the fee read; PROMPT-05's protection layer writes the exact
      // per-position reserve. Until then open risk is approximate (the
      // dominant blocking term is the pending-entry risk below, which is
      // fully populated).
      const positions = yield* sql<PositionBudgetRow>`
        SELECT p.market, p.size, p.entry_price, p.observed_at, s.stop_price
        FROM trading_position_snapshots p
        LEFT JOIN (
          SELECT mission_id, stop_price
          FROM trading_execution_records
          WHERE mission_id = ${input.missionId}
            AND stop_price IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
        ) s ON s.mission_id = p.mission_id
        WHERE p.mission_id = ${input.missionId} AND p.size != 0
      `.pipe(Effect.mapError(sqlFail("positions")));
      const latestPositionObservedAt = positions
        .map((p) => p.observed_at)
        .reduce<number | null>((max, t) => (max === null || (t ?? -1) > max ? t : max), null);
      const openPositions = positions.map((p) => ({
        missionId: input.missionId,
        direction: p.size >= 0 ? ("long" as const) : ("short" as const),
        size: Math.abs(p.size),
        weightedEntryPrice: p.entry_price ?? undefined,
        stopPrice: p.stop_price ?? undefined,
        paidFeesUsd: 0,
        estimatedExitFeeUsd: 0,
        stopSlippageReserveUsd: 0,
      }));

      // Pending-entry risk: reserved, unfilled entries. The reservation's
      // `reserved_risk_usd` already encodes `plannedLossAtStopUsd` + entry/exit
      // fees + slippage reserve (§16.2 Eq 4), captured at preview time. A
      // `released` reservation no longer counts.
      const reservations = yield* sql<ReservationBudgetRow>`
        SELECT action_type, reserved_risk_usd, status FROM trading_risk_reservations
        WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("reservations")));
      const pendingEntries = reservations
        .filter((r) => r.status === "reserved")
        .map((r) => ({
          missionId: input.missionId,
          // The reservation's reserved_risk_usd is the full Eq 4 value; map it
          // onto plannedLossAtStopUsd and zero the additive terms so the sum
          // is unchanged (Eq 4 = plannedLoss + entryFee + exitFee + slippage;
          // they were already added at preview time and stored as one number).
          plannedLossAtStopUsd: r.reserved_risk_usd,
          estimatedEntryFeeUsd: 0,
          estimatedExitFeeUsd: 0,
          stopSlippageReserveUsd: 0,
        }));

      // `observedAt` is the freshness anchor for preview item 9 (account-and-
      // bbo-fresh) and for the reactor's `accountObservedAt`. It must reflect
      // when the position/account snapshot was actually reconciled, not the
      // clock at read time — otherwise the age is always ~0 and the freshness
      // gate can never fire. Fall back to the clock only when no position has
      // been observed yet (e.g. a brand-new mission with no fills).
      const observedAt = latestPositionObservedAt ?? (yield* Clock.currentTimeMillis);

      return {
        maximumCumulativeLossUsd: input.maximumCumulativeLossUsd,
        closedPnlUsd,
        netFundingUsd: 0,
        allPaidTradingFeesUsd,
        openPositions,
        pendingEntries,
        observedAt,
      } satisfies LossBudgetInput;
    });

  return { read } satisfies TradingBudgetReaderShape;
});

export const TradingBudgetReaderLive = Layer.effect(TradingBudgetReader, makeTradingBudgetReader);
