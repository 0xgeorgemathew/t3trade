/**
 * TradingMissionSweep - the boot-time purge of missions that are over.
 *
 * A settled mission is deleted the moment it settles (see
 * `TradingMissionReactor.deleteWhenTerminalAndFlat`), but that rule only
 * applies from the release that introduced it. Databases in the field already
 * hold every mission ever created: the wall of dead rows on the Trading
 * Settings page, plus missions whose thread was deleted out from under them and
 * which nothing will ever settle.
 *
 * Two categories go, both at boot, both only while flat:
 * - permanently terminal missions (`revoked` / `completed`);
 * - non-terminal missions with no surviving thread — nothing can wake them,
 *   nothing can settle them, and they hold the one active-mission slot.
 *
 * Kept rather than made a one-off migration because it is idempotent and cheap:
 * on a clean database it finds nothing, and it is the backstop for any path
 * that fails to delete at settle time.
 *
 * @module TradingMissionSweep
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingMissionService } from "./TradingMissionService.ts";

/**
 * Whether the mission still has exposure on the exchange, per the reconciled
 * snapshot. A row is never deleted while this is true: doing so would strand
 * real money with no record of who opened it.
 */
const holdsPosition = (missionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly open_count: number }>`
      SELECT COUNT(*) AS open_count FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND size != 0
    `;
    return (rows[0]?.open_count ?? 0) > 0;
  });

export const purgeFinishedMissions = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  const candidates = yield* missions.listDeletableMissions();
  if (candidates.length === 0) return;

  let deleted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (yield* holdsPosition(candidate.missionId)) {
      skipped += 1;
      continue;
    }
    yield* missions.deleteMission(candidate.missionId);
    deleted += 1;
  }

  yield* Effect.logInfo("TradingMissionSweep: purged finished missions", {
    deleted,
    skippedHoldingPosition: skipped,
  });
});

/**
 * Runs the sweep once at layer build. A failure is logged rather than fatal:
 * housekeeping must never stop the server booting.
 */
export const TradingMissionSweepLive: Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | TradingMissionService
> = Layer.effectDiscard(
  purgeFinishedMissions.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("TradingMissionSweep: could not purge finished missions", {
        cause: Cause.pretty(cause),
      }),
    ),
  ),
);
