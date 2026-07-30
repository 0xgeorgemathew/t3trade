/**
 * Trading account - spec §10.1.
 *
 * One user-owned master wallet plus one Privy-managed execution wallet. The
 * execution wallet signs actions; Hyperliquid account state is always queried
 * with the master-wallet address.
 *
 * @module TradingAccount
 */
import { Schema } from "effect";
import { EvmAddress, TradingId, UnixMillis } from "./primitives.ts";

export const TradingEnvironment = Schema.Literal("hyperliquid_testnet");
export type TradingEnvironment = typeof TradingEnvironment.Type;

export const TradingExecutionWalletStatus = Schema.Literals([
  "creating",
  "awaiting_approval",
  "approved",
  "revoked",
  "error",
]);
export type TradingExecutionWalletStatus = typeof TradingExecutionWalletStatus.Type;

export const TradingAccountStatus = Schema.Literals([
  "onboarding",
  "ready",
  "agent_revoked",
  "account_unavailable",
  "error",
]);
export type TradingAccountStatus = typeof TradingAccountStatus.Type;

export const TradingMasterWallet = Schema.Struct({
  privyWalletId: TradingId,
  address: EvmAddress,
  ownership: Schema.Literal("user"),
});
export type TradingMasterWallet = typeof TradingMasterWallet.Type;

export const TradingExecutionWallet = Schema.Struct({
  privyWalletId: TradingId,
  address: EvmAddress,
  hyperliquidAgentName: Schema.String,
  status: TradingExecutionWalletStatus,
  approvedAt: Schema.optional(UnixMillis),
});
export type TradingExecutionWallet = typeof TradingExecutionWallet.Type;

export const TradingAccount = Schema.Struct({
  id: TradingId,
  userId: TradingId,
  environment: TradingEnvironment,

  masterWallet: TradingMasterWallet,
  executionWallet: TradingExecutionWallet,

  status: TradingAccountStatus,

  createdAt: UnixMillis,
  updatedAt: UnixMillis,
});
export type TradingAccount = typeof TradingAccount.Type;
