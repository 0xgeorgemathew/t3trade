/**
 * Shared primitive schemas for the trading domain.
 *
 * The published contracts on the T3 Trades spec site declare plain `string` and
 * `number` for identifiers, timestamps, and money. These primitives preserve
 * those declared types exactly and only add runtime validation that the spec
 * already implies (non-empty identifiers, non-negative epoch millis, positive
 * money and leverage).
 *
 * @module TradingPrimitives
 */
import { Effect, Schema, SchemaTransformation } from "effect";

const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

/** A durable record identifier. Declared type: `string`. */
export const TradingId = TrimmedString.check(Schema.isNonEmpty());
export type TradingId = typeof TradingId.Type;

/** Free-form narrative supplied by the harness. Declared type: `string`. */
export const TradingText = Schema.String;
export type TradingText = typeof TradingText.Type;

/** Epoch milliseconds. Declared type: `number`. */
export const UnixMillis = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export type UnixMillis = typeof UnixMillis.Type;

/** A USD amount that may be zero. Declared type: `number`. */
export const UsdAmount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export type UsdAmount = typeof UsdAmount.Type;

/** A USD amount that must be strictly positive. Declared type: `number`. */
export const PositiveUsdAmount = Schema.Number.check(Schema.isGreaterThan(0));
export type PositiveUsdAmount = typeof PositiveUsdAmount.Type;

/** A price quoted by the exchange. Declared type: `number`. */
export const Price = Schema.Number.check(Schema.isGreaterThan(0));
export type Price = typeof Price.Type;

/**
 * An EVM address. Declared type: `` `0x${string}` `` — modeled as a template
 * literal so the runtime schema matches the published type rather than
 * widening it to `string`.
 */
export const EvmAddress = Schema.TemplateLiteral(["0x", Schema.String]);
export type EvmAddress = typeof EvmAddress.Type;

/** The single POC market. Declared type: `"ETH"`. */
export const TradingMarket = Schema.Literal("ETH");
export type TradingMarket = typeof TradingMarket.Type;
