// @effect-diagnostics nodeBuiltinImport:off - checked-in fixture data, read
// synchronously at load; an Effect FileSystem here would put a service
// requirement on what is a constant.
/**
 * The 2026-08-13 ETH window as replay fixtures — plan 27 D1.
 *
 * This is the morning the stop-out review was written about: the grind lower
 * from ~06:00 UTC, three boundary entries that failed, then the breakdown.
 * The candles are the testnet feed's own record (the venue the missions
 * trade), fetched once and checked in under `replay-fixtures/`, so every
 * replay of this window is the same replay — a threshold argued from it can
 * be re-argued from it later, byte for byte.
 *
 * Four intervals, each cut into (history, forward) pairs per the replay
 * contract: the setup finder sees history and stops, the outcome settles on
 * bars it never saw. History runs long enough before 06:00 that the earliest
 * decisions inside the window still have a full momentum lookback behind
 * them.
 *
 * @module TradingReplayWindow20260813
 */
import * as NodeFS from "node:fs";

import type { MarketCandle, MarketCandleInterval } from "@t3tools/trading-contracts/market";
import type { ReplayFixture, ReplaySessionState } from "@t3tools/trading-contracts/replay";

import { cutReplayFixtures } from "./TradingReplayFixtures.ts";

/** One candle as the exchange wire serves it (prices as strings). */
interface WireCandle {
  readonly t: number;
  readonly T: number;
  readonly o: string;
  readonly c: string;
  readonly h: string;
  readonly l: string;
  readonly v: string;
  readonly n: number;
}

const toCandle = (wire: WireCandle): MarketCandle => ({
  openTime: wire.t,
  closeTime: wire.T,
  open: Number(wire.o),
  close: Number(wire.c),
  high: Number(wire.h),
  low: Number(wire.l),
  volume: Number(wire.v),
  trades: wire.n,
});

/** The recorded candles for one interval of the window, oldest first. */
export function loadWindowCandles(
  interval: MarketCandleInterval & ("1m" | "5m" | "15m" | "1h"),
): ReadonlyArray<MarketCandle> {
  const path = new URL(`./replay-fixtures/eth-${interval}-2026-08-13.json`, import.meta.url);
  const wire = JSON.parse(NodeFS.readFileSync(path, "utf8")) as ReadonlyArray<WireCandle>;
  return wire.map(toCandle);
}

/**
 * The costs every fixture is priced at: a $1,000 entry (the test wallet's 1x
 * capital) paying the 5 bps fallback taker fee each way, plus half a dollar
 * for the spread. Flat across the set on purpose — the book that priced a
 * round trip that morning is not readable now, and a flat honest cost keeps
 * the V1-vs-candidate comparison fair, which is the only comparison a replay
 * is for.
 */
export const WINDOW_NOTIONAL_USD = 1_000;
export const WINDOW_ROUND_TRIP_COST_USD = 1.5;

/** Mid-session, no losing streak: the state the morning's entries were taken in. */
const SESSION: ReplaySessionState = {
  minutesRemaining: 90,
  consecutiveNetLosses: 0,
  minutesSinceLastLoss: null,
};

interface WindowCut {
  readonly interval: "1m" | "5m" | "15m" | "1h";
  readonly historyBars: number;
  readonly forwardBars: number;
}

/**
 * History long enough for a full 120-bar momentum read, forward long enough
 * to settle a scalp on that interval. Stride defaults to the forward length,
 * so consecutive outcomes are disjoint.
 */
const CUTS: ReadonlyArray<WindowCut> = [
  { interval: "1m", historyBars: 240, forwardBars: 20 },
  { interval: "5m", historyBars: 120, forwardBars: 12 },
  { interval: "15m", historyBars: 96, forwardBars: 8 },
  { interval: "1h", historyBars: 120, forwardBars: 4 },
];

/**
 * Every fixture the window yields for one playbook.
 *
 * Both playbooks that traded (or should have traded) that morning are worth
 * replaying: `momentum` is what the breakdown rewarded, `range_reversion` is
 * what the three boundary failures punished.
 */
export function windowFixtures(playbook: ReplayFixture["playbook"]): ReadonlyArray<ReplayFixture> {
  return CUTS.flatMap((cut) =>
    cutReplayFixtures(loadWindowCandles(cut.interval), {
      interval: cut.interval,
      historyBars: cut.historyBars,
      forwardBars: cut.forwardBars,
      notionalUsd: WINDOW_NOTIONAL_USD,
      roundTripCostUsd: WINDOW_ROUND_TRIP_COST_USD,
      playbook,
      session: SESSION,
      label: `eth-${cut.interval}-2026-08-13-${playbook}`,
    }),
  );
}
