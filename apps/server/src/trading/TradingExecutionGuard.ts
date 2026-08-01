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
     * reason `cumulative_loss_limit`. The reactor + decider honour this by
     * rejecting `trading_resume_mission` while blocked.
     */
    readonly blockForExhaustion: (
      missionId: string,
      expectedVersion: number,
    ) => Effect.Effect<void, TradingExhaustionError>;

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
  ): Effect.Effect<void, TradingExhaustionError> =>
    Effect.gen(function* () {
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
      // A reduce-only close is permitted under exhaustion (§16.4). Run it
      // through the execution service (which signs + submits a reduce-only
      // IOC), then reconcile to confirm the canonical position is flat.
      yield* execution.submitOrder(executionInput).pipe(
        Effect.mapError(
          (cause) =>
            new TradingExhaustionError({
              reason: "budget_exhausted",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const { intent } = executionInput;
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
          reason: "budget_exhausted",
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
