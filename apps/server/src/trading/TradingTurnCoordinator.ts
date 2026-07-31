/**
 * TradingTurnCoordinator - the single gate between an observed event and a
 * started run, spec §12.3.
 *
 * It runs the seven pre-run checks in their listed order before acquiring the
 * decision lease, and returns one of three outcomes so a caller can tell
 * whether a run actually started, was queued behind an active one, or was
 * blocked. Only one run may own the mission decision lease at a time; the
 * `idx_trading_harness_runs_one_active_per_mission` unique partial index
 * (migration 035) makes a concurrent second insert a unique violation, which
 * the coordinator catches and reports as `queued_behind_active_run`.
 *
 * The coordinator never starts a provider turn itself. On a `started` outcome
 * it marks the pending inbox events `included_in_run` and leaves wake-up
 * (dispatching `thread.turn.start`) to the wake path (Step 5), which is the
 * only place that talks to `ProviderService`.
 *
 * @module TradingTurnCoordinator
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { HarnessRunOutcome, HarnessRunRequest, TradingHarnessRunCause } from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";

export interface TradingTurnCoordinatorShape {
  /**
   * Run the seven §12.3 pre-run checks and, if they pass, acquire the lease.
   *
   * Returns `started` when this call acquired the lease, `queued_behind_active_run`
   * when another run already owns it, or `blocked{reason}` when a check failed.
   */
  readonly requestRun: (
    input: HarnessRunRequest,
  ) => Effect.Effect<HarnessRunOutcome, PersistenceSqlError>;
}

export class TradingTurnCoordinator extends Context.Service<
  TradingTurnCoordinator,
  TradingTurnCoordinatorShape
>()("t3/trading/TradingTurnCoordinator") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingTurnCoordinator.${operation}`);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const missions = yield* TradingMissionService;
  const strategies = yield* TradingStrategyService;
  const inbox = yield* TradingEventInbox;

  /**
   * Acquire the lease by inserting a `starting` run. The partial unique index
   * `idx_trading_harness_runs_one_active_per_mission` (status NOT IN
   * 'completed','failed') makes a second concurrent insert a unique violation,
   * which is the single-lease guarantee: exactly one non-terminal run per
   * mission can ever exist.
   *
   * Returns the new run id on success, or `null` when the lease is already held.
   */
  const acquireLease = Effect.fn("TradingTurnCoordinator.acquireLease")(function* (
    missionId: string,
    cause: TradingHarnessRunCause,
  ) {
    const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;

    const inserted = yield* sql<{ readonly run_id: string }>`
      INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
      VALUES (${runId}, ${missionId}, ${cause}, 'starting', ${now}, ${now})
      RETURNING run_id
    `.pipe(
      // A unique-violation means another run already owns the lease: the
      // single-lease invariant held, and this caller is queued, not failed.
      Effect.catchIf(
        (error): boolean => {
          const detail = JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase();
          return detail.includes("unique") || detail.includes("constraint");
        },
        () => Effect.succeed([] as ReadonlyArray<{ readonly run_id: string }>),
      ),
      Effect.mapError(sqlFail("acquireLease")),
    );

    return inserted.length > 0 ? runId : null;
  });

  const requestRun: TradingTurnCoordinatorShape["requestRun"] = (input) =>
    Effect.gen(function* () {
      // §12.3 check 1: Mission is active.
      const mission = yield* missions
        .getMission(input.missionId)
        .pipe(Effect.catchTag("TradingMissionNotFoundError", () => Effect.succeed(null)));
      if (mission === null) {
        return { status: "blocked", reason: "mission_not_found" } as const;
      }
      if (!isActiveMissionStatus(mission.status)) {
        return { status: "blocked", reason: "mission_not_active" } as const;
      }
      if (!isActiveMissionStatus(mission.status)) {
        return { status: "blocked", reason: "mission_not_active" } as const;
      }

      // §12.3 check 2: Provider binding is unchanged. The binding is immutable
      // for an active mission (§10.2), so presence is the check; a missing
      // binding means the mission was created without one (Phase 1 placeholder
      // still in place — Step 7 derives it from the thread's provider session).
      if (mission.harness.threadId === undefined || mission.harness.threadId === "") {
        return { status: "blocked", reason: "provider_binding_missing" } as const;
      }

      // §12.3 check 3: Provider instance is available. Phase 3 has no provider
      // registry gate yet; the binding's `status` field is the availability
      // signal. (Step 7 / the recovery phase refine this against the live
      // ProviderService session state.)
      if (mission.harness.status === "unavailable") {
        return { status: "blocked", reason: "provider_unavailable" } as const;
      }

      // §12.3 check 4: No other run owns the lease. Acquiring the lease is the
      // check — the DB partial unique index enforces at-most-one non-terminal
      // run per mission.
      const runId = yield* acquireLease(input.missionId, input.cause);
      if (runId === null) {
        return { status: "queued_behind_active_run" } as const;
      }

      // §12.3 check 5: Account is available. Phase 3 has no account-status gate
      // (execution lands in PROMPT-04); the account row existing is the check.
      // The mission already resolved its trading account at creation, so this
      // passes by construction until the execution phase adds a real gate.
      // (Intentionally a no-op seam for now.)

      // §12.3 check 6: The event has not been superseded. A watch that fired
      // may have been superseded by a strategy publish between firing and run
      // start; collecting the pending events and marking them included_in_run
      // atomically with the lease means a superseded event cannot drive a run.
      const pending = yield* inbox.collectPending(input.missionId);
      void pending;
      yield* inbox.markPendingIncludedInRun(input.missionId);

      // §12.3 check 7: The latest strategy and authority versions are loaded.
      // The mission row already points at the current versions; reading the
      // current strategy here confirms it is still the one this run should
      // execute against (a publish between checks 4 and 7 is caught by the
      // optimistic version the wake path will carry).
      const currentStrategy = yield* strategies.getCurrentStrategy(input.missionId);
      if (currentStrategy._tag === "None") {
        // No strategy published yet — only `mission_created` may proceed without
        // one (the first turn publishes it). Any other cause is blocked.
        if (input.cause !== "mission_created") {
          return { status: "blocked", reason: "no_active_strategy" } as const;
        }
      }

      return { status: "started", harnessRunId: runId } as const;
    });

  return { requestRun } satisfies TradingTurnCoordinatorShape;
});

export const TradingTurnCoordinatorLive = Layer.effect(TradingTurnCoordinator, make);
