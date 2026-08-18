/**
 * The ledger of orders the SERVER rests on a position — plan 34 step 5.
 *
 * The take-profit reconcile places a reduce-only ALO at the plan's target and
 * replaces it whenever the target moves. Until now those orders existed only
 * on the exchange: no execution record, no event, no row. So when one filled,
 * the position simply shrank between two wakes with nothing anywhere to say
 * why — and on the mission this was found on, the model attributed the
 * server's own profit-taking to the give-back watch it had armed itself.
 *
 * Two readers: {@link recordTakeProfitOutcome} writes what a reconcile pass
 * did, and {@link readTakeProfitOrders} tells the fill reconciler which cloids
 * are the server's, so a fill on one becomes an event the next wake carries.
 *
 * Bookkeeping, never protection. Nothing here gates anything, and a write that
 * fails costs the attribution and nothing else.
 *
 * @module TradingProtectionLedger
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROTECTION_SIZE_EPSILON } from "@t3tools/trading-contracts/protection";

/** One order the server rested, as the ledger holds it. */
export interface ProtectionOrderRow {
  readonly cloid: string;
  readonly kind: string;
  readonly size: number;
  readonly limit_price: number;
  readonly placed_at: number;
  readonly retired_at: number | null;
}

/** What one take-profit reconcile pass did to the resting orders. */
export interface TakeProfitLedgerInput {
  readonly missionId: string;
  readonly market: string;
  /** The order this pass placed and confirmed, when it placed one. */
  readonly placedCloid?: string | undefined;
  readonly targetPrice: number | null;
  /** Signed canonical position size the order covers. */
  readonly positionSize: number;
  /** Orders this pass withdrew or superseded. */
  readonly cancelledCloids: ReadonlyArray<string>;
}

/**
 * Record a reconcile pass: the order it rested, and the ones it retired.
 *
 * Idempotent on the cloid, because the pass is: a retry of the same target
 * reuses the cloid deliberately.
 *
 * Nothing is recorded against a flat position. The pass that places a
 * take-profit and then finds the position gone reports the cloid it sent with
 * a size of zero, and the ledger wrote that down as a live order: one mission
 * carries a `take_profit` row of size 0.0 placed 280ms after its close, never
 * retired. An order on nothing is not protection, and a row saying otherwise
 * is read by the fill reconciler as an order still standing.
 */
export const recordTakeProfitOutcome = (
  input: TakeProfitLedgerInput,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

    const size = Math.abs(input.positionSize);
    const flat = size <= PROTECTION_SIZE_EPSILON;

    if (input.placedCloid !== undefined && input.targetPrice !== null && !flat) {
      yield* sql`
        INSERT INTO trading_protection_orders (
          cloid, mission_id, market, kind, size, limit_price, placed_at
        ) VALUES (
          ${input.placedCloid}, ${input.missionId}, ${input.market}, 'take_profit',
          ${size}, ${input.targetPrice}, ${at}
        )
        ON CONFLICT(cloid) DO UPDATE SET
          size = ${size}, limit_price = ${input.targetPrice}, retired_at = NULL
      `;
    }

    // The position is gone, so every order the server was resting on it is
    // gone with it — whether this pass managed to cancel it or the exchange
    // retired it alongside the position.
    if (flat) {
      yield* sql`
        UPDATE trading_protection_orders SET retired_at = ${at}
        WHERE mission_id = ${input.missionId} AND retired_at IS NULL
      `;
    }

    if (input.cancelledCloids.length > 0) {
      yield* sql`
        UPDATE trading_protection_orders SET retired_at = ${at}
        WHERE mission_id = ${input.missionId}
          AND ${sql.in("cloid", input.cancelledCloids)}
      `;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not record a take-profit in the protection ledger", {
        missionId: input.missionId,
        cloid: input.placedCloid,
        cause,
      }),
    ),
  );

/**
 * Every take-profit this mission's server side has rested, retired ones
 * included.
 *
 * Retired rows stay in the answer on purpose: a fill arrives on the pass AFTER
 * the order it filled against was replaced, and an order that is gone is
 * exactly the one whose fill needs explaining.
 */
export const readTakeProfitOrders = (
  missionId: string,
): Effect.Effect<ReadonlyArray<ProtectionOrderRow>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<ProtectionOrderRow>`
      SELECT cloid, kind, size, limit_price, placed_at, retired_at
      FROM trading_protection_orders
      WHERE mission_id = ${missionId} AND kind = 'take_profit'
    `;
  }).pipe(Effect.orElseSucceed(() => []));
