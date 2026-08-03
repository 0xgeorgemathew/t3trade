/**
 * Account-read contracts - spec §10.6 (un-pinned, first implemented here) + §13.
 *
 * Like `market.ts`, these field lists are the pin: the spec references
 * `AgentAccountSnapshot` as "account value, margin used, withdrawable, and
 * positions for the master-wallet address" but leaves structure to the phase
 * that implements it. Phase 2 is that phase.
 *
 * Identity rule (§10.6, load-bearing): account state is queried with the
 * user-owned **master-wallet** address. The Privy-managed execution-wallet
 * address signs actions but is never used as account identity. The gateway
 * enforces this; the contract models it by taking `address` as the master
 * wallet and never naming the execution wallet here.
 *
 * @module AccountReads
 */
import { Schema } from "effect";
import {
  EvmAddress,
  ExchangeMarket,
  Price,
  TradingMarket,
  UnixMillis,
  UsdAmount,
} from "./primitives.ts";
import { FreshnessMeta, MARKET_FRESHNESS } from "./market.ts";

/** §13: account state is stale after 5 seconds during execution. */
export const ACCOUNT_FRESHNESS = {
  accountStateStaleAfterMillis: 5_000,
} as const;

/**
 * A net position row returned by the exchange clearinghouse state.
 *
 * The clearinghouse reports the whole wallet, so `market` is whatever the
 * exchange named — not necessarily the mission's mandate.
 */
export const AccountPosition = Schema.Struct({
  market: ExchangeMarket,
  /** Signed net size; positive long, negative short, in base units. */
  size: Schema.Number,
  /** Average entry price. */
  entryPrice: Price,
  /** Unrealised PnL in USD. */
  unrealisedPnl: Schema.Number,
  /** Accumulated funding in USD; may be negative. */
  cumulativeFunding: Schema.Number,
  /** Margin allocated to this position in USD. */
  marginUsed: UsdAmount,
  /** Exchange liquidation price, when the exchange reports one. */
  liquidationPx: Schema.optional(Price),
});
export type AccountPosition = typeof AccountPosition.Type;

/**
 * Canonical net position for the traded asset - spec §10.6 / §14.2.
 *
 * The harness asks `trading_get_position` for one position; this is that view.
 * `size` is signed so the harness sees direction without inferring it.
 */
export const AgentNetPosition = Schema.Struct({
  /** Echoes the market that was asked for, as the exchange spells it. */
  market: ExchangeMarket,
  size: Schema.Number,
  /**
   * Absent when the account is flat.
   *
   * `AccountPosition` can require a `Price` because a row only exists while a
   * position does. This view also has to model "no position", which is a
   * legitimate answer rather than an error — and a flat account has no entry
   * price to report. Reporting `0` instead is what a `Price` refuses.
   */
  entryPrice: Schema.optional(Price),
  unrealisedPnl: Schema.Number,
  cumulativeFunding: Schema.Number,
  marginUsed: UsdAmount,
  freshness: FreshnessMeta,
});
export type AgentNetPosition = typeof AgentNetPosition.Type;

/**
 * Canonical account state for the master-wallet address - spec §10.6.
 *
 * `address` is always the master wallet (§10.6 identity rule). Freshness uses
 * the §13 5s account window.
 */
export const AgentAccountSnapshot = Schema.Struct({
  address: EvmAddress,
  /** Total account equity in USD. */
  accountValue: UsdAmount,
  /** Margin currently in use across all positions. */
  marginUsed: UsdAmount,
  /** Available collateral that could be withdrawn. */
  withdrawable: UsdAmount,
  positions: Schema.Array(AccountPosition),
  freshness: FreshnessMeta,
});
export type AgentAccountSnapshot = typeof AgentAccountSnapshot.Type;

/**
 * A canonicalised open order keyed by canonical identity.
 *
 * Open orders are read per wallet, not per market, so `market` carries whatever
 * the exchange reported. Callers acting on an order must filter by the mission's
 * market first — an order in another market is not this mission's to touch.
 */
export const AgentOpenOrder = Schema.Struct({
  market: ExchangeMarket,
  /** Exchange-assigned order id. */
  orderId: Schema.Number,
  /** Client order id, when supplied. */
  cloid: Schema.optional(Schema.String),
  side: Schema.Literals(["buy", "sell"]),
  limitPrice: Price,
  size: Schema.Number.check(Schema.isGreaterThan(0)),
  /** Remaining size after partial fills. */
  remainingSize: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Exchange order status, verbatim. */
  status: Schema.String,
  createdAt: UnixMillis,

  // -- protective-order detail (§17.2 step 7) --------------------------------
  //
  // An order is protection only if all three hold: reduce-only, a trigger, and
  // a trigger price on the losing side of the position. Defaulted to the
  // conservative reading (`false` / absent) so an order the exchange did not
  // describe is never counted as protection.

  /** True when the order may only reduce an existing position. */
  reduceOnly: Schema.Boolean,
  /** True when the order is a stop/take-profit trigger rather than a limit. */
  isTrigger: Schema.Boolean,
  /** Trigger price, when this is a trigger order. */
  triggerPrice: Schema.optional(Price),
  /** Exchange order-type label, verbatim (e.g. "Stop Market"). */
  orderType: Schema.optional(Schema.String),
});
export type AgentOpenOrder = typeof AgentOpenOrder.Type;

/** Freshness stamp for an account read (§13: 5s window). */
export const accountFreshness = (
  observedAt: UnixMillis,
  source: "info_api" | "websocket" | "reconciled",
): FreshnessMeta => ({
  observedAt,
  source,
  staleAfterMillis: ACCOUNT_FRESHNESS.accountStateStaleAfterMillis,
});
