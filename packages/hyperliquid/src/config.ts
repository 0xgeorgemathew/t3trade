/**
 * Hyperliquid transport configuration.
 *
 * The POC targets testnet only (TradingEnvironment = "hyperliquid_testnet").
 * Endpoints are values, not operator knobs: the Info and WS URLs are a matched
 * pair from the same environment. Overriding them is a dev/test affordance
 * (fixtures point at a local recorder), not a runtime choice.
 *
 * @module HyperliquidConfig
 */
import { Context } from "effect";

/** Testnet endpoints. Mainnet is out of scope for the POC. */
export const TESTNET_ENDPOINTS = {
  infoHttpUrl: "https://api.hyperliquid-testnet.xyz/info",
  webSocketUrl: "wss://api.hyperliquid-testnet.xyz/ws",
} as const;

export type HyperliquidEndpoints = typeof TESTNET_ENDPOINTS;

/**
 * Transport configuration reference.
 *
 * Provided as a `Context.Reference` so the default is the testnet pair and
 * tests/dev can override via `Layer.succeed` without threading arguments. The
 * master-wallet address is intentionally NOT here: account identity is a
 * per-call argument to the gateway, not transport config (§10.6 identity rule).
 */
export const HyperliquidEndpoints = Context.Reference<HyperliquidEndpoints>(
  "t3/hyperliquid/HyperliquidEndpoints",
  {
    defaultValue: () => TESTNET_ENDPOINTS,
  },
);
