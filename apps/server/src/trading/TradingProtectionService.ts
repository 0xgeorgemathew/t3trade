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
  readonly strategyVersion: number;
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
    ) => Effect.Effect<ProtectionOutcome, TradingProtectionError, HyperliquidGateway>;
  }
>()("t3/trading/TradingProtectionService") {}

/** A canonical read of the position and everything resting against it. */
interface CanonicalView {
  readonly positionSize: number;
  readonly referencePrice: number;
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
    strategyVersion: input.strategyVersion,
    executionSequence: input.executionSequence,
    actionType: `protect_${attempt}`,
  });
}

export const makeTradingProtectionService = Effect.gen(function* () {
  const execution = yield* HyperliquidExecutionService;

  /** Read the canonical position and every resting order in one pass. */
  const readCanonical = (
    input: ProtectionInput,
  ): Effect.Effect<CanonicalView, TradingProtectionError, HyperliquidGateway> =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
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
        return { positionSize: 0, referencePrice: 0, openOrders };
      }
      // Mark, derived the same way the reconciler derives it: the clearinghouse
      // position carries no mark field, but upnl = (mark − entry) × size.
      const markPx = position.entryPrice + position.unrealisedPnl / position.size;
      return { positionSize: position.size, referencePrice: markPx, openOrders };
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
  ): Effect.Effect<
    { view: CanonicalView; covered: number },
    TradingProtectionError,
    HyperliquidGateway
  > =>
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
  ): Effect.Effect<ProtectionOutcome, TradingProtectionError, HyperliquidGateway> =>
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

  return TradingProtectionService.of({ reconcileProtection });
});

export const TradingProtectionServiceLive = Layer.effect(
  TradingProtectionService,
  makeTradingProtectionService,
);
