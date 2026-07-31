/**
 * @t3tools/hyperliquid — testnet transport for the T3 Trades POC.
 *
 * Effect-based Info (HTTP) and WebSocket clients for Hyperliquid testnet, plus
 * the wire schemas and tagged transport errors. Nothing here signs or mutates
 * exchange state — Phase 2 is the read path only.
 *
 * The market resolver, precision normaliser, and read gateway are added by
 * Steps 2–4 and re-exported here as they land.
 *
 * @module HyperliquidPackage
 */
export * from "./config.ts";
export * from "./errors.ts";
export * from "./wire.ts";
export * from "./InfoClient.ts";
export * from "./WebSocketClient.ts";
export * from "./MarketResolver.ts";
export * from "./Precision.ts";
export * from "./Gateway.ts";
