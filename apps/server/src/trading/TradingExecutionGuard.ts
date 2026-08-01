/**
 * TradingExecutionGuard — §16.4 exhaustion enforcement + reduce-only close.
 *
 * When the cumulative-loss budget is exhausted (`remainingCumulativeLossUsd ≤
 * 0`), §16.4 mandates: cancel position-increasing orders, block new entries/
 * scale-ins/reversals/re-entry, preserve valid reduce-only protection, and
 * set the mission to `blocked` with reason `cumulative_loss_limit`. The
 * harness `trading_resume_mission` is REJECTED while blocked — only an
 * explicit user resume (after revalidation) clears it.
 *
 * Reduce-only close (§17.2) submits a reduce-only IOC that brings the
 * position to flat, then reconciles.
 *
 * @module TradingExecutionGuard
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isPermittedUnderExhaustion } from "@t3tools/trading-contracts/loss-accounting";
import type { TradingLossBudget } from "@t3tools/trading-contracts/execution";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";

import { TradingMissionService } from "./TradingMissionService.ts";
import { HyperliquidExecutionService, type ExecutionInput } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";

/** The guard rejected an action under §16.4. */
export class TradingExhaustionError extends Schema.TaggedErrorClass<TradingExhaustionError>()(
  "TradingExhaustionError",
  {
    reason: Schema.Literals([
      "budget_exhausted",
      "action_not_permitted_under_exhaustion",
      "resume_blocked",
      "close_did_not_flatten",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingExhaustionError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/**
 * The execution guard. Enforces §16.4 exhaustion before any signable action,
 * and provides the reduce-only close path.
 */
export class TradingExecutionGuard extends Context.Service<
  TradingExecutionGuard,
  {
    /**
     * Enforce §16.4 before an action. Returns the input unchanged if the action
     * is permitted; fails with `budget_exhausted` / `action_not_permitted_under
     * _exhaustion` if blocked. Position-increasing actions are blocked under
     * exhaustion; cancel/reduce/close are permitted.
     */
    readonly guardAction: (
      actionType: string,
      budget: TradingLossBudget,
    ) => Effect.Effect<void, TradingExhaustionError>;

    /**
     * Block a mission under §16.4. Transitions the mission to `blocked` with
     * reason `cumulative_loss_limit`, AND cancels any mission-owned
     * position-increasing resting orders so the exchange does not keep filling
     * against an exhausted budget while the mission reads "blocked". The reactor
     * + decider honour this by rejecting `trading_resume_mission` while blocked.
     */
    readonly blockForExhaustion: (
      missionId: string,
      expectedVersion: number,
      masterAddress: string,
    ) => Effect.Effect<
      void,
      TradingExhaustionError,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;

    /**
     * Reject a harness resume while the mission is blocked (§16.4: no
     * auto-resume; the user must explicitly resume after revalidation).
     */
    readonly guardResume: (
      missionId: string,
      isBlocked: boolean,
    ) => Effect.Effect<void, TradingExhaustionError>;

    /**
     * Reduce-only close (§17.2). Submits a reduce-only IOC that brings the
     * position to flat, then reconciles canonical state to confirm flat.
     */
    readonly reduceOnlyClose: (
      executionInput: ExecutionInput,
    ) => Effect.Effect<
      void,
      TradingExhaustionError,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;
  }
>()("t3/trading/TradingExecutionGuard") {}

export const makeTradingExecutionGuard = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;

  const guardAction = (
    actionType: string,
    budget: TradingLossBudget,
  ): Effect.Effect<void, TradingExhaustionError> =>
    Effect.gen(function* () {
      if (!budget.exhausted) return;
      if (!isPermittedUnderExhaustion(actionType)) {
        return yield* new TradingExhaustionError({
          reason: "action_not_permitted_under_exhaustion",
          detail: `${actionType} is blocked while the loss budget is exhausted (§16.4)`,
        });
      }
    });

  const blockForExhaustion = (
    missionId: string,
    expectedVersion: number,
    masterAddress: string,
  ): Effect.Effect<
    void,
    TradingExhaustionError,
    SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
  > =>
    Effect.gen(function* () {
      // §16.4 item 1: cancel mission-owned position-increasing resting orders.
      // Identify "increasing" from the execution record's action_type (not
      // trading_orders.reduce_only — the reconciler hardcodes that to false;
      // PROMPT-05 fixes the column). An action not in the permitted-under-
      // exhaustion set {cancel, reduce, close} is position-increasing.
      //
      // Protection preservation is vacuous until PROMPT-05 places protection
      // orders; this cancel path only targets increasing orders today.
      const sql = yield* SqlClient.SqlClient;
      const increasing = yield* sql<{ readonly cloid: string; readonly market: string }>`
        SELECT DISTINCT o.cloid, o.market
        FROM trading_orders o
        JOIN trading_execution_records e ON e.cloid = o.cloid
        WHERE o.mission_id = ${missionId}
          AND e.action_type NOT IN ('cancel', 'reduce', 'close')
      `.pipe(
        Effect.mapError(
          (cause) =>
            new TradingExhaustionError({
              reason: "budget_exhausted",
              detail: `read open orders failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      // Submit a cancel-by-cloid per increasing order. A failed cancel does not
      // abort the block — the mission still reads blocked; the reconciler will
      // catch a still-resting order on the next convergence. But a silently
      // swallowed cancel leaves exposure live on a mission reading "blocked",
      // so log at warn with the cloid and the exchange's reason before
      // continuing, rather than discarding the failure entirely.
      for (const order of increasing) {
        yield* execution
          .submitCancel({ market: order.market, cloid: order.cloid })
          .pipe(
            Effect.catchTag("TradingExecutionError", (cause) =>
              Effect.logWarning(
                `blockForExhaustion: cancel-by-cloid failed (cloid=${order.cloid}, market=${order.market}); ` +
                  `mission still transitions to blocked. reason: ${cause.stage}: ${cause.detail ?? ""}`,
              ),
            ),
          );
      }

      yield* missions
        .transition({
          missionId,
          to: "blocked",
          expectedVersion,
          blockedReason: "cumulative_loss_limit",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingExhaustionError({
                reason: "budget_exhausted",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        );

      // Reconcile so local order rows reflect the cancels before the reactor
      // announces the blocked status.
      yield* reconciler
        .reconcile(
          { missionId, masterAddress: masterAddress as `0x${string}`, market: "ETH" },
          "after_position_update",
        )
        .pipe(Effect.catch(() => Effect.void));
    });

  const guardResume = (
    _missionId: string,
    isBlocked: boolean,
  ): Effect.Effect<void, TradingExhaustionError> =>
    Effect.gen(function* () {
      if (isBlocked) {
        return yield* new TradingExhaustionError({
          reason: "resume_blocked",
          detail:
            "mission is blocked (cumulative_loss_limit); the user must explicitly resume after revalidation (§16.4)",
        });
      }
    });

  const reduceOnlyClose = (
    executionInput: ExecutionInput,
  ): Effect.Effect<
    void,
    TradingExhaustionError,
    SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
  > =>
    Effect.gen(function* () {
      const before = yield* reconciler
        .reconcile(
          {
            missionId: executionInput.intent.missionId,
            masterAddress: executionInput.masterAddress,
            market: executionInput.intent.market,
          },
          "before_execution",
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingExhaustionError({
                reason: "budget_exhausted",
                detail: `reconcile failed before close: ${cause.reason}`,
              }),
          ),
        );
      const position = before.position;
      if (position === null || position.size === 0) return yield* Effect.void;
      const closeIntent = {
        ...executionInput.intent,
        actionType: "close" as const,
        side: position.size > 0 ? ("sell" as const) : ("buy" as const),
        size: Math.abs(position.size),
        orderPreference: "marketable_ioc" as const,
        reduceOnly: true,
      };
      // A reduce-only close is permitted under exhaustion (§16.4). Always
      // submit the canonical position as an IOC, regardless of caller input.
      yield* execution.submitOrder({ ...executionInput, intent: closeIntent }).pipe(
        Effect.mapError(
          (cause) =>
            new TradingExhaustionError({
              reason: "budget_exhausted",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const { intent } = { intent: closeIntent };
      // Reconcile to confirm flat. The master address is the §10.6 identity
      // for canonical reads — resolved by the caller through the mission's
      // trading account, threaded here via a closure-built input.
      const state = yield* reconciler
        .reconcile(
          {
            missionId: intent.missionId,
            masterAddress: executionInput.masterAddress,
            market: intent.market,
          },
          "after_position_update",
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingExhaustionError({
                reason: "budget_exhausted",
                detail: `reconcile failed after close: ${cause.reason}`,
              }),
          ),
        );
      // §17.2: never assume the close landed. Escalate if the canonical
      // position is not flat rather than marking the mission closed on a lie.
      if (state.position !== null && state.position.size !== 0) {
        return yield* new TradingExhaustionError({
          reason: "close_did_not_flatten",
          detail: `close_did_not_flatten: size ${state.position.size} remains`,
        });
      }
    });

  return TradingExecutionGuard.of({
    guardAction,
    blockForExhaustion,
    guardResume,
    reduceOnlyClose,
  });
});

export const TradingExecutionGuardLive = Layer.effect(
  TradingExecutionGuard,
  makeTradingExecutionGuard,
);
