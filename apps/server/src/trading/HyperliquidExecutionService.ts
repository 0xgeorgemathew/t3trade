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
  buildOrderAction,
  mapOrder,
  HyperliquidOrderMapperError,
} from "@t3tools/hyperliquid/OrderMapper";
import { HyperliquidExchangeClient, type SignedAction } from "@t3tools/hyperliquid/ExchangeClient";
import { HyperliquidNonceCoordinator } from "@t3tools/hyperliquid/NonceCoordinator";
import { signAndPackL1Action } from "@t3tools/hyperliquid/Signing";
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
        reduce_only, signer_address, status, order_results_json, created_at, updated_at
      ) VALUES (
        ${record.executionId}, ${record.missionId}, ${record.strategyVersion},
        ${record.executionSequence}, ${record.actionType}, ${record.cloid},
        ${record.idempotencyKey}, ${record.market}, ${record.side}, ${record.size},
        ${record.limitPrice}, ${record.timeInForce}, ${record.reduceOnly ? 1 : 0},
        ${record.signerAddress}, ${record.status}, ${encodeOrderResultsJson(record.orderResults)},
        ${record.createdAt}, ${record.updatedAt}
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
      const executionId = `exec_${uuid}`;
      const idempotencyKey = `idem_${intent.missionId}_${intent.executionSequence}_${intent.actionType}`;
      const record: TradingExecutionRecord = {
        executionId,
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
      };
      yield* persistExecutionRecord(record);

      const reservationUuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () => new TradingExecutionError({ stage: "persist_failed", detail: "uuid" }),
        ),
      );
      const reservation: TradingRiskReservation = {
        reservationId: `res_${reservationUuid}`,
        missionId: intent.missionId,
        executionId,
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
            const signature = signAndPackL1Action({
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
      yield* updateExecutionRecord(executionId, "submitted", [], yield* now());

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
      const orderResults = yield* inspectOrderStatuses(response.response.statuses, intent);

      // --- 9. update the execution record with the result --------------------
      const accepted = orderResults.some((r) => r.status === "ok" || r.status === "triggered");
      const finalStatus: TradingExecutionRecord["status"] = accepted ? "accepted" : "rejected";
      const updatedAt = yield* now();
      yield* updateExecutionRecord(executionId, finalStatus, orderResults, updatedAt);

      return { ...record, status: finalStatus, orderResults, updatedAt };
    });

  return HyperliquidExecutionService.of({ submitOrder });
});

export const HyperliquidExecutionServiceLive = Layer.effect(
  HyperliquidExecutionService,
  makeHyperliquidExecutionService,
);
