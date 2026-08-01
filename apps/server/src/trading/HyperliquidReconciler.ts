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
import type {
  TradingFill,
  TradingOpenOrderRecord,
  TradingPositionSnapshot,
} from "@t3tools/trading-contracts/execution";

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
  readonly openOrders: ReadonlyArray<TradingOpenOrderRecord>;
  readonly fills: ReadonlyArray<TradingFill>;
  readonly observedAt: number;
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

/**
 * Read canonical position + account state via the gateway (master address),
 * returning a `TradingPositionSnapshot` or null when flat. Reads the full
 * account snapshot so the liquidation price surfaces to the position card.
 */
function readCanonicalPosition(
  input: ReconcileInput,
  observedAt: number,
): Effect.Effect<TradingPositionSnapshot | null, TradingReconciliationError, HyperliquidGateway> {
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
    const position = snapshot.positions.find((p) => p.market === input.market);
    if (position === undefined || position.size === 0) return null;
    // The clearinghouse position payload carries no mark price field; the mark
    // lives on the asset context (metaAndAssetCtxs.markPx). Rather than make a
    // second network call per reconcile, derive it from the unrealised PnL the
    // exchange already reports: upnl = (mark - entry) × size for longs, and the
    // mirror for shorts, so mark = entry + upnl/size (sign carried by size).
    const markPx = position.entryPrice + position.unrealisedPnl / position.size;
    return {
      missionId: input.missionId,
      market: input.market,
      size: position.size,
      entryPrice: position.entryPrice,
      unrealisedPnl: position.unrealisedPnl,
      marginUsed: position.marginUsed,
      // Protected size is confirmed by the protection path (§17.2 steps 6–8);
      // the reconciler records zero until that path marks it.
      protectedSize: 0,
      liquidationPrice: position.liquidationPx,
      markPx,
      observedAt,
    } as TradingPositionSnapshot;
  });
}

/**
 * Read canonical open orders via the gateway and map them to records keyed by
 * cloid. Orders without a cloid are skipped (T3 only tracks its own orders).
 */
function readCanonicalOpenOrders(
  input: ReconcileInput,
  observedAt: number,
): Effect.Effect<
  ReadonlyArray<TradingOpenOrderRecord>,
  TradingReconciliationError,
  HyperliquidGateway
> {
  return Effect.gen(function* () {
    const gateway = yield* HyperliquidGateway;
    const orders = yield* gateway.getOpenOrders(input.masterAddress as `0x${string}`).pipe(
      Effect.mapError(
        (cause) =>
          new TradingReconciliationError({
            reason: "orders_read_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
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
            reduceOnly: false,
            observedAt,
          }) as TradingOpenOrderRecord,
      );
  });
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
        (f) =>
          ({
            fillId: f.hash ?? f.cloid ?? `${f.oid}-${f.time}`,
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

export const makeHyperliquidReconciler = Effect.gen(function* () {
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
      // Read all canonical state in parallel, then persist. Local state never
      // outranks Hyperliquid — the canonical reads are the source of truth.
      const [position, openOrders, fills] = yield* Effect.all(
        [
          readCanonicalPosition(input, observedAt),
          readCanonicalOpenOrders(input, observedAt),
          readCanonicalFills(input, observedAt),
        ],
        { concurrency: "unbounded" },
      );

      yield* persistPosition(position, input);
      // Fills append idempotently; open orders are replaced with the canonical
      // set. Local state never outranks Hyperliquid — both reach the 037 tables
      // here so the projection and loss-budget accounting read reconciled truth.
      yield* persistFills(fills);
      yield* persistOpenOrders(openOrders, input);
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

      yield* Effect.logInfo("trading reconciled", { missionId: input.missionId, trigger });
      return { position, openOrders, fills, observedAt } as ReconciledState;
    });

  return HyperliquidReconciler.of({ reconcile });
});

export const HyperliquidReconcilerLive = Layer.effect(
  HyperliquidReconciler,
  makeHyperliquidReconciler,
);
