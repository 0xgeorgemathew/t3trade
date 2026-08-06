/**
 * TradingAutoMission - a mission starts when the user says what they want.
 *
 * A mission used to be created on `thread.created` with a static instruction,
 * which meant the harness was already analysing a market before the user had
 * typed anything, against a mandate nobody wrote. The first message on a fresh
 * thread IS the instruction, so that is when the mission is created — and the
 * `mission_created` bootstrap run, which already carries the instruction, is
 * that message's turn.
 *
 * This lives outside `ws.ts` because the decision has four inputs (the
 * auto-mission config, the thread's history, the workspace scope, and who holds
 * the single active-mission slot) and exactly one of them is about websockets.
 * `ws.ts` asks one question and acts on one of three answers.
 *
 * @module TradingAutoMission
 */
import { CommandId, ThreadId, TradingMissionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { AutoMissionConfig } from "./AutoMissionConfig.ts";
import { TradingMissionService } from "./TradingMissionService.ts";

/**
 * The user id every locally-created mission belongs to. Mirrors the reactor's
 * own constant — a lab server has one operator.
 */
const LOCAL_TRADING_USER_ID = "local";

/**
 * The longest instruction a mission is created with.
 *
 * The instruction is read back on every `trading_get_mission` and embedded in
 * the bootstrap wakeup, so a pasted essay would ride along for the mission's
 * life. Two thousand characters is more mandate than anyone writes and still
 * bounded.
 */
const MAX_INSTRUCTION_CHARS = 2_000;

export type AutoMissionOutcome =
  /** Nothing to do — dispatch the turn the ordinary way. */
  | { readonly kind: "not_applicable" }
  /**
   * A mission was created for this thread. The `mission_created` bootstrap run
   * is this message's turn, so the caller must NOT also dispatch it.
   */
  | { readonly kind: "mission_created"; readonly missionId: string }
  /**
   * The active slot is held by a mission with real exposure. No mission was
   * created; the caller dispatches the turn the ordinary way and shows this
   * message so the user knows why the thread is not a trading thread.
   */
  | { readonly kind: "slot_held"; readonly message: string };

export interface TradingAutoMissionShape {
  readonly claimFirstMessage: (input: {
    readonly threadId: string;
    readonly text: string;
    /**
     * The thread's project, when the caller already knows it. A thread created
     * in the same dispatch is not projected yet, so the scope check would
     * otherwise read nothing and decline every brand-new thread.
     */
    readonly projectId?: string;
  }) => Effect.Effect<AutoMissionOutcome>;
}

export class TradingAutoMission extends Context.Service<
  TradingAutoMission,
  TradingAutoMissionShape
>()("t3/trading/TradingAutoMission") {}

export const SLOT_HELD_MESSAGE =
  "Another mission still holds a position — settle that thread first.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const missions = yield* TradingMissionService;
  const autoMission = yield* AutoMissionConfig;
  const crypto = yield* Crypto.Crypto;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * "First message" means the thread has never run a turn. An old thread with
   * history that happens to be typed into again is not a fresh mission — it is
   * an ordinary conversation that predates trading.
   */
  const hasPriorTurns = (threadId: string) =>
    sql<{ readonly turn_count: number }>`
      SELECT COUNT(*) AS turn_count FROM projection_turns WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => (rows[0]?.turn_count ?? 0) > 0));

  /**
   * The workspace root of the project a thread (or a named project) belongs to,
   * or null when neither is projected yet.
   */
  const workspaceRootOf = (threadId: string, projectId: string | undefined) =>
    (projectId === undefined
      ? sql<{ readonly workspace_root: string }>`
          SELECT p.workspace_root
          FROM projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.thread_id = ${threadId}
        `
      : sql<{ readonly workspace_root: string }>`
          SELECT workspace_root FROM projection_projects WHERE project_id = ${projectId}
        `
    ).pipe(Effect.map((rows) => rows[0]?.workspace_root ?? null));

  /** Whether the auto-mission scope (when set) covers this thread's project. */
  const inScope = (input: {
    readonly threadId: string;
    readonly projectId: string | undefined;
    readonly workspaceRoot: string | null;
  }) =>
    Effect.gen(function* () {
      if (input.workspaceRoot === null) return true;
      const root = yield* workspaceRootOf(input.threadId, input.projectId);
      return root === input.workspaceRoot;
    });

  const holdsPosition = (missionId: string) =>
    sql<{ readonly open_count: number }>`
      SELECT COUNT(*) AS open_count FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND size != 0
    `.pipe(Effect.map((rows) => (rows[0]?.open_count ?? 0) > 0));

  const claimFirstMessage: TradingAutoMissionShape["claimFirstMessage"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* autoMission.resolve;
      if (Option.isNone(settings)) return { kind: "not_applicable" } as const;

      // Already a trading thread: the coordinator's user-message path owns it.
      const bound = yield* missions.findMissionByThreadId(input.threadId);
      if (Option.isSome(bound)) return { kind: "not_applicable" } as const;

      const instruction = input.text.trim().slice(0, MAX_INSTRUCTION_CHARS);
      if (instruction === "") return { kind: "not_applicable" } as const;

      if (yield* hasPriorTurns(input.threadId)) return { kind: "not_applicable" } as const;
      const scoped = yield* inScope({
        threadId: input.threadId,
        projectId: input.projectId,
        workspaceRoot: settings.value.workspaceRoot,
      });
      if (!scoped) return { kind: "not_applicable" } as const;

      // One active mission per user is a domain invariant (§10.1), so claiming
      // the slot means retiring whoever holds it. Safe only while the incumbent
      // is flat — revoking a mission that holds a position would strand real
      // exposure behind a mission with no authority left to manage it.
      const active = yield* missions.findActiveMission(LOCAL_TRADING_USER_ID);
      const threadId = ThreadId.make(input.threadId);
      if (Option.isSome(active)) {
        const incumbent = active.value;
        if (yield* holdsPosition(incumbent.id)) {
          yield* Effect.logInfo("auto-mission: incumbent holds a position, slot not taken", {
            threadId: input.threadId,
            incumbentMissionId: incumbent.id,
          });
          return { kind: "slot_held", message: SLOT_HELD_MESSAGE } as const;
        }

        // Revoked through the ordinary control command so the reactor's own
        // terminal handling runs: status announced, session profile cleared,
        // the flat mission deleted. The reactor's worker is ordered, so this
        // lands before the create below.
        yield* engine.dispatch({
          type: "trading.mission.revoke",
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          threadId: ThreadId.make(incumbent.harness.threadId ?? ""),
          missionId: TradingMissionId.make(incumbent.id),
          createdAt: yield* nowIso,
        });
        yield* Effect.logInfo("auto-mission: taking the active slot from a flat incumbent", {
          threadId: input.threadId,
          incumbentMissionId: incumbent.id,
          incumbentStatus: incumbent.status,
        });
      }

      const missionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* engine.dispatch({
        type: "trading.mission.create",
        commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        threadId,
        missionId: TradingMissionId.make(missionId),
        tradingAccountId: settings.value.tradingAccountId,
        // The message IS the mandate. That is the whole point of moving
        // creation here from `thread.created`.
        instruction,
        ...(settings.value.allocatedCapitalUsd === null
          ? {}
          : { allocatedCapitalUsd: settings.value.allocatedCapitalUsd }),
        createdAt: yield* nowIso,
      });

      yield* Effect.logInfo("auto-mission: created from the thread's first message", {
        threadId: input.threadId,
        missionId,
      });
      return { kind: "mission_created", missionId } as const;
    }).pipe(
      // Never cost the user their message: any failure here falls back to the
      // ordinary turn.
      Effect.catchCause((cause) =>
        Effect.logWarning("auto-mission: could not claim the first message", {
          threadId: input.threadId,
          cause: String(cause),
        }).pipe(Effect.as({ kind: "not_applicable" } as const)),
      ),
    );

  return { claimFirstMessage } satisfies TradingAutoMissionShape;
});

export const TradingAutoMissionLive = Layer.effect(TradingAutoMission, make);
