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
 * Retries reuse the same cloid + idempotency key (persisted before signing).
 * Idempotency is entirely local: the record is read back by idempotency key and
 * the retry is refused the moment that record shows the action already reached
 * the exchange. The exchange itself does NOT deduplicate — cloid uniqueness is
 * enforced only among *resting* orders, and a marketable IOC never rests, so a
 * resubmitted IOC opens a second order and fills again (verified live in
 * `packages/hyperliquid/src/executionLive.test.ts`).
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
  buildGroupedEntryWithStopAction,
  buildOrderAction,
  buildProtectiveStopAction,
  mapOrder,
  mapProtectiveStop,
  HyperliquidOrderMapperError,
} from "@t3tools/hyperliquid/OrderMapper";
import { readExchangeResponse } from "@t3tools/hyperliquid/ExchangeResponse";
import { formatPrice, formatSize } from "@t3tools/hyperliquid/Precision";
import { deriveCloid } from "@t3tools/hyperliquid/Cloid";
import { HyperliquidExchangeClient, type SignedAction } from "@t3tools/hyperliquid/ExchangeClient";
import { HyperliquidNonceCoordinator } from "@t3tools/hyperliquid/NonceCoordinator";
import { signL1ActionForWire } from "@t3tools/hyperliquid/Signing";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { TradingOrderResult } from "@t3tools/trading-contracts/execution";
import type { TradingWireOrder } from "@t3tools/trading-contracts/execution";
import type {
  TradingExecutionRecord,
  TradingOrderIntent,
  TradingRiskReservation,
} from "@t3tools/trading-contracts/execution";

import {
  checkStopInformation,
  describeStopGateDefect,
  isPositionIncreasing,
} from "@t3tools/trading-contracts/protection";

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
      "missing_stop",
      /** The intent could not be acted on as written — a malformed request. */
      "intent_invalid",
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

    /**
     * Place one independent, explicitly sized reduce-only stop (§17.2 step 6).
     *
     * This is the protection the reconciliation path places when canonical
     * state shows the position is larger than the confirmed protected size —
     * after a partial fill, after a scale-in, or after a parent cancellation
     * took its linked children with it. It is submitted with `na` grouping so
     * it is nobody's child and outlives the parent.
     *
     * Returns the per-order results. Acceptance here still does not mean the
     * position is protected: only a canonical read does (§17.2 steps 7–8).
     */
    readonly submitProtectiveStop: (input: {
      readonly market: string;
      readonly cloid: string;
      /** Signed canonical position size; positive long, negative short. */
      readonly positionSize: number;
      readonly stopPrice: number;
    }) => Effect.Effect<ReadonlyArray<TradingOrderResult>, TradingExecutionError>;

    /**
     * Submit a reduce-only marketable IOC for a canonical position, WITHOUT a
     * preview context (§14.7, §17.5).
     *
     * The §16.3 checklist exists to decide whether taking on risk is allowed.
     * A reduce-only order takes on none — the exchange itself will not let it
     * open or extend a position — so gating it behind a checklist that needs a
     * mission, an authority version, and a harness lease would make the
     * deterministic controls and the emergency close depend on exactly the
     * machinery they are supposed to work without. §14.7 is explicit that
     * their availability does not depend on the harness being online.
     *
     * What is NOT bypassed: the signer, the nonce lane, precision, minimum
     * notional, and the canonical reconciliation that follows. The caller
     * supplies the signed canonical position; this sizes and prices the exit.
     */
    readonly submitReduceOnlyIoc: (input: {
      readonly missionId: string;
      readonly market: string;
      /** Signed canonical position size; positive long, negative short. */
      readonly positionSize: number;
      /** Price to cross from — the bid for a long exit, the ask for a short. */
      readonly referencePrice: number;
      /** Distinguishes repeated attempts so each carries its own cloid. */
      readonly attempt: number;
    }) => Effect.Effect<ReadonlyArray<TradingOrderResult>, TradingExecutionError>;
  }
>()("t3/trading/HyperliquidExecutionService") {}

/**
 * Slippage allowance on a deterministic reduce-only exit.
 *
 * Wider than an entry's, deliberately. An entry that misses can be retried at
 * leisure; an exit that misses leaves exposure open, which is the thing being
 * escaped. 1% of the crossing price buys the fill.
 */
export const REDUCE_ONLY_EXIT_SLIPPAGE_BPS = 100;

/**
 * Suffix appended to an action type when deriving the cloid of its linked
 * protective child, so parent and child get distinct deterministic cloids from
 * the same `(mission, strategy, sequence)` triple.
 */
export const PROTECTION_CLOID_SUFFIX = "_protect";

// JSON columns go through the contract schema, not raw JSON.stringify, so a
// malformed row fails loudly instead of flowing into the domain as `any`.
const OrderResultsJson = Schema.fromJsonString(Schema.Array(TradingOrderResult));
const encodeOrderResultsJson = Schema.encodeUnknownSync(OrderResultsJson);

const now = (): Effect.Effect<number> => Clock.currentTimeMillis;

/**
 * The only statuses from which it is safe to submit. Everything else means this
 * cloid has already been POSTed to `/exchange`, and the exchange will not stop
 * a second copy: cloid uniqueness applies to *resting* orders only, so a
 * marketable IOC — which never rests — fills twice if it is submitted twice.
 *
 * `submitted` is deliberately excluded even though its outcome is unknown. An
 * unresolved submission is exactly the case that duplicates a position if it is
 * retried blind, so the retry returns the unresolved record and leaves it to
 * reconciliation (§18.2) to settle it into `accepted`/`filled`/`failed`.
 */
const PRE_SUBMISSION_STATUSES: ReadonlyArray<TradingExecutionRecord["status"]> = [
  "previewed",
  "reserved",
  "signed",
];

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

/** The legs of one submission, in the order they were sent. */
interface SubmittedLeg {
  readonly cloid: string;
  readonly role: "entry" | "protection";
}

/**
 * Inspect EVERY per-order status in the exchange response (§17.2 step 4).
 *
 * The exchange returns one status per order in submission order, so each row
 * is attributed to the leg that was sent at that index. A `filled` row does
 * not reliably echo the cloid back, and for a grouped request "which leg
 * failed" is the whole question — positional attribution is the only way to
 * answer it.
 *
 * An action-level rejection (insufficient margin, for example) carries no rows
 * at all. That is reported as a failure rather than an empty success: §17.1's
 * rule is that a response never proves an order is live, and it is doubly true
 * of a response T3 could not read.
 */
function inspectOrderStatuses(
  response: unknown,
  legs: ReadonlyArray<SubmittedLeg>,
  intent: TradingOrderIntent,
): Effect.Effect<ReadonlyArray<TradingOrderResult>, TradingExecutionError> {
  return Effect.gen(function* () {
    const outcome = readExchangeResponse(response);
    if (outcome.actionError !== undefined) {
      return yield* new TradingExecutionError({
        stage: "inspect_failed",
        detail: `${intent.actionType} rejected by the exchange: ${outcome.actionError}`,
      });
    }
    if (outcome.statuses.length === 0) {
      return yield* new TradingExecutionError({
        stage: "inspect_failed",
        detail: `exchange response for ${intent.actionType} carried no per-order statuses`,
      });
    }

    return outcome.statuses.map((row, index) => {
      const leg = legs[index];
      return {
        // Prefer the leg T3 sent over the echo: it is always present, and a
        // mismatch would mean the positional contract broke, which the caller
        // must not paper over with a blank cloid.
        cloid: leg?.cloid ?? row.cloid ?? "",
        status: row.outcome,
        orderId: row.orderId,
        filledSize: row.filledSize,
        reason: row.reason,
        role: leg?.role,
      } satisfies TradingOrderResult;
    });
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

      // --- 4b. the mandatory-stop gate, second evaluation (§16.3 item 17) ----
      // Preview already ran `checkStopInformation` against the harness's limit.
      // This one runs against the price actually going on the wire — for a
      // marketable IOC that is the BBO-derived limit, not the requested one —
      // so an increase whose stop stopped making sense between preview and
      // mapping is refused here rather than signed. Nothing has been persisted
      // and no nonce has been spent at this point.
      const stopGateInput = {
        actionType: intent.actionType,
        side: intent.side,
        referencePrice: Number.parseFloat(wireOrder.limitPrice),
        stop: intent.stop,
      };
      const stopDefect = checkStopInformation(stopGateInput);
      if (stopDefect !== null) {
        return yield* new TradingExecutionError({
          stage: "missing_stop",
          detail: describeStopGateDefect(stopDefect, stopGateInput),
        });
      }

      // --- 4c. map the linked protective child, when this is an increase -----
      //
      // §17.2 step 3: the IOC parent and its reduce-only stop may go out in one
      // `normalTpsl` action. This is an optimisation and a linkage mechanism
      // (§17.1) — submitting it proves nothing about whether the child is
      // live, which is why the caller still runs protection reconciliation
      // against canonical state afterwards.
      //
      // The child is sized to the REQUESTED size here because no fill has
      // happened yet. Reconciliation resizes it to the canonical position, and
      // that is the number the invariant is measured against.
      const stop = intent.stop;
      const linkedStop =
        isPositionIncreasing(intent.actionType) && stop !== undefined
          ? yield* mapProtectiveStop({
              cloid: deriveCloid({
                missionId: intent.missionId,
                strategyVersion: intent.strategyVersion,
                executionSequence: intent.executionSequence,
                actionType: `${intent.actionType}${PROTECTION_CLOID_SUFFIX}`,
              }),
              coin: intent.market,
              positionSize: intent.side === "buy" ? intent.size : -intent.size,
              stopPrice: stop.stopPrice,
              szDecimals: market.szDecimals,
            }).pipe(
              Effect.mapError(
                (e: HyperliquidOrderMapperError) =>
                  new TradingExecutionError({
                    stage: "order_mapping_failed",
                    detail: `protective child: ${e.reason}${e.detail ? `: ${e.detail}` : ""}`,
                  }),
              ),
            )
          : undefined;

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
        stopPrice: intent.stop?.stopPrice,
        plannedLossAtStopUsd: intent.stop?.plannedLossAtStopUsd,
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
      if (!PRE_SUBMISSION_STATUSES.includes(persisted.status)) {
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
      const legs: ReadonlyArray<SubmittedLeg> =
        linkedStop === undefined
          ? [{ cloid: wireOrder.cloid, role: "entry" }]
          : [
              { cloid: wireOrder.cloid, role: "entry" },
              { cloid: linkedStop.cloid, role: "protection" },
            ];
      const action =
        linkedStop === undefined
          ? buildOrderAction(wireOrder, market.assetIndex)
          : buildGroupedEntryWithStopAction(wireOrder, linkedStop, market.assetIndex);
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
      const orderResults = yield* inspectOrderStatuses(response, legs, intent);

      // --- 9. update the execution record with the result --------------------
      //
      // The ENTRY leg decides the record's status, not "some leg succeeded".
      // In a grouped request the child can be rejected while the parent fills,
      // and reading that as "accepted" across the batch is exactly the batch-
      // atomicity assumption §17.1 forbids. A rejected child is recorded in
      // `orderResults` and left for protection reconciliation to repair.
      //
      // A response that says `filled` is recorded as `filled`, not `accepted`.
      // The exchange is the authority on the outcome of its own submit, and an
      // IOC reports that outcome in the submit response itself — there is no
      // later reconciliation question to leave open. Recording it as `accepted`
      // parked every successful IOC in a non-terminal status forever: nothing
      // in the system ever wrote `filled`, so the record stayed "in flight",
      // its risk reservation stayed reserved, and preview item 16 refused every
      // subsequent intent for the mission. `accepted` now means only what it
      // says — acknowledged and resting on the book.
      const entryResult = orderResults.find((r) => r.role !== "protection") ?? orderResults[0];
      const finalStatus: TradingExecutionRecord["status"] =
        entryResult?.status === "filled"
          ? "filled"
          : entryResult?.status === "resting"
            ? "accepted"
            : "rejected";
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

  // §17.2 step 6: independent, explicitly sized reduce-only protection. Shares
  // the signer and nonce lane with every other action so protection never
  // races an order for a nonce.
  const submitProtectiveStop: HyperliquidExecutionService["Service"]["submitProtectiveStop"] = (
    input,
  ) =>
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

      const market = yield* gateway
        .resolveMarket(input.market)
        .pipe(Effect.mapError(() => new TradingExecutionError({ stage: "market_unresolved" })));

      const stop = yield* mapProtectiveStop({
        cloid: input.cloid,
        coin: input.market,
        positionSize: input.positionSize,
        stopPrice: input.stopPrice,
        szDecimals: market.szDecimals,
      }).pipe(
        Effect.mapError(
          (e: HyperliquidOrderMapperError) =>
            new TradingExecutionError({
              stage: "order_mapping_failed",
              detail: `${e.reason}${e.detail ? `: ${e.detail}` : ""}`,
            }),
        ),
      );

      const action = buildProtectiveStopAction(stop, market.assetIndex);
      const signed = yield* nonceCoord
        .runWithNonce((nonce) =>
          Effect.succeed({
            action,
            nonce,
            signature: signL1ActionForWire({
              action,
              nonce,
              privateKey: signer.privateKeyBytes,
              isTestnet: true,
            }),
          } satisfies SignedAction),
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

      const response = yield* exchange.submit(signed).pipe(
        Effect.mapError(
          (cause) =>
            new TradingExecutionError({
              stage: "submit_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

      const outcome = readExchangeResponse(response);
      if (outcome.actionError !== undefined) {
        return yield* new TradingExecutionError({
          stage: "inspect_failed",
          detail: `protective stop rejected by the exchange: ${outcome.actionError}`,
        });
      }
      return outcome.statuses.map(
        (row) =>
          ({
            cloid: input.cloid,
            status: row.outcome,
            orderId: row.orderId,
            filledSize: row.filledSize,
            reason: row.reason,
            role: "protection",
          }) satisfies TradingOrderResult,
      );
    });

  // §14.7 / §17.5: the preview-free reduce-only exit. See the interface for
  // why the §16.3 checklist is not in this path.
  const submitReduceOnlyIoc: HyperliquidExecutionService["Service"]["submitReduceOnlyIoc"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const size = Math.abs(input.positionSize);
      if (size <= 0) return [];

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

      const market = yield* gateway
        .resolveMarket(input.market)
        .pipe(Effect.mapError(() => new TradingExecutionError({ stage: "market_unresolved" })));

      // Exit the opposite way the position was entered, priced through the
      // book so the IOC actually crosses.
      const isLong = input.positionSize > 0;
      const side = isLong ? ("sell" as const) : ("buy" as const);
      const slippage = REDUCE_ONLY_EXIT_SLIPPAGE_BPS / 10_000;
      const rawLimit = isLong
        ? input.referencePrice * (1 - slippage)
        : input.referencePrice * (1 + slippage);

      const cloid = deriveCloid({
        missionId: input.missionId,
        strategyVersion: 0,
        executionSequence: input.attempt,
        actionType: "reduce_only_exit",
      });

      const action = buildOrderAction(
        {
          cloid,
          coin: input.market as TradingWireOrder["coin"],
          side,
          limitPrice: formatPrice(rawLimit),
          size: formatSize(size, market.szDecimals),
          timeInForce: "ioc",
          reduceOnly: true,
        },
        market.assetIndex,
      );

      const signed = yield* nonceCoord
        .runWithNonce((nonce) =>
          Effect.succeed({
            action,
            nonce,
            signature: signL1ActionForWire({
              action,
              nonce,
              privateKey: signer.privateKeyBytes,
              isTestnet: true,
            }),
          } satisfies SignedAction),
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

      const response = yield* exchange.submit(signed).pipe(
        Effect.mapError(
          (cause) =>
            new TradingExecutionError({
              stage: "submit_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

      const outcome = readExchangeResponse(response);
      if (outcome.actionError !== undefined) {
        return yield* new TradingExecutionError({
          stage: "inspect_failed",
          detail: `reduce-only exit rejected by the exchange: ${outcome.actionError}`,
        });
      }
      return outcome.statuses.map(
        (row) =>
          ({
            cloid,
            status: row.outcome,
            orderId: row.orderId,
            filledSize: row.filledSize,
            reason: row.reason,
            role: "entry",
          }) satisfies TradingOrderResult,
      );
    });

  return HyperliquidExecutionService.of({
    submitOrder,
    submitCancel,
    submitProtectiveStop,
    submitReduceOnlyIoc,
  });
});

export const HyperliquidExecutionServiceLive = Layer.effect(
  HyperliquidExecutionService,
  makeHyperliquidExecutionService,
);
