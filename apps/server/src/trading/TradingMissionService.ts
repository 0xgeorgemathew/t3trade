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

import { PENDING_EXECUTION_STATUSES } from "@t3tools/trading-contracts/execution";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  TradingHarnessBindingImmutableError,
  TradingMissionAlreadyActiveError,
  TradingMissionNotFoundError,
  TradingMissionTransitionError,
  TradingMissionVersionConflictError,
} from "./Errors.ts";
import { isActiveMissionStatus, validateTransition } from "./MissionTransitions.ts";
import { resolveTestnetAuthority } from "./TestnetAuthority.ts";
import {
  EvmAddress,
  TradingAuthority,
  TradingHarnessBinding,
  TradingMarket,
  TradingMasterWallet,
  TradingMission,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  TradingPendingExecution,
} from "./Schemas.ts";

export const CreateTradingMissionInput = Schema.Struct({
  missionId: Schema.String,
  userId: Schema.String,
  tradingAccountId: Schema.String,
  instruction: Schema.String,
  allocatedCapitalUsd: Schema.Number,
  /** The market the mission is mandated to trade. Absent means the default (ETH). */
  market: Schema.optional(TradingMarket),
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
   * Create a mission with the testnet authority defaults applied to the mandate
   * (`TestnetAuthority`, env-overridable).
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
   * The mission row's optimistic-locking version.
   *
   * `TradingMission` is a published contract (§10.3) and does not carry the row
   * version, so a caller that needs to transition a mission it did not just
   * write reads the version through here.
   */
  readonly getMissionVersion: (
    missionId: string,
  ) => Effect.Effect<number, PersistenceSqlError | TradingMissionNotFoundError>;

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

  /**
   * The newest mission ever bound to `threadId`, terminal ones included.
   *
   * `findMissionByThreadId` is the authorization query and deliberately stops
   * seeing a mission the moment it is revoked or completed. That leaves a thread
   * whose mission has ended unable to learn anything at all about it, which is
   * the one moment it most wants to. This is the read that answers "what
   * happened to mine" — it grants nothing.
   */
  readonly findLastMissionByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;

  /**
   * The mission's mid-submission executions, oldest first.
   *
   * This is the set preview item 16 refuses a new intent against. Published so
   * a harness told `no_conflicting_execution_pending` can read what is holding
   * the lock and how stale it is, instead of only that something is.
   */
  readonly listPendingExecutions: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<TradingPendingExecution>, PersistenceSqlError>;

  /**
   * The master-wallet address for the account a mission trades against.
   *
   * Account reads (§14.2 `trading_look`, `trading_look`,
   * `trading_look`) use the user-owned master-wallet address as
   * identity — never the execution-wallet address (§10.6). This resolves the
   * address from the mission's trading account so the gateway receives it
   * server-side; the harness never supplies an address.
   */
  readonly getMasterWalletAddress: (
    tradingAccountId: string,
  ) => Effect.Effect<EvmAddress, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * The highest unrealised PnL this position has reached, from the reconciler's
   * durable high-water mark.
   *
   * `null` when the mission is flat, when the position has never been in
   * profit, or when it was opened before the mark was being recorded. The
   * exchange reports what a position is worth now and never what it was worth
   * at its best, so this is the only place a woken run can learn how much of a
   * winner it has already given back.
   */
  readonly readPeakUnrealisedPnl: (input: {
    readonly missionId: string;
    readonly market: string;
  }) => Effect.Effect<number | null, PersistenceSqlError>;

  /**
   * How far the held position has already come off that high-water mark — plan
   * 34 step 6.
   *
   * The same subtraction the wakeup composer publishes as
   * `position.drawdownFromPeakUsd`, read from the reconciler's snapshot rather
   * than from the exchange, so arming a watch does not cost a market read.
   * `null` when the mission is flat or has no peak to have come off.
   */
  readonly readDrawdownFromPeak: (input: {
    readonly missionId: string;
    readonly market: string;
  }) => Effect.Effect<number | null, PersistenceSqlError>;

  /**
   * Erase a mission and everything keyed to it, in one transaction.
   *
   * A settled mission is finished, and every row it ever wrote is finished with
   * it. Missions used to accumulate forever — the wall of settled rows on the
   * Trading Settings page — because nothing ever removed one.
   *
   * This deletes the mission's realised history too: its `trading_closed_trades`
   * rows go with it, so the calibration a later mission could have read off them
   * is gone. That is the accepted trade of "settled means gone".
   *
   * Idempotent (deleting absent rows is a no-op) and NOT guarded: the caller is
   * responsible for checking the mission is flat first. Deleting a mission that
   * still holds a position would strand real exposure with no record of who
   * opened it.
   */
  readonly deleteMission: (missionId: string) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * Every mission in a permanently terminal status, plus every non-terminal
   * mission whose bound thread no longer exists. The startup sweep's input.
   */
  readonly listDeletableMissions: () => Effect.Effect<
    ReadonlyArray<{ readonly missionId: string; readonly status: string }>,
    PersistenceSqlError
  >;
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
  readonly harness_json: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  readonly control_json: string;
  readonly authority_version: number;
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
  // Rows written before the market column carried a real choice all say "ETH";
  // anything unrecognised falls back rather than failing the whole hydrate.
  market: row.market === "BTC" ? "BTC" : "ETH",
  harness: decodeHarnessJson(row.harness_json),
  authority: decodeAuthorityJson(authorityJson),
  status: decodeStatus(row.status),
  ...(row.blocked_reason === null
    ? {}
    : { blockedReason: decodeBlockedReason(row.blocked_reason) }),
  control: decodeControlJson(row.control_json),
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
      // The partial unique index (migration 035) makes at most one row match,
      // so the ordering can never actually choose between two missions. It is
      // here because "at most one" is a database guarantee and reading a row
      // out of an unordered result set is a habit that outlives the guarantee:
      // drop the index and this quietly starts picking a mission at random.
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE user_id = ${userId} AND status NOT IN ('revoked', 'completed')
        ORDER BY created_at DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("findActiveMission")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  const getMissionVersion: TradingMissionServiceShape["getMissionVersion"] = (missionId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly version: number }>`
        SELECT version FROM trading_missions WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("getMissionVersion")));

      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }
      return row.version;
    });

  const listPendingExecutions: TradingMissionServiceShape["listPendingExecutions"] = (missionId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        readonly cloid: string;
        readonly action_type: string;
        readonly status: string;
        readonly updated_at: number;
      }>`
        SELECT cloid, action_type, status, updated_at FROM trading_execution_records
        WHERE mission_id = ${missionId}
          AND ${sql.in("status", PENDING_EXECUTION_STATUSES)}
        ORDER BY updated_at ASC
      `.pipe(Effect.mapError(sqlFail("listPendingExecutions")));

      return rows.map((row) => ({
        cloid: row.cloid,
        actionType: row.action_type,
        status: row.status,
        ageMillis: Math.max(0, now - row.updated_at),
      }));
    });

  const readPeakUnrealisedPnl: TradingMissionServiceShape["readPeakUnrealisedPnl"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly size: number;
        readonly peak_unrealised_pnl: number | null;
      }>`
        SELECT size, peak_unrealised_pnl FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
      `.pipe(Effect.mapError(sqlFail("readPeakUnrealisedPnl")));

      const row = rows[0];
      // A flat row keeps its columns around; a peak from the position before
      // this one is not this position's high-water mark.
      if (row === undefined || row.size === 0) return null;
      const peak = row.peak_unrealised_pnl;
      return peak === null || peak <= 0 ? null : peak;
    });

  const readDrawdownFromPeak: TradingMissionServiceShape["readDrawdownFromPeak"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly size: number;
        readonly unrealised_pnl: number;
        readonly peak_unrealised_pnl: number | null;
      }>`
        SELECT size, unrealised_pnl, peak_unrealised_pnl FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
      `.pipe(Effect.mapError(sqlFail("readDrawdownFromPeak")));

      const row = rows[0];
      if (row === undefined || row.size === 0) return null;
      const peak = row.peak_unrealised_pnl;
      if (peak === null || peak <= 0) return null;
      return Math.max(0, peak - row.unrealised_pnl);
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

  const findLastMissionByThreadId: TradingMissionServiceShape["findLastMissionByThreadId"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE json_extract(harness_json, '$.threadId') = ${threadId}
        ORDER BY created_at DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("findLastMissionByThreadId")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  // Decode the master-wallet JSON column. The address is the identity for
  // account reads (§10.6); the wallet's privy id is never sent to the exchange.
  const decodeMasterWalletJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(TradingMasterWallet),
  );

  const getMasterWalletAddress: TradingMissionServiceShape["getMasterWalletAddress"] = (
    tradingAccountId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ master_wallet_json: string }>`
        SELECT master_wallet_json FROM trading_accounts WHERE account_id = ${tradingAccountId}
      `.pipe(Effect.mapError(sqlFail("getMasterWalletAddress")));
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: tradingAccountId });
      }
      const wallet = yield* decodeMasterWalletJson(row.master_wallet_json).pipe(Effect.orDie);
      return wallet.address;
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

      // The testnet lab preset, not the spec's $1,000 worked example — see
      // `TestnetAuthority` for the sizing and the env knobs that adjust it.
      const authority = resolveTestnetAuthority(process.env, input.allocatedCapitalUsd);
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
          harness_json, status, blocked_reason, control_json,
          authority_version, version, last_harness_run_id,
          created_at, updated_at
        ) VALUES (
          ${input.missionId}, ${input.userId}, ${input.tradingAccountId},
          ${input.instruction}, ${input.market ?? "ETH"},
          ${encodeHarnessJson(input.harness)}, 'initializing', NULL,
          ${encodeControlJson(control)}, 1, 1, NULL, ${now}, ${now}
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

  const deleteMission: TradingMissionServiceShape["deleteMission"] = (missionId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Children first, then the projection, then the mission row. Order
          // does not matter to SQLite here (no foreign keys are declared), but
          // it keeps the intent readable: nothing is left pointing at a row
          // that is gone.
          yield* sql`DELETE FROM trading_watches WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_harness_runs WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_event_inbox WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_execution_records WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_orders WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_fills WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_position_snapshots WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_risk_reservations WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_closed_trades WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_account_snapshots WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_account_observations WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_authority_versions WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_plan_history WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM projection_trading_missions WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_missions WHERE mission_id = ${missionId}`;
        }),
      )
      .pipe(Effect.mapError(sqlFail("deleteMission")), Effect.asVoid);

  const listDeletableMissions: TradingMissionServiceShape["listDeletableMissions"] = () =>
    // Only orphans are deletable. A terminal (revoked/completed) mission with a
    // surviving thread is the permanent record of what was traded — plan 27 H1
    // stopped deleting those; a mission whose thread no longer exists has no
    // surface left to show that record on and nothing that can ever wake it.
    sql<{ readonly mission_id: string; readonly status: string }>`
      SELECT m.mission_id, m.status
      FROM trading_missions m
      WHERE NOT EXISTS (
              SELECT 1 FROM projection_threads t
              WHERE t.thread_id = json_extract(m.harness_json, '$.threadId')
            )
    `.pipe(
      Effect.mapError(sqlFail("listDeletableMissions")),
      Effect.map((rows) => rows.map((row) => ({ missionId: row.mission_id, status: row.status }))),
    );

  return {
    createMission,
    transition,
    updateHarnessBinding,
    getMission,
    getMissionVersion,
    findActiveMission,
    findMissionByThreadId,
    findLastMissionByThreadId,
    listPendingExecutions,
    getMasterWalletAddress,
    readPeakUnrealisedPnl,
    readDrawdownFromPeak,
    deleteMission,
    listDeletableMissions,
  } satisfies TradingMissionServiceShape;
});

export const TradingMissionServiceLive = Layer.effect(
  TradingMissionService,
  makeTradingMissionService,
);

export { isActiveMissionStatus };
