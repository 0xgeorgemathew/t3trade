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
import { EXPOSURE_REDUCING_ACTION_TYPES } from "@t3tools/trading-contracts/protection";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";

import { TradingMissionService } from "./TradingMissionService.ts";
import {
  HyperliquidExecutionService,
  TradingExecutionError,
  type ExecutionInput,
} from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler, TradingReconciliationError } from "./HyperliquidReconciler.ts";

/** The guard rejected an action under §16.4. */
export class TradingExhaustionError extends Schema.TaggedErrorClass<TradingExhaustionError>()(
  "TradingExhaustionError",
  {
    reason: Schema.Literals([
      "budget_exhausted",
      "action_not_permitted_under_exhaustion",
      "resume_blocked",
      "close_did_not_flatten",
      /** A read or write the block needed did not answer. Not a verdict. */
      "infrastructure_error",
      /** The mission would not move to `blocked` — usually a version conflict. */
      "transition_failed",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingExhaustionError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/**
 * What a reduce-only exit can fail with.
 *
 * Deliberately three errors rather than one. `TradingExhaustionError` is a
 * §16.4 verdict — the budget says no — and an LLM harness is expected to act on
 * that word: stop trying to trade, wait for relief. A preview rejection or a
 * failed canonical read is neither of those things, and relabelling one as
 * `budget_exhausted` sends the harness down a recovery path that cannot work.
 * It happened live: a stuck execution record was reported to the harness as
 * `budget_exhausted` inside a payload that also said `exhausted: false`.
 */
export type ReduceOnlyError =
  | TradingExhaustionError
  | TradingExecutionError
  | TradingReconciliationError;

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
     * Reduce-only close (§17.2). Submits a reduce-only IOC for the whole
     * canonical position, then reconciles canonical state to confirm flat.
     * Fails with `close_did_not_flatten` if anything remains.
     */
    readonly reduceOnlyClose: (
      executionInput: ExecutionInput,
    ) => Effect.Effect<
      ReduceOnlyOutcome,
      ReduceOnlyError,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;

    /**
     * Sized reduce-only exit — the scale-out path.
     *
     * Takes the size the intent asked for, clamped to the canonical position,
     * and submits it reduce-only. Unlike `reduceOnlyClose` this is not
     * required to end flat: taking half off and keeping half is the point, and
     * an IOC that filled less than requested is a normal outcome the harness
     * reads back from the reconciled position rather than an error.
     */
    readonly reduceOnlySized: (
      executionInput: ExecutionInput,
    ) => Effect.Effect<
      ReduceOnlyOutcome,
      ReduceOnlyError,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;
  }
>()("t3/trading/TradingExecutionGuard") {}

/** What one reduce-only exit did, measured against canonical state. */
export interface ReduceOnlyOutcome {
  /** Size the intent asked to remove. */
  readonly requestedSize: number;
  /** Size actually submitted, after clamping to the canonical position. */
  readonly submittedSize: number;
  /** Signed canonical position size after the post-submit reconcile. */
  readonly remainingSize: number;
}

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
      // PROMPT-05 fixes the column). Anything outside the exposure-reducing set
      // is position-increasing — the same rule `isPositionIncreasing` applies in
      // TypeScript, read from the same contract list rather than spelled out
      // again in SQL.
      //
      // Protection preservation is vacuous until PROMPT-05 places protection
      // orders; this cancel path only targets increasing orders today.
      const sql = yield* SqlClient.SqlClient;
      const increasing = yield* sql<{ readonly cloid: string; readonly market: string }>`
        SELECT DISTINCT o.cloid, o.market
        FROM trading_orders o
        JOIN trading_execution_records e ON e.cloid = o.cloid
        WHERE o.mission_id = ${missionId}
          AND NOT ${sql.in("e.action_type", EXPOSURE_REDUCING_ACTION_TYPES)}
      `.pipe(
        Effect.mapError(
          // A SQL read that failed is not the budget saying no. Labelling it
          // `budget_exhausted` sent the harness down a recovery path — wait for
          // the ceiling to lift — that could never work, on a mission whose own
          // payload said `exhausted: false`.
          (cause) =>
            new TradingExhaustionError({
              reason: "infrastructure_error",
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
            // Likewise: the mission refusing the transition says nothing about
            // the budget.
            (cause) =>
              new TradingExhaustionError({
                reason: "transition_failed",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        );

      // Reconcile so local order rows reflect the cancels before the reactor
      // announces the blocked status. The mission names the market it is
      // mandated to; an unreadable mission falls back to the default rather
      // than skipping the reconcile.
      const market = yield* missions.getMission(missionId).pipe(
        Effect.map((mission) => mission.market),
        Effect.orElseSucceed(() => "ETH" as const),
      );
      yield* reconciler
        .reconcile(
          { missionId, masterAddress: masterAddress as `0x${string}`, market },
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

  /**
   * The shared reduce-only exit.
   *
   * `requestedSize` is what the caller wants removed; the size that actually
   * goes on the wire is that clamped to the canonical position, because the
   * exchange is the authority on what there is to reduce. The side is likewise
   * derived from the canonical position rather than taken from the intent — a
   * reduce named with the wrong side would otherwise be an increase wearing a
   * reduce's name, which is the hazard `reduceOnly: true` here also closes.
   */
  const submitReduceOnly = (
    executionInput: ExecutionInput,
    request: number | "all",
    actionType: "reduce" | "close",
  ): Effect.Effect<
    ReduceOnlyOutcome,
    ReduceOnlyError,
    SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
  > =>
    Effect.gen(function* () {
      const { intent, masterAddress } = executionInput;
      // Every failure below travels as itself. A reduce that preview refused,
      // or a canonical read that did not answer, is not the budget saying no —
      // and the harness acts on that word.
      const before = yield* reconciler.reconcile(
        { missionId: intent.missionId, masterAddress, market: intent.market },
        "before_execution",
      );

      const position = before.position;
      const exposure = position === null ? 0 : Math.abs(position.size);
      const requestedSize = request === "all" ? exposure : request;
      if (position === null || position.size === 0) {
        return { requestedSize, submittedSize: 0, remainingSize: 0 } satisfies ReduceOnlyOutcome;
      }

      const submittedSize = Math.min(requestedSize, exposure);
      if (submittedSize <= 0) {
        return {
          requestedSize,
          submittedSize: 0,
          remainingSize: position.size,
        } satisfies ReduceOnlyOutcome;
      }

      const exitIntent = {
        ...intent,
        actionType,
        side: position.size > 0 ? ("sell" as const) : ("buy" as const),
        size: submittedSize,
        orderPreference: "marketable_ioc" as const,
        reduceOnly: true,
      };
      // Reduce-only exits are permitted under exhaustion (§16.4).
      yield* execution.submitOrder({ ...executionInput, intent: exitIntent });

      // Reconcile to read what the exit actually left. The master address is
      // the §10.6 identity for canonical reads — resolved by the caller through
      // the mission's trading account, threaded here via a closure-built input.
      const state = yield* reconciler.reconcile(
        { missionId: intent.missionId, masterAddress, market: intent.market },
        "after_position_update",
      );

      return {
        requestedSize,
        submittedSize,
        remainingSize: state.position?.size ?? 0,
      } satisfies ReduceOnlyOutcome;
    });

  const reduceOnlyClose: TradingExecutionGuard["Service"]["reduceOnlyClose"] = (executionInput) =>
    Effect.gen(function* () {
      // The whole canonical position, regardless of the size the caller named.
      const outcome = yield* submitReduceOnly(executionInput, "all", "close");
      // §17.2: never assume the close landed. Escalate if the canonical
      // position is not flat rather than marking the mission closed on a lie.
      if (outcome.remainingSize !== 0) {
        return yield* new TradingExhaustionError({
          reason: "close_did_not_flatten",
          detail: `close_did_not_flatten: size ${outcome.remainingSize} remains`,
        });
      }
      return outcome;
    });

  const reduceOnlySized: TradingExecutionGuard["Service"]["reduceOnlySized"] = (executionInput) =>
    submitReduceOnly(executionInput, executionInput.intent.size, "reduce");

  return TradingExecutionGuard.of({
    guardAction,
    blockForExhaustion,
    guardResume,
    reduceOnlyClose,
    reduceOnlySized,
  });
});

export const TradingExecutionGuardLive = Layer.effect(
  TradingExecutionGuard,
  makeTradingExecutionGuard,
);
