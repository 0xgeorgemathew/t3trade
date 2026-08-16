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
import {
  urgencyToOrderPreference,
  type MomentumOrderPreference,
  type TradingUrgency,
} from "@t3tools/trading-contracts/strategy";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import {
  analyseMomentum,
  MOMENTUM_LOOKBACK_BARS,
  MOMENTUM_TIMEFRAMES,
} from "@t3tools/trading-contracts/momentum";
import { targetNotionalForPlan } from "@t3tools/trading-contracts/costs";
import { stopNoiseFloorUsd } from "@t3tools/trading-contracts/stop-adjustment";
import { ACTIVE_TRADING_POLICY } from "@t3tools/trading-contracts/policy";
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
  /**
   * How urgently the entry should land, in the harness's vocabulary. Mapped to
   * the internal order preference below; the persisted column stays the
   * preference, so no DB shape changes with this.
   */
  readonly urgency?: TradingUrgency | undefined;
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

  /**
   * The published plan's target: the USD rung and the price it aims at, when
   * the plan publishes either, and whether the plan stood aside.
   *
   * Read as numbers rather than through the strategy decoder: a quote that
   * fails because a historical field no longer decodes would be a refusal about
   * bookkeeping, and this is a sizing hint. Null fields when the mission has
   * published nothing, when the plan stood aside (`intent: "stand_aside"` —
   * the stand-down of the old schema), or when the fields are absent.
   */
  const readPlanTarget = (missionId: string) =>
    sql<{
      readonly target_profit_usd: number | null;
      readonly take_profit_price: number | null;
      readonly stand_aside: number | null;
    }>`
      SELECT
        json_extract(s.strategy_json, '$.target.profitUsd') AS target_profit_usd,
        json_extract(s.strategy_json, '$.target.price') AS take_profit_price,
        json_extract(s.strategy_json, '$.intent') = 'stand_aside' AS stand_aside
      FROM trading_plan_history s
      WHERE s.mission_id = ${missionId}
      ORDER BY s.version DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      // A sizing hint is never worth the turn: an unreadable row leaves the
      // quote sized exactly as it was before this existed.
      Effect.orElseSucceed(() => null),
    );

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

      // The harness states urgency, never a preference: `now` crosses, `patient`
      // rests post-only. Everything downstream — the derived limit, the intent,
      // the persisted row — speaks the preference this one mapping produces.
      const urgency = request.urgency ?? "now";
      const orderPreference = urgencyToOrderPreference(urgency);
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

      // The notional the plan's own target needs, given what the round trip
      // costs at this book. A floor the sizing lifts toward, never a ceiling:
      // sizing down does not make a target cheaper to reach, it makes it
      // unreachable, because the costs shrink with the notional and the target
      // does not. Every risk ceiling still binds above it.
      const plan = yield* readPlanTarget(request.missionId);
      // Sized through the same composition the structure read's cost estimate
      // prices from (`targetNotionalForPlan`), so the two cannot drift apart on
      // what a target needs. The expected move is the distance from the entry
      // being quoted to the plan's own take-profit price, so the lift applies
      // only to plans that name the level they are aiming at.
      const targetNotional =
        plan === null ||
        plan.stand_aside === 1 ||
        plan.target_profit_usd === null ||
        plan.take_profit_price === null
          ? null
          : targetNotionalForPlan({
              targetProfitUsd: plan.target_profit_usd,
              expectedPriceMoveUsd: Math.abs(plan.take_profit_price - entryPrice),
              referencePrice: entryPrice,
              takerFeeBpsPerSide: takerFeeRateBps,
              halfSpreadUsd: Math.max(0, (bestAsk - bestBid) / 2),
            });

      const sizing = deriveFeasibleSize({
        side: request.side,
        entryPrice,
        stopPrice: request.stopPrice,
        requestedSize,
        ...(targetNotional?.notionalUsd == null
          ? {}
          : { targetNotionalUsd: targetNotional.notionalUsd }),
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

      // Plan 27 C1: snapshot the setup evidence behind this entry, or null.
      // Measurement, never a gate — a quote with no scored setup behind it is
      // still cut; the funnel is what reads the difference. The structure is
      // recomputed here so the snapshot is the server's own read at quote
      // time, not prose the harness asserted.
      const setupSnapshot = yield* Effect.gen(function* () {
        const histories = yield* Effect.all(
          MOMENTUM_TIMEFRAMES.map((interval) =>
            gateway
              .getMarketHistory({
                // Equal to request.market by the mandate guard above, but
                // carries the market type the gateway wants.
                market: mission.market,
                interval,
                maxBars: MOMENTUM_LOOKBACK_BARS,
              })
              .pipe(Effect.map((history) => ({ interval, candles: history.candles }))),
          ),
          { concurrency: "unbounded" },
        );
        const structure = analyseMomentum({
          market: request.market,
          measuredAt: now,
          frames: histories,
        });
        const wantedDirection = request.side === "buy" ? "up" : "down";
        // Only a setup that cleared every internal gate is a scored setup
        // (plan 29 step 3.4): near-misses are context and must not put a
        // setup kind behind an entry that never had one.
        const best = structure.setups.find(
          (setup) => setup.direction === wantedDirection && setup.rejectedBy === undefined,
        );
        // The primary timeframe's ATR, for the stop noise floor and the
        // stop-distance record on the eventual closed trade.
        const primaryFrame = structure.timeframes.find((frame) => frame.sufficientData) ?? null;
        return {
          setupKind: best?.kind ?? null,
          setupScore: best?.score ?? null,
          regime: structure.regime.classification as string | null,
          atrUsd: primaryFrame === null ? null : primaryFrame.atrUsd,
        };
      }).pipe(
        // A failed structure read costs the snapshot, never the quote.
        Effect.catchCause(() =>
          Effect.succeed({
            setupKind: null,
            setupScore: null,
            regime: null as string | null,
            atrUsd: null as number | null,
          }),
        ),
      );

      // Plan 27 G2: the same noise floor `trading_adjust_stop` enforces, at
      // the entry. A stop inside max(2x half-spread, 0.35x ATR) is not
      // protection, it is a scheduled exit — refuse it with the floor named
      // rather than let the entry buy a stop-out the doctrine already
      // forbids. When the ATR read failed the floor is spread-only, which
      // only ever makes the rule more permissive, never stricter.
      const halfSpreadUsd = Math.max(0, (bestAsk - bestBid) / 2);
      const noiseFloorUsd = stopNoiseFloorUsd({
        halfSpreadUsd,
        atrUsd: setupSnapshot.atrUsd ?? 0,
      });
      const stopDistanceUsd = Math.abs(entryPrice - request.stopPrice);
      if (stopDistanceUsd < noiseFloorUsd) {
        // Name the price that would clear. The floor is arithmetic the server
        // already did; making the harness re-derive it costs a round trip and
        // reads to it as a market refusal rather than a fixable input.
        const clearingStop =
          request.side === "buy" ? entryPrice - noiseFloorUsd : entryPrice + noiseFloorUsd;
        return refused(
          "stop_inside_noise_floor",
          `the stop at ${request.stopPrice} sits ${stopDistanceUsd.toFixed(2)} USD from the ` +
            `${entryPrice} entry, inside the ${noiseFloorUsd.toFixed(2)} USD noise floor ` +
            `(max(2 x ${halfSpreadUsd.toFixed(2)} half-spread, 0.35 x ${(setupSnapshot.atrUsd ?? 0).toFixed(2)} ATR)); ` +
            `${clearingStop.toFixed(2)} is the nearest stop that clears it — place yours at or beyond ` +
            "the level that invalidates the thesis, plus that margin, and re-quote once",
        );
      }

      const quoteId = `qte_${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const executable: ExecutableQuote = {
        quoteId,
        quotedAt: now,
        expiresAt: now + QUOTE_VALIDITY_MILLIS,
        missionId: request.missionId,
        market: request.market,
        side: request.side,
        actionType,
        urgency,
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
          quote_id, mission_id, harness_run_id, authority_version,
          execution_sequence, market, side, action_type, order_preference,
          size, requested_size, constrained_by, limit_price, stop_price,
          planned_loss_usd, reserved_risk_usd, notional_usd, best_bid, best_ask,
          round_trip_cost_usd, quoted_at, expires_at,
          setup_kind_at_entry, setup_score_at_entry, regime_at_entry, atr_usd_at_entry
        ) VALUES (
          ${quoteId}, ${request.missionId}, ${harnessRunId},
          ${mission.authorityVersion}, ${intent.executionSequence}, ${request.market},
          ${request.side}, ${actionType}, ${orderPreference},
          ${sizing.size}, ${sizing.requestedSize}, ${sizing.constrainedBy}, ${limitPrice},
          ${request.stopPrice}, ${sizing.plannedLossAtStopUsd}, ${sizing.reservedRiskUsd},
          ${sizing.notionalUsd}, ${bestBid}, ${bestAsk}, ${executable.estimatedRoundTripCostUsd},
          ${now}, ${executable.expiresAt},
          ${setupSnapshot.setupKind}, ${setupSnapshot.setupScore}, ${setupSnapshot.regime},
          ${setupSnapshot.atrUsd}
        )
      `;

      const warnings: Array<string> = [];
      if (sizing.constrainedBy !== "requested") {
        warnings.push(sizing.detail);
      }
      // A size well inside the ceilings is not a safer thesis, it is the same
      // thesis paid less — the spread, the round trip, and the turn it took are
      // unchanged. Said, never enforced: a mandate that names a notional is the
      // user's call and this line is the only thing that happens about it.
      const sizeFloor =
        ACTIVE_TRADING_POLICY.session.entrySizeFloorFractionOfCeiling * sizing.ceilingSize;
      if (sizing.constrainedBy === "requested" && sizing.size < sizeFloor) {
        warnings.push(
          `size ${sizing.size} is under ${(ACTIVE_TRADING_POLICY.session.entrySizeFloorFractionOfCeiling * 100).toFixed(0)}% ` +
            `of the ${sizing.ceilingSize} every risk ceiling allows; unless the mandate caps the notional, ` +
            "a position this far inside the approved risk pays proportionally less for the same costs and the same turn",
        );
      }
      // Say what the target did to the size, in both directions. A trade is
      // never refused over this: a target the ceilings cannot fund is a target
      // to re-cut at the next publish, not a reason to sit out a setup that
      // cleared every risk rule.
      if (targetNotional !== null) {
        if (targetNotional.notionalUsd === null) {
          warnings.push(
            `the plan's target cannot be funded at any size: ${targetNotional.reason} — ` +
              "re-cut the target off the move the market is actually producing, or take the trade for a nearer rung",
          );
        } else if (!sizing.fundsTarget) {
          warnings.push(
            `this size pays about ${(sizing.notionalUsd * targetNotional.netFraction).toFixed(2)} USD ` +
              `on the plan's expected move, short of the target it published; ${targetNotional.reason}, ` +
              `and ${sizing.constrainedBy} capped the notional at ${sizing.notionalUsd.toFixed(2)} USD`,
          );
        }
        // A size RAISED to fund the target is already reported: `constrainedBy`
        // is `target_notional` and the block above pushed its detail.
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
