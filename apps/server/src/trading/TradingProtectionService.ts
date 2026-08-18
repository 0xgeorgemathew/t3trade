/**
 * TradingProtectionService — §17.2 steps 5–9, and the §17.3 / §17.4 repairs.
 *
 * One invariant, one implementation:
 *
 *   No acknowledged position increase may remain without confirmed
 *   exchange-native reduce-only protection beyond the bounded reconciliation
 *   window.
 *
 * Everything in §17 that places or repairs protection converges here, because
 * the three situations that break protection are the same situation wearing
 * different clothes: a partial fill (§17.3), a scale-in (§17.4), and a parent
 * cancellation that took its children with it (§17.1) all end with the
 * canonical position larger than the confirmed protected size. So the routine
 * is not "handle a partial fill" — it is "read the canonical position, read
 * the confirmed coverage, and close the gap", run after every one of them.
 *
 * Two rules shape the code more than anything else:
 *
 * A grouped response is not proof (§17.1). The submitted `normalTpsl` child
 * may be untriggered, rejected, or already cancelled, so nothing here trusts
 * what was sent. Coverage is read back from `frontendOpenOrders` every time.
 *
 * The replacement is confirmed before the old stop is dropped (§17.4). Placing
 * a correctly sized stop and cancelling the stale one is safe in that order
 * and unsafe in the other; overlapping reduce-only protection is harmless
 * because reduce-only orders cannot open exposure, while a gap between the
 * cancel and the placement is exactly the window the invariant forbids.
 *
 * When the window closes without confirmed coverage, this service does not
 * keep trying — it reports `escalate`, and §17.5's bounded emergency close
 * takes over.
 *
 * Alongside the stop invariant, `reconcileTakeProtection` (plan 29 step 2.5)
 * holds the plan's profit-taking on the exchange: exactly one resting
 * reduce-only ALO at the plan's derived target price while a position is
 * open, withdrawn when the position is flat or the plan has no target. It
 * shares the confirm-before-cancel ordering, never touches a stop, and never
 * touches a reduce-only order the harness rested itself (a `patient` exit —
 * the caller names those in `preserveCloids`).
 *
 * @module TradingProtectionService
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { deriveCloid } from "@t3tools/hyperliquid/Cloid";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import {
  confirmedProtectedSize,
  isProtectiveOrder,
  PROTECTION_RECONCILIATION,
  PROTECTION_SIZE_EPSILON,
} from "@t3tools/trading-contracts/protection";

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";

/** Protection could not be established. */
export class TradingProtectionError extends Schema.TaggedErrorClass<TradingProtectionError>()(
  "TradingProtectionError",
  {
    reason: Schema.Literals([
      "position_read_failed",
      "orders_read_failed",
      "placement_failed",
      "window_expired",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingProtectionError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** What the protection path needs to know to protect one mission's position. */
export interface ProtectionInput {
  readonly missionId: string;
  /** The execution sequence whose protection this is; fixes the cloid. */
  readonly executionSequence: number;
  /** The master-wallet address (§10.6) — canonical reads use it. */
  readonly masterAddress: string;
  readonly market: string;
  /** The stop price the authority approved for this position. */
  readonly stopPrice: number;
}

/** How a reconciliation attempt ended. */
export type ProtectionOutcomeStatus =
  /** The position is flat; there is nothing to protect. */
  | "flat"
  /** Coverage already matched the canonical position; nothing was placed. */
  | "already_protected"
  /** New protection was placed and confirmed from canonical state. */
  | "protected"
  /** The window closed with the position still uncovered (§17.2 step 9). */
  | "escalate";

/** The result of one reconciliation pass. */
export interface ProtectionOutcome {
  readonly status: ProtectionOutcomeStatus;
  /** Signed canonical position size at the end of the pass. */
  readonly positionSize: number;
  /** Confirmed protected size at the end of the pass. */
  readonly protectedSize: number;
  /** Cloids of stale protective orders this pass cancelled. */
  readonly replacedCloids: ReadonlyArray<string>;
  /** Why the pass escalated, when it did. */
  readonly escalationReason?: string | undefined;
}

/** What the take-profit reconciliation needs to know for one mission. */
export interface TakeProfitInput {
  readonly missionId: string;
  /** Varies the cloid across passes; the derived target price also does. */
  readonly executionSequence: number;
  /** The master-wallet address (§10.6) — canonical reads use it. */
  readonly masterAddress: string;
  readonly market: string;
  /**
   * The active plan's target — its take-profit price when it published one,
   * else the USD rung priced off the position's entry — or `null` when the
   * plan published no usable target (nothing published, or a stand-down). The
   * caller reads the plan; this service owns only the exchange convergence.
   */
  readonly target: {
    readonly takeProfitPrice: number | null;
    readonly targetProfitUsd: number | null;
  } | null;
  /**
   * Cloids of resting reduce-only orders the HARNESS placed itself — a
   * `patient` exit (plan 29 step 2.3) is one, and it is a reduce-only limit
   * on the reducing side exactly like a take-profit.
   *
   * They are invisible to this pass: it neither counts one as satisfying the
   * plan's target nor cancels one. A model that deliberately rested part of
   * its exit must not have that order withdrawn five seconds later by a
   * server loop whose only claim on it is that it has the same shape.
   */
  readonly preserveCloids?: ReadonlyArray<string> | undefined;
}

/** How a take-profit reconciliation pass ended. */
export type TakeProfitOutcomeStatus =
  /** The position is flat; any leftover resting take-profit was withdrawn. */
  | "flat"
  /** The plan has no usable target; resting take-profits were withdrawn. */
  | "withdrawn"
  /** A take-profit at the target already covered the position. */
  | "unchanged"
  /** A take-profit was placed and confirmed; nothing was superseded. */
  | "placed"
  /** A take-profit was placed and confirmed, superseding older ones. */
  | "replaced"
  /**
   * A placement could not be confirmed inside the window. Nothing was
   * cancelled — a replacement that cannot confirm leaves the old take-profit
   * resting (the same ordering rule the stop replacement follows).
   */
  | "failed";

/** The result of one take-profit reconciliation pass. */
export interface TakeProfitOutcome {
  readonly status: TakeProfitOutcomeStatus;
  /** Signed canonical position size at the start of the pass. */
  readonly positionSize: number;
  /** The target price the pass derived, when the plan produced one. */
  readonly targetPrice: number | null;
  /** Cloid of the take-profit this pass placed and confirmed, when it did. */
  readonly placedCloid?: string | undefined;
  /** Cloids of resting take-profits this pass cancelled. */
  readonly cancelledCloids: ReadonlyArray<string>;
  /** Why the pass failed, when it did. */
  readonly detail?: string | undefined;
}

/**
 * The protection service. `reconcileProtection` is the only entry point; the
 * §17.2 post-submit path, the §17.3 partial-fill fallback, and the §17.4
 * scale-in replacement are the same call made at different moments.
 */
export class TradingProtectionService extends Context.Service<
  TradingProtectionService,
  {
    readonly reconcileProtection: (
      input: ProtectionInput,
    ) => Effect.Effect<ProtectionOutcome, TradingProtectionError>;

    /**
     * Move the stop on an open position to a new trigger price (§17.4).
     *
     * `reconcileProtection` deliberately stops at `already_protected` — its job
     * is to close a coverage gap, and a fully covered position has none. This
     * one exists for the case where coverage is fine and the *price* is wrong:
     * trailing a stop up behind a winner, or pulling it to break-even.
     *
     * Same ordering rule, enforced more strictly. The replacement is placed and
     * confirmed by its own cloid before any old stop is cancelled, because here
     * "some protection is resting" is not enough evidence — the old stop would
     * satisfy that check and then be the thing cancelled. A replacement that
     * cannot be confirmed leaves the old stop exactly where it was.
     */
    readonly replaceProtection: (
      input: ProtectionInput,
    ) => Effect.Effect<ProtectionOutcome, TradingProtectionError>;

    /**
     * Cancel entry orders in the order §17.3 requires: protect first, cancel
     * second, reconcile again third.
     *
     * The middle step is the dangerous one. A partially filled parent's linked
     * TP/SL children are cancelled along with it, so cancelling the parent of
     * a partial fill can strip the filled slice of its only stop — and the
     * slice stays open. Reconciling protection BEFORE the cancel puts an
     * independent, `na`-grouped stop on the filled size, which survives.
     *
     * The reconcile afterwards is not belt-and-braces: it is the step that
     * notices the children went with the parent, and replaces them.
     */
    readonly cancelEntriesWithProtection: (
      input: ProtectionInput & { readonly cloids: ReadonlyArray<string> },
    ) => Effect.Effect<ProtectionOutcome, TradingProtectionError>;

    /**
     * Reconcile the resting take-profit against the plan and the position
     * (plan 29 step 2.5).
     *
     * Where `reconcileProtection` is a safety invariant — an uncovered
     * position escalates to §17.5 — this one is an economic concern: the
     * published plan says where profit is taken, and the exchange should hold
     * exactly one resting reduce-only ALO at that price while the position is
     * open. When the position is flat, or the plan has no usable target, any
     * resting take-profit is withdrawn. A pass that cannot place or confirm a
     * take-profit reports `failed` and does nothing else — the stop is
     * untouched either way, and a missing take-profit is never an emergency.
     *
     * Stops are not this method's business. Its predicate matches resting
     * reduce-only limits only; trigger orders (the stop's wire shape) are
     * invisible to it, and it never cancels one.
     */
    readonly reconcileTakeProtection: (
      input: TakeProfitInput,
    ) => Effect.Effect<TakeProfitOutcome, TradingProtectionError>;
  }
>()("t3/trading/TradingProtectionService") {}

/** A canonical read of the position and everything resting against it. */
interface CanonicalView {
  readonly positionSize: number;
  readonly referencePrice: number;
  /** The position's entry price; 0 when the exchange reports none. */
  readonly entryPrice: number;
  readonly openOrders: ReadonlyArray<AgentOpenOrder>;
}

/**
 * The cloid a protection placement uses.
 *
 * Deterministic in the attempt number so a retry of the SAME attempt reuses
 * the cloid (the exchange rejects a duplicate among resting orders, which is
 * the behaviour wanted here), while a genuinely new attempt — a resize after a
 * further fill — gets a fresh one and can rest alongside the old.
 */
function protectionCloid(input: ProtectionInput, attempt: number): string {
  return deriveCloid({
    missionId: input.missionId,
    executionSequence: input.executionSequence,
    actionType: `protect_${attempt}`,
  });
}

export const makeTradingProtectionService = Effect.gen(function* () {
  const execution = yield* HyperliquidExecutionService;
  // Captured at layer build rather than demanded per call: these methods are
  // invoked from the deterministic control path, which must not have to carry
  // an exchange-read service into every call site.
  const gateway = yield* HyperliquidGateway;

  /**
   * What a canonical read needs: the §10.6 identity and the market. Both the
   * stop and the take-profit reconciles read the exchange through this.
   */
  type CanonicalReadInput = Pick<ProtectionInput, "masterAddress" | "market">;

  /** Read the canonical position and every resting order in one pass. */
  const readCanonical = (
    input: CanonicalReadInput,
  ): Effect.Effect<CanonicalView, TradingProtectionError> =>
    Effect.gen(function* () {
      const snapshot = yield* gateway.getAccountSnapshot(input.masterAddress as `0x${string}`).pipe(
        Effect.mapError(
          (cause) =>
            new TradingProtectionError({
              reason: "position_read_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const openOrders = yield* gateway.getOpenOrders(input.masterAddress as `0x${string}`).pipe(
        Effect.mapError(
          (cause) =>
            new TradingProtectionError({
              reason: "orders_read_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

      const position = snapshot.positions.find((p) => p.market === input.market);
      if (position === undefined || position.size === 0) {
        return { positionSize: 0, referencePrice: 0, entryPrice: 0, openOrders };
      }
      // Mark, derived the same way the reconciler derives it: the clearinghouse
      // position carries no mark field, but upnl = (mark − entry) × size.
      const markPx = position.entryPrice + position.unrealisedPnl / position.size;
      return {
        positionSize: position.size,
        referencePrice: markPx,
        entryPrice: position.entryPrice,
        openOrders,
      };
    });

  const coverageOf = (input: ProtectionInput, view: CanonicalView): number =>
    confirmedProtectedSize({
      market: input.market,
      positionSize: view.positionSize,
      referencePrice: view.referencePrice,
      openOrders: view.openOrders,
    });

  /** The resting protective orders that are NOT the one just placed. */
  const staleProtection = (
    input: ProtectionInput,
    view: CanonicalView,
    keepCloid: string,
  ): ReadonlyArray<string> =>
    view.openOrders
      .filter((order) =>
        isProtectiveOrder(order, {
          market: input.market,
          positionSize: view.positionSize,
          referencePrice: view.referencePrice,
          openOrders: view.openOrders,
        }),
      )
      .map((order) => order.cloid)
      .filter((cloid): cloid is string => cloid !== undefined && cloid !== keepCloid);

  /**
   * Re-read canonical state until coverage matches the position or the window
   * runs out. Returns whatever it last saw either way — the caller decides
   * whether that is enough.
   */
  const confirmWithin = (
    input: ProtectionInput,
  ): Effect.Effect<{ view: CanonicalView; covered: number }, TradingProtectionError> =>
    Effect.gen(function* () {
      const deadlinePolls = Math.max(
        1,
        Math.floor(
          PROTECTION_RECONCILIATION.windowMillis /
            PROTECTION_RECONCILIATION.maximumPlacementAttempts /
            PROTECTION_RECONCILIATION.confirmPollMillis,
        ),
      );

      let view = yield* readCanonical(input);
      let covered = coverageOf(input, view);

      for (let poll = 1; poll < deadlinePolls; poll++) {
        const exposure = Math.abs(view.positionSize);
        if (exposure <= PROTECTION_SIZE_EPSILON) break;
        if (covered >= exposure - PROTECTION_SIZE_EPSILON) break;

        yield* Effect.sleep(`${PROTECTION_RECONCILIATION.confirmPollMillis} millis`);
        view = yield* readCanonical(input);
        covered = coverageOf(input, view);
      }

      return { view, covered };
    });

  const reconcileProtection = (
    input: ProtectionInput,
  ): Effect.Effect<ProtectionOutcome, TradingProtectionError> =>
    Effect.gen(function* () {
      // --- §17.2 step 5: query canonical state ------------------------------
      let view = yield* readCanonical(input);
      let exposure = Math.abs(view.positionSize);

      if (exposure <= PROTECTION_SIZE_EPSILON) {
        return {
          status: "flat",
          positionSize: 0,
          protectedSize: 0,
          replacedCloids: [],
        } satisfies ProtectionOutcome;
      }

      // --- §17.2 step 7: confirm what is already covered --------------------
      let covered = coverageOf(input, view);
      if (covered >= exposure - PROTECTION_SIZE_EPSILON) {
        return {
          status: "already_protected",
          positionSize: view.positionSize,
          protectedSize: covered,
          replacedCloids: [],
        } satisfies ProtectionOutcome;
      }

      // --- §17.2 step 6: place protection for the ACTUAL canonical size -----
      //
      // Sized to the whole position, not to the shortfall. Two half-sized
      // stops at different prices are not equivalent to one full-sized stop:
      // the position would unwind in pieces at prices nobody chose. The stale
      // stop is cancelled afterwards, once the replacement is confirmed.
      const replacedCloids: string[] = [];
      let lastFailure = "";

      for (
        let attempt = 0;
        attempt < PROTECTION_RECONCILIATION.maximumPlacementAttempts;
        attempt++
      ) {
        const cloid = protectionCloid(input, attempt);

        // A failed placement does not abort the pass. The canonical read
        // below is what decides whether the position is covered, and a
        // placement can fail for reasons that leave it covered anyway (a
        // duplicate cloid, a concurrent stop from an earlier attempt). The
        // reason is kept only to explain an eventual escalation.
        const failure = yield* execution
          .submitProtectiveStop({
            market: input.market,
            cloid,
            positionSize: view.positionSize,
            stopPrice: input.stopPrice,
          })
          .pipe(
            Effect.match({
              onSuccess: (rows) =>
                rows
                  .filter((row) => row.status === "error")
                  .map((row) => row.reason ?? "rejected")
                  .join("; "),
              onFailure: (cause) => cause.message,
            }),
          );
        if (failure !== "") lastFailure = failure;

        // --- §17.2 steps 7–8: confirm from canonical state, never from the
        // placement's own response. Poll inside the window: the order takes a
        // moment to appear, and "not visible yet" is not "not placed".
        const confirmed = yield* confirmWithin(input);
        view = confirmed.view;
        exposure = Math.abs(view.positionSize);
        covered = confirmed.covered;

        if (exposure <= PROTECTION_SIZE_EPSILON) {
          return {
            status: "flat",
            positionSize: 0,
            protectedSize: 0,
            replacedCloids,
          } satisfies ProtectionOutcome;
        }

        if (covered >= exposure - PROTECTION_SIZE_EPSILON) {
          // --- §17.4: only NOW is it safe to drop the superseded stops. A
          // failed cancel leaves overlapping reduce-only protection, which is
          // harmless — it cannot open exposure — so it is logged, not fatal.
          for (const stale of staleProtection(input, view, cloid)) {
            yield* execution.submitCancel({ market: input.market, cloid: stale }).pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.sync(() => replacedCloids.push(stale)),
                onFailure: (cause) =>
                  Effect.logWarning(
                    "protection: could not cancel a superseded stop; overlapping " +
                      `reduce-only protection remains (cloid=${stale}): ${cause.message}`,
                  ),
              }),
            );
          }

          return {
            status: "protected",
            positionSize: view.positionSize,
            protectedSize: covered,
            replacedCloids,
          } satisfies ProtectionOutcome;
        }
      }

      // --- §17.2 step 9: the window closed uncovered. Do not keep trying ----
      return {
        status: "escalate",
        positionSize: view.positionSize,
        protectedSize: covered,
        replacedCloids,
        escalationReason:
          `protection for ${exposure} ${input.market} confirmed only ${covered} after ` +
          `${PROTECTION_RECONCILIATION.maximumPlacementAttempts} attempts` +
          (lastFailure === "" ? "" : `; last failure: ${lastFailure}`),
      } satisfies ProtectionOutcome;
    });

  /** Confirmed size resting under one specific cloid, per `isProtectiveOrder`. */
  const coverageUnderCloid = (input: ProtectionInput, view: CanonicalView, cloid: string): number =>
    view.openOrders
      .filter((order) => order.cloid === cloid)
      .filter((order) =>
        isProtectiveOrder(order, {
          market: input.market,
          positionSize: view.positionSize,
          referencePrice: view.referencePrice,
          openOrders: view.openOrders,
        }),
      )
      .reduce((sum, order) => sum + order.remainingSize, 0);

  const replaceProtection: TradingProtectionService["Service"]["replaceProtection"] = (input) =>
    Effect.gen(function* () {
      let view = yield* readCanonical(input);
      let exposure = Math.abs(view.positionSize);
      if (exposure <= PROTECTION_SIZE_EPSILON) {
        return {
          status: "flat",
          positionSize: 0,
          protectedSize: 0,
          replacedCloids: [],
        } satisfies ProtectionOutcome;
      }

      const replacedCloids: string[] = [];
      let lastFailure = "";

      for (
        let attempt = 0;
        attempt < PROTECTION_RECONCILIATION.maximumPlacementAttempts;
        attempt++
      ) {
        const cloid = protectionCloid(input, attempt);

        const failure = yield* execution
          .submitProtectiveStop({
            market: input.market,
            cloid,
            positionSize: view.positionSize,
            stopPrice: input.stopPrice,
          })
          .pipe(
            Effect.match({
              onSuccess: (rows) =>
                rows
                  .filter((row) => row.status === "error")
                  .map((row) => row.reason ?? "rejected")
                  .join("; "),
              onFailure: (cause) => cause.message,
            }),
          );
        if (failure !== "") lastFailure = failure;

        // Poll for the NEW cloid specifically. Total coverage is the wrong
        // question here: the stop being replaced already answers it yes.
        let covered = coverageUnderCloid(input, view, cloid);
        for (
          let poll = 1;
          poll <
          PROTECTION_RECONCILIATION.windowMillis / PROTECTION_RECONCILIATION.confirmPollMillis;
          poll++
        ) {
          exposure = Math.abs(view.positionSize);
          if (exposure <= PROTECTION_SIZE_EPSILON) break;
          if (covered >= exposure - PROTECTION_SIZE_EPSILON) break;
          yield* Effect.sleep(`${PROTECTION_RECONCILIATION.confirmPollMillis} millis`);
          view = yield* readCanonical(input);
          covered = coverageUnderCloid(input, view, cloid);
        }

        exposure = Math.abs(view.positionSize);
        if (exposure <= PROTECTION_SIZE_EPSILON) {
          return {
            status: "flat",
            positionSize: 0,
            protectedSize: 0,
            replacedCloids,
          } satisfies ProtectionOutcome;
        }

        if (covered >= exposure - PROTECTION_SIZE_EPSILON) {
          for (const stale of staleProtection(input, view, cloid)) {
            yield* execution.submitCancel({ market: input.market, cloid: stale }).pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.sync(() => replacedCloids.push(stale)),
                onFailure: (cause) =>
                  Effect.logWarning(
                    "protection: could not cancel the superseded stop; overlapping " +
                      `reduce-only protection remains (cloid=${stale}): ${cause.message}`,
                  ),
              }),
            );
          }
          return {
            status: "protected",
            positionSize: view.positionSize,
            protectedSize: covered,
            replacedCloids,
          } satisfies ProtectionOutcome;
        }
      }

      // The replacement never confirmed. The old stop was never cancelled, so
      // the position may well still be covered — say which, because the two
      // read very differently: one is a failed adjustment, the other is an
      // uncovered position that §17.5 has to take over.
      const stillCovered = coverageOf(input, view);
      if (stillCovered >= exposure - PROTECTION_SIZE_EPSILON) {
        return {
          status: "already_protected",
          positionSize: view.positionSize,
          protectedSize: stillCovered,
          replacedCloids,
          escalationReason:
            `could not place a stop at ${input.stopPrice}; the previous stop is still in place` +
            (lastFailure === "" ? "" : `; last failure: ${lastFailure}`),
        } satisfies ProtectionOutcome;
      }

      return {
        status: "escalate",
        positionSize: view.positionSize,
        protectedSize: stillCovered,
        replacedCloids,
        escalationReason:
          `stop replacement at ${input.stopPrice} left ${exposure} ${input.market} covered ` +
          `only ${stillCovered}` +
          (lastFailure === "" ? "" : `; last failure: ${lastFailure}`),
      } satisfies ProtectionOutcome;
    });

  const cancelEntriesWithProtection: TradingProtectionService["Service"]["cancelEntriesWithProtection"] =
    (input) =>
      Effect.gen(function* () {
        // --- §17.3 step 4: independent protection BEFORE the cancel ---------
        //
        // If this escalates, the cancel does not happen. Cancelling a parent
        // whose filled slice could not be protected would trade a known
        // problem (an entry still working) for an unknown one (an unprotected
        // position and nothing left to cancel).
        const before = yield* reconcileProtection(input);
        if (before.status === "escalate") return before;

        for (const cloid of input.cloids) {
          yield* execution
            .submitCancel({ market: input.market, cloid })
            .pipe(
              Effect.catchTag("TradingExecutionError", (cause) =>
                Effect.logWarning(
                  `cancel entries: could not cancel ${cloid}: ${cause.message}. ` +
                    "The reconcile below still runs; a still-resting order is caught " +
                    "on the next convergence.",
                ),
              ),
            );
        }

        // --- §17.3 step 5: reconcile again, because the parent's children
        // may have been cancelled with it.
        return yield* reconcileProtection(input);
      });

  // --- plan 29 step 2.5: the take-profit mirror of the stop reconcile ------
  //
  // The stop reconcile asks "is the downside covered?" and escalates when it
  // is not. This one asks "does the book hold the profit-taking the plan
  // published?" — a question with no emergency answer, only convergence.

  /**
   * True when one resting order is this position's take-profit.
   *
   * The mirror of `isProtectiveOrder`: reduce-only and on the reducing side
   * are shared, but a take-profit is a RESTING LIMIT (never a trigger —
   * triggers are the stop's wire shape and stay invisible here) priced on the
   * PROFIT side of the mark, where a stop is priced on the losing side.
   *
   * A `patient` exit the harness placed itself has the same shape, so it is
   * excluded by cloid rather than by shape: converging one into the plan's
   * target would cancel an order the model deliberately rested.
   */
  const isTakeProfitOrder = (
    order: AgentOpenOrder,
    input: {
      readonly market: string;
      readonly positionSize: number;
      readonly referencePrice: number;
      readonly preserved: ReadonlySet<string>;
    },
  ): boolean => {
    if (order.market !== input.market) return false;
    if (order.cloid !== undefined && input.preserved.has(order.cloid)) return false;
    if (!order.reduceOnly || order.isTrigger) return false;
    if (order.remainingSize <= PROTECTION_SIZE_EPSILON) return false;

    const isLong = input.positionSize > 0;
    const reducingSide = isLong ? "sell" : "buy";
    if (order.side !== reducingSide) return false;

    return isLong
      ? order.limitPrice > input.referencePrice
      : order.limitPrice < input.referencePrice;
  };

  /**
   * A resting reduce-only limit with no position behind it: pure leftover.
   * A preserved cloid is the harness's own order and is left where it is,
   * flat or not — withdrawing it is the caller's decision, never this pass's.
   */
  const isFlatLeftoverReduceLimit = (
    order: AgentOpenOrder,
    market: string,
    preserved: ReadonlySet<string>,
  ): boolean =>
    order.market === market &&
    order.reduceOnly &&
    !order.isTrigger &&
    order.remainingSize > PROTECTION_SIZE_EPSILON &&
    !(order.cloid !== undefined && preserved.has(order.cloid));

  const reconcileTakeProtection = (
    input: TakeProfitInput,
  ): Effect.Effect<TakeProfitOutcome, TradingProtectionError> =>
    Effect.gen(function* () {
      const cancelAll = (
        orders: ReadonlyArray<AgentOpenOrder>,
      ): Effect.Effect<ReadonlyArray<string>> =>
        Effect.gen(function* () {
          const cancelled: string[] = [];
          for (const order of orders) {
            if (order.cloid === undefined) continue;
            yield* execution.submitCancel({ market: input.market, cloid: order.cloid }).pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.sync(() => cancelled.push(order.cloid!)),
                onFailure: (cause) =>
                  Effect.logWarning(
                    "take-profit: could not cancel a resting order; it cannot " +
                      "open exposure, and the next pass will retry " +
                      `(cloid=${order.cloid}): ${cause.message}`,
                  ),
              }),
            );
          }
          return cancelled;
        });

      // The harness's own resting reduce-only orders, invisible to every
      // predicate below: this pass owns the plan's take-profit, not the
      // model's patient exits.
      const preserved = new Set(input.preserveCloids ?? []);

      let view = yield* readCanonical(input);
      let exposure = Math.abs(view.positionSize);

      // --- flat: there is nothing to take profit on. Withdraw leftovers ----
      // (§17.2's flat return cancels nothing — the stop path relies on the
      // exchange retiring reduce-only orders with the position — so this pass
      // owns the belt for the take-profit it places.)
      if (exposure <= PROTECTION_SIZE_EPSILON) {
        const cancelled = yield* cancelAll(
          view.openOrders.filter((order) =>
            isFlatLeftoverReduceLimit(order, input.market, preserved),
          ),
        );
        return {
          status: "flat",
          positionSize: 0,
          targetPrice: null,
          cancelledCloids: cancelled,
          ...(cancelled.length === 0
            ? {}
            : {
                detail: `${cancelled.length} leftover take-profit(s) withdrawn on a flat position`,
              }),
        } satisfies TakeProfitOutcome;
      }

      // --- the target is a wake, and never a resting order ----------------
      //
      // The server used to rest a reduce-only ALO at the plan's target. It made
      // the target an exit the mission could not reconsider: whatever the
      // market looked like when the level printed, the order took it. Worse, it
      // took it at a number nothing had checked was worth banking — one live
      // plan's target was $0.34 against $0.45 of round-trip fees.
      //
      // The target is now a `pnl_above` wake and nothing more, evaluated net of
      // the exit it has yet to pay, so reaching it is a decision point rather
      // than a fill. The stop stays server-side: a stop is protection and must
      // work while nobody is looking, which is exactly what a target is not.
      //
      // This pass still runs, to withdraw what earlier builds rested.
      const resting = view.openOrders.filter((order) =>
        isTakeProfitOrder(order, {
          market: input.market,
          positionSize: view.positionSize,
          referencePrice: view.referencePrice,
          preserved,
        }),
      );
      const cancelled = yield* cancelAll(resting);
      return {
        status: "withdrawn",
        positionSize: view.positionSize,
        targetPrice: null,
        cancelledCloids: cancelled,
        ...(cancelled.length === 0
          ? {}
          : {
              detail: `${cancelled.length} resting take-profit(s) withdrawn: the target is a wake, not an order`,
            }),
      } satisfies TakeProfitOutcome;
    });

  return TradingProtectionService.of({
    reconcileProtection,
    replaceProtection,
    cancelEntriesWithProtection,
    reconcileTakeProtection,
  });
});

export const TradingProtectionServiceLive = Layer.effect(
  TradingProtectionService,
  makeTradingProtectionService,
);
