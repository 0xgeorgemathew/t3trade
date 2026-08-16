/**
 * TradingEntryService — one entry, priced, sized and pre-checked, from what the
 * harness can actually name.
 *
 * Executing used to ask for eight things a language model cannot know: the
 * current strategy version, the current authority version, the id of the
 * harness run holding the decision lease, a monotonic execution sequence, a
 * limit price that crosses the book, a size inside four separate ceilings, a
 * planned loss consistent with that size and stop, and precision the exchange
 * accepts. Every one of them is a refusal when it is wrong, and all eight are
 * things the server already knows.
 *
 * This is the server answering them. The harness names a market, a side, a
 * stop, and optionally a size; this reads the mission, the lease, the book, the
 * account and the budget, derives the rest, and runs the same §16.3 preview the
 * execution will run. What comes back is the intent, ready to submit.
 *
 * Nothing is persisted as a token and nothing is handed to the harness to hand
 * back (plan 29 step 6.2). The two-step existed so the harness could see the
 * size and price before committing, but the only thing it could DO with them
 * was execute — and the wait between the halves was four more ways to fail:
 * an expired quote, a lease that moved on, a mission mismatch, a token that
 * was never cut. The sizing travels out with the outcome instead, which is
 * where a harness needs it: sizing the NEXT decision.
 *
 * Symmetric with `TradingExitService.prepare` on purpose — both hand the
 * caller a ready intent with the versions and the lease it must execute
 * against, and both refuse in the same shape.
 *
 * @module TradingEntryService
 */
import {
  deriveFeasibleSize,
  deriveEntryLimitPrice,
  type EntryActionType,
  type EntrySizeConstraint,
} from "@t3tools/trading-contracts/entry";
import type { TradingOrderIntent, TradingOrderSide } from "@t3tools/trading-contracts/execution";
import { urgencyToOrderPreference, type TradingUrgency } from "@t3tools/trading-contracts/strategy";
import { classifyFailure, type FailureRecovery } from "@t3tools/trading-contracts/recovery";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import {
  analyseMarketStructure,
  MARKET_STRUCTURE_LOOKBACK_BARS,
  MARKET_STRUCTURE_TIMEFRAMES,
} from "@t3tools/trading-contracts/market-structure";
import { targetNotionalForPlan } from "@t3tools/trading-contracts/costs";
import { stopNoiseFloorUsd } from "@t3tools/trading-contracts/stop-adjustment";
import { ACTIVE_TRADING_POLICY } from "@t3tools/trading-contracts/policy";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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

/** What the harness asked for, with the mission already resolved. */
export interface EntryRequest {
  readonly missionId: string;
  readonly market: string;
  readonly side: TradingOrderSide;
  readonly stopPrice: number;
  readonly sizeEth?: number | undefined;
  readonly notionalUsd?: number | undefined;
  readonly actionType?: EntryActionType | undefined;
  /**
   * How urgently the entry should land, in the harness's vocabulary. Mapped to
   * the internal order preference below; the persisted column stays the
   * preference, so no DB shape changes with this.
   */
  readonly urgency?: TradingUrgency | undefined;
}

/**
 * A prepared entry: the intent the server built, with everything the submit
 * path needs to check it against, and what the sizing decided on the way.
 */
export interface PreparedEntry {
  readonly outcome: "prepared";
  readonly intent: TradingOrderIntent;
  readonly expectedAuthorityVersion: number;
  readonly activeHarnessRunId: string;
  readonly size: number;
  readonly constrainedBy: EntrySizeConstraint;
  readonly notionalUsd: number;
  readonly plannedLossAtStopUsd: number;
  readonly estimatedRoundTripCostUsd: number;
  /** True of this entry, but not reasons to refuse it. */
  readonly notes: ReadonlyArray<string>;
}

/**
 * Why no entry could be built. The `reason` is the §16.3 preview item that
 * refused it or the size constraint that left nothing to send — one name for
 * the rule, the server's own.
 */
export interface RefusedEntry {
  readonly outcome: "refused";
  readonly reason: string;
  readonly detail: string;
  /** The largest size that would have cleared, when a smaller one would. */
  readonly feasibleSize?: number | undefined;
  /**
   * What to do about it, derived where the refusal happened.
   *
   * The reason alone cannot be classified: `classifyFailure` needs the error's
   * tag to tell a §16.3 item from a dropped read, and with only a bare string
   * every refusal here — a preview verdict, a book that went one-sided, a
   * ceiling — falls to the same permanent `read_state`. This is the only place
   * that knows which of the three produced it.
   */
  readonly recovery: FailureRecovery;
}

export type EntryPreparation = PreparedEntry | RefusedEntry;

export class TradingEntryService extends Context.Service<
  TradingEntryService,
  {
    readonly prepare: (request: EntryRequest) => Effect.Effect<EntryPreparation>;
  }
>()("t3/trading/TradingEntryService") {}

/**
 * A refusal about this mission's own state — a mandate, a lease, a ceiling.
 *
 * Permanent and worth a look at what is actually true, which is what the
 * classifier's default already says; it is spelled out here so every refusal
 * carries the field rather than some of them.
 */
const refused = (reason: string, detail: string, feasibleSize?: number): RefusedEntry => ({
  outcome: "refused",
  reason,
  detail,
  ...(feasibleSize === undefined ? {} : { feasibleSize }),
  recovery: classifyFailure({ reason }),
});

/**
 * A refusal from a read that could answer differently in a second — a book
 * with one side, a mission or account read that dropped. The detail already
 * says "retry"; this is the same instruction in the field the harness acts on.
 */
const refusedTransiently = (reason: string, detail: string): RefusedEntry => ({
  outcome: "refused",
  reason,
  detail,
  recovery: classifyFailure({ tag: "HyperliquidRequestError", reason: "network" }),
});

/**
 * A refusal by the §16.3 checklist, classified as the preview rejection it is
 * — so `account_and_bbo_fresh` reads as "price again" and every other item as
 * the rule it is, exactly as it did when the reactor ran the checklist and the
 * refusal came back wrapped.
 */
const refusedByPreview = (item: string, detail: string, feasibleSize: number): RefusedEntry => ({
  outcome: "refused",
  reason: item,
  detail,
  feasibleSize,
  recovery: classifyFailure({ tag: "TradingPreviewRejection", reason: item }),
});

export const makeTradingEntryService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missions = yield* TradingMissionService;
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
   * Read as numbers rather than through the strategy decoder: an entry that
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
      // entry sized exactly as it was before this existed.
      Effect.orElseSucceed(() => null),
    );

  const prepare: TradingEntryService["Service"]["prepare"] = (request) =>
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
          "no harness run currently owns this mission's decision lease; an entry is only executable inside a turn",
        );
      }

      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      const fallbackFeeBps = mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide;
      // Both rates in one read: the sizer needs the maker rate too, because the
      // take-profit rests. A read that fails prices both at the authority's
      // fallback — the pessimistic maker, same convention the cost estimate uses.
      const feeRate = yield* gateway.getUserFeeRatesBps(masterAddress).pipe(
        Effect.orElseSucceed(() => ({
          takerFeeBps: fallbackFeeBps,
          makerFeeBps: fallbackFeeBps,
        })),
      );
      const takerFeeRateBps = feeRate.takerFeeBps;
      // The two reads an entry cannot be made without. A dropped socket or a
      // rate limit here used to end the turn; now it costs one backoff.
      const orderBook = yield* retryTransientRead(
        gateway.getOrderBook(request.market),
        "entry.getOrderBook",
      );
      const resolved = yield* retryTransientRead(
        gateway.resolveMarket(request.market),
        "entry.resolveMarket",
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
        return refusedTransiently(
          "market_data_unavailable",
          `${request.market} has no two-sided book right now, so there is no price to enter against`,
        );
      }
      const limitPrice = deriveEntryLimitPrice({
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
      // being taken to the plan's own take-profit price, so the lift applies
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
              // The take-profit rests, so the exit pays the maker fee and
              // crosses no spread. Costing it as a second taker fill would
              // shrink the divisor and demand a bigger position for a target
              // the trade would have reached anyway.
              exitIsMaker: true,
              makerFeeBpsPerSide: feeRate.makerFeeBps,
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
        approvedExecutionWalletAddress: "prepare",
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
        return refusedByPreview(verdict.item, verdict.detail, sizing.size);
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
      // Measurement, never a gate — an entry with no scored setup behind it is
      // still taken; the funnel is what reads the difference. The structure is
      // recomputed here so the snapshot is the server's own read at entry
      // time, not prose the harness asserted.
      const setupSnapshot = yield* Effect.gen(function* () {
        const histories = yield* Effect.all(
          MARKET_STRUCTURE_TIMEFRAMES.map((interval) =>
            gateway
              .getMarketHistory({
                // Equal to request.market by the mandate guard above, but
                // carries the market type the gateway wants.
                market: mission.market,
                interval,
                maxBars: MARKET_STRUCTURE_LOOKBACK_BARS,
              })
              .pipe(Effect.map((history) => ({ interval, candles: history.candles }))),
          ),
          { concurrency: "unbounded" },
        );
        const structure = analyseMarketStructure({
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
        // A failed structure read costs the snapshot, never the entry.
        Effect.catchCause(() =>
          Effect.succeed({
            setupKind: null,
            setupScore: null,
            regime: null as string | null,
            atrUsd: null as number | null,
          }),
        ),
      );

      // Plan 27 G2: the same noise floor `trading_exit`'s `move_stop` enforces, at
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
            "the level that invalidates the thesis, plus that margin, and try once more",
        );
      }

      // The entry the server is about to commit to, recorded before it is
      // sent (plan 29 step 6.2). The retired quote row carried this and every
      // reader of it now reads here; writing it before the submit keeps the
      // sequence floor honest for an order refused on the wire.
      yield* recordEntryContext({
        missionId: request.missionId,
        executionSequence: intent.executionSequence,
        market: request.market,
        side: request.side,
        actionType,
        entryPrice,
        bestBid,
        bestAsk,
        stopPrice: request.stopPrice,
        size: sizing.size,
        notionalUsd: sizing.notionalUsd,
        constrainedBy: sizing.constrainedBy,
        setup: setupSnapshot,
        now,
      });

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
          "the round-trip cost could not be read, so estimatedRoundTripCostUsd is 0 — hold the target against trading_look",
        );
      }

      return {
        outcome: "prepared" as const,
        intent,
        expectedAuthorityVersion: mission.authorityVersion,
        activeHarnessRunId: harnessRunId,
        size: sizing.size,
        constrainedBy: sizing.constrainedBy,
        notionalUsd: sizing.notionalUsd,
        plannedLossAtStopUsd: sizing.plannedLossAtStopUsd,
        estimatedRoundTripCostUsd: costs?.roundTripUsd ?? 0,
        notes: warnings,
      } satisfies PreparedEntry;
    }).pipe(
      // Everything this reads is either the mission's own state or the
      // exchange. Neither failing is a defect worth killing the tool call over:
      // the harness gets a refusal it can act on, and the funnel counts it.
      Effect.catchCause((cause) =>
        Effect.logWarning("trading entry could not be prepared", { cause: String(cause) }).pipe(
          Effect.as(
            refusedTransiently(
              "market_data_unavailable",
              "the mission, book, or account state an entry is made of could not be read; retry once",
            ),
          ),
        ),
      ),
    );

  /**
   * Record what the server saw at the moment it committed to this entry.
   *
   * Four readers depend on it — the wake's `enteredWithoutScoredSetup`, the
   * run telemetry's entry governance and session economics, and the
   * closed-trade review's stop measurement. All four ask "what was behind the
   * trade that opened here?", so the row is keyed by the mission-local
   * execution sequence and written before the order goes out.
   *
   * Losing the row costs the evidence, never the entry: every reader already
   * treats an absent row as a trade it cannot explain.
   */
  const recordEntryContext = (input: {
    readonly missionId: string;
    readonly executionSequence: number;
    readonly market: string;
    readonly side: string;
    readonly actionType: string;
    readonly entryPrice: number;
    readonly bestBid: number;
    readonly bestAsk: number;
    readonly stopPrice: number;
    readonly size: number;
    readonly notionalUsd: number;
    readonly constrainedBy: string;
    readonly setup: {
      readonly setupKind: string | null;
      readonly setupScore: number | null;
      readonly regime: string | null;
      readonly atrUsd: number | null;
    };
    readonly now: number;
  }) =>
    sql`
      INSERT OR IGNORE INTO trading_entry_context (
        mission_id, execution_sequence, market, side, action_type,
        entry_price, best_bid, best_ask, stop_price, size, notional_usd,
        constrained_by, setup_kind, setup_score, regime, atr_usd, recorded_at
      ) VALUES (
        ${input.missionId}, ${input.executionSequence}, ${input.market}, ${input.side},
        ${input.actionType}, ${input.entryPrice}, ${input.bestBid}, ${input.bestAsk},
        ${input.stopPrice}, ${input.size}, ${input.notionalUsd}, ${input.constrainedBy},
        ${input.setup.setupKind}, ${input.setup.setupScore}, ${input.setup.regime},
        ${input.setup.atrUsd}, ${input.now}
      )
    `.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("trading entry context could not be recorded", { cause: String(cause) }),
      ),
    );

  return TradingEntryService.of({ prepare });
});

export const TradingEntryServiceLive = Layer.effect(TradingEntryService, makeTradingEntryService);
