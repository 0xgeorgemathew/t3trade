/**
 * TradingQuoteService — priced, sized, pre-checked entries the harness can
 * execute with one field.
 *
 * `trading_execute` asks for eight things a language model cannot know: the
 * current strategy version, the current authority version, the id of the
 * harness run holding the decision lease, a monotonic execution sequence, a
 * limit price that crosses the book, a size inside four separate ceilings, a
 * planned loss consistent with that size and stop, and precision the exchange
 * accepts. Every one of them is a refusal when it is wrong, and all eight are
 * things the server already knows.
 *
 * A quote is the server answering them. The harness names a market, a side, a
 * stop, and optionally a size; this reads the mission, the lease, the book, the
 * account and the budget, derives the rest, runs the same §16.3 preview the
 * execution will run, and persists a short-lived token. Executing is then
 * `{ quoteId }`.
 *
 * A quote is not an order: nothing is reserved, nothing is signed, and the
 * ceilings are re-checked at execution against state read then. What the quote
 * removes is the class of failure where a correct read of the market died on
 * the way to a well-formed call.
 *
 * @module TradingQuoteService
 */
import {
  deriveFeasibleSize,
  deriveQuoteLimitPrice,
  QUOTE_VALIDITY_MILLIS,
  type ExecutableQuote,
  type QuotableActionType,
  type TradingQuoteEntryResult,
} from "@t3tools/trading-contracts/quote";
import type { TradingOrderIntent, TradingOrderSide } from "@t3tools/trading-contracts/execution";
import type { MomentumOrderPreference } from "@t3tools/trading-contracts/strategy";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { retryTransientRead } from "./RetryTransient.ts";
import { IocSlippageConfig } from "./IocSlippageConfig.ts";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { previewOrder } from "./TradingPreviewService.ts";
import { allocateExecutionSequence } from "./TradingExecutionSequence.ts";

/** What the harness asked to be quoted, with the mission already resolved. */
export interface QuoteRequest {
  readonly missionId: string;
  readonly market: string;
  readonly side: TradingOrderSide;
  readonly stopPrice: number;
  readonly sizeEth?: number | undefined;
  readonly notionalUsd?: number | undefined;
  readonly actionType?: QuotableActionType | undefined;
  readonly orderPreference?: MomentumOrderPreference | undefined;
}

/**
 * Why a quote could not be turned into an order.
 *
 * All four are about the quote itself rather than about the market: the
 * harness named one that never existed, one belonging to another mission, one
 * whose prices have aged out, or one cut by a harness run that has since
 * released the decision lease.
 */
export type QuoteConsumptionRefusal =
  | "quote_not_found"
  | "quote_mission_mismatch"
  | "quote_expired"
  | "lease_lost";

export type QuoteConsumption =
  | {
      readonly outcome: "ready";
      readonly intent: TradingOrderIntent;
      readonly expectedAuthorityVersion: number;
      readonly activeHarnessRunId: string;
      /** True on a repeat execute of the same quote — same sequence, same cloid. */
      readonly replay: boolean;
    }
  | {
      readonly outcome: "refused";
      readonly reason: QuoteConsumptionRefusal;
      readonly detail: string;
    };

export class TradingQuoteService extends Context.Service<
  TradingQuoteService,
  {
    readonly quote: (request: QuoteRequest) => Effect.Effect<TradingQuoteEntryResult>;
    readonly consume: (input: {
      readonly quoteId: string;
      readonly missionId: string;
    }) => Effect.Effect<QuoteConsumption>;
  }
>()("t3/trading/TradingQuoteService") {}

interface QuoteRow {
  readonly quote_id: string;
  readonly mission_id: string;
  readonly harness_run_id: string;
  readonly strategy_version: number;
  readonly authority_version: number;
  readonly execution_sequence: number;
  readonly market: string;
  readonly side: string;
  readonly action_type: string;
  readonly order_preference: string;
  readonly size: number;
  readonly limit_price: number;
  readonly stop_price: number;
  readonly planned_loss_usd: number;
  readonly expires_at: number;
  readonly consumed_at: number | null;
}

const refused = (
  reason: string,
  detail: string,
  feasibleSize?: number,
): TradingQuoteEntryResult => ({
  outcome: "refused",
  reason,
  detail,
  ...(feasibleSize === undefined ? {} : { feasibleSize }),
});

export const makeTradingQuoteService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missions = yield* TradingMissionService;
  const crypto = yield* Crypto.Crypto;
  const iocSlippage = yield* IocSlippageConfig;
  const gateway = yield* HyperliquidGateway;
  const budgetReader = yield* TradingBudgetReader;
  const estimator = yield* TradingCostEstimator;

  /**
   * The harness run that currently holds the mission's decision lease, read
   * from the table the lease actually lives in.
   *
   * The old execute path took `activeHarnessRunId` as an argument and preview
   * only checked it was non-null — so a run id the harness invented, or one
   * belonging to a turn that had already ended, passed. This is the ownership
   * check the checklist item was named for.
   */
  const readActiveRun = (missionId: string) =>
    sql<{ readonly run_id: string }>`
      SELECT run_id FROM trading_harness_runs
      WHERE mission_id = ${missionId} AND status NOT IN ('completed', 'failed')
      ORDER BY started_at DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.run_id ?? null));

  const quote: TradingQuoteService["Service"]["quote"] = (request) =>
    Effect.gen(function* () {
      const mission = yield* missions.getMission(request.missionId);
      if (mission.market !== request.market) {
        return refused(
          "market_is_eth",
          `mission is mandated to ${mission.market} only; got ${request.market}`,
        );
      }

      const harnessRunId = yield* readActiveRun(request.missionId);
      if (harnessRunId === null) {
        return refused(
          "harness_run_owns_lease",
          "no harness run currently owns this mission's decision lease; a quote is only executable inside a turn",
        );
      }

      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      const fallbackFeeBps = mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide;
      const takerFeeRateBps = yield* gateway.getTakerFeeRateBps(masterAddress).pipe(
        Effect.map((rate) => rate.feeBps),
        Effect.orElseSucceed(() => fallbackFeeBps),
      );
      // The two reads a quote cannot be made without. A dropped socket or a
      // rate limit here used to end the turn; now it costs one backoff.
      const orderBook = yield* retryTransientRead(
        gateway.getOrderBook(request.market),
        "quote.getOrderBook",
      );
      const resolved = yield* retryTransientRead(
        gateway.resolveMarket(request.market),
        "quote.resolveMarket",
      );
      const budgetInput = yield* budgetReader.read({
        missionId: request.missionId,
        maximumCumulativeLossUsd: mission.authority.maximumCumulativeLossUsd,
        takerFeeRateBps,
      });
      const budget = evaluateLossBudget(budgetInput);

      const orderPreference = request.orderPreference ?? "marketable_ioc";
      const bbo = orderBook.bestBidOffer;
      const bestBid = bbo.bidPrice;
      const bestAsk = bbo.askPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        return refused(
          "market_data_unavailable",
          `${request.market} has no two-sided book right now, so there is no price to quote against`,
        );
      }
      const limitPrice = deriveQuoteLimitPrice({
        side: request.side,
        orderPreference,
        bestBid,
        bestAsk,
        slippageBps: (yield* iocSlippage.resolve).entryBps,
      });

      // The price a fill would actually happen at — the far side of the book,
      // not the padded limit. Sizing against the padded limit would quietly
      // reserve the slippage allowance twice.
      const entryPrice = request.side === "buy" ? bestAsk : bestBid;
      const requestedSize =
        request.sizeEth ??
        (request.notionalUsd === undefined ? undefined : request.notionalUsd / entryPrice);

      const sizing = deriveFeasibleSize({
        side: request.side,
        entryPrice,
        stopPrice: request.stopPrice,
        requestedSize,
        szDecimals: resolved.szDecimals,
        existingNotionalUsd: budgetInput.openPositions.reduce(
          (sum, position) => sum + position.size * (position.weightedEntryPrice ?? entryPrice),
          0,
        ),
        allocatedCapitalUsd: mission.authority.allocatedCapitalUsd,
        maximumLeverage: mission.authority.maximumLeverage,
        maximumGrossNotionalUsd: mission.authority.maximumGrossNotionalUsd,
        maximumPlannedRiskPerPositionUsd: mission.authority.maximumPlannedRiskPerPositionUsd,
        remainingCumulativeLossUsd: budget.remainingCumulativeLossUsd,
        takerFeeBpsPerSide: takerFeeRateBps,
        stopSlippageReserveBps: mission.authority.riskPolicy.stopSlippageReserveBps,
        minimumNotionalUsd: MIN_NOTIONAL_USD,
      });

      if (!sizing.feasible) {
        return refused(sizing.constrainedBy, sizing.detail, sizing.size);
      }

      const actionType = request.actionType ?? "open";
      const executionSequence = yield* allocateExecutionSequence(sql, request.missionId);
      const intent: TradingOrderIntent = {
        missionId: request.missionId,
        strategyVersion: mission.strategyVersion,
        executionSequence,
        actionType,
        market: request.market,
        side: request.side,
        size: sizing.size,
        orderPreference,
        limitPrice,
        stop: {
          stopPrice: request.stopPrice,
          plannedLossAtStopUsd: sizing.plannedLossAtStopUsd,
        },
        reduceOnly: false,
      };

      // Run the checklist the execution will run, against the state it will
      // read. `mission_active` is the one item deliberately satisfied here: the
      // reactor moves the mission to `executing` as part of requesting an
      // entry, so a waiting mission would fail an item that execution itself
      // makes true. Every other item is checked for real.
      const now = yield* Clock.currentTimeMillis;
      const verdict = yield* previewOrder(intent, {
        mission: { ...mission, status: "executing" },
        currentStrategyVersion: mission.strategyVersion,
        currentAuthorityVersion: mission.authorityVersion,
        expectedAuthorityVersion: mission.authorityVersion,
        activeHarnessRunId: harnessRunId,
        requestingHarnessRunId: harnessRunId,
        // Signing identity is not resolvable from a read path and is checked
        // again immediately before the nonce is spent.
        approvedExecutionWalletAddress: "quote",
        bbo,
        accountObservedAt: budgetInput.observedAt,
        pendingExecution: null,
        budget: budgetInput,
        takerFeeRateBps,
        stopSlippageReserveBps: mission.authority.riskPolicy.stopSlippageReserveBps,
        nowMs: now,
      }).pipe(
        Effect.as(null),
        Effect.catch((rejection) => Effect.succeed(rejection)),
      );

      if (verdict !== null) {
        return refused(verdict.item, verdict.detail, sizing.size);
      }

      const costs = yield* estimator
        .estimate({
          market: request.market,
          masterAddress,
          sizeEth: sizing.size,
          fallbackTakerFeeBpsPerSide: fallbackFeeBps,
        })
        .pipe(
          // The estimator reaches the exchange through the same gateway this
          // service already holds.
          Effect.provideService(HyperliquidGateway, gateway),
          Effect.orElseSucceed(() => null),
        );

      const quoteId = `qte_${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const executable: ExecutableQuote = {
        quoteId,
        quotedAt: now,
        expiresAt: now + QUOTE_VALIDITY_MILLIS,
        missionId: request.missionId,
        market: request.market,
        side: request.side,
        actionType,
        orderPreference,
        strategyVersion: mission.strategyVersion,
        authorityVersion: mission.authorityVersion,
        harnessRunId,
        executionSequence: intent.executionSequence,
        size: sizing.size,
        requestedSize: sizing.requestedSize,
        constrainedBy: sizing.constrainedBy,
        notionalUsd: sizing.notionalUsd,
        limitPrice,
        bestBid,
        bestAsk,
        stopPrice: request.stopPrice,
        plannedLossAtStopUsd: sizing.plannedLossAtStopUsd,
        reservedRiskUsd: sizing.reservedRiskUsd,
        estimatedRoundTripCostUsd: costs?.roundTripUsd ?? 0,
      };

      yield* sql`
        INSERT INTO trading_entry_quotes (
          quote_id, mission_id, harness_run_id, strategy_version, authority_version,
          execution_sequence, market, side, action_type, order_preference,
          size, requested_size, constrained_by, limit_price, stop_price,
          planned_loss_usd, reserved_risk_usd, notional_usd, best_bid, best_ask,
          round_trip_cost_usd, quoted_at, expires_at
        ) VALUES (
          ${quoteId}, ${request.missionId}, ${harnessRunId}, ${mission.strategyVersion},
          ${mission.authorityVersion}, ${intent.executionSequence}, ${request.market},
          ${request.side}, ${actionType}, ${orderPreference},
          ${sizing.size}, ${sizing.requestedSize}, ${sizing.constrainedBy}, ${limitPrice},
          ${request.stopPrice}, ${sizing.plannedLossAtStopUsd}, ${sizing.reservedRiskUsd},
          ${sizing.notionalUsd}, ${bestBid}, ${bestAsk}, ${executable.estimatedRoundTripCostUsd},
          ${now}, ${executable.expiresAt}
        )
      `;

      const warnings: Array<string> = [];
      if (sizing.constrainedBy !== "requested") {
        warnings.push(sizing.detail);
      }
      if (costs === null) {
        warnings.push(
          "the round-trip cost could not be read, so estimatedRoundTripCostUsd is 0 — hold the target against trading_estimate_costs before executing",
        );
      }

      return { outcome: "quoted" as const, quote: executable, warnings };
    }).pipe(
      // Everything a quote reads is either the mission's own state or the
      // exchange. Neither failing is a defect worth killing the tool call over:
      // the harness gets a refusal it can act on, and the funnel counts it.
      Effect.catchCause((cause) =>
        Effect.logWarning("trading quote failed", { cause: String(cause) }).pipe(
          Effect.as(
            refused(
              "market_data_unavailable",
              "the mission, book, or account state a quote is made of could not be read; retry once",
            ),
          ),
        ),
      ),
    );

  const consume: TradingQuoteService["Service"]["consume"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<QuoteRow>`
        SELECT * FROM trading_entry_quotes WHERE quote_id = ${input.quoteId}
      `;
      const row = rows[0];
      if (row === undefined) {
        return {
          outcome: "refused" as const,
          reason: "quote_not_found" as const,
          detail: `no quote ${input.quoteId}; call trading_quote_entry to cut one`,
        };
      }
      if (row.mission_id !== input.missionId) {
        return {
          outcome: "refused" as const,
          reason: "quote_mission_mismatch" as const,
          detail: `quote ${input.quoteId} belongs to another mission`,
        };
      }

      const now = yield* Clock.currentTimeMillis;
      // A replay is not stale: the sequence is already spent, so re-executing
      // it can only produce the execution it already produced. Only a quote
      // that never became an order expires.
      const replay = row.consumed_at !== null;
      if (!replay && now > row.expires_at) {
        return {
          outcome: "refused" as const,
          reason: "quote_expired" as const,
          detail:
            `quote ${input.quoteId} expired ${Math.round((now - row.expires_at) / 1000)}s ago; ` +
            "call trading_quote_entry again for a fresh price and size",
        };
      }

      const activeRun = yield* readActiveRun(input.missionId);
      if (activeRun !== row.harness_run_id) {
        return {
          outcome: "refused" as const,
          reason: "lease_lost" as const,
          detail:
            `the turn that cut quote ${input.quoteId} no longer owns the decision lease; ` +
            "re-quote inside the current turn",
        };
      }

      yield* sql`
        UPDATE trading_entry_quotes SET consumed_at = ${now}
        WHERE quote_id = ${input.quoteId} AND consumed_at IS NULL
      `;

      return {
        outcome: "ready" as const,
        replay,
        expectedAuthorityVersion: row.authority_version,
        activeHarnessRunId: row.harness_run_id,
        intent: {
          missionId: row.mission_id,
          strategyVersion: row.strategy_version,
          executionSequence: row.execution_sequence,
          actionType: row.action_type as TradingOrderIntent["actionType"],
          market: row.market as TradingOrderIntent["market"],
          side: row.side as TradingOrderSide,
          size: row.size,
          orderPreference: row.order_preference as MomentumOrderPreference,
          limitPrice: row.limit_price,
          stop: {
            stopPrice: row.stop_price,
            plannedLossAtStopUsd: row.planned_loss_usd,
          },
          reduceOnly: false,
        },
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("trading quote could not be read", { cause: String(cause) }).pipe(
          Effect.as({
            outcome: "refused" as const,
            reason: "quote_not_found" as const,
            detail: "the quote could not be read; call trading_quote_entry again",
          }),
        ),
      ),
    );

  return TradingQuoteService.of({ quote, consume });
});

export const TradingQuoteServiceLive = Layer.effect(TradingQuoteService, makeTradingQuoteService);
