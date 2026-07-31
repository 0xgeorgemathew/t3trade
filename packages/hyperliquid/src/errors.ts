/**
 * Hyperliquid transport errors.
 *
 * Tagged errors carry enough to retry or report distinctly: a network failure
 * is retriable, a malformed payload is not, and an identity violation is a
 * programming error that must surface loudly.
 *
 * @module HyperliquidErrors
 */
import { Schema } from "effect";

/** The exchange returned a non-2xx response, or the fetch failed. */
export class HyperliquidRequestError extends Schema.TaggedErrorClass<HyperliquidRequestError>()(
  "HyperliquidRequestError",
  {
    /** The Info POST `type` or "ws_connect" for socket failures. */
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
    reason: Schema.Literals(["network", "http_error", "timeout"]),
  },
) {
  override get message(): string {
    return `HyperliquidRequestError(${this.reason}): ${this.operation} status=${this.status ?? "-"}`;
  }
}

/** The exchange returned 2xx but the body did not match the expected schema. */
export class HyperliquidDecodeError extends Schema.TaggedErrorClass<HyperliquidDecodeError>()(
  "HyperliquidDecodeError",
  {
    operation: Schema.String,
    parseError: Schema.String,
  },
) {
  override get message(): string {
    return `HyperliquidDecodeError(${this.operation}): ${this.parseError}`;
  }
}

/**
 * The master-wallet identity rule was violated (§10.6).
 *
 * Account state must be queried with the user-owned master-wallet address.
 * This fires if a caller tries to pass the execution-wallet address as account
 * identity. It is a programming error, not a retriable condition.
 */
export class HyperliquidIdentityError extends Schema.TaggedErrorClass<HyperliquidIdentityError>()(
  "HyperliquidIdentityError",
  {
    address: Schema.String,
    reason: Schema.Literals(["execution_wallet_as_identity", "unbound_address"]),
  },
) {
  override get message(): string {
    return `HyperliquidIdentityError(${this.reason}): ${this.address}`;
  }
}

/** A market symbol could not be resolved from live metadata. */
export class HyperliquidMarketError extends Schema.TaggedErrorClass<HyperliquidMarketError>()(
  "HyperliquidMarketError",
  {
    symbol: Schema.String,
    reason: Schema.Literals(["not_found", "unavailable"]),
  },
) {
  override get message(): string {
    return `HyperliquidMarketError(${this.reason}): ${this.symbol}`;
  }
}
