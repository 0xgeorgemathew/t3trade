/**
 * TradingPlanProtectionService — plan 29 step 4.5: the plan writes protection.
 *
 * The plan is the position's declared state; writing it reconciles the
 * exchange to it. The reactor's watchdog converges stop coverage and the
 * resting take-profit to the CURRENT plan every ~5s; this service is the
 * immediate half, run from the publish aftermath so the stop and target move
 * at publish time rather than a watchdog pass later. This is why a separate
 * `protect` tool is unnecessary.
 *
 * Division of labour with the watchdog, stated once:
 * - Target side: both this and `guardTakeProfit` run the same
 *   `reconcileTakeProtection` against the plan's own target fields, so the
 *   resting reduce-only ALO follows the plan either way.
 * - Stop side: this service MOVES the resting stop to the plan's stop price,
 *   inside the hard constraint below. `guardProtection` remains the coverage
 *   backstop — it re-places a stop that vanished, at the last price anyone
 *   set, and never widens anything.
 *
 * HARD CONSTRAINTS (risk gates, not preferences), both in `planStopRefusal`:
 * a plan-driven stop must be on the losing side of the mark — one on the
 * winning side triggers the instant it rests and closes the position at market
 * — and it may tighten freely but must not widen the position's planned loss
 * beyond the approved per-position envelope (the entry record's
 * planned-loss-at-stop, else the plan's own `stop.maximumPlannedLossUsd`). A
 * revision that fails either leaves the exchange stop exactly where it is and
 * says so in the outcome, so the publish response can carry it back to the
 * model (which still has `trading_exit`'s guarded `move_stop` path).
 *
 * @module TradingPlanProtectionService
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import {
  checkStopReplacement,
  confirmedProtectedSize,
  isProtectiveOrder,
  PROTECTION_SIZE_EPSILON,
} from "@t3tools/trading-contracts/protection";
import { plannedLossAtStopUsd } from "@t3tools/trading-contracts/stop-adjustment";
import type { TakeProfitOutcome } from "./TradingProtectionService.ts";
import { TradingProtectionService, type ProtectionOutcome } from "./TradingProtectionService.ts";
import type { TradingPlanState } from "./Schemas.ts";

/** The reconcile could not even be attempted. */
export class TradingPlanProtectionError extends Schema.TaggedErrorClass<TradingPlanProtectionError>()(
  "TradingPlanProtectionError",
  {
    reason: Schema.Literals(["position_read_failed", "orders_read_failed"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingPlanProtectionError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** How the stop half of a plan reconcile ended. */
export type PlanStopStatus =
  /** No position: nothing to protect (the take half withdrew leftovers). */
  | "no_position"
  /** The plan states no stop price; the watchdog keeps the coverage invariant. */
  | "no_stop_stated"
  /** The resting stop already matches the plan's. */
  | "unchanged"
  /** The stop moved to the plan's price and confirmed. */
  | "moved"
  /** Coverage was short; protection was repaired at the plan's price. */
  | "repaired"
  /**
   * The plan's stop would widen the planned loss beyond the approved
   * envelope; the exchange stop was left where it is and `refusal` says so.
   */
  | "refused";

/** The result of one plan-driven reconcile. */
export interface PlanProtectionOutcome {
  readonly stopStatus: PlanStopStatus;
  /** The plan stop price this pass considered, when the plan stated one. */
  readonly stopPrice: number | null;
  /** Why the plan's stop was not applied, when it was not. */
  readonly refusal?: string | undefined;
  /**
   * Where the protective trigger actually rests, as this pass observed it.
   *
   * Step 8.4 needs it and the model never did: when the envelope refuses the
   * plan's stop, the plan states one price and the exchange holds another, and
   * a chart drawing only the plan's would show the operator a stop they do not
   * have. Undefined before the pass has a position to measure.
   */
  readonly restingStopPrice?: number | null | undefined;
  readonly stopOutcome?: ProtectionOutcome | undefined;
  /** The take-profit half's own outcome, verbatim. */
  readonly target: TakeProfitOutcome;
}

/**
 * The two checks a plan-driven stop move must pass, pure so the refusal
 * wording is one thing.
 *
 * FIRST, the side. A stop on the winning side of the mark triggers the instant
 * it rests, so publishing one would close the position at market — the same
 * violent answer to a bad digit that `checkStopReplacement` exists to prevent,
 * and the reason `trading_exit`'s `move_stop` refuses `wrong_side`. Publishing moves
 * the stop now, so it answers to that gate too.
 *
 * SECOND, the envelope: a move may tighten freely but must not widen the
 * planned loss past what was approved. An unstated envelope never refuses,
 * because the watchdog's repair path faces the same situation and must not
 * wedge.
 *
 * `null` means the move is allowed.
 */
export const planStopRefusal = (input: {
  readonly positionSize: number;
  readonly entryPrice: number;
  /** Current mark — what the exchange would measure the trigger against. */
  readonly referencePrice: number;
  readonly planStopPrice: number;
  readonly envelopeUsd: number | null;
}): string | null => {
  if (
    checkStopReplacement({
      positionSize: input.positionSize,
      referencePrice: input.referencePrice,
      stopPrice: input.planStopPrice,
    }) !== null
  ) {
    return (
      `the revised plan's stop at ${input.planStopPrice} is not on the losing side of the ` +
      `${input.referencePrice} mark for this ${input.positionSize > 0 ? "long" : "short"}; ` +
      "it would trigger the moment it rested and close the position at market, so the " +
      "exchange stop was left where it is"
    );
  }

  if (input.envelopeUsd === null || !(input.envelopeUsd > 0)) return null;
  const plannedLossUsd = plannedLossAtStopUsd({
    positionSize: input.positionSize,
    entryPrice: input.entryPrice,
    stopPrice: input.planStopPrice,
  });
  if (plannedLossUsd <= input.envelopeUsd + PROTECTION_SIZE_EPSILON) return null;
  return (
    `the revised plan's stop at ${input.planStopPrice} plans a loss of ` +
    `$${plannedLossUsd.toFixed(2)}, beyond the $${input.envelopeUsd.toFixed(2)} approved for ` +
    "this position; the exchange stop was left where it is — trading_exit's move_stop " +
    "can move it inside the envelope"
  );
};

/** What a plan reconcile needs to know. */
export interface PlanProtectionInput {
  readonly missionId: string;
  readonly masterAddress: string;
  readonly plan: TradingPlanState;
}

export class TradingPlanProtectionService extends Context.Service<
  TradingPlanProtectionService,
  {
    /**
     * Reconcile the exchange's stop and resting target to the plan, now.
     *
     * Only the canonical reads fail the effect. The protection legs' own
     * failures surface in the outcome (a refused/widening stop leaves the
     * resting one untouched; an unconfirmed replacement leaves the previous
     * stop resting) — the publish that triggered this must never die on an
     * exchange hiccup, because the plan itself is already durable.
     */
    readonly reconcilePlan: (
      input: PlanProtectionInput,
    ) => Effect.Effect<PlanProtectionOutcome, TradingPlanProtectionError>;
  }
>()("t3/trading/TradingPlanProtectionService") {}

/**
 * The cloids of reduce-only orders the HARNESS itself rested (a `patient`
 * exit): the take-profit reconcile must leave them alone, exactly as the
 * reactor's pass does. Duplicated from the reactor rather than shared — ten
 * lines either side of an ownership boundary beats one import that couples
 * the publish aftermath to the reactor's build.
 */
const readHarnessRestingExitCloids =
  (sql: SqlClient.SqlClient) => (input: { readonly missionId: string; readonly market: string }) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly cloid: string }>`
      SELECT cloid FROM trading_execution_records
      WHERE mission_id = ${input.missionId}
        AND market = ${input.market}
        AND reduce_only = 1
        AND time_in_force = 'alo'
        AND status IN ('submitted', 'accepted')
    `;
      return rows.map((row) => row.cloid);
    }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

/**
 * How far BEFORE the position was first observed open the record that opened it
 * may have been written.
 *
 * The two timestamps come from opposite ends of an entry. An execution record's
 * `created_at` is stamped before the order is signed (§17.2 step 2); the
 * snapshot's `opened_at` is stamped when a later reconcile pass first observes
 * the position non-flat. So the row that carries this position's approved risk
 * is always a little OLDER than the position itself, and a scope of
 * `created_at >= opened_at` excludes precisely the row it exists to find — which
 * left the envelope null and, for a plan that states no
 * `maximumPlannedLossUsd`, the widening gate open.
 *
 * A minute of lead covers signing, the fill and the pass that saw it. It is the
 * same slack `buildClosedTradeReview` gives the same gap. A previous trade that
 * closed inside that minute could still put its own record first; that is a
 * neighbouring approved envelope rather than no envelope at all, which is the
 * right way round to be wrong.
 */
const ENTRY_RECORD_LEAD_MILLIS = 60_000;

/** Two stop prices closer than this are the same stop (wire precision). */
const STOP_PRICE_EPSILON_RELATIVE = 1e-5;

const sameStopPrice = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * STOP_PRICE_EPSILON_RELATIVE;

export const makeTradingPlanProtectionService = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;
  const protection = yield* TradingProtectionService;
  // Captured at layer build, like the protection and control services: the
  // publish aftermath must not have to thread a database handle in.
  const sql = yield* SqlClient.SqlClient;

  const readCanonical = Effect.fn("TradingPlanProtectionService.readCanonical")(function* (
    input: PlanProtectionInput,
  ) {
    const snapshot = yield* gateway.getAccountSnapshot(input.masterAddress as `0x${string}`).pipe(
      Effect.mapError(
        (cause) =>
          new TradingPlanProtectionError({
            reason: "position_read_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    const openOrders = yield* gateway.getOpenOrders(input.masterAddress as `0x${string}`).pipe(
      Effect.mapError(
        (cause) =>
          new TradingPlanProtectionError({
            reason: "orders_read_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    return { snapshot, openOrders };
  });

  const reconcilePlan = (input: PlanProtectionInput) =>
    Effect.gen(function* () {
      const { plan } = input;
      const { snapshot, openOrders } = yield* readCanonical(input);
      const position = snapshot.positions.find((p) => p.market === plan.market);

      // --- the take half: the resting target follows the plan, flat or not.
      const occurredAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const preserveCloids = yield* readHarnessRestingExitCloids(sql)({
        missionId: input.missionId,
        market: plan.market,
      });
      const target = yield* protection
        .reconcileTakeProtection({
          missionId: input.missionId,
          // Not a harness execution: epoch seconds keep this pass's cloid
          // distinct, the same trick the watchdog passes use.
          executionSequence: Math.floor(occurredAt / 1000),
          masterAddress: input.masterAddress,
          market: plan.market,
          target:
            plan.intent === "stand_aside"
              ? null
              : {
                  takeProfitPrice: plan.target.price ?? null,
                  targetProfitUsd: plan.target.profitUsd ?? null,
                },
          ...(preserveCloids.length === 0 ? {} : { preserveCloids }),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "trading plan protection: the take-profit leg could not run; the watchdog pass retries it",
              { missionId: input.missionId, cause: String(cause) },
            ).pipe(
              Effect.as({
                status: "failed",
                positionSize: position?.size ?? 0,
                targetPrice: null,
                cancelledCloids: [],
              } satisfies TakeProfitOutcome),
            ),
          ),
        );

      // --- the stop half.
      if (position === undefined || position.size === 0 || position.entryPrice === undefined) {
        return {
          stopStatus: "no_position",
          stopPrice: null,
          target,
        } satisfies PlanProtectionOutcome;
      }

      const planStopPrice = plan.stop.price;
      if (planStopPrice === undefined) {
        return {
          stopStatus: "no_stop_stated",
          stopPrice: null,
          target,
        } satisfies PlanProtectionOutcome;
      }

      // Mark derived the same way the protection service derives it.
      const markPx = position.entryPrice + position.unrealisedPnl / position.size;
      const covered = confirmedProtectedSize({
        market: plan.market,
        positionSize: position.size,
        referencePrice: markPx,
        openOrders,
      });
      const resting = restingStopPrice(openOrders, {
        market: plan.market,
        positionSize: position.size,
        referencePrice: markPx,
      });
      const fullyCovered = covered >= Math.abs(position.size) - PROTECTION_SIZE_EPSILON;

      if (fullyCovered && resting !== null && sameStopPrice(resting, planStopPrice)) {
        return {
          stopStatus: "unchanged",
          stopPrice: planStopPrice,
          restingStopPrice: resting,
          target,
        } satisfies PlanProtectionOutcome;
      }

      // The envelope: the entry record's approved planned loss for THIS
      // position, else the plan's own maximum. Scoped to the position — a prior
      // trade's record must not veto this one's move — but with a minute of
      // lead, because the record that opened the position predates the
      // observation that noticed it. See ENTRY_RECORD_LEAD_MILLIS.
      const opened = yield* sql<{ readonly opened_at: number | null }>`
        SELECT opened_at FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${plan.market} AND size != 0
      `.pipe(Effect.orElseSucceed(() => [] as Array<{ readonly opened_at: number | null }>));
      const openedAt = opened[0]?.opened_at ?? 0;
      const envelopeRows = yield* sql<{ readonly planned_loss_at_stop_usd: number | null }>`
        SELECT planned_loss_at_stop_usd FROM trading_execution_records
        WHERE mission_id = ${input.missionId} AND market = ${plan.market}
          AND stop_price IS NOT NULL AND planned_loss_at_stop_usd IS NOT NULL
          AND created_at >= ${openedAt - ENTRY_RECORD_LEAD_MILLIS}
        ORDER BY created_at ASC
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as Array<{ readonly planned_loss_at_stop_usd: null }>));
      const envelopeUsd =
        envelopeRows[0]?.planned_loss_at_stop_usd ?? plan.stop.maximumPlannedLossUsd ?? null;

      const refusal = planStopRefusal({
        positionSize: position.size,
        entryPrice: position.entryPrice,
        referencePrice: markPx,
        planStopPrice,
        envelopeUsd,
      });
      if (refusal !== null) {
        yield* Effect.logWarning(
          "trading plan protection: refused to widen the stop past the approved envelope",
          { missionId: input.missionId, planStopPrice, envelopeUsd },
        );
        return {
          stopStatus: "refused",
          stopPrice: planStopPrice,
          restingStopPrice: resting,
          refusal,
          target,
        } satisfies PlanProtectionOutcome;
      }

      const stopOutcome = yield* (
        fullyCovered ? protection.replaceProtection : protection.reconcileProtection
      )({
        missionId: input.missionId,
        executionSequence: Math.floor(occurredAt / 1000),
        masterAddress: input.masterAddress,
        market: plan.market,
        stopPrice: planStopPrice,
      }).pipe(
        // A replacement that could not confirm leaves the previous stop
        // resting (confirm-before-cancel); the watchdog retries the coverage
        // half on its next pass. Never fail the publish over it.
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "trading plan protection: the stop leg could not run; the previous stop was left resting",
            { missionId: input.missionId, planStopPrice, cause: String(cause) },
          ).pipe(
            Effect.as({
              status: "already_protected",
              positionSize: position.size,
              protectedSize: covered,
              replacedCloids: [],
            } satisfies ProtectionOutcome),
          ),
        ),
      );

      return {
        stopStatus: fullyCovered ? "moved" : "repaired",
        stopPrice: planStopPrice,
        // The move confirmed unless it escalated, in which case the previous
        // stop is what is still resting.
        restingStopPrice: stopOutcome.status === "escalate" ? resting : planStopPrice,
        ...(stopOutcome.status === "escalate"
          ? {
              refusal:
                `the plan's stop at ${planStopPrice} could not be confirmed on the exchange ` +
                `(${stopOutcome.escalationReason ?? "unconfirmed"}); the previous stop was left resting`,
            }
          : {}),
        stopOutcome,
        target,
      } satisfies PlanProtectionOutcome;
    });

  return TradingPlanProtectionService.of({ reconcilePlan });
});

/** The resting protective trigger closest to the mark, when one rests. */
function restingStopPrice(
  orders: ReadonlyArray<AgentOpenOrder>,
  ctx: { readonly market: string; readonly positionSize: number; readonly referencePrice: number },
): number | null {
  return orders
    .filter((order) =>
      isProtectiveOrder(order, {
        market: ctx.market,
        positionSize: ctx.positionSize,
        referencePrice: ctx.referencePrice,
        openOrders: orders,
      }),
    )
    .reduce<number | null>((nearest, order) => {
      const price = order.triggerPrice;
      if (price === undefined) return nearest;
      if (nearest === null) return price;
      return Math.abs(price - ctx.referencePrice) < Math.abs(nearest - ctx.referencePrice)
        ? price
        : nearest;
    }, null);
}

export const TradingPlanProtectionServiceLive = Layer.effect(
  TradingPlanProtectionService,
  makeTradingPlanProtectionService,
);
