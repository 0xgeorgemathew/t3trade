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

/**
 * A market symbol as the exchange reports it. Declared type: `string`.
 *
 * `TradingMarket` is the mandate — the one market a mission is authorized to
 * act on. A wallet's contents are not a mandate: the master wallet can hold a
 * position or a resting order in any market, left by faucet play or an earlier
 * session, and a snapshot schema that admits only "ETH" cannot represent the
 * wallet at all. One BTC position used to make the whole account snapshot
 * undecodable, which killed every wakeup that carried it.
 *
 * Use this for what the exchange reports back; use `TradingMarket` for what the
 * mission asks for.
 */
export const ExchangeMarket = TrimmedString.check(Schema.isNonEmpty());
export type ExchangeMarket = typeof ExchangeMarket.Type;

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
