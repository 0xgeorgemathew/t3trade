/**
 * TradingStopAdjustmentService - the evidence behind `trading_exit`'s `move_stop`.
 *
 * The policy itself is pure and lives in
 * `@t3tools/trading-contracts/stop-adjustment`. This gathers the seven numbers
 * it measures against — the position, the stop actually resting on the
 * exchange, the mark and half-spread, the server's own ATR, the target price,
 * and this position's adjustment history — and records an accepted move.
 *
 * It decides nothing and touches no exchange state. An approved decision is
 * still executed through the ordinary `modify_stop` path, so the
 * place-and-confirm-before-cancel sequence and its §17.5 escalation are the
 * same ones every other stop move takes.
 *
 * @module TradingStopAdjustmentService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { ENTRY_RECORD_LEAD_MILLIS, isProtectiveOrder } from "@t3tools/trading-contracts/protection";
import {
  checkStopAdjustment,
  plannedLossAtStopUsd,
  STOP_ADJUSTMENT_LIMITS,
  type StopAdjustmentJustification,
  type StopAdjustmentRefusalCode,
} from "@t3tools/trading-contracts/stop-adjustment";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import { timeframeBarMillis } from "@t3tools/trading-contracts/watch";
import type { TradingAdjustStopRefusalContext } from "@t3tools/trading-contracts/tools";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";

/** What the mission's own state says about a proposed stop move. */
export type StopAdjustmentDecision =
  | {
      readonly outcome: "approved";
      /** Signed position size, so the caller can shape the reduce-only intent. */
      readonly positionSize: number;
      readonly previousStop: number;
      readonly newStop: number;
      readonly stopDistanceUsd: number;
      readonly plannedLossAtStopUsd: number;
      readonly remainingAdjustments: number;
    }
  | {
      readonly outcome: "refused";
      readonly refusalCode: StopAdjustmentRefusalCode | TradingAdjustStopRefusalContext;
      /** The stop still resting, when one could be read. */
      readonly previousStop: number;
      readonly newStop: number;
      readonly detail: string;
    };

export interface TradingStopAdjustmentServiceShape {
  /** Measure the mission and run the policy. Writes nothing. */
  readonly evaluate: (input: {
    readonly missionId: string;
    readonly market: TradingMarket;
    readonly newStopPrice: number;
    /** The `updatedAt` of the plan the caller last read; stale is refused. */
    readonly expectedPlanUpdatedAt: number;
  }) => Effect.Effect<StopAdjustmentDecision, PersistenceSqlError>;

  /** Record an adjustment the exchange confirmed. */
  readonly record: (input: {
    readonly missionId: string;
    readonly market: TradingMarket;
    readonly previousStopPrice: number;
    readonly newStopPrice: number;
    readonly justification: StopAdjustmentJustification;
  }) => Effect.Effect<void, PersistenceSqlError>;
}

export class TradingStopAdjustmentService extends Context.Service<
  TradingStopAdjustmentService,
  TradingStopAdjustmentServiceShape
>()("t3/trading/TradingStopAdjustmentService") {}

const refuse = (
  refusalCode: StopAdjustmentRefusalCode | TradingAdjustStopRefusalContext,
  detail: string,
  prices: { readonly previousStop: number; readonly newStop: number },
): StopAdjustmentDecision => ({ outcome: "refused", refusalCode, ...prices, detail });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* HyperliquidGateway;
  const missions = yield* TradingMissionService;
  const strategies = yield* TradingStrategyService;
  const crypto = yield* Crypto.Crypto;

  const evaluate: TradingStopAdjustmentServiceShape["evaluate"] = (input) =>
    Effect.gen(function* () {
      const noStop = { previousStop: 0, newStop: input.newStopPrice };

      const positions = yield* sql<{
        readonly size: number;
        readonly entry_price: number | null;
        readonly opened_at: number | null;
      }>`
        SELECT size, entry_price, opened_at FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${input.market} AND size != 0
      `.pipe(Effect.mapError(toPersistenceSqlError("TradingStopAdjustmentService.position")));

      const position = positions[0];
      if (position === undefined || position.entry_price === null) {
        return refuse("no_position", "this mission holds no position in this market", noStop);
      }

      const mission = yield* missions.getMission(input.missionId).pipe(Effect.orDie);
      const strategy = yield* strategies.getCurrentStrategy(input.missionId).pipe(Effect.orDie);
      // The staleness guard, re-keyed onto the plan's own `updatedAt` (plan 29
      // step 4.2): a stop asked against a plan the server has since revised is
      // refused, because the revision may itself have moved the stop. A
      // position with no plan at all has nothing to be stale against.
      if (Option.isSome(strategy) && strategy.value.updatedAt !== input.expectedPlanUpdatedAt) {
        return refuse(
          "stale_plan",
          `the plan was revised at ${strategy.value.updatedAt}; re-read it before moving the stop`,
          noStop,
        );
      }

      // The mission's runtime timeframe — the interval the mandate names, else
      // 1m. The plan stopped publishing its own `timeframes[0]` (plan 29 step
      // 4.1), so the mission is the source, same as the wakeup composer.
      const timeframe = runtimeTimeframe(mission.instruction);

      // Exchange reads refuse rather than die: a transient gateway failure is
      // "cannot measure right now", and the stop the position has is safe.
      const snapshot = yield* gateway
        .getMarketSnapshot(input.market)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (snapshot === null) {
        return refuse("market_data_unavailable", "the market snapshot could not be read", noStop);
      }
      const { bidPrice, askPrice } = snapshot.bestBidOffer;
      if (bidPrice === undefined || askPrice === undefined) {
        return refuse(
          "market_data_unavailable",
          "no two-sided book to price the new stop against",
          noStop,
        );
      }
      const markPrice = snapshot.markPrice;
      const halfSpreadUsd = (askPrice - bidPrice) / 2;

      // The stop actually resting, read from canonical open orders rather than
      // from what T3 last asked for. When several cover the position, the one
      // closest to the mark is the one that would end the trade.
      const address = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.orDie);
      const openOrders = yield* gateway
        .getOpenOrders(address)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (openOrders === null) {
        return refuse("market_data_unavailable", "open orders could not be read", noStop);
      }
      const protective = openOrders.filter((order) =>
        isProtectiveOrder(
          {
            market: order.market,
            side: order.side,
            remainingSize: order.remainingSize,
            reduceOnly: order.reduceOnly,
            isTrigger: order.isTrigger,
            triggerPrice: order.triggerPrice,
          },
          {
            market: input.market,
            positionSize: position.size,
            referencePrice: markPrice,
            openOrders: [],
          },
        ),
      );
      const currentStopPrice = protective.reduce<number | null>((nearest, order) => {
        const price = order.triggerPrice;
        if (price === undefined) return nearest;
        if (nearest === null) return price;
        return Math.abs(price - markPrice) < Math.abs(nearest - markPrice) ? price : nearest;
      }, null);
      if (currentStopPrice === null) {
        return refuse(
          "no_resting_stop",
          "no confirmed reduce-only stop is resting for this position",
          noStop,
        );
      }
      const prices = { previousStop: currentStopPrice, newStop: input.newStopPrice };

      // The server's own ATR, over the strategy's primary timeframe: the noise
      // floor and the step cap are measured on it. The agent supplies no ATR
      // any more (plan 29 step 3.5) — restating the server's number was
      // proof-of-work, not evidence.
      const history = yield* gateway
        .getMarketHistory({
          market: input.market,
          interval: timeframe,
          maxBars: VOLATILITY_LOOKBACK_BARS,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (history === null) {
        return refuse("market_data_unavailable", "candle history could not be read", prices);
      }
      const volatility = measureVolatility({
        market: input.market,
        interval: timeframe,
        candles: history.candles,
        measuredAt: history.freshness.observedAt,
      });
      const serverAtrUsd = volatility.atrUsd;
      if (!(serverAtrUsd > 0)) {
        return refuse(
          "market_data_unavailable",
          "no measurable ATR on the primary timeframe",
          prices,
        );
      }

      // The published target as a price: the same arithmetic the runtime's
      // `pnl_above` target watch fires on, read back onto the price axis. A
      // plan that names no rung (the target leg is optional now, plan 29 step
      // 4.1) has no target price to check the move against.
      const isLong = position.size > 0;
      const targetProfitUsd = Option.isSome(strategy) ? strategy.value.target.profitUsd : undefined;
      const targetPrice =
        targetProfitUsd === undefined
          ? undefined
          : position.entry_price + (isLong ? 1 : -1) * (targetProfitUsd / Math.abs(position.size));

      const openedAt = position.opened_at ?? 0;

      // The entry's approved stop — the risk envelope no adjustment may widen.
      // Scoped to THIS position (market, opened since): the first stop of the
      // mission's life belongs to whatever trade opened first, and after a
      // direction flip it can sit on the wrong side entirely — an envelope that
      // would refuse every loosening or approve any widening.
      //
      // With a minute of lead, because the record that opened the position was
      // written before the pass that noticed it: without the lead this scope
      // excludes precisely the row it exists to find, falls back to whatever
      // stop is resting, and a stop that once tightened can never move back
      // out — not even inside the approval. See ENTRY_RECORD_LEAD_MILLIS.
      const originalStopPrice = yield* sql<{ readonly stop_price: number | null }>`
        SELECT stop_price FROM trading_execution_records
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
          AND stop_price IS NOT NULL AND created_at >= ${openedAt - ENTRY_RECORD_LEAD_MILLIS}
        ORDER BY created_at ASC LIMIT 1
      `.pipe(
        Effect.mapError(toPersistenceSqlError("TradingStopAdjustmentService.envelope")),
        Effect.map((rows) => rows[0]?.stop_price ?? currentStopPrice),
      );
      const adjustments = yield* sql<{
        readonly count: number;
        readonly last_at: number | null;
      }>`
        SELECT COUNT(*) AS count, MAX(adjusted_at) AS last_at
        FROM trading_stop_adjustments
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
          AND adjusted_at >= ${openedAt}
      `.pipe(Effect.mapError(toPersistenceSqlError("TradingStopAdjustmentService.budget")));

      const spent = adjustments[0]?.count ?? 0;
      const lastAt = adjustments[0]?.last_at ?? null;
      const now = yield* Clock.currentTimeMillis;

      const refusal = checkStopAdjustment({
        positionSize: position.size,
        entryPrice: position.entry_price,
        markPrice,
        currentStopPrice,
        newStopPrice: input.newStopPrice,
        originalStopPrice,
        targetPrice,
        serverAtrUsd,
        halfSpreadUsd,
        nowMillis: now,
        barMillis: timeframeBarMillis(timeframe),
        lastAdjustmentAtMillis: lastAt ?? undefined,
        adjustmentsThisPosition: spent,
      });

      if (refusal !== null) {
        return refuse(
          refusal,
          `mark ${markPrice}, stop ${currentStopPrice} -> ${input.newStopPrice}, ` +
            `ATR ${serverAtrUsd.toFixed(4)}, ` +
            `${spent} of ${STOP_ADJUSTMENT_LIMITS.maximumAdjustmentsPerPosition} adjustments used`,
          prices,
        );
      }

      return {
        outcome: "approved",
        positionSize: position.size,
        previousStop: currentStopPrice,
        newStop: input.newStopPrice,
        stopDistanceUsd: Math.abs(markPrice - input.newStopPrice),
        plannedLossAtStopUsd: plannedLossAtStopUsd({
          positionSize: position.size,
          entryPrice: position.entry_price,
          stopPrice: input.newStopPrice,
        }),
        remainingAdjustments: Math.max(
          0,
          STOP_ADJUSTMENT_LIMITS.maximumAdjustmentsPerPosition - spent - 1,
        ),
      };
    });

  const record: TradingStopAdjustmentServiceShape["record"] = (input) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO trading_stop_adjustments (
          adjustment_id, mission_id, market, previous_stop_price, new_stop_price,
          justification, adjusted_at
        ) VALUES (
          ${id}, ${input.missionId}, ${input.market}, ${input.previousStopPrice},
          ${input.newStopPrice}, ${input.justification}, ${now}
        )
      `.pipe(Effect.mapError(toPersistenceSqlError("TradingStopAdjustmentService.record")));
    });

  return { evaluate, record } satisfies TradingStopAdjustmentServiceShape;
});

export const TradingStopAdjustmentServiceLive = Layer.effect(TradingStopAdjustmentService, make);
