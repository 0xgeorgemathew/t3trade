/**
 * `trading_look` — the one read, plan 29 step 6.1.
 *
 * Twelve read tools used to answer twelve halves of the same question, and the
 * `TradingWakeupComposer` answered all of it again, differently, on every wake.
 * They are two implementations of "what does the model need to know"; this is
 * the contract for the surviving one, and the composer is its implementation.
 *
 * A `look` is always safe to take and always returns the same shape: the market
 * as it is now, what the mission holds, what it has already done, and one line
 * of cost context. Nothing here gates anything.
 *
 * @module TradingObservation
 */
import { Schema } from "effect";

import { AgentAccountSnapshot, AgentNetPosition, AgentOpenOrder } from "./account-snapshot.ts";
import { TradingCostContext, TradingCostEstimate } from "./costs.ts";
import { TradingTradeHistory } from "./history.ts";
import { AgentMarketSnapshot, MarketHistory, OrderBook, ResolvedMarket } from "./market.ts";
import { MarketStructure } from "./marketStructure.ts";
import { MarketMicrostructure } from "./microstructure.ts";
import { TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { ObservedVolatility } from "./volatility.ts";
import { TradingGetMissionResult } from "./tools.ts";

export const TRADING_LOOK_TOOL = "trading_look";

/**
 * `market` defaults to the mission's own market. A thread with no live mission
 * may still look at a market — the read is the same answer whoever asks — and
 * gets the market half of the observation with `mission.bound: false`.
 */
export const TradingLookInput = Schema.Struct({
  missionId: Schema.optional(TradingId),
  market: Schema.optional(TradingMarket),
});
export type TradingLookInput = typeof TradingLookInput.Type;

/**
 * Everything one look answers.
 *
 * The market half is always present. The mission half is present whenever the
 * calling thread holds a live mission; `mission.bound` discriminates, and an
 * unbound look still reports the last mission the thread held rather than
 * failing, so a model whose mission just ended can read why.
 */
export const TradingObservation = Schema.Struct({
  observedAt: UnixMillis,
  market: TradingMarket,

  // -- the market, as it is now ----------------------------------------------
  //
  // Every field below is optional for one reason: a look must never fail. The
  // exchange read is the half that can, and the moment it does is exactly when
  // the model most needs to be able to read its own position and mandate. A
  // failed market read costs these fields and nothing else.
  resolvedMarket: Schema.optional(ResolvedMarket),
  snapshot: Schema.optional(AgentMarketSnapshot),
  orderBook: Schema.optional(OrderBook),
  /** The lookback window the volatility and structure reads were taken over. */
  candles: Schema.optional(MarketHistory),
  /** Fluctuation on the mission's runtime timeframe. Gross of costs. */
  volatility: Schema.optional(ObservedVolatility),
  /** The same measurement one interval up; absent on the highest interval. */
  higherTimeframeVolatility: Schema.optional(ObservedVolatility),
  /** Direction, alignment, regime, and the scored setups with their cost. */
  structure: Schema.optional(MarketStructure),
  /**
   * What the book says, as readings — plan 29 phase 7. The same value the wake
   * carries, from the same read: a look and a wake quote one book, never two.
   */
  microstructure: Schema.optional(MarketMicrostructure),
  /**
   * Why the market half is missing, when it is. Present only then, so its
   * absence is the signal that everything above was read.
   */
  marketReadFailed: Schema.optional(Schema.String),

  /**
   * The one line of cost context (plan 29 step 3.1): the round trip in USD and
   * bps at a stated reference notional. Context for whether the expected move
   * pays, never a gate. Absent only when the cost read failed.
   */
  cost: Schema.optional(TradingCostContext),
  /**
   * The round trip on the position actually held, when one is. This is what
   * banking costs; `cost` above prices a hypothetical entry instead.
   */
  positionCosts: Schema.optional(TradingCostEstimate),

  // -- what the mission holds and has done -----------------------------------
  account: Schema.optional(AgentAccountSnapshot),
  /** Flat is `size: 0`, not an absence. Absent only on an unbound look. */
  position: Schema.optional(AgentNetPosition),
  openOrders: Schema.optional(Schema.Array(AgentOpenOrder)),
  /** This mission's completed orders, newest first, with their round trips. */
  trades: Schema.optional(TradingTradeHistory),

  /** Mandate, authority, plan, watches, and pending executions. */
  mission: TradingGetMissionResult,
});
export type TradingObservation = typeof TradingObservation.Type;
