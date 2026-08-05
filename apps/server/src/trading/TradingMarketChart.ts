/**
 * TradingMarketChart — the chart surface's combined snapshot + candle read.
 *
 * The chart needs two things the exchange owns: the OHLC series a candle pane is
 * drawn from, and the mark/funding/OI/volume/change figures its header and
 * footer rows quote. Reading them as two separate RPCs would let the chart
 * render a price series against a stale header any time the two reads raced, so
 * this service fetches both in one effect and returns a single
 * `TradingMarketChartView` the surface can project atomically.
 *
 * The pair is cached for a few seconds because the chart is polled on a fixed
 * cadence: without the window every open workspace would put its own pair of
 * Hyperliquid calls on the wire on every poll, for figures that barely move in
 * that window. The TTL stays well under the candle poll so a polling client
 * still sees a fresh series each time, while concurrent clients share one read.
 *
 * A failed read yields `null`, never a stale or invented chart. If either the
 * snapshot or the history call fails, the whole read yields `null` and nothing
 * is written to cache — a chart the exchange did not just confirm is worse than
 * no chart at all on a surface an operator makes exit decisions from.
 *
 * @module TradingMarketChart
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { TradingMarketChartView } from "@t3tools/contracts";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";

export interface TradingMarketChartShape {
  /** The market's chart view, or null when either exchange read failed. */
  readonly read: (
    market: string,
    interval: "1m" | "3m" | "5m" | "15m" | "1h",
    maxBars: number,
  ) => Effect.Effect<TradingMarketChartView | null>;
}

export class TradingMarketChart extends Context.Service<
  TradingMarketChart,
  TradingMarketChartShape
>()("t3/trading/TradingMarketChart") {}

/**
 * How long a chart view is served from memory before the exchange is asked
 * again. The candle poll runs every 15s; this 5s window is short enough that a
 * polling client still sees a fresh series each poll, and long enough that
 * several clients polling at once collapse onto a single pair of reads.
 */
const CACHE_WINDOW_MS = 5_000;

interface CachedChart {
  readonly view: TradingMarketChartView;
  readonly readAt: number;
}

export const makeTradingMarketChart = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;
  const cache = yield* Ref.make(new Map<string, CachedChart>());

  const read = (
    market: string,
    interval: "1m" | "3m" | "5m" | "15m" | "1h",
    maxBars: number,
  ): Effect.Effect<TradingMarketChartView | null> =>
    Effect.gen(function* () {
      const key = `${market}:${interval}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(key);
      if (cached !== undefined && now - cached.readAt < CACHE_WINDOW_MS) return cached.view;

      // Both reads degrade to null on failure; if either yields null the whole
      // read yields null and nothing is cached (a half-populated chart lies).
      const snapshot = yield* gateway.getMarketSnapshot(market).pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("trading chart snapshot read failed", { market, cause }),
        ),
        Effect.orElseSucceed(() => null),
      );
      const history = yield* gateway
        .getMarketHistory({ market: market as TradingMarket, interval, maxBars })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logDebug("trading chart history read failed", { market, interval, cause }),
          ),
          Effect.orElseSucceed(() => null),
        );
      if (snapshot === null || history === null) return null;

      const view: TradingMarketChartView = {
        market,
        interval,
        candles: history.candles.map((candle) => ({
          openTime: candle.openTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
        markPrice: snapshot.markPrice,
        change24hPercent: snapshot.change24hPercent,
        fundingRate8h: snapshot.fundingRate8h,
        openInterest: snapshot.openInterest,
        dayVolumeUsd: snapshot.dayVolumeUsd,
        observedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.freshness.observedAt)),
      };
      yield* Ref.update(cache, (entries) => new Map(entries).set(key, { view, readAt: now }));
      return view;
    });

  return TradingMarketChart.of({ read });
});

export const TradingMarketChartLive = Layer.effect(TradingMarketChart, makeTradingMarketChart);
