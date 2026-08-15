/**
 * TradingCostEstimator - what a round trip on this market actually costs.
 *
 * The arithmetic lives in `@t3tools/trading-contracts/costs` and is pure. This
 * service is only the reads it needs: the master wallet's taker and maker fee
 * rates, the order book, and the mark. It resolves the fee rate the same way
 * `TradingMissionReactor` does before a preview — `userFees`, falling back to
 * the authority's `fallbackTakerFeeBpsPerSide` — so the number the harness is
 * shown and the number the loss budget reserves against cannot drift apart.
 *
 * A failed fee read degrades the estimate rather than failing it: the fallback
 * rate is the same one the preview would have used, and an agent that gets no
 * answer at all goes back to guessing, which is the failure this exists to fix.
 * A failed mark or book read has no such fallback, and fails typed
 * ({@link TradingCostDataUnavailableError}) so the tool boundary can refuse in
 * terms the harness can read.
 *
 * @module TradingCostEstimator
 */
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { estimateTradingCosts, type TradingCostEstimate } from "@t3tools/trading-contracts/costs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface EstimateCostsInput {
  readonly market: string;
  /** The master wallet, for the fee-rate read. */
  readonly masterAddress: `0x${string}`;
  /** Position size in base units. Takes precedence over `notionalUsd`. */
  readonly sizeEth?: number | undefined;
  /** Position size in USD, converted at the mark when `sizeEth` is absent. */
  readonly notionalUsd?: number | undefined;
  /** The authority's fee rate, used when `userFees` cannot be read. */
  readonly fallbackTakerFeeBpsPerSide: number;
}

/**
 * The mark and the book could not be read, so there is no round trip to price.
 *
 * These two reads used to be `.orDie`: a transient gateway failure became a
 * defect, and the harness saw an opaque tool-call crash where it should have
 * seen a refusal it could act on. The fee read is different — it has a
 * fallback, so it degrades rather than fails.
 */
export interface TradingCostDataUnavailableError {
  readonly _tag: "TradingCostDataUnavailableError";
  readonly market: string;
  readonly cause: unknown;
}

export interface TradingCostEstimatorShape {
  readonly estimate: (
    input: EstimateCostsInput,
  ) => Effect.Effect<TradingCostEstimate, TradingCostDataUnavailableError, HyperliquidGateway>;
}

export class TradingCostEstimator extends Context.Service<
  TradingCostEstimator,
  TradingCostEstimatorShape
>()("t3/trading/TradingCostEstimator") {}

const make = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;

  const estimate: TradingCostEstimatorShape["estimate"] = (input) =>
    Effect.gen(function* () {
      const [snapshot, book] = yield* Effect.all(
        [gateway.getMarketSnapshot(input.market), gateway.getOrderBook(input.market)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause): TradingCostDataUnavailableError => ({
            _tag: "TradingCostDataUnavailableError",
            market: input.market,
            cause,
          }),
        ),
      );

      // `userFees` is a network read that can fail on its own; the rest of the
      // estimate is still worth having when it does. A maker rate the gateway
      // could not read is dropped rather than passed through, so the estimate
      // prices the maker combinations at the taker rate and says so in its
      // notes instead of passing an assumption off as a read. The same applies
      // on the authority fallback, where the fallback names one (taker) rate.
      const fee = yield* gateway.getUserFeeRatesBps(input.masterAddress).pipe(
        Effect.map((read) => ({
          takerBps: read.takerFeeBps,
          makerBps:
            read.makerRateSource === "assumed_equal_to_taker" ? undefined : read.makerFeeBps,
          source: "hyperliquid_user_fees" as const,
        })),
        Effect.orElseSucceed(() => ({
          takerBps: input.fallbackTakerFeeBpsPerSide,
          makerBps: undefined,
          source: "authority_fallback" as const,
        })),
      );

      // Size in base units is what the book is walked for, so a notional-only
      // request is converted at the mark before anything else happens.
      const sizeEth =
        input.sizeEth ??
        (input.notionalUsd === undefined ? 0 : input.notionalUsd / snapshot.markPrice);

      return estimateTradingCosts({
        market: input.market,
        sizeEth,
        referencePrice: snapshot.markPrice,
        takerFeeBpsPerSide: fee.takerBps,
        makerFeeBpsPerSide: fee.makerBps,
        feeRateSource: fee.source,
        bids: book.bids,
        asks: book.asks,
        fundingRatePer8h: snapshot.fundingRate8h,
        measuredAt: book.freshness.observedAt,
        freshness: book.freshness,
      });
    });

  return { estimate } satisfies TradingCostEstimatorShape;
});

export const TradingCostEstimatorLive = Layer.effect(TradingCostEstimator, make);
