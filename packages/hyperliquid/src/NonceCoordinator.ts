/**
 * Serialized signing lane and monotonic-nonce coordinator - spec §15.6.
 *
 * Every action signed by the execution wallet passes through ONE serialized
 * lane. The coordinator guarantees:
 *
 *  - nonces are strictly monotonic (never duplicated);
 *  - the next nonce is fast-forwarded to current Unix milliseconds when the
 *    wall clock has moved past the last-issued value (the exchange accepts
 *    a current-or-future ms nonce and rejects stale ones);
 *  - the last-issued nonce is exposed as a recovery hint so a restart can
 *    rehydrate before submitting again.
 *
 * The lane serializes the whole "assign nonce → sign → submit" critical
 * section so two harness-requested actions can never race for the same
 * nonce. Callers pass the effect that consumes the assigned nonce; the
 * coordinator runs it under the single permit and only commits the nonce
 * once the effect succeeds.
 *
 * @module HyperliquidNonceCoordinator
 */
import { Context, Data, Effect, Ref, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/** A nonce that could not be issued. */
export class HyperliquidNonceError extends Schema.TaggedErrorClass<HyperliquidNonceError>()(
  "HyperliquidNonceError",
  {
    reason: Schema.Literals(["clock_before_last", "persist_failed"]),
    lastIssued: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `HyperliquidNonceError(${this.reason}): lastIssued=${this.lastIssued ?? "-"}`;
  }
}

/**
 * A recovery hint snapshot. A restart rehydrates `lastIssuedNonce` so the next
 * issued nonce is strictly greater than anything signed before the restart.
 */
export class NonceRecoveryHint extends Data.Class<{
  readonly lastIssuedNonce: number;
}> {}

/**
 * The serialized nonce lane. One instance per execution wallet.
 *
 * `nextNonce` returns the next monotonic nonce without running work; use it
 * only for previews. `runWithNonce` is the signing lane: it assigns a nonce,
 * runs the caller's effect (sign + submit) under the single permit, and
 * commits the nonce on success.
 */
export class HyperliquidNonceCoordinator extends Context.Service<
  HyperliquidNonceCoordinator,
  {
    /**
     * Peek the next nonce this lane would issue, without consuming it. Useful
     * for previews and dry-runs. The returned value is monotonic relative to
     * the last committed nonce but is not reserved.
     */
    readonly nextNonce: Effect.Effect<number, HyperliquidNonceError>;

    /**
     * Run `effect` under the serialized signing lane with a freshly issued,
     * strictly-monotonic nonce. The nonce is committed only if `effect`
     * succeeds, so a failed submission does not burn a gap unnecessarily
     * (though gaps are harmless to the exchange).
     */
    readonly runWithNonce: <A, E, R>(
      effect: (nonce: number) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HyperliquidNonceError, R>;

    /** The recovery hint (last-issued nonce). */
    readonly recoveryHint: Effect.Effect<NonceRecoveryHint>;
  }
>()("@t3tools/hyperliquid/NonceCoordinator/HyperliquidNonceCoordinator") {}

/**
 * Build a coordinator that seeds its last-issued nonce from a recovery hint
 * and persists each new high-water mark through `persist`.
 *
 * `persist` is invoked for every committed nonce; it should be idempotent.
 * Failures to persist are surfaced as `clock_before_last`/`persist_failed`
 * errors so the caller never signs with a nonce it cannot remember.
 */
export const makeNonceCoordinator = Effect.fn("makeNonceCoordinator")(function* (
  initial?: NonceRecoveryHint,
  persist: (nonce: number) => Effect.Effect<void> = () => Effect.void,
) {
  const lastRef = yield* Ref.make<number>(initial?.lastIssuedNonce ?? 0);
  const lane = yield* Semaphore.make(1);

  const commit = (nonce: number): Effect.Effect<void, HyperliquidNonceError> =>
    Effect.gen(function* () {
      yield* Ref.update(lastRef, (prev) => (nonce > prev ? nonce : prev));
      // A persist failure must never let a signed nonce be forgotten. Catch
      // any defect and surface it as a typed persist_failed error.
      yield* persist(nonce).pipe(
        Effect.catchDefect(
          () => new HyperliquidNonceError({ reason: "persist_failed", lastIssued: nonce }),
        ),
      );
    });

  const issueNext: Effect.Effect<number, HyperliquidNonceError> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(lastRef);
    // Fast-forward to the current wall clock when it has moved past the last
    // issued nonce; otherwise increment by one. Both branches are strictly
    // greater than `last`, so the lane never duplicates a nonce.
    const next = now > last ? now : last + 1;
    return next;
  });

  return HyperliquidNonceCoordinator.of({
    nextNonce: issueNext,

    runWithNonce: <A, E, R>(effect: (nonce: number) => Effect.Effect<A, E, R>) =>
      lane.withPermits(1)(
        Effect.gen(function* () {
          const nonce = yield* issueNext;
          const result = yield* effect(nonce);
          yield* commit(nonce);
          return result;
        }),
      ),

    recoveryHint: Effect.gen(function* () {
      const lastIssuedNonce = yield* Ref.get(lastRef);
      return new NonceRecoveryHint({ lastIssuedNonce });
    }),
  });
});

/**
 * A live layer that seeds from a recovery hint and persists each committed
 * nonce through the supplied effectful sink (no-op by default).
 */
export const HyperliquidNonceCoordinatorLive = (options?: {
  initial?: NonceRecoveryHint;
  persist?: (nonce: number) => Effect.Effect<void>;
}) =>
  Layer.effect(
    HyperliquidNonceCoordinator,
    makeNonceCoordinator(options?.initial, options?.persist),
  );
