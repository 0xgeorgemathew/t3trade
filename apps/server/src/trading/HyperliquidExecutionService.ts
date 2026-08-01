/**
 * HyperliquidExecutionService — the submit sequence (§17.2 steps 1–5).
 *
 * This is the only code path that spends testnet capital. It runs the exact
 * order of operations:
 *
 *   1. resolve the interim signer (fail-closed if not armed)
 *   2. resolve market metadata (asset index) + fresh BBO
 *   3. run the §16.3 preview checklist
 *   4. map the order (IOC/GTC) with slippage + precision
 *   5. persist the execution record + risk reservation (before signing)
 *   6. sign in the serialized nonce lane
 *   7. POST /exchange
 *   8. inspect EVERY per-order status
 *   9. update the execution record with the result
 *
 * Retries reuse the same cloid + idempotency key (persisted before signing),
 * so the exchange deduplicates on cloid and the local write deduplicates on
 * idempotency key.
 *
 * @module HyperliquidExecutionService
 */
import { Context, Effect, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  buildCancelByCloidAction,
  buildOrderAction,
  mapOrder,
  HyperliquidOrderMapperError,
} from "@t3tools/hyperliquid/OrderMapper";
import { HyperliquidExchangeClient, type SignedAction } from "@t3tools/hyperliquid/ExchangeClient";
import { HyperliquidNonceCoordinator } from "@t3tools/hyperliquid/NonceCoordinator";
import { signL1ActionForWire } from "@t3tools/hyperliquid/Signing";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type {
  TradingExecutionRecord,
  TradingOrderIntent,
  TradingOrderResult,
  TradingRiskReservation,
} from "@t3tools/trading-contracts/execution";

import { InterimSignerConfig, InterimSignerError } from "./InterimSignerConfig.ts";
import { TradingPreviewService, type PreviewContext } from "./TradingPreviewService.ts";

/** The execution service failed at a named stage. */
export class TradingExecutionError extends Schema.TaggedErrorClass<TradingExecutionError>()(
  "TradingExecutionError",
  {
    stage: Schema.Literals([
      "signer_not_configured",
      "market_unresolved",
      "preview_rejected",
      "order_mapping_failed",
      "persist_failed",
      "sign_failed",
      "submit_failed",
      "inspect_failed",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingExecutionError(${this.stage})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** Inputs to a single execution attempt. */
export interface ExecutionInput {
  readonly intent: TradingOrderIntent;
  readonly previewContext: PreviewContext;
  /** Allowed slippage in bps for marketable IOC pricing (§15.4). */
  readonly allowedSlippageBps: number;
  /**
   * The master-wallet address (§10.6 identity) for canonical reads. The
   * execution service records the signer address on the order; this is the
   * account/position identity a later reconcile (e.g. reduce-only close) uses.
   */
  readonly masterAddress: string;
}

/**
 * The execution service. `submitOrder` runs the full §17.2 submit sequence.
 */
export class HyperliquidExecutionService extends Context.Service<
  HyperliquidExecutionService,
  {
    readonly submitOrder: (
      input: ExecutionInput,
    ) => Effect.Effect<TradingExecutionRecord, TradingExecutionError, SqlClient.SqlClient>;
    /**
     * Cancel a resting order by its client order id (§16.4 exhaustion cancel).
     * Signs and submits a cancel-by-cloid through the nonce lane. Returns void;
     * the caller reconciles to confirm the cancel landed.
     */
    readonly submitCancel: (input: {
      readonly market: string;
      readonly cloid: string;
    }) => Effect.Effect<void, TradingExecutionError>;
  }
>()("t3/trading/HyperliquidExecutionService") {}

// JSON columns go through the contract schema, not raw JSON.stringify, so a
// malformed row fails loudly instead of flowing into the domain as `any`.
const OrderResultsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      cloid: Schema.String,
      status: Schema.Literals(["ok", "err", "queued", "triggered"]),
      orderId: Schema.optional(Schema.Number),
      reason: Schema.optional(Schema.String),
    }),
  ),
);
const encodeOrderResultsJson = Schema.encodeUnknownSync(OrderResultsJson);

const now = (): Effect.Effect<number> => Clock.currentTimeMillis;

/** Persist the execution record BEFORE signing (§17.2 step 2). */
function persistExecutionRecord(
  record: TradingExecutionRecord,
): Effect.Effect<void, TradingExecutionError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, strategy_version, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at,
        stop_price, planned_loss_at_stop_usd
      ) VALUES (
        ${record.executionId}, ${record.missionId}, ${record.strategyVersion},
        ${record.executionSequence}, ${record.actionType}, ${record.cloid},
        ${record.idempotencyKey}, ${record.market}, ${record.side}, ${record.size},
        ${record.limitPrice}, ${record.timeInForce}, ${record.reduceOnly ? 1 : 0},
        ${record.signerAddress}, ${record.status}, ${encodeOrderResultsJson(record.orderResults)},
        ${record.createdAt}, ${record.updatedAt},
        ${record.stopPrice ?? null}, ${record.plannedLossAtStopUsd ?? null}
      )
      ON CONFLICT(idempotency_key) DO UPDATE SET updated_at = ${record.updatedAt}
    `;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingExecutionError({
          stage: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/** Persist a risk reservation alongside the execution record. */
function persistReservation(
  reservation: TradingRiskReservation,
): Effect.Effect<void, TradingExecutionError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_risk_reservations (
        reservation_id, mission_id, execution_id, cloid, action_type,
        reserved_risk_usd, status, reserved_at
      ) VALUES (
        ${reservation.reservationId}, ${reservation.missionId}, ${reservation.executionId},
        ${reservation.cloid}, ${reservation.actionType}, ${reservation.reservedRiskUsd},
        ${reservation.status}, ${reservation.reservedAt}
      )
      ON CONFLICT(execution_id) DO NOTHING
    `;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingExecutionError({
          stage: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

function releaseReservation(
  executionId: string,
  releasedAt: number,
): Effect.Effect<void, TradingExecutionError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE trading_risk_reservations
      SET status = 'released', released_at = ${releasedAt}
      WHERE execution_id = ${executionId} AND status = 'reserved'
    `;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingExecutionError({
          stage: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/** Update the execution record's status + per-order results after submission. */
function updateExecutionRecord(
  executionId: string,
  status: TradingExecutionRecord["status"],
  orderResults: ReadonlyArray<TradingOrderResult>,
  updatedAt: number,
): Effect.Effect<void, TradingExecutionError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE trading_execution_records
      SET status = ${status}, order_results_json = ${encodeOrderResultsJson(orderResults)},
          updated_at = ${updatedAt}
      WHERE execution_id = ${executionId}
    `;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TradingExecutionError({
          stage: "persist_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
}

/**
 * Inspect EVERY per-order status in the exchange response (§17.2 step 4).
 * The exchange returns one status per order in a batch; T3 records each
 * rather than assuming batch atomicity.
 */
function inspectOrderStatuses(
  statuses: ReadonlyArray<unknown> | undefined,
  intent: TradingOrderIntent,
): Effect.Effect<ReadonlyArray<TradingOrderResult>, TradingExecutionError> {
  return Effect.gen(function* () {
    const rows = statuses ?? [];
    const results: TradingOrderResult[] = [];
    for (const row of rows) {
      if (typeof row === "string") {
        const status: TradingOrderResult["status"] =
          row === "ok" ? "ok" : row === "triggered" ? "triggered" : "err";
        results.push({ cloid: "", status, reason: status === "err" ? row : undefined });
      } else if (typeof row === "object" && row !== null) {
        const r = row as { rsp?: string; cloid?: string; oid?: number };
        const status: TradingOrderResult["status"] =
          r.rsp === "ok"
            ? "ok"
            : r.rsp === "queued"
              ? "queued"
              : r.rsp === "triggered"
                ? "triggered"
                : "err";
        results.push({
          cloid: r.cloid ?? "",
          status,
          orderId: r.oid,
          reason: status === "err" ? r.rsp : undefined,
        });
      }
    }
    if (results.length === 0) {
      return yield* new TradingExecutionError({
        stage: "inspect_failed",
        detail: `exchange response for ${intent.actionType} carried no per-order statuses`,
      });
    }
    return results;
  });
}

export const makeHyperliquidExecutionService = Effect.gen(function* () {
  const signerConfig = yield* InterimSignerConfig;
  const gateway = yield* HyperliquidGateway;
  const preview = yield* TradingPreviewService;
  const nonceCoord = yield* HyperliquidNonceCoordinator;
  const exchange = yield* HyperliquidExchangeClient;
  const crypto = yield* Crypto.Crypto;

  const submitOrder = (
    input: ExecutionInput,
  ): Effect.Effect<TradingExecutionRecord, TradingExecutionError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const { intent, previewContext, allowedSlippageBps } = input;
      const nowMs = yield* now();

      // --- 1. resolve the signer (fail-closed) -------------------------------
      const signerOpt = yield* signerConfig.resolve.pipe(
        Effect.mapError(
          (e: InterimSignerError) =>
            new TradingExecutionError({ stage: "signer_not_configured", detail: e.reason }),
        ),
      );
      if (signerOpt._tag === "None") {
        return yield* new TradingExecutionError({ stage: "signer_not_configured" });
      }
      const signer = signerOpt.value;

      // --- 2. resolve market metadata (asset index) + fresh BBO --------------
      const market = yield* gateway
        .resolveMarket(intent.market)
        .pipe(Effect.mapError(() => new TradingExecutionError({ stage: "market_unresolved" })));
      const orderBook = yield* gateway
        .getOrderBook(intent.market)
        .pipe(Effect.mapError(() => new TradingExecutionError({ stage: "market_unresolved" })));

      // --- 3. preview (§16.3 checklist) --------------------------------------
      const previewResult = yield* preview
        .preview(intent, {
          ...previewContext,
          bbo: orderBook.bestBidOffer,
          nowMs,
        })
        .pipe(
          Effect.mapError(
            (rejection) =>
              new TradingExecutionError({
                stage: "preview_rejected",
                detail: `${rejection.item}: ${rejection.detail}`,
              }),
          ),
        );

      // --- 4. map the order (IOC/GTC, slippage, precision) -------------------
      const wireOrder = yield* mapOrder({
        intent,
        bbo: orderBook.bestBidOffer,
        szDecimals: market.szDecimals,
        allowedSlippageBps,
        nowMs,
      }).pipe(
        Effect.mapError(
          (e: HyperliquidOrderMapperError) =>
            new TradingExecutionError({
              stage: "order_mapping_failed",
              detail: `${e.reason}${e.detail ? `: ${e.detail}` : ""}`,
            }),
        ),
      );

      // --- 5. persist the execution record + reservation (before signing) ----
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () => new TradingExecutionError({ stage: "persist_failed", detail: "uuid" }),
        ),
      );
      const newExecutionId = `exec_${uuid}`;
      const idempotencyKey = `idem_${intent.missionId}_${intent.executionSequence}_${intent.actionType}`;
      const record: TradingExecutionRecord = {
        executionId: newExecutionId,
        missionId: intent.missionId,
        strategyVersion: intent.strategyVersion,
        executionSequence: intent.executionSequence,
        actionType: intent.actionType,
        cloid: wireOrder.cloid,
        idempotencyKey,
        market: intent.market,
        side: intent.side,
        size: intent.size,
        limitPrice: Number.parseFloat(wireOrder.limitPrice),
        timeInForce: wireOrder.timeInForce,
        reduceOnly: wireOrder.reduceOnly,
        signerAddress: signer.address as `0x${string}`,
        status: "reserved",
        orderResults: [],
        createdAt: nowMs,
        updatedAt: nowMs,
        stopPrice: intent.stop.stopPrice,
        plannedLossAtStopUsd: intent.stop.plannedLossAtStopUsd,
      };
      yield* persistExecutionRecord(record);

      const sql = yield* SqlClient.SqlClient;
      const persistedRows = yield* sql<{
        readonly execution_id: string;
        readonly status: TradingExecutionRecord["status"];
        readonly order_results_json: string;
        readonly updated_at: number;
      }>`
        SELECT execution_id, status, order_results_json, updated_at
        FROM trading_execution_records
        WHERE idempotency_key = ${idempotencyKey}
      `.pipe(
        Effect.mapError(
          (cause) =>
            new TradingExecutionError({
              stage: "persist_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const persisted = persistedRows[0];
      if (persisted === undefined) {
        return yield* new TradingExecutionError({
          stage: "persist_failed",
          detail: "execution record was not readable after insert",
        });
      }
      const persistedExecutionId = persisted.execution_id;
      const persistedOrderResults = yield* Schema.decodeUnknownEffect(OrderResultsJson)(
        persisted.order_results_json,
      ).pipe(Effect.orDie);
      const persistedRecord = {
        ...record,
        executionId: persistedExecutionId,
        status: persisted.status,
        orderResults: persistedOrderResults,
        updatedAt: persisted.updated_at,
      } satisfies TradingExecutionRecord;
      if (["filled", "rejected", "cancelled", "failed"].includes(persisted.status)) {
        return persistedRecord;
      }

      const reservation: TradingRiskReservation = {
        reservationId: `res_${idempotencyKey}`,
        missionId: intent.missionId,
        executionId: persistedExecutionId,
        cloid: wireOrder.cloid,
        actionType: intent.actionType,
        reservedRiskUsd: previewResult.reservedRiskUsd,
        status: "reserved",
        reservedAt: nowMs,
      };
      yield* persistReservation(reservation);

      // --- 6 + 7. sign in the nonce lane, then POST /exchange ----------------
      const action = buildOrderAction(wireOrder, market.assetIndex);
      const signed = yield* nonceCoord
        .runWithNonce((nonce) =>
          Effect.gen(function* () {
            const signature = signL1ActionForWire({
              action,
              nonce,
              privateKey: signer.privateKeyBytes,
              isTestnet: true,
            });
            return { action, nonce, signature } satisfies SignedAction;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingExecutionError({
                stage: "sign_failed",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        );

      // Mark the record as submitted.
      yield* updateExecutionRecord(persistedExecutionId, "submitted", [], yield* now());

      const response = yield* exchange.submit(signed).pipe(
        Effect.mapError(
          (cause) =>
            new TradingExecutionError({
              stage: "submit_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

      // --- 8. inspect EVERY per-order status ---------------------------------
      const responseView = response.response as {
        type: string;
        statuses?: ReadonlyArray<unknown>;
      };
      const orderResults = yield* inspectOrderStatuses(responseView.statuses, intent);

      // --- 9. update the execution record with the result --------------------
      const accepted = orderResults.some((r) => r.status === "ok" || r.status === "triggered");
      const finalStatus: TradingExecutionRecord["status"] = accepted ? "accepted" : "rejected";
      const updatedAt = yield* now();
      yield* updateExecutionRecord(persistedExecutionId, finalStatus, orderResults, updatedAt);
      if (finalStatus === "rejected") {
        yield* releaseReservation(persistedExecutionId, updatedAt);
      }

      return { ...persistedRecord, status: finalStatus, orderResults, updatedAt };
    });

  // §16.4 exhaustion cancel: sign and submit a cancel-by-cloid for one resting
  // order. Reuses the same signer + nonce lane as submitOrder so cancels
  // serialize with orders and never race a nonce. The caller (guard) reconciles
  // after to confirm the cancel landed.
  const submitCancel: HyperliquidExecutionService["Service"]["submitCancel"] = (input) =>
    Effect.gen(function* () {
      const signerOpt = yield* signerConfig.resolve.pipe(
        Effect.mapError(
          (e: InterimSignerError) =>
            new TradingExecutionError({ stage: "signer_not_configured", detail: e.reason }),
        ),
      );
      if (signerOpt._tag === "None") {
        return yield* new TradingExecutionError({ stage: "signer_not_configured" });
      }
      const signer = signerOpt.value;
      // Resolve the asset index from live metadata, mirroring the order path —
      // a cancel leg is keyed by the numeric asset index, not the coin symbol.
      const market = yield* gateway
        .resolveMarket(input.market)
        .pipe(Effect.mapError(() => new TradingExecutionError({ stage: "market_unresolved" })));
      const action = buildCancelByCloidAction(market.assetIndex, input.cloid);
      const signed = yield* nonceCoord
        .runWithNonce((nonce) =>
          Effect.gen(function* () {
            const signature = signL1ActionForWire({
              action,
              nonce,
              privateKey: signer.privateKeyBytes,
              isTestnet: true,
            });
            return { action, nonce, signature } satisfies SignedAction;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingExecutionError({
                stage: "sign_failed",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        );
      yield* exchange.submit(signed).pipe(
        Effect.mapError(
          (cause) =>
            new TradingExecutionError({
              stage: "submit_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
    });

  return HyperliquidExecutionService.of({ submitOrder, submitCancel });
});

export const HyperliquidExecutionServiceLive = Layer.effect(
  HyperliquidExecutionService,
  makeHyperliquidExecutionService,
);
