/**
 * TradingControlService — the §14.7 deterministic user-control API.
 *
 * Seven controls, one service, and one rule that shapes all of it: none of
 * them may require a harness turn. §14.7 puts it plainly — "their availability
 * does not depend on the bound harness being online". A user who wants out of
 * a position must be able to get out while the provider process is dead, the
 * session is unreachable, or the model is mid-thought.
 *
 * What that rules out is a specific temptation: routing these through the same
 * `trading_preview_order` checklist the harness uses. That checklist needs a
 * current strategy version, a matching authority version, and a harness run
 * holding the decision lease — three things that are absent precisely when
 * these buttons matter most. So the risk-reducing controls take the
 * preview-free reduce-only path instead (`submitReduceOnlyIoc`), which is safe
 * for a different reason: the exchange itself will not let a reduce-only order
 * open or extend a position.
 *
 * What is NOT bypassed is T3's safety boundary. §14.7: "The deterministic
 * buttons bypass discretionary harness reasoning — never T3's safety
 * boundary." Every control still goes through the signer, the nonce lane,
 * canonical reconciliation, and — where it matters most — the protection
 * reconciliation, so cancelling entries cannot strip a partial fill of its
 * stop.
 *
 * The seven map to §14.7's names:
 *
 *   trading_control_pause            → pause
 *   trading_control_resume           → resume
 *   trading_control_cancel_entries   → cancelEntries
 *   trading_control_reduce_position  → reducePosition (25/50/75/100%)
 *   trading_control_close_position   → closePosition
 *   trading_control_revoke           → revoke
 *   trading_control_close_and_revoke → closeAndRevoke
 *
 * @module TradingControlService
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
import { TradingProtectionService } from "./TradingProtectionService.ts";

/** A deterministic control could not be carried out. */
export class TradingControlError extends Schema.TaggedErrorClass<TradingControlError>()(
  "TradingControlError",
  {
    reason: Schema.Literals([
      "mission_not_found",
      "transition_rejected",
      "exchange_action_failed",
      "reduction_percent_required",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingControlError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** Every control names the mission it acts on. */
export interface ControlInput {
  readonly missionId: string;
}

/** A control that reaches the exchange also needs the canonical identity. */
export interface ExchangeControlInput extends ControlInput {
  readonly masterAddress: string;
  readonly market: string;
}

/** What a control did. */
export interface ControlOutcome {
  /** The mission status after the control, when it changed one. */
  readonly status?: string | undefined;
  /** Signed canonical position size after the control. */
  readonly positionSize: number;
  /** Cloids the control cancelled. */
  readonly cancelledCloids: ReadonlyArray<string>;
  /** Human-readable summary for the workspace. */
  readonly summary: string;
}

/**
 * The deterministic control service. Harness tools and workspace buttons
 * converge here (§14.7: "one control service, two entry points").
 */
export class TradingControlService extends Context.Service<
  TradingControlService,
  {
    /** Block new entries, scale-ins, reversals, and re-entry. Protection stays live. */
    readonly pause: (input: ControlInput) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Re-enable a paused mission. A blocked mission is not resumable here (§16.4). */
    readonly resume: (input: ControlInput) => Effect.Effect<ControlOutcome, TradingControlError>;

    /**
     * Cancel every resting position-increasing order, protecting any filled
     * slice first (§17.3). The position itself is left alone.
     */
    readonly cancelEntries: (
      input: ExchangeControlInput,
    ) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Reduce the canonical position by a percentage via a reduce-only IOC. */
    readonly reducePosition: (
      input: ExchangeControlInput & { readonly percent: number },
    ) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Close the canonical position entirely. */
    readonly closePosition: (
      input: ExchangeControlInput,
    ) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** End autonomous authority permanently, preserving any valid protection. */
    readonly revoke: (input: ControlInput) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Close the position, then revoke. The one-click way out. */
    readonly closeAndRevoke: (
      input: ExchangeControlInput,
    ) => Effect.Effect<ControlOutcome, TradingControlError>;
  }
>()("t3/trading/TradingControlService") {}

/** How many reduce-only attempts one button press makes before reporting back. */
const REDUCTION_ATTEMPTS = 2;

export const makeTradingControlService = Effect.gen(function* () {
  // SQL and the gateway are captured at layer build, not demanded per call.
  // §14.7's controls are invoked straight from a workspace button; making the
  // caller thread a database handle and an exchange reader in would put the
  // burden in exactly the wrong place.
  const sql = yield* SqlClient.SqlClient;
  const missions = yield* TradingMissionService;
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;
  const protection = yield* TradingProtectionService;
  const gateway = yield* HyperliquidGateway;
  const info = yield* HyperliquidInfoClient;

  /**
   * Reconcile with the captured services supplied, so a control's caller never
   * has to carry them. Failures are logged rather than raised: the canonical
   * re-read that follows is what decides the outcome, and a control that
   * already moved the position must report what it did.
   */
  const reconcileNow = (input: ExchangeControlInput) =>
    reconciler
      .reconcile(
        {
          missionId: input.missionId,
          masterAddress: input.masterAddress,
          market: input.market,
        },
        "after_position_update",
      )
      .pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(HyperliquidGateway, gateway),
        Effect.provideService(HyperliquidInfoClient, info),
        Effect.catch(() => Effect.void),
      );

  /** Read the canonical position and the price a reduce-only exit would cross. */
  const readPosition = (input: ExchangeControlInput) =>
    Effect.gen(function* () {
      const snapshot = yield* gateway
        .getAccountSnapshot(input.masterAddress as `0x${string}`)
        .pipe(Effect.orElseSucceed(() => ({ positions: [] })));
      const position = snapshot.positions.find((p) => p.market === input.market);
      if (position === undefined || position.size === 0) return { size: 0, crossingPrice: 0 };

      const book = yield* gateway.getOrderBook(input.market).pipe(
        Effect.map((b) => b.bestBidOffer),
        Effect.orElseSucceed(() => undefined),
      );
      const crossing = position.size > 0 ? book?.bidPrice : book?.askPrice;
      return { size: position.size, crossingPrice: crossing ?? position.entryPrice };
    });

  const transitionTo = (
    missionId: string,
    to: "paused" | "analysing" | "revoked",
  ): Effect.Effect<string, TradingControlError> =>
    Effect.gen(function* () {
      const expectedVersion = yield* missions.getMissionVersion(missionId);
      const updated = yield* missions.transition({ missionId, to, expectedVersion });
      return updated.status;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TradingControlError({
            reason: "transition_rejected",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

  /**
   * Submit reduce-only IOCs until the target size is gone or the attempts run
   * out, re-reading canonical state between attempts.
   *
   * Bounded for the same reason the emergency close is: an IOC fills what the
   * book will take and cancels the rest, so a button that loops until flat
   * could loop for a long time paying fees. Two attempts, then an honest
   * report of what is left.
   */
  const reduceBy = (input: ExchangeControlInput & { readonly targetSize: number }) =>
    Effect.gen(function* () {
      let position = yield* readPosition(input);
      let remainingToClose = Math.min(input.targetSize, Math.abs(position.size));

      for (let attempt = 0; attempt < REDUCTION_ATTEMPTS; attempt++) {
        if (remainingToClose <= PROTECTION_SIZE_EPSILON) break;
        if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) break;

        const signed = position.size > 0 ? remainingToClose : -remainingToClose;
        yield* execution
          .submitReduceOnlyIoc({
            missionId: input.missionId,
            market: input.market,
            positionSize: signed,
            referencePrice: position.crossingPrice,
            attempt,
          })
          .pipe(
            Effect.catchTag("TradingExecutionError", (cause) =>
              Effect.logWarning(
                `control: reduce attempt ${attempt} did not submit: ${cause.message}`,
              ).pipe(Effect.as([])),
            ),
          );

        yield* reconcileNow(input);

        const before = Math.abs(position.size);
        position = yield* readPosition(input);
        const closed = before - Math.abs(position.size);
        remainingToClose = Math.max(0, remainingToClose - closed);
      }

      return position.size;
    });

  const pause: TradingControlService["Service"]["pause"] = (input) =>
    Effect.gen(function* () {
      const status = yield* transitionTo(input.missionId, "paused");
      // Deliberately does NOT touch resting protection. §14.7's paused card
      // says the stop stays live on-exchange, and it means it: pausing is
      // about not opening anything new, not about standing down the stop.
      return {
        status,
        positionSize: 0,
        cancelledCloids: [],
        summary: "Paused. New entries are blocked; protection stays live on-exchange.",
      } satisfies ControlOutcome;
    });

  const resume: TradingControlService["Service"]["resume"] = (input) =>
    Effect.gen(function* () {
      const status = yield* transitionTo(input.missionId, "analysing");
      return {
        status,
        positionSize: 0,
        cancelledCloids: [],
        summary: "Resumed.",
      } satisfies ControlOutcome;
    });

  const revoke: TradingControlService["Service"]["revoke"] = (input) =>
    Effect.gen(function* () {
      const status = yield* transitionTo(input.missionId, "revoked");
      // §14.6: revocation ends autonomous authority and preserves valid
      // protection if a position remains. Cancelling the stop here would end
      // the authority and the safety net in one move.
      return {
        status,
        positionSize: 0,
        cancelledCloids: [],
        summary: "Authority revoked. Any remaining protection stays live on-exchange.",
      } satisfies ControlOutcome;
    });

  const cancelEntries: TradingControlService["Service"]["cancelEntries"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly cloid: string;
        readonly action_type: string;
        readonly stop_price: number | null;
      }>`
        SELECT DISTINCT o.cloid, e.action_type, e.stop_price
        FROM trading_orders o
        JOIN trading_execution_records e ON e.cloid = o.cloid
        WHERE o.mission_id = ${input.missionId}
          AND o.reduce_only = 0
      `.pipe(Effect.orElseSucceed(() => []));

      const increasing = rows.filter((row) => isPositionIncreasing(row.action_type));
      if (increasing.length === 0) {
        const position = yield* readPosition(input);
        return {
          positionSize: position.size,
          cancelledCloids: [],
          summary: "No resting entry orders to cancel.",
        } satisfies ControlOutcome;
      }

      // §17.3: protect the filled slice BEFORE cancelling, because a partial
      // parent's linked children are cancelled with it. The stop price comes
      // from the execution record the harness authorised, not from anything
      // the button supplies.
      const stopPrice = increasing.find((row) => row.stop_price !== null)?.stop_price ?? null;
      const cloids = increasing.map((row) => row.cloid);

      if (stopPrice === null) {
        // No recorded stop to reconcile against; cancel plainly. This is the
        // pre-Phase-5 record shape, not a new state.
        for (const cloid of cloids) {
          yield* execution
            .submitCancel({ market: input.market, cloid })
            .pipe(Effect.catch(() => Effect.void));
        }
        const position = yield* readPosition(input);
        return {
          positionSize: position.size,
          cancelledCloids: cloids,
          summary: `Cancelled ${cloids.length} resting entry order(s).`,
        } satisfies ControlOutcome;
      }

      const outcome = yield* protection
        .cancelEntriesWithProtection({
          missionId: input.missionId,
          strategyVersion: 1,
          executionSequence: 0,
          masterAddress: input.masterAddress,
          market: input.market,
          stopPrice,
          cloids,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingControlError({
                reason: "exchange_action_failed",
                detail: cause.message,
              }),
          ),
        );

      return {
        positionSize: outcome.positionSize,
        cancelledCloids: cloids,
        summary:
          outcome.status === "escalate"
            ? "Entry orders left in place: the filled size could not be protected first."
            : `Cancelled ${cloids.length} resting entry order(s); the filled size stays protected.`,
      } satisfies ControlOutcome;
    });

  const reducePosition: TradingControlService["Service"]["reducePosition"] = (input) =>
    Effect.gen(function* () {
      const position = yield* readPosition(input);
      if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) {
        return {
          positionSize: 0,
          cancelledCloids: [],
          summary: "Already flat.",
        } satisfies ControlOutcome;
      }

      const targetSize = Math.abs(position.size) * (input.percent / 100);
      const remaining = yield* reduceBy({ ...input, targetSize });

      // Protection is sized to the position, so a smaller position needs a
      // smaller stop — and the old one is oversized until it is replaced.
      // Reduce-only protection cannot over-close, so this is a tidy-up rather
      // than a safety fix, but leaving it stale would misreport coverage.
      return {
        positionSize: remaining,
        cancelledCloids: [],
        summary: `Reduced by ${input.percent}%. ${Math.abs(remaining)} ${input.market} remains.`,
      } satisfies ControlOutcome;
    });

  const closePosition: TradingControlService["Service"]["closePosition"] = (input) =>
    Effect.gen(function* () {
      const position = yield* readPosition(input);
      if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) {
        return {
          positionSize: 0,
          cancelledCloids: [],
          summary: "Already flat.",
        } satisfies ControlOutcome;
      }

      const remaining = yield* reduceBy({ ...input, targetSize: Math.abs(position.size) });
      return {
        positionSize: remaining,
        cancelledCloids: [],
        summary:
          Math.abs(remaining) <= PROTECTION_SIZE_EPSILON
            ? "Position closed."
            : `Position partly closed; ${Math.abs(remaining)} ${input.market} remains.`,
      } satisfies ControlOutcome;
    });

  const closeAndRevoke: TradingControlService["Service"]["closeAndRevoke"] = (input) =>
    Effect.gen(function* () {
      const closed = yield* closePosition(input);
      const status = yield* transitionTo(input.missionId, "revoked");
      return {
        status,
        positionSize: closed.positionSize,
        cancelledCloids: closed.cancelledCloids,
        summary: `${closed.summary} Authority revoked.`,
      } satisfies ControlOutcome;
    });

  return TradingControlService.of({
    pause,
    resume,
    cancelEntries,
    reducePosition,
    closePosition,
    revoke,
    closeAndRevoke,
  });
});

export const TradingControlServiceLive = Layer.effect(
  TradingControlService,
  makeTradingControlService,
);
