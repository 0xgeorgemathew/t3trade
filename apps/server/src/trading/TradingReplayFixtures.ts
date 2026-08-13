/**
 * Turning bars the exchange served into fixtures a policy can be replayed over.
 *
 * `replayPolicy` is pure and takes fixtures; this is where the fixtures come
 * from. One long candle window is cut into many overlapping (history, forward)
 * pairs, so a single 500-bar read produces dozens of independent decisions
 * rather than one — which is the difference between a replay whose verdict
 * means something and one that is a single anecdote with arithmetic on it.
 *
 * The cut is the whole point: the setup finder sees `historyBars` and stops,
 * and the outcome comes from the `forwardBars` after them. Nothing here lets a
 * fixture see its own answer.
 *
 * The cost figure is supplied by the caller rather than measured per window,
 * because the book that priced a round trip an hour ago is not readable now.
 * A flat, honest cost across the set keeps the comparison between two policies
 * fair, which is the only comparison a replay is for.
 *
 * @module TradingReplayFixtures
 */
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { MarketCandle, MarketCandleInterval } from "@t3tools/trading-contracts/market";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";
import type { ReplayFixture } from "@t3tools/trading-contracts/replay";
import * as Effect from "effect/Effect";

export interface FixtureCutOptions {
  readonly interval: MarketCandleInterval;
  /** Bars the setup is read from. At least `MIN_MOMENTUM_BARS` to be readable. */
  readonly historyBars: number;
  /** Bars the outcome is settled on. */
  readonly forwardBars: number;
  /**
   * Bars between one fixture's start and the next.
   *
   * Overlapping windows are not independent samples, so a stride well under
   * `historyBars` inflates the count without adding evidence. Defaults to the
   * forward length, which makes each fixture's outcome disjoint from the last.
   */
  readonly strideBars?: number;
  readonly notionalUsd: number;
  readonly roundTripCostUsd: number;
  /** The live playbook this recorded window is meant to replay. */
  readonly playbook: ReplayFixture["playbook"];
  /** Standing-rule facts at each cut. Required so session gates are replayed. */
  readonly session: ReplayFixture["session"];
  /** Required only for opening-range fixtures; defaults to 20 in evaluation. */
  readonly openingRangeBars?: number | undefined;
  /** Prefix for fixture names, so a report says which window it came from. */
  readonly label: string;
}

/**
 * Cut one candle series into fixtures.
 *
 * Windows that would run off the end of the series are dropped rather than
 * shortened: a fixture with two forward bars settles almost nothing and would
 * fill the report with `open`.
 */
export function cutReplayFixtures(
  candles: ReadonlyArray<MarketCandle>,
  options: FixtureCutOptions,
): ReadonlyArray<ReplayFixture> {
  const stride = Math.max(1, options.strideBars ?? options.forwardBars);
  const span = options.historyBars + options.forwardBars;
  const fixtures: Array<ReplayFixture> = [];

  for (let start = 0; start + span <= candles.length; start += stride) {
    const cut = start + options.historyBars;
    fixtures.push({
      name: `${options.label}#${start}`,
      interval: options.interval,
      history: candles.slice(start, cut),
      forward: candles.slice(cut, start + span),
      notionalUsd: options.notionalUsd,
      roundTripCostUsd: options.roundTripCostUsd,
      playbook: options.playbook,
      session: options.session,
      ...(options.openingRangeBars === undefined
        ? {}
        : { openingRangeBars: options.openingRangeBars }),
    });
  }

  return fixtures;
}

/**
 * Read a market's recent history and cut it into fixtures.
 *
 * Bounded by the §13 cap of 500 bars per read, so this is a window of hours on
 * 1m and days on 1h. A larger sample means several calls across different
 * sessions, which is the right way to get one anyway — a replay over one
 * afternoon is a replay of one afternoon's regime.
 */
export const collectReplayFixtures = Effect.fn("trading.collectReplayFixtures")(function* (input: {
  readonly market: TradingMarket;
  readonly maxBars?: number;
  readonly cut: FixtureCutOptions;
}) {
  const gateway = yield* HyperliquidGateway;
  const history = yield* gateway.getMarketHistory({
    market: input.market,
    interval: input.cut.interval,
    ...(input.maxBars === undefined ? {} : { maxBars: input.maxBars }),
  });
  return cutReplayFixtures(history.candles, input.cut);
});
