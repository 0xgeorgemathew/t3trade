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
import { TradingTimeframe } from "./strategy.ts";
import { ObservedVolatility } from "./volatility.ts";
import { TradingGetMissionResult } from "./tools.ts";

export const TRADING_LOOK_TOOL = "trading_look";

/**
 * The parts of a look, so a turn can ask for the one it needs.
 *
 * The full read answers what twelve tools used to and is the right shape for
 * an assessment turn. It is the wrong shape for a reaction: a run woken by a
 * fired level wants the last few bars, or the position, or the structure — and
 * paying for the account, the trade history and a multi-timeframe structure
 * read to get one of them is how a mission's context fills up in a handful of
 * wakes.
 *
 * - `market`: the resolved market, the snapshot, the book, microstructure.
 * - `candles`: recent bars and the volatility measured on them.
 * - `structure`: the multi-timeframe read with its scored `candidates[]`.
 * - `position`: what is held, the account behind it, resting orders, and what
 *   closing it costs.
 * - `mission`: mandate, authority, plan, watches, pending executions.
 * - `retrospect`: what the mission has BELIEVED — plan history, journal,
 *   target calibration. Split out of `mission` because it is the half that
 *   grows: a turn reacting to a level that just fired was paying for its own
 *   back-catalogue on every read.
 * - `trades`: this mission's completed orders and round trips.
 */
export const TradingLookScope = Schema.Literals([
  "market",
  "candles",
  "structure",
  "position",
  "mission",
  "retrospect",
  "trades",
]);
export type TradingLookScope = typeof TradingLookScope.Type;

/** Every scope, which is what an omitted `scope` means. */
export const TRADING_LOOK_SCOPES: ReadonlyArray<TradingLookScope> = [
  "market",
  "candles",
  "structure",
  "position",
  "mission",
  "retrospect",
  "trades",
];

/**
 * The most bars a scoped candle read will return.
 *
 * The cap is the schema's, not the caller's: a bounded response is the point,
 * and a bound the model can raise is not a bound. Above this the answer is a
 * chart, and a chart is not something to put in a context window.
 */
export const TRADING_LOOK_MAX_BARS = 200;

/**
 * `market` defaults to the mission's own market. A thread with no live mission
 * may still look at a market — the read is the same answer whoever asks — and
 * gets the market half of the observation with `mission.bound: false`.
 */
export const TradingLookInput = Schema.Struct({
  missionId: Schema.optional(TradingId),
  market: Schema.optional(TradingMarket),
  /**
   * Which parts to read. Omit for all of them — the assessment read. Name one
   * or two to answer a specific question cheaply.
   */
  scope: Schema.optional(Schema.Array(TradingLookScope)),
  /** The bar interval for the `candles` scope. Defaults to the mission's own. */
  interval: Schema.optional(TradingTimeframe),
  /**
   * How many bars the `candles` scope returns, newest last. Clamped to
   * {@link TRADING_LOOK_MAX_BARS}; omitted returns the volatility lookback the
   * measurements were taken over.
   */
  bars: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: TRADING_LOOK_MAX_BARS }),
    ),
  ),
});
export type TradingLookInput = typeof TradingLookInput.Type;

/** The scopes this call asks for — every one, when it named none. */
export function resolveLookScopes(
  input: Pick<TradingLookInput, "scope">,
): ReadonlySet<TradingLookScope> {
  return new Set(
    input.scope === undefined || input.scope.length === 0 ? TRADING_LOOK_SCOPES : input.scope,
  );
}

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
