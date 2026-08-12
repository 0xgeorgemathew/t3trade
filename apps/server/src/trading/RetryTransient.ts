/**
 * One more try, for the failures where one more try is the whole fix.
 *
 * A quote and an exit are both built from three or four exchange reads, and any
 * one of them dropping takes the whole call down to `market_data_unavailable`.
 * The harness's only move then is to stand down — for a socket that would have
 * answered 250ms later. Whether that is the situation is not something the
 * harness can judge from a message, but it is something the error itself says,
 * which is what `classifyUnknownFailure` reads.
 *
 * Bounded at one deliberately. Two retries is a policy, and a policy about
 * retries is a thing that hides an outage; one is the difference between a blip
 * and a problem.
 *
 * Reads only. Nothing here is safe for a write: a submission whose outcome is
 * unknown is settled by reading its receipt, never by sending it again.
 *
 * @module RetryTransient
 */
import { classifyUnknownFailure } from "@t3tools/trading-contracts/recovery";
import * as Effect from "effect/Effect";

/**
 * Retry `read` once if — and only if — the failure says a second attempt could
 * answer differently, after the backoff that failure asks for.
 */
export const retryTransientRead = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  label: string,
): Effect.Effect<A, E, R> =>
  read.pipe(
    Effect.catch((error) => {
      const recovery = classifyUnknownFailure(error);
      if (!recovery.retryable) return Effect.fail(error);
      return Effect.logInfo("trading read failed transiently; retrying once", {
        read: label,
        reason: recovery.reason,
        retryAfterMillis: recovery.retryAfterMillis,
      }).pipe(
        Effect.andThen(Effect.sleep(`${recovery.retryAfterMillis} millis`)),
        Effect.andThen(read),
      );
    }),
  );
