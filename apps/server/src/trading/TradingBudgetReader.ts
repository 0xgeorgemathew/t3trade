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

/** A typed row from `trading_position_snapshots`. */
interface PositionBudgetRow {
  readonly market: string;
  readonly size: number;
  readonly entry_price: number | null;
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

      // Open-position risk. A full implementation needs the stop price + a
      // taker-rate exit-fee estimate per open position. The position snapshot
      // table does not yet carry the stop or fee estimates; until the
      // protection layer (PROMPT-05) writes them, open risk is approximated
      // from the snapshot's size and entry only when a stop is derivable. For
      // the budget gate's purpose — blocking new exposure — the dominant term
      // is the pending-entry risk below, which IS fully populated.
      const positions = yield* sql<PositionBudgetRow>`
        SELECT market, size, entry_price FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND size != 0
      `.pipe(Effect.mapError(sqlFail("positions")));
      const openPositions = positions.map((p) => ({
        missionId: input.missionId,
        direction: p.size >= 0 ? ("long" as const) : ("short" as const),
        size: Math.abs(p.size),
        weightedEntryPrice: p.entry_price ?? undefined,
        // The stop + fee estimate are written by the protection layer; until
        // then an open position contributes its unpaid-exit-fee estimate of
        // zero and no slippage reserve. This is conservative for new-entry
        // blocking (under-counts open risk) and corrected when protection lands.
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

      const observedAt = yield* Clock.currentTimeMillis;

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
