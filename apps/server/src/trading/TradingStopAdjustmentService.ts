/**
 * TradingStopAdjustmentService - the evidence behind `trading_adjust_stop`.
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
import { isProtectiveOrder } from "@t3tools/trading-contracts/protection";
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
import { POC_DEFAULT_TIMEFRAME } from "@t3tools/trading-contracts/strategy";
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
    readonly observedAtrUsd: number;
    readonly expectedVersion: number;
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
      if (mission.strategyVersion !== input.expectedVersion) {
        return refuse(
          "stale_strategy_version",
          `the current strategy version is ${mission.strategyVersion}`,
          noStop,
        );
      }

      const strategy = yield* strategies.getCurrentStrategy(input.missionId).pipe(Effect.orDie);
      const timeframe = Option.isSome(strategy)
        ? (strategy.value.timeframes[0] ?? POC_DEFAULT_TIMEFRAME)
        : POC_DEFAULT_TIMEFRAME;

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

      // The server's own ATR, over the strategy's primary timeframe. The
      // agent's number is cross-checked against this, never substituted for it.
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
      // `pnl_above` target watch fires on, read back onto the price axis.
      const isLong = position.size > 0;
      const targetPrice = Option.isSome(strategy)
        ? position.entry_price +
          (isLong ? 1 : -1) * (strategy.value.protection.targetProfitUsd / Math.abs(position.size))
        : undefined;

      const openedAt = position.opened_at ?? 0;

      // The entry's approved stop — the risk envelope no adjustment may widen.
      // Scoped to THIS position (market, opened since): the first stop of the
      // mission's life belongs to whatever trade opened first, and after a
      // direction flip it can sit on the wrong side entirely — an envelope that
      // would refuse every loosening or approve any widening.
      const originalStopPrice = yield* sql<{ readonly stop_price: number | null }>`
        SELECT stop_price FROM trading_execution_records
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
          AND stop_price IS NOT NULL AND created_at >= ${openedAt}
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
        observedAtrUsd: input.observedAtrUsd,
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
            `ATR ${serverAtrUsd.toFixed(4)} (server) vs ${input.observedAtrUsd} (observed), ` +
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
