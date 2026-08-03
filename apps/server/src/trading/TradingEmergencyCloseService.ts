/**
 * TradingEmergencyCloseService — the bounded emergency close (§17.5).
 *
 * Invoked when full protection cannot be confirmed inside the reconciliation
 * window. §17.5 is emphatic that this is "a deterministic safety action, not a
 * strategy decision": it runs without the harness, in a fixed order, a fixed
 * number of times, and it never waits for anyone to wake up and help.
 *
 * The order is the specification, and each step exists because of the failure
 * it prevents:
 *
 *   1. Mark the mission blocked and block all position increases — otherwise
 *      the thing being unwound can grow while it is being unwound.
 *   2. Cancel mission-owned non-reduce-only orders — a resting entry that
 *      fills mid-close re-opens the exposure just closed. Reduce-only orders
 *      are deliberately left alone: they are the protection.
 *   3. Read fresh canonical position and BBO — the size closed must be the
 *      size that exists now, not the size that existed when the trouble
 *      started.
 *   4. Submit a reduce-only marketable IOC for that size.
 *   5. Reconcile fills and the remaining position.
 *   6. Retry with a FRESH read and the REMAINING size, at most three attempts
 *      in total. An IOC fills what it can and cancels the rest, so a partial
 *      close is the expected case, not an error.
 *   7. If a position still remains: keep the mission blocked, preserve
 *      whatever protection can be placed, and report the exact remaining size
 *      and reason.
 *
 * The bound is what makes this safe to run deterministically. An unbounded
 * retry loop against a market that will not take the size is a way to keep
 * paying fees forever; three attempts and an honest "here is what is left" is
 * the behaviour §17.5 asks for.
 *
 * @module TradingEmergencyCloseService
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import {
  isPositionIncreasing,
  PROTECTION_SIZE_EPSILON,
} from "@t3tools/trading-contracts/protection";

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingMissionService } from "./TradingMissionService.ts";

/** §17.5: at most three bounded attempts. */
export const EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS = 3;

/** What the emergency close is being asked to unwind. */
export interface EmergencyCloseInput {
  readonly missionId: string;
  /** The master-wallet address (§10.6) — canonical reads use it. */
  readonly masterAddress: string;
  readonly market: string;
  /** Why the close was triggered, carried into the user-facing notification. */
  readonly reason: string;
}

/** How the procedure ended. */
export interface EmergencyCloseOutcome {
  /** True when the canonical position reached flat. */
  readonly flat: boolean;
  /** Signed size still open. Zero on success. */
  readonly remainingSize: number;
  /** How many of the three attempts were used. */
  readonly attempts: number;
  /**
   * The exact message the user is owed when the close did not complete: the
   * remaining size and the reason (§17.5 step 7).
   */
  readonly failureNotice?: string | undefined;
}

/**
 * The emergency close. One entry point, deterministic, harness-free.
 */
export class TradingEmergencyCloseService extends Context.Service<
  TradingEmergencyCloseService,
  {
    readonly emergencyClose: (
      input: EmergencyCloseInput,
    ) => Effect.Effect<
      EmergencyCloseOutcome,
      never,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;
  }
>()("t3/trading/TradingEmergencyCloseService") {}

/** A fresh canonical read of what is left to close. */
interface RemainingPosition {
  readonly size: number;
  readonly markPrice: number;
}

export const makeTradingEmergencyCloseService = Effect.gen(function* () {
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;
  const missions = yield* TradingMissionService;

  /** §17.5 step 3: fresh canonical position + BBO, every attempt. */
  const readRemaining = (
    input: EmergencyCloseInput,
  ): Effect.Effect<RemainingPosition, never, HyperliquidGateway> =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const snapshot = yield* gateway
        .getAccountSnapshot(input.masterAddress as `0x${string}`)
        .pipe(Effect.orElseSucceed(() => ({ positions: [] })));
      const position = snapshot.positions.find((p) => p.market === input.market);
      if (position === undefined || position.size === 0) {
        return { size: 0, markPrice: 0 };
      }
      const book = yield* gateway.getOrderBook(input.market).pipe(
        Effect.map((b) => b.bestBidOffer),
        Effect.orElseSucceed(() => undefined),
      );
      // Price the IOC off the side it will cross. Falling back to the entry
      // price keeps the attempt possible when the book read fails; the IOC's
      // own slippage allowance is what makes it marketable either way.
      const crossing =
        position.size > 0 ? (book?.bidPrice ?? undefined) : (book?.askPrice ?? undefined);
      return { size: position.size, markPrice: crossing ?? position.entryPrice };
    });

  /**
   * §17.5 step 2: cancel mission-owned orders that could INCREASE the
   * position. Reduce-only orders stay: they are the protection, and cancelling
   * them is the opposite of what a safety action should do.
   */
  const cancelIncreasingOrders = (
    input: EmergencyCloseInput,
  ): Effect.Effect<void, never, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly cloid: string;
        readonly market: string;
        readonly action_type: string;
      }>`
        SELECT DISTINCT o.cloid, o.market, e.action_type
        FROM trading_orders o
        JOIN trading_execution_records e ON e.cloid = o.cloid
        WHERE o.mission_id = ${input.missionId}
          AND o.reduce_only = 0
      `.pipe(Effect.orElseSucceed(() => []));

      for (const row of rows) {
        if (!isPositionIncreasing(row.action_type)) continue;
        yield* execution
          .submitCancel({ market: row.market, cloid: row.cloid })
          .pipe(
            Effect.catchTag("TradingExecutionError", (cause) =>
              Effect.logWarning(
                `emergency close: could not cancel increasing order ${row.cloid}: ${cause.message}`,
              ),
            ),
          );
      }
    });

  const emergencyClose: TradingEmergencyCloseService["Service"]["emergencyClose"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.logError("trading emergency close: starting", {
        missionId: input.missionId,
        reason: input.reason,
      });

      // --- §17.5 step 1: block the mission and every position increase ------
      //
      // First, before anything is cancelled or closed. A failure to record the
      // block does not stop the close — leaving exposure open because a status
      // write failed would be the worse outcome — but it is logged loudly.
      yield* Effect.gen(function* () {
        const expectedVersion = yield* missions.getMissionVersion(input.missionId);
        yield* missions.transition({
          missionId: input.missionId,
          to: "blocked",
          expectedVersion,
          blockedReason: "protection_failure",
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("emergency close: could not mark the mission blocked", {
            missionId: input.missionId,
            cause: String(cause),
          }),
        ),
      );

      // --- §17.5 step 2: cancel what could grow the position ----------------
      yield* cancelIncreasingOrders(input);

      // --- §17.5 steps 3–6: up to three bounded attempts --------------------
      let remaining = yield* readRemaining(input);
      let attempts = 0;

      while (
        Math.abs(remaining.size) > PROTECTION_SIZE_EPSILON &&
        attempts < EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS
      ) {
        attempts++;

        yield* Effect.logWarning("trading emergency close: attempt", {
          missionId: input.missionId,
          attempt: attempts,
          size: remaining.size,
        });

        // §17.5 step 4: reduce-only marketable IOC for the size that exists
        // right now. A failed attempt does not abort the procedure — the fresh
        // read at the top of the next iteration is what decides whether there
        // is still work to do.
        yield* execution
          .submitReduceOnlyIoc({
            missionId: input.missionId,
            market: input.market,
            positionSize: remaining.size,
            referencePrice: remaining.markPrice,
            attempt: attempts,
          })
          .pipe(
            Effect.catchTag("TradingExecutionError", (cause) =>
              Effect.logWarning(
                `emergency close: attempt ${attempts} did not submit: ${cause.message}`,
              ).pipe(Effect.as([])),
            ),
          );

        // §17.5 step 5: reconcile fills and the remaining position.
        yield* reconciler
          .reconcile(
            {
              missionId: input.missionId,
              masterAddress: input.masterAddress,
              market: input.market,
            },
            "after_position_update",
          )
          .pipe(Effect.catch(() => Effect.void));

        // §17.5 step 6: a FRESH read and the REMAINING size. An IOC fills what
        // it can and cancels the rest, so a partial close is expected here.
        remaining = yield* readRemaining(input);
      }

      if (Math.abs(remaining.size) <= PROTECTION_SIZE_EPSILON) {
        yield* Effect.logInfo("trading emergency close: flat", {
          missionId: input.missionId,
          attempts,
        });
        return { flat: true, remainingSize: 0, attempts } satisfies EmergencyCloseOutcome;
      }

      // --- §17.5 step 7: still exposed. Stay blocked, say exactly what is left
      const failureNotice =
        `Emergency close did not flatten ${input.market}: ${remaining.size} remains after ` +
        `${attempts} attempts. The mission stays blocked. Reason: ${input.reason}`;
      yield* Effect.logError("trading emergency close: position remains", {
        missionId: input.missionId,
        remainingSize: remaining.size,
        attempts,
        reason: input.reason,
      });

      return {
        flat: false,
        remainingSize: remaining.size,
        attempts,
        failureNotice,
      } satisfies EmergencyCloseOutcome;
    });

  return TradingEmergencyCloseService.of({ emergencyClose });
});

export const TradingEmergencyCloseServiceLive = Layer.effect(
  TradingEmergencyCloseService,
  makeTradingEmergencyCloseService,
);
