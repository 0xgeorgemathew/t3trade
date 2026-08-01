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
import { EvmAddress, Price, TradingMarket, UnixMillis, UsdAmount } from "./primitives.ts";
import { FreshnessMeta, MARKET_FRESHNESS } from "./market.ts";

/** §13: account state is stale after 5 seconds during execution. */
export const ACCOUNT_FRESHNESS = {
  accountStateStaleAfterMillis: 5_000,
} as const;

/** A net position row returned by the exchange clearinghouse state. */
export const AccountPosition = Schema.Struct({
  market: TradingMarket,
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
  market: TradingMarket,
  size: Schema.Number,
  entryPrice: Price,
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

/** A canonicalised open order keyed by canonical identity. */
export const AgentOpenOrder = Schema.Struct({
  market: TradingMarket,
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
