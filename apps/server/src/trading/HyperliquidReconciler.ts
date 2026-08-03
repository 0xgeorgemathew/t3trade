/**
 * HyperliquidReconciler — converges local state to canonical exchange state
 * on the eight §18.2 triggers.
 *
 * Hyperliquid is the canonical source of market and account truth. Local
 * records (fills, position snapshots, open orders) are hints until canonical
 * account/order/position state confirms them. This service reads canonical
 * state via the master-wallet address and upserts the migration-037 tables so
 * the projection and loss-budget accounting reflect reconciled truth.
 *
 * The eight triggers (§18.2): at server startup, after WebSocket reconnect,
 * before execution, after submission, after each fill, after position updates,
 * before resuming a paused mission, and periodically while a position is open.
 * Each is a named entry point that funnels into `reconcile`.
 *
 * @module HyperliquidReconciler
 */
import { Context, Effect, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import { confirmedProtectedSize } from "@t3tools/trading-contracts/protection";
import type {
  TradingFill,
  TradingOpenOrderRecord,
  TradingPositionSnapshot,
} from "@t3tools/trading-contracts/execution";

import { TradingEventInbox } from "./TradingEventInbox.ts";

/** The reconciler failed at a named stage. */
export class TradingReconciliationError extends Schema.TaggedErrorClass<TradingReconciliationError>()(
  "TradingReconciliationError",
  {
    reason: Schema.Literals([
      "account_read_failed",
      "fills_read_failed",
      "orders_read_failed",
      "persist_failed",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingReconciliationError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** The eight §18.2 reconciliation triggers. */
export const RECONCILIATION_TRIGGERS = [
  "server_startup",
  "websocket_reconnect",
  "before_execution",
  "after_submission",
  "after_fill",
  "after_position_update",
  "before_resuming_paused_mission",
  "periodic_while_position_open",
] as const;
export type ReconciliationTrigger = (typeof RECONCILIATION_TRIGGERS)[number];

/** Inputs the reconciler needs: which mission + master address to reconcile. */
export interface ReconcileInput {
  readonly missionId: string;
  /** The master-wallet address (§10.6 identity — never the execution wallet). */
  readonly masterAddress: string;
  /** The traded market (POC: ETH). */
  readonly market: string;
}

/** A reconciled snapshot of all canonical state for a mission. */
export interface ReconciledState {
  readonly position: TradingPositionSnapshot | null;
  /** T3's own orders, keyed by cloid. */
  readonly openOrders: ReadonlyArray<TradingOpenOrderRecord>;
  /**
   * Every resting order on the account, including ones T3 did not place.
   * Protection confirmation reads this, not `openOrders` — a linked TP/SL
   * child carries a cloid T3 never chose, and it still protects the position.
   */
  readonly canonicalOrders: ReadonlyArray<AgentOpenOrder>;
  readonly fills: ReadonlyArray<TradingFill>;
  readonly observedAt: number;
  /**
   * Changes this pass observed that no order of this mission's explains. The
   * caller wakes the harness for them — the reconciler only names them.
   */
  readonly externalChanges: ReadonlyArray<ExternalChange>;
}

/**
 * The reconciler. `reconcile` is the single convergence path; the eight
 * trigger entry points all funnel through it, recording which trigger fired.
 */
export class HyperliquidReconciler extends Context.Service<
  HyperliquidReconciler,
  {
    /** Run the full reconciliation for one mission + master address. */
    readonly reconcile: (
      input: ReconcileInput,
      trigger: ReconciliationTrigger,
    ) => Effect.Effect<
      ReconciledState,
      TradingReconciliationError,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;
  }
>()("t3/trading/HyperliquidReconciler") {}

const now = (): Effect.Effect<number> => Clock.currentTimeMillis;

/** The canonical account read: this mission's position, plus the account value. */
interface CanonicalAccount {
  readonly position: TradingPositionSnapshot | null;
  readonly accountValue: number;
}

/**
 * Read canonical position + account state via the gateway (master address),
 * returning a `TradingPositionSnapshot` or null when flat. Reads the full
 * account snapshot so the liquidation price surfaces to the position card, and
 * carries the account value out so the transfer detector has something to diff.
 */
function readCanonicalAccount(
  input: ReconcileInput,
  observedAt: number,
): Effect.Effect<CanonicalAccount, TradingReconciliationError, HyperliquidGateway> {
  return Effect.gen(function* () {
    const gateway = yield* HyperliquidGateway;
    const snapshot = yield* gateway.getAccountSnapshot(input.masterAddress as `0x${string}`).pipe(
      Effect.mapError(
        (cause) =>
          new TradingReconciliationError({
            reason: "account_read_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    const accountValue = snapshot.accountValue;
    const position = snapshot.positions.find((p) => p.market === input.market);
    if (position === undefined || position.size === 0) return { position: null, accountValue };
    // The clearinghouse position payload carries no mark price field; the mark
    // lives on the asset context (metaAndAssetCtxs.markPx). Rather than make a
    // second network call per reconcile, derive it from the unrealised PnL the
    // exchange already reports: upnl = (mark - entry) × size for longs, and the
    // mirror for shorts, so mark = entry + upnl/size (sign carried by size).
    const markPx = position.entryPrice + position.unrealisedPnl / position.size;
    return {
      accountValue,
      position: {
        missionId: input.missionId,
        market: input.market,
        size: position.size,
        entryPrice: position.entryPrice,
        unrealisedPnl: position.unrealisedPnl,
        marginUsed: position.marginUsed,
        // Filled in by `reconcile` once the canonical open orders are in hand
        // (§17.2 steps 7–8) — a position read on its own cannot know it.
        protectedSize: 0,
        liquidationPrice: position.liquidationPx,
        markPx,
        observedAt,
      } as TradingPositionSnapshot,
    };
  });
}

/**
 * Read canonical open orders via the gateway.
 *
 * Returns the full canonical set, not only T3's own orders: protection
 * confirmation has to see every resting reduce-only trigger on the position,
 * including one placed outside T3 (or by a linked TP/SL child whose cloid T3
 * never chose). The persisted subset is narrowed later, by cloid.
 */
function readCanonicalOpenOrders(
  input: ReconcileInput,
): Effect.Effect<ReadonlyArray<AgentOpenOrder>, TradingReconciliationError, HyperliquidGateway> {
  return Effect.gen(function* () {
    const gateway = yield* HyperliquidGateway;
    return yield* gateway.getOpenOrders(input.masterAddress as `0x${string}`).pipe(
      Effect.mapError(
        (cause) =>
          new TradingReconciliationError({
            reason: "orders_read_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  });
}

/**
 * Narrow the canonical orders to the rows T3 persists — its own, keyed by
 * cloid — carrying the reduce-only flag the exchange reported rather than a
 * hardcoded `false`.
 */
function toOpenOrderRecords(
  orders: ReadonlyArray<AgentOpenOrder>,
  input: ReconcileInput,
  observedAt: number,
): ReadonlyArray<TradingOpenOrderRecord> {
  return orders
    .filter((o) => o.cloid !== undefined)
    .map(
      (o) =>
        ({
          missionId: input.missionId,
          cloid: o.cloid ?? "",
          orderId: o.orderId,
          market: o.market,
          side: o.side,
          limitPrice: o.limitPrice,
          remainingSize: o.remainingSize,
          reduceOnly: o.reduceOnly,
          observedAt,
        }) as TradingOpenOrderRecord,
    );
}

/**
 * Read canonical fills via the InfoClient userFills endpoint and map them to
 * `TradingFill` records. Only the mission's market's fills are kept.
 */
function readCanonicalFills(
  input: ReconcileInput,
  observedAt: number,
): Effect.Effect<ReadonlyArray<TradingFill>, TradingReconciliationError, HyperliquidInfoClient> {
  return Effect.gen(function* () {
    const info = yield* HyperliquidInfoClient;
    const wireFills = yield* info.userFills(input.masterAddress).pipe(
      Effect.mapError(
        (cause) =>
          new TradingReconciliationError({
            reason: "fills_read_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
    return wireFills
      .filter((f) => f.coin === input.market)
      .map(
        (f, idx) =>
          ({
            // Fill identity: prefer the exchange hash; fall back to a composite
            // cloid-time-idx rather than bare cloid. Two partial fills of the
            // same order share a cloid but are distinct fill events — a bare
            // cloid would collide on fill_id and the idempotent upsert would
            // silently drop one. `hash` is optional on the wire fill, so the
            // composite must carry the timestamp (and a positional idx as a
            // tiebreaker for same-ms partials).
            fillId: f.hash ?? `${f.cloid ?? f.oid}-${f.time}-${idx}`,
            missionId: input.missionId,
            cloid: f.cloid,
            orderId: f.oid,
            market: f.coin,
            side: f.side === "B" ? "buy" : "sell",
            filledSize: Number.parseFloat(f.sz),
            avgFillPrice: Number.parseFloat(f.px),
            feeUsd: Number.parseFloat(f.fee),
            feeToken: f.feeToken ?? "USDC",
            // §16.2 closedPnl: the realised PnL the exchange attributes to this
            // fill. Absent on some fills (e.g. entry increases) — treat as 0.
            closedPnl: f.closedPnl !== undefined ? Number.parseFloat(f.closedPnl) : 0,
            tradedAt: f.time,
            observedAt,
          }) as TradingFill,
      );
  });
}

/** Upsert the reconciled position snapshot (one row per mission+market). */
function persistPosition(
  position: TradingPositionSnapshot | null,
  input: ReconcileInput,
): Effect.Effect<void, TradingReconciliationError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ts = yield* now();
    if (position === null) {
      // Flat — clear the snapshot row.
      yield* sql`
        UPDATE trading_position_snapshots
        SET size = 0, entry_price = NULL, unrealised_pnl = 0, margin_used = 0,
            protected_size = 0, liquidation_price = NULL, mark_px = NULL, observed_at = ${ts}
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
      `;
      return;
    }
    yield* sql`
      INSERT INTO trading_position_snapshots (
        mission_id, market, size, entry_price, unrealised_pnl, margin_used,
        protected_size, liquidation_price, mark_px, observed_at
      ) VALUES (
        ${position.missionId}, ${position.market}, ${position.size},
        ${position.entryPrice ?? null}, ${position.unrealisedPnl},
        ${position.marginUsed}, ${position.protectedSize},
        ${position.liquidationPrice ?? null}, ${position.markPx ?? null}, ${position.observedAt}
      )
      ON CONFLICT(mission_id, market) DO UPDATE SET
        size = ${position.size}, entry_price = ${position.entryPrice ?? null},
        unrealised_pnl = ${position.unrealisedPnl}, margin_used = ${position.marginUsed},
        protected_size = ${position.protectedSize},
        liquidation_price = ${position.liquidationPrice ?? null},
        mark_px = ${position.markPx ?? null},
        observed_at = ${position.observedAt}
    `;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingReconciliationError({
          reason: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/**
 * Append reconciled fills (idempotent on `fill_id` — re-running a reconcile
 * never duplicates a fill, never overwrites the realised PnL the exchange
 * already reported).
 */
function persistFills(
  fills: ReadonlyArray<TradingFill>,
): Effect.Effect<void, TradingReconciliationError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    if (fills.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    for (const f of fills) {
      yield* sql`
        INSERT INTO trading_fills (
          fill_id, mission_id, execution_id, cloid, order_id, market, side,
          filled_size, avg_fill_price, fee_usd, fee_token, closed_pnl,
          traded_at, observed_at
        ) VALUES (
          ${f.fillId}, ${f.missionId}, ${f.executionId ?? null}, ${f.cloid ?? null},
          ${f.orderId}, ${f.market}, ${f.side}, ${f.filledSize}, ${f.avgFillPrice},
          ${f.feeUsd}, ${f.feeToken}, ${f.closedPnl}, ${f.tradedAt}, ${f.observedAt}
        )
        ON CONFLICT(fill_id) DO UPDATE SET
          closed_pnl = ${f.closedPnl}, fee_usd = ${f.feeUsd}, observed_at = ${f.observedAt}
      `;
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingReconciliationError({
          reason: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/**
 * Replace the mission's open orders with the canonical set. Open orders are
 * transient, so each reconcile deletes the mission's rows and re-inserts the
 * canonical snapshot — local rows never survive a canonical read that omits
 * them.
 */
function persistOpenOrders(
  openOrders: ReadonlyArray<TradingOpenOrderRecord>,
  input: ReconcileInput,
): Effect.Effect<void, TradingReconciliationError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM trading_orders WHERE mission_id = ${input.missionId}
    `;
    for (const o of openOrders) {
      yield* sql`
        INSERT INTO trading_orders (
          mission_id, cloid, order_id, market, side, limit_price,
          remaining_size, reduce_only, observed_at
        ) VALUES (
          ${o.missionId}, ${o.cloid}, ${o.orderId}, ${o.market}, ${o.side},
          ${o.limitPrice}, ${o.remainingSize}, ${o.reduceOnly ? 1 : 0}, ${o.observedAt}
        )
        ON CONFLICT(mission_id, cloid) DO UPDATE SET
          order_id = ${o.orderId}, limit_price = ${o.limitPrice},
          remaining_size = ${o.remainingSize}, reduce_only = ${o.reduceOnly ? 1 : 0},
          observed_at = ${o.observedAt}
      `;
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingReconciliationError({
          reason: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/**
 * How long a record may sit mid-submission before canonical silence settles it.
 *
 * Long enough that a slow round-trip is never mistaken for a lost one — the
 * whole submit sequence is a handful of exchange calls — and short enough that
 * the next entry attempt, minutes later, is not still blocked by it.
 */
const ABANDONED_EXECUTION_AFTER_MS = 60_000;

/**
 * Settle execution records the exchange has no memory of.
 *
 * A record is written at `reserved` before signing and moved to `submitted`
 * before the POST, so a failure anywhere in between — a signer error, a dropped
 * connection, a server restart — leaves it non-terminal forever. Preview item 16
 * refuses every new entry while one exists, so one failed submit quietly ends
 * the mission's ability to trade: hours later it is still answering
 * `no_conflicting_execution_pending` to a request that conflicts with nothing.
 *
 * Silence alone is not proof. An order can be a second old and simply not
 * visible yet, and settling that one would let a duplicate go out on the next
 * request. Proof is silence that has lasted: no resting order under the cloid,
 * no fill ever recorded under the cloid, and a full minute since the record last
 * moved. Then the submission never reached the book, and `failed` is what
 * happened.
 */
function settleAbandonedExecutions(
  input: ReconcileInput,
  canonicalOrders: ReadonlyArray<AgentOpenOrder>,
  observedAt: number,
): Effect.Effect<void, TradingReconciliationError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stale = yield* sql<{ readonly execution_id: string; readonly cloid: string }>`
      SELECT execution_id, cloid
      FROM trading_execution_records
      WHERE mission_id = ${input.missionId}
        AND status IN ('previewed', 'reserved', 'signed', 'submitted')
        AND updated_at <= ${observedAt - ABANDONED_EXECUTION_AFTER_MS}
    `;
    if (stale.length === 0) return;

    const resting = new Set(
      canonicalOrders.flatMap((order) => (order.cloid === undefined ? [] : [order.cloid])),
    );

    for (const record of stale) {
      if (resting.has(record.cloid)) continue;
      // `persistFills` ran already this pass, so the table is current.
      const filled = yield* sql<{ readonly fill_id: string }>`
        SELECT fill_id FROM trading_fills
        WHERE mission_id = ${input.missionId} AND cloid = ${record.cloid}
        LIMIT 1
      `;
      if (filled.length > 0) continue;

      yield* sql`
        UPDATE trading_execution_records
        SET status = 'failed', updated_at = ${observedAt}
        WHERE execution_id = ${record.execution_id}
      `;
      yield* Effect.logWarning("trading reconcile settled an abandoned execution record", {
        missionId: input.missionId,
        executionId: record.execution_id,
        cloid: record.cloid,
      });
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingReconciliationError({
          reason: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/**
 * Settle acknowledged records the exchange has since resolved.
 *
 * `accepted` means the exchange took the order and it rests on the book. That
 * is a live state, not a terminal one, and nothing about it settles itself: the
 * submit response is the last word the submit path ever hears. So a resting
 * order that later fills, or that the user cancels, leaves its record parked at
 * `accepted` — holding a risk reservation the loss budget keeps counting on top
 * of the position that reservation was for.
 *
 * Canonical state answers it, and live state is the strongest truth there is:
 *
 *   - still resting on the book → leave it, whatever fills exist. A partial
 *     fill is not the end of an order: settling on the first fill would take
 *     the record terminal and release its risk reservation while the remainder
 *     is still working, leaving live size with nothing reserved behind it;
 *   - gone from the book, with a fill under the record's cloid → `filled`;
 *   - gone, no fill, and the record has not moved for a full minute →
 *     `cancelled`. The order left the book without filling. Which agent removed
 *     it — the user, the exchange, an expiry — is not knowable from here and
 *     does not change the answer;
 *   - gone, no fill, and recent → leave it for the next pass.
 *
 * The grace window is the same one the abandoned settler uses, and for the same
 * reason: an order can be a second old and simply not visible yet.
 */
function settleAcceptedExecutions(
  input: ReconcileInput,
  canonicalOrders: ReadonlyArray<AgentOpenOrder>,
  observedAt: number,
): Effect.Effect<void, TradingReconciliationError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accepted = yield* sql<{
      readonly execution_id: string;
      readonly cloid: string;
      readonly updated_at: number;
    }>`
      SELECT execution_id, cloid, updated_at
      FROM trading_execution_records
      WHERE mission_id = ${input.missionId} AND status = 'accepted'
    `;
    if (accepted.length === 0) return;

    const resting = new Set(
      canonicalOrders.flatMap((order) => (order.cloid === undefined ? [] : [order.cloid])),
    );

    for (const record of accepted) {
      // Live beats everything: a resting order is not done, however much of it
      // has filled so far.
      if (resting.has(record.cloid)) continue;

      // `persistFills` ran already this pass, so the table is current.
      const filled = yield* sql<{ readonly fill_id: string }>`
        SELECT fill_id FROM trading_fills
        WHERE mission_id = ${input.missionId} AND cloid = ${record.cloid}
        LIMIT 1
      `;
      if (filled.length === 0 && record.updated_at > observedAt - ABANDONED_EXECUTION_AFTER_MS) {
        continue;
      }
      const settled = filled.length > 0 ? "filled" : "cancelled";

      yield* sql`
        UPDATE trading_execution_records
        SET status = ${settled}, updated_at = ${observedAt}
        WHERE execution_id = ${record.execution_id}
      `;
      yield* Effect.logInfo("trading reconcile settled an accepted execution record", {
        missionId: input.missionId,
        executionId: record.execution_id,
        cloid: record.cloid,
        status: settled,
      });
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingReconciliationError({
          reason: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

// ---------------------------------------------------------------------------
// §18.2 · External actions: what the exchange did that T3 did not ask for
// ---------------------------------------------------------------------------

/** How an observed position change is attributed when T3 did not cause it. */
export type ExternalChangeKind =
  | "external_close"
  | "external_reduce"
  | "external_increase"
  | "external_transfer";

/** One classified change, ready to be written to the inbox. */
export interface ExternalChange {
  readonly kind: ExternalChangeKind;
  readonly summary: string;
}

/**
 * Name a position change by what it did to the exposure.
 *
 * A reversal counts as an increase: crossing through flat opens new exposure in
 * the other direction, which is the thing that needs a stop and a decision, not
 * a reduction of anything.
 */
export function classifyPositionChange(before: number, after: number): ExternalChangeKind | null {
  if (before === after) return null;
  if (after === 0) return "external_close";
  if (before === 0) return "external_increase";
  if (Math.sign(before) !== Math.sign(after)) return "external_increase";
  return Math.abs(after) < Math.abs(before) ? "external_reduce" : "external_increase";
}

/**
 * How far the account value may move on a flat mission before it is a transfer.
 *
 * Fees and funding move it by cents; a deposit or a withdrawal moves it by
 * dollars. A dollar is the line, and it is only ever consulted while the
 * mission is flat both before and after — with a position open the account
 * value tracks unrealised PnL continuously and a diff means nothing.
 */
const TRANSFER_TOLERANCE_USD = 1;

export const makeHyperliquidReconciler = Effect.gen(function* () {
  const inbox = yield* TradingEventInbox;

  /** The position size and observation time the previous pass left behind. */
  const readPreviousPosition = (input: ReconcileInput) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly size: number; readonly observed_at: number }>`
        SELECT size, observed_at FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
      `;
      return rows[0] ?? null;
    }).pipe(Effect.orElseSucceed(() => null));

  const readPreviousAccountValue = (missionId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly account_value: number }>`
        SELECT account_value FROM trading_account_observations WHERE mission_id = ${missionId}
      `;
      return rows[0]?.account_value ?? null;
    }).pipe(Effect.orElseSucceed(() => null));

  const persistAccountValue = (missionId: string, accountValue: number, observedAt: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_account_observations (mission_id, account_value, observed_at)
        VALUES (${missionId}, ${accountValue}, ${observedAt})
        ON CONFLICT(mission_id) DO UPDATE SET
          account_value = ${accountValue}, observed_at = ${observedAt}
      `;
    }).pipe(Effect.ignore);

  /**
   * Whether a fill T3 placed explains a change since `since`.
   *
   * Every order T3 signs carries a deterministic cloid; an order placed in the
   * Hyperliquid UI carries none. So the cloid is the attribution — a fill with
   * one is T3's own work (including a protective stop firing), a fill without
   * one came from somewhere else.
   */
  const hasAttributedFill = (missionId: string, since: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly fill_id: string }>`
        SELECT fill_id FROM trading_fills
        WHERE mission_id = ${missionId} AND cloid IS NOT NULL AND traded_at >= ${since}
        LIMIT 1
      `;
      return rows.length > 0;
    }).pipe(Effect.orElseSucceed(() => true));

  /**
   * Classify what happened between two reconciles that T3 did not do, and write
   * it where the harness will read it.
   *
   * Closing a position in the exchange UI used to produce nothing at all: the
   * snapshot was blanked, the mission was walked back to `waiting`, and the
   * harness went on managing a position that no longer existed until something
   * else happened to wake it. The event is the fix; the wake is the caller's.
   */
  const recordExternalChanges = (
    input: ReconcileInput,
    previous: { readonly size: number; readonly observed_at: number } | null,
    accountValue: number,
    previousAccountValue: number | null,
    newSize: number,
    observedAt: number,
  ): Effect.Effect<ReadonlyArray<ExternalChange>, never, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const changes: Array<ExternalChange> = [];

      // The position diff needs a previous snapshot to measure against; the
      // first pass for a mission has none and reports nothing.
      const kind = previous === null ? null : classifyPositionChange(previous.size, newSize);
      if (
        previous !== null &&
        kind !== null &&
        !(yield* hasAttributedFill(input.missionId, previous.observed_at))
      ) {
        changes.push({
          kind,
          summary:
            `${kind}: the ${input.market} position moved from ${previous.size} to ${newSize} ` +
            `with no order of this mission's behind it — someone acted on the exchange directly`,
        });
      }

      // A flat mission never writes a position row, so the transfer check hangs
      // off the account observation alone.
      if (
        previousAccountValue !== null &&
        (previous === null || previous.size === 0) &&
        newSize === 0 &&
        Math.abs(accountValue - previousAccountValue) > TRANSFER_TOLERANCE_USD
      ) {
        changes.push({
          kind: "external_transfer",
          summary:
            `external_transfer: account value moved from ${previousAccountValue} to ` +
            `${accountValue} with no position open. Your mandate is unchanged; what you can ` +
            `afford is not`,
        });
      }

      for (const change of changes) {
        yield* inbox
          .persist({
            missionId: input.missionId,
            category: "exchange",
            deduplicationKey: `${change.kind}:${observedAt}`,
            payload: { kind: change.kind, beforeSize: previous?.size ?? 0, afterSize: newSize },
            occurredAt: observedAt,
            summary: change.summary,
          })
          .pipe(Effect.ignore);
        yield* Effect.logWarning("trading observed an external exchange action", {
          missionId: input.missionId,
          kind: change.kind,
          summary: change.summary,
        });
      }

      return changes;
    });

  const reconcile = (
    input: ReconcileInput,
    trigger: ReconciliationTrigger,
  ): Effect.Effect<
    ReconciledState,
    TradingReconciliationError,
    SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
  > =>
    Effect.gen(function* () {
      const observedAt = yield* now();
      // What the previous pass left behind, read before anything overwrites it —
      // the only baseline an external change can be measured against.
      const previousPosition = yield* readPreviousPosition(input);
      const previousAccountValue = yield* readPreviousAccountValue(input.missionId);

      // Read all canonical state in parallel, then persist. Local state never
      // outranks Hyperliquid — the canonical reads are the source of truth.
      const [account, canonicalOrders, fills] = yield* Effect.all(
        [
          readCanonicalAccount(input, observedAt),
          readCanonicalOpenOrders(input),
          readCanonicalFills(input, observedAt),
        ],
        { concurrency: "unbounded" },
      );
      const rawPosition = account.position;

      // §17.2 steps 7–8: the protected size is CONFIRMED from canonical state —
      // resting reduce-only triggers on the losing side of the position — not
      // inferred from what T3 believes it placed. A grouped response, a local
      // record, and an untriggered child all read as protection if you ask the
      // wrong source; only this read counts.
      const position =
        rawPosition === null
          ? null
          : ({
              ...rawPosition,
              protectedSize: confirmedProtectedSize({
                market: input.market,
                positionSize: rawPosition.size,
                referencePrice: rawPosition.markPx ?? rawPosition.entryPrice ?? 0,
                openOrders: canonicalOrders,
              }),
            } satisfies TradingPositionSnapshot);

      const openOrders = toOpenOrderRecords(canonicalOrders, input, observedAt);

      yield* persistPosition(position, input);
      // Fills append idempotently; open orders are replaced with the canonical
      // set. Local state never outranks Hyperliquid — both reach the 037 tables
      // here so the projection and loss-budget accounting read reconciled truth.
      yield* persistFills(fills);
      yield* persistOpenOrders(openOrders, input);
      // Before the release below, so a record settled here has its reservation
      // released in the same pass.
      yield* settleAbandonedExecutions(input, canonicalOrders, observedAt);
      yield* settleAcceptedExecutions(input, canonicalOrders, observedAt);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE trading_risk_reservations
        SET status = 'released', released_at = ${observedAt}
        WHERE mission_id = ${input.missionId}
          AND status = 'reserved'
          AND execution_id IN (
            SELECT execution_id FROM trading_execution_records
            WHERE status IN ('filled', 'rejected', 'cancelled', 'failed')
          )
      `.pipe(
        Effect.mapError(
          (cause) =>
            new TradingReconciliationError({
              reason: "persist_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

      // After the fills are persisted, so attribution reads the current table.
      const externalChanges = yield* recordExternalChanges(
        input,
        previousPosition,
        account.accountValue,
        previousAccountValue,
        position?.size ?? 0,
        observedAt,
      );
      yield* persistAccountValue(input.missionId, account.accountValue, observedAt);

      yield* Effect.logInfo("trading reconciled", { missionId: input.missionId, trigger });
      return {
        position,
        openOrders,
        canonicalOrders,
        fills,
        observedAt,
        externalChanges,
      } as ReconciledState;
    });

  return HyperliquidReconciler.of({ reconcile });
});

export const HyperliquidReconcilerLive = Layer.effect(
  HyperliquidReconciler,
  makeHyperliquidReconciler,
);
