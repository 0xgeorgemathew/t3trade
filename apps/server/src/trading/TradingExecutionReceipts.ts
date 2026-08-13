/**
 * The signal that one execution is finished, instead of asking eighty times.
 *
 * `trading_execute` raises an event and the reactor answers it on another
 * fiber, so the tool has to wait for an answer it cannot see being produced. It
 * did that by re-reading the database every 250ms for twenty seconds: up to
 * eighty queries per execution, each one a guess, and a latency floor of a
 * quarter second on an execution that had already finished.
 *
 * The reactor knows the moment it is done. This is that moment, made into
 * something the waiting tool can block on: one latch per `(mission, sequence)`,
 * opened when the reactor settles the request, whichever way it settled. The
 * waiter then reads the durable record once, because the record — not the
 * signal — is still the truth.
 *
 * In-process only, and deliberately so: the latch is an optimisation over a
 * durable fact, never a substitute for it. A waiter that arrives after the
 * signal, or in another process, still reads the same record; it just waits out
 * its deadline first.
 *
 * @module TradingExecutionReceipts
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Duration from "effect/Duration";

export interface TradingExecutionReceiptsShape {
  /**
   * Wait for this execution to be settled, or for `timeoutMillis` to pass.
   *
   * Returns `true` when the reactor signalled, `false` on timeout. Either way
   * the caller reads the record: a `false` means "no signal arrived", not "it
   * did not happen".
   */
  readonly awaitSettled: (input: {
    readonly missionId: string;
    readonly executionSequence: number;
    readonly timeoutMillis: number;
  }) => Effect.Effect<boolean>;

  /**
   * Announce that an execution reached a durable conclusion — a written
   * record, a recorded refusal, a settled deterministic action. Called by the
   * reactor after the write, never before: a waiter woken early reads a record
   * that is not there yet and reports the execution as still in flight.
   */
  readonly settle: (input: {
    readonly missionId: string;
    readonly executionSequence: number;
  }) => Effect.Effect<void>;
}

export class TradingExecutionReceipts extends Context.Service<
  TradingExecutionReceipts,
  TradingExecutionReceiptsShape
>()("t3/trading/TradingExecutionReceipts") {}

const keyOf = (missionId: string, executionSequence: number): string =>
  `${missionId}:${executionSequence}`;

/** Longer than the execution outcome deadline; late waiters read durable state first. */
export const SETTLED_RECEIPT_RETENTION_MILLIS = 30_000;

export const makeTradingExecutionReceipts = Effect.gen(function* () {
  /**
   * One latch per in-flight execution.
   *
   * Entries are removed when the waiter finishes, and a settle for an
   * execution nobody is waiting on still leaves an open latch behind for the
   * waiter that has not arrived yet — which is the race that matters, because
   * the reactor regularly finishes before the tool starts waiting.
   */
  const latches = new Map<string, Latch.Latch>();

  const latchFor = (key: string) =>
    Effect.gen(function* () {
      const existing = latches.get(key);
      if (existing !== undefined) return existing;
      const created = yield* Latch.make(false);
      latches.set(key, created);
      return created;
    });

  const awaitSettled: TradingExecutionReceiptsShape["awaitSettled"] = (input) =>
    Effect.gen(function* () {
      const key = keyOf(input.missionId, input.executionSequence);
      const latch = yield* latchFor(key);
      const signalled = yield* latch.await.pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: `${input.timeoutMillis} millis`,
          orElse: () => Effect.succeed(false),
        }),
      );
      latches.delete(key);
      return signalled;
    });

  const settle: TradingExecutionReceiptsShape["settle"] = (input) =>
    Effect.gen(function* () {
      const key = keyOf(input.missionId, input.executionSequence);
      const latch = yield* latchFor(key);
      yield* latch.open;
      // A settle can beat its waiter, so retain the open latch through the
      // outcome deadline. It cannot stay forever: a waiter that found the
      // durable row before touching the latch would otherwise leak one map
      // entry per execution for the process lifetime.
      yield* Effect.sleep(Duration.millis(SETTLED_RECEIPT_RETENTION_MILLIS)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (latches.get(key) === latch) latches.delete(key);
          }),
        ),
        Effect.forkDetach,
      );
    });

  return { awaitSettled, settle } satisfies TradingExecutionReceiptsShape;
});

export const TradingExecutionReceiptsLive = Layer.effect(
  TradingExecutionReceipts,
  makeTradingExecutionReceipts,
);
