/**
 * TradingMissionService - durable mission lifecycle.
 *
 * Owns mission creation, the §11.1 status transitions, and the
 * one-active-mission invariant. A harness turn is temporary; the records this
 * service writes are what outlive it.
 *
 * @module TradingMissionService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  TradingHarnessBindingImmutableError,
  TradingMissionAlreadyActiveError,
  TradingMissionNotFoundError,
  TradingMissionTransitionError,
  TradingMissionVersionConflictError,
} from "./Errors.ts";
import { isActiveMissionStatus, validateTransition } from "./MissionTransitions.ts";
import {
  pocAuthorityDefaults,
  TradingAuthority,
  TradingHarnessBinding,
  TradingMission,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
} from "./Schemas.ts";

export const CreateTradingMissionInput = Schema.Struct({
  missionId: Schema.String,
  userId: Schema.String,
  tradingAccountId: Schema.String,
  instruction: Schema.String,
  allocatedCapitalUsd: Schema.Number,
  harness: TradingHarnessBinding,
});
export type CreateTradingMissionInput = typeof CreateTradingMissionInput.Type;

export const TransitionTradingMissionInput = Schema.Struct({
  missionId: Schema.String,
  to: TradingMissionStatus,
  expectedVersion: Schema.Number,
  blockedReason: Schema.optional(TradingMissionBlockedReason),
});
export type TransitionTradingMissionInput = typeof TransitionTradingMissionInput.Type;

export const UpdateHarnessBindingInput = Schema.Struct({
  missionId: Schema.String,
  expectedVersion: Schema.Number,
  harness: TradingHarnessBinding,
});
export type UpdateHarnessBindingInput = typeof UpdateHarnessBindingInput.Type;

/**
 * The binding fields frozen for the life of an active mission (§10.2). Recovery
 * §18.3 depends on this: "no restart ever performs automatic provider
 * substitution."
 */
export const HARNESS_BINDING_IDENTITY_FIELDS = [
  "provider",
  "providerInstanceId",
  "threadId",
] as const;

const changedIdentityFields = (
  current: TradingHarnessBinding,
  next: TradingHarnessBinding,
): ReadonlyArray<string> =>
  HARNESS_BINDING_IDENTITY_FIELDS.filter((field) => current[field] !== next[field]);

export type TradingMissionServiceError =
  | PersistenceSqlError
  | TradingMissionAlreadyActiveError
  | TradingMissionNotFoundError
  | TradingMissionTransitionError
  | TradingMissionVersionConflictError;

export interface TradingMissionServiceShape {
  /**
   * Create a mission with the POC authority defaults applied to the mandate.
   *
   * Fails with `TradingMissionAlreadyActiveError` when the user already holds a
   * mission that is not in a permanent terminal state.
   */
  readonly createMission: (
    input: CreateTradingMissionInput,
  ) => Effect.Effect<
    TradingMission,
    PersistenceSqlError | TradingMissionAlreadyActiveError | TradingMissionNotFoundError
  >;

  /** Move a mission to a new status, enforcing §11.1 and the row version. */
  readonly transition: (
    input: TransitionTradingMissionInput,
  ) => Effect.Effect<TradingMission, TradingMissionServiceError>;

  /**
   * Update the binding's runtime bookkeeping — session id, resume cursor,
   * model, availability — which ProviderService owns and which changes as a
   * session starts, resumes, and drops.
   *
   * Fails with `TradingHarnessBindingImmutableError` if the caller tries to
   * change the binding's identity (provider, providerInstanceId, threadId)
   * while the mission is active.
   */
  readonly updateHarnessBinding: (
    input: UpdateHarnessBindingInput,
  ) => Effect.Effect<
    TradingMission,
    | PersistenceSqlError
    | TradingHarnessBindingImmutableError
    | TradingMissionNotFoundError
    | TradingMissionVersionConflictError
  >;

  readonly getMission: (
    missionId: string,
  ) => Effect.Effect<TradingMission, PersistenceSqlError | TradingMissionNotFoundError>;

  /** The user's mission that still holds authority, if any. */
  readonly findActiveMission: (
    userId: string,
  ) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;

  /**
   * The still-authoritative mission whose harness binding names `threadId`, if
   * any.
   *
   * This is how a harness-facing tool call resolves which mission it is allowed
   * to act on: the credential carries a thread, §10.2 freezes that thread onto
   * one active mission, so the thread is the authorization.
   */
  readonly findMissionByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;
}

export class TradingMissionService extends Context.Service<
  TradingMissionService,
  TradingMissionServiceShape
>()("t3/trading/TradingMissionService") {}

interface MissionRow {
  readonly mission_id: string;
  readonly user_id: string;
  readonly trading_account_id: string;
  readonly instruction: string;
  readonly market: string;
  readonly strategy_family: string;
  readonly harness_json: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  readonly control_json: string;
  readonly authority_version: number;
  readonly strategy_version: number;
  readonly version: number;
  readonly last_harness_run_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

// JSON text columns are decoded and encoded through the contract schemas, so a
// malformed row fails loudly instead of flowing into the domain as `any`.
const HarnessJson = Schema.fromJsonString(TradingHarnessBinding);
const ControlJson = Schema.fromJsonString(TradingMissionControl);
const AuthorityJson = Schema.fromJsonString(TradingAuthority);

const decodeHarnessJson = Schema.decodeUnknownSync(HarnessJson);
const decodeControlJson = Schema.decodeUnknownSync(ControlJson);
const decodeAuthorityJson = Schema.decodeUnknownSync(AuthorityJson);
const encodeHarnessJson = Schema.encodeUnknownSync(HarnessJson);
const encodeControlJson = Schema.encodeUnknownSync(ControlJson);
const encodeAuthorityJson = Schema.encodeUnknownSync(AuthorityJson);
const decodeStatus = Schema.decodeUnknownSync(TradingMissionStatus);
const decodeBlockedReason = Schema.decodeUnknownSync(TradingMissionBlockedReason);

/**
 * The mission row plus its current authority version. Strategy is intentionally
 * left off: it is published separately and joined by the read tools.
 */
const toMission = (row: MissionRow, authorityJson: string): TradingMission => ({
  id: row.mission_id,
  userId: row.user_id,
  tradingAccountId: row.trading_account_id,
  instruction: row.instruction,
  market: "ETH",
  strategyFamily: "momentum",
  harness: decodeHarnessJson(row.harness_json),
  authority: decodeAuthorityJson(authorityJson),
  status: decodeStatus(row.status),
  ...(row.blocked_reason === null
    ? {}
    : { blockedReason: decodeBlockedReason(row.blocked_reason) }),
  control: decodeControlJson(row.control_json),
  strategyVersion: row.strategy_version,
  authorityVersion: row.authority_version,
  ...(row.last_harness_run_id === null ? {} : { lastHarnessRunId: row.last_harness_run_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const makeTradingMissionService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingMissionService.${operation}`);

  const readMissionRow = (missionId: string) =>
    sql<MissionRow>`
      SELECT * FROM trading_missions WHERE mission_id = ${missionId}
    `.pipe(Effect.mapError(sqlFail("readMissionRow")));

  const readAuthorityJson = (missionId: string, version: number) =>
    sql<{ readonly authority_json: string }>`
      SELECT authority_json FROM trading_authority_versions
      WHERE mission_id = ${missionId} AND version = ${version}
    `.pipe(Effect.mapError(sqlFail("readAuthorityJson")));

  /** Hydrate a mission row together with the authority version it points at. */
  const hydrate = (row: MissionRow) =>
    Effect.gen(function* () {
      const authority = yield* readAuthorityJson(row.mission_id, row.authority_version);
      const authorityJson = authority[0]?.authority_json;
      if (authorityJson === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: row.mission_id });
      }
      return toMission(row, authorityJson);
    });

  const getMission: TradingMissionServiceShape["getMission"] = (missionId) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }
      return yield* hydrate(row);
    });

  const findActiveMission: TradingMissionServiceShape["findActiveMission"] = (userId) =>
    Effect.gen(function* () {
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE user_id = ${userId} AND status NOT IN ('revoked', 'completed')
      `.pipe(Effect.mapError(sqlFail("findActiveMission")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  const findMissionByThreadId: TradingMissionServiceShape["findMissionByThreadId"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE json_extract(harness_json, '$.threadId') = ${threadId}
          AND status NOT IN ('revoked', 'completed')
      `.pipe(Effect.mapError(sqlFail("findMissionByThreadId")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  const createMission: TradingMissionServiceShape["createMission"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* findActiveMission(input.userId);
      if (Option.isSome(existing)) {
        return yield* new TradingMissionAlreadyActiveError({
          userId: input.userId,
          activeMissionId: existing.value.id,
          activeStatus: existing.value.status,
        });
      }

      const authority = pocAuthorityDefaults(input.allocatedCapitalUsd);
      const control: TradingMissionControl = {
        entriesAllowed: true,
        reentryAllowed: authority.allowReentry,
        pauseAfterPositionClose: false,
      };
      const now = yield* Clock.currentTimeMillis;

      yield* sql`
        INSERT INTO trading_authority_versions (mission_id, version, authority_json, created_at)
        VALUES (${input.missionId}, 1, ${encodeAuthorityJson(authority)}, ${now})
      `.pipe(Effect.mapError(sqlFail("createMission:authority")));

      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          strategy_family, harness_json, status, blocked_reason, control_json,
          authority_version, strategy_version, version, last_harness_run_id,
          created_at, updated_at
        ) VALUES (
          ${input.missionId}, ${input.userId}, ${input.tradingAccountId},
          ${input.instruction}, 'ETH', 'momentum',
          ${encodeHarnessJson(input.harness)}, 'initializing', NULL,
          ${encodeControlJson(control)}, 1, 0, 1, NULL, ${now}, ${now}
        )
      `.pipe(Effect.mapError(sqlFail("createMission:mission")));

      return yield* getMission(input.missionId);
    });

  const transition: TradingMissionServiceShape["transition"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(input.missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: input.missionId });
      }
      if (row.version !== input.expectedVersion) {
        return yield* new TradingMissionVersionConflictError({
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion: row.version,
        });
      }

      const current = yield* hydrate(row);

      const rejection = validateTransition({
        from: current.status,
        to: input.to,
        blockedReason: input.blockedReason,
      });
      if (rejection !== undefined) {
        return yield* new TradingMissionTransitionError({
          missionId: input.missionId,
          from: current.status,
          to: input.to,
          reason: rejection.reason,
          ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
        });
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE trading_missions
        SET status = ${input.to},
            blocked_reason = ${input.blockedReason ?? null},
            version = version + 1,
            updated_at = ${now}
        WHERE mission_id = ${input.missionId} AND version = ${input.expectedVersion}
      `.pipe(Effect.mapError(sqlFail("transition")));

      return yield* getMission(input.missionId);
    });

  const updateHarnessBinding: TradingMissionServiceShape["updateHarnessBinding"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(input.missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: input.missionId });
      }
      if (row.version !== input.expectedVersion) {
        return yield* new TradingMissionVersionConflictError({
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion: row.version,
        });
      }

      const current = yield* hydrate(row);
      const changed = changedIdentityFields(current.harness, input.harness);
      if (changed.length > 0 && isActiveMissionStatus(current.status)) {
        return yield* new TradingHarnessBindingImmutableError({
          missionId: input.missionId,
          status: current.status,
          changedFields: changed,
        });
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE trading_missions
        SET harness_json = ${encodeHarnessJson(input.harness)},
            version = version + 1,
            updated_at = ${now}
        WHERE mission_id = ${input.missionId} AND version = ${input.expectedVersion}
      `.pipe(Effect.mapError(sqlFail("updateHarnessBinding")));

      return yield* getMission(input.missionId);
    });

  return {
    createMission,
    transition,
    updateHarnessBinding,
    getMission,
    findActiveMission,
    findMissionByThreadId,
  } satisfies TradingMissionServiceShape;
});

export const TradingMissionServiceLive = Layer.effect(
  TradingMissionService,
  makeTradingMissionService,
);

export { isActiveMissionStatus };
