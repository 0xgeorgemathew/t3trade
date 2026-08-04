/**
 * StaleSessionReconciler - clear sessions that outlived the process.
 *
 * A provider session lives in this process: the CLI child, the SDK query, the
 * event pump. Nothing survives a restart, and nothing is resumed eagerly at
 * boot. So a projected session still reading `starting` or `running` after the
 * server comes up is describing work that no longer exists — the last thing
 * that happened was the process going away before the adapter could emit
 * `session.exited`, which is the ordinary outcome of a crash, a `node --watch`
 * reload, or a quit mid-turn.
 *
 * Left alone the thread is stuck: the composer stays blocked, the sidebar
 * counts "Working for 57m", and the only way out is settling the thread. This
 * reconciler dispatches the same `thread.session.set` the adapter would have
 * sent, which settles the running turns and clears the pending turn start
 * through the normal projection path.
 *
 * @module StaleSessionReconciler
 */
import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

/** Stop every session row that claims to be live. */
export const reconcileStaleSessions = Effect.gen(function* () {
  const sessions = yield* ProjectionThreadSessionRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const stale = yield* sessions.listLive();
  if (stale.length === 0) {
    return;
  }

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* Effect.logInfo("stopping provider sessions that did not survive the last shutdown", {
    threadCount: stale.length,
  });

  yield* Effect.forEach(
    stale,
    (session) =>
      Effect.gen(function* () {
        const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandId),
          threadId: session.threadId,
          session: {
            threadId: session.threadId,
            status: "stopped",
            providerName: session.providerName,
            ...(session.providerInstanceId === null
              ? {}
              : { providerInstanceId: session.providerInstanceId }),
            runtimeMode: session.runtimeMode,
            activeTurnId: null,
            lastError: session.lastError,
            updatedAt: now,
          },
          createdAt: now,
        });
      }),
    { concurrency: 1, discard: true },
  );
});

/**
 * Runs the reconcile once at layer build.
 *
 * A failure here is logged rather than fatal: a thread left reading "running"
 * is a bad experience, not a reason to refuse to boot.
 */
export const StaleSessionReconcilerLive: Layer.Layer<
  never,
  never,
  ProjectionThreadSessionRepository | OrchestrationEngineService | Crypto.Crypto
> = Layer.effectDiscard(
  reconcileStaleSessions.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not reconcile provider sessions at startup", {
        cause: Cause.pretty(cause),
      }),
    ),
  ),
);
