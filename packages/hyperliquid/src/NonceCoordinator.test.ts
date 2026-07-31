import { Duration, Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";

import { makeNonceCoordinator, NonceRecoveryHint } from "./NonceCoordinator.ts";

/**
 * TestClock starts at epoch 0 and only advances on `adjust`. Every concurrent
 * fiber that reads `currentTimeMillis` during a single `adjust` window sees
 * the same value — exactly what the no-duplicate-under-concurrency test needs.
 */
const testClock = TestClock.layer();

describe("HyperliquidNonceCoordinator", () => {
  it.effect("issues monotonic nonces and fast-forwards to the wall clock", () =>
    Effect.gen(function* () {
      const coord = yield* makeNonceCoordinator();

      // Advance the controlled clock to a known base. A peek fast-forwards
      // to the wall clock but does not consume (two peeks are equal).
      yield* TestClock.adjust(Duration.millis(5_000));
      const peekA = yield* coord.nextNonce;
      const peekB = yield* coord.nextNonce;
      expect(peekA).toBe(5_000);
      expect(peekB).toBe(5_000);

      // A committed submit consumes 5_000; the next peek must advance past it
      // even though the wall clock has not moved.
      const committed = yield* coord.runWithNonce((n) => Effect.succeed(n));
      expect(committed).toBe(5_000);
      const peekAfterCommit = yield* coord.nextNonce;
      expect(peekAfterCommit).toBe(5_001);

      // A later wall clock fast-forwards past everything.
      yield* TestClock.adjust(Duration.millis(5_000));
      const peekFuture = yield* coord.nextNonce;
      expect(peekFuture).toBe(10_000);
      expect(peekFuture).toBeGreaterThan(peekAfterCommit);
    }).pipe(Effect.provide(testClock)),
  );

  it.effect("commits the nonce only after the signed effect succeeds", () =>
    Effect.gen(function* () {
      const committed: number[] = [];
      const persist = (n: number): Effect.Effect<void> =>
        Effect.sync(() => {
          committed.push(n);
        });
      const coord = yield* makeNonceCoordinator(undefined, persist);

      // A failing submission must not commit its nonce.
      const failure = yield* coord
        .runWithNonce(() => Effect.fail("submit_failed"))
        .pipe(Effect.flip);

      expect(failure).toBe("submit_failed");
      expect(committed).toEqual([]);

      // A succeeding one commits.
      const ok = yield* coord.runWithNonce((n) => Effect.succeed(n));
      expect(ok).toBe(committed[0]);
    }),
  );

  it.effect("produces strictly increasing nonces with no duplicates under concurrency", () =>
    Effect.gen(function* () {
      const coord = yield* makeNonceCoordinator();

      // Advance the clock once; all 50 concurrent submissions observe this
      // same millisecond. The serialized lane must still issue 50 distinct,
      // strictly-increasing nonces (each increments past the prior commit).
      yield* TestClock.adjust(Duration.millis(7_000));

      const effects = Array.from({ length: 50 }, (_, i) =>
        coord.runWithNonce((n) => Effect.succeed([i, n] as const)),
      );
      const results = yield* Effect.all(effects, { concurrency: "unbounded" });

      const nonces = results.map(([, n]) => n).sort((x, y) => x - y);
      const unique = new Set(nonces);
      expect(unique.size).toBe(50);
      for (let i = 1; i < nonces.length; i++) {
        const prev = nonces[i - 1];
        const curr = nonces[i];
        if (prev !== undefined && curr !== undefined) {
          expect(curr).toBeGreaterThan(prev);
        }
      }
    }).pipe(Effect.provide(testClock)),
  );

  it.effect("exposes the last-issued nonce as a recovery hint", () =>
    Effect.gen(function* () {
      const coord = yield* makeNonceCoordinator();
      yield* TestClock.adjust(Duration.millis(12_000));
      yield* coord.runWithNonce((n) => Effect.succeed(n));

      const hint = yield* coord.recoveryHint;
      expect(hint.lastIssuedNonce).toBe(12_000);
    }).pipe(Effect.provide(testClock)),
  );

  it.effect("seeds from a recovery hint so a restart never duplicates a nonce", () =>
    Effect.gen(function* () {
      const restart = new NonceRecoveryHint({ lastIssuedNonce: 9_999 });
      const coord = yield* makeNonceCoordinator(restart);
      // Wall clock (epoch 0) below the hint — coordinator must still issue
      // past it, never colliding with the pre-restart 9_999.
      const next = yield* coord.nextNonce;
      expect(next).toBe(10_000);
    }),
  );
});
