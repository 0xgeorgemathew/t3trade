import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TradingMarketChartView } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

/** Candle intervals the `getTradingMarketChart` RPC accepts. */
export type ChartInterval = "1m" | "3m" | "5m" | "15m" | "1h";

/**
 * A closed candle window, in epoch millis.
 *
 * Passing one turns the read into the post-mortem chart of a finished trade:
 * the server serves that span instead of the latest bars, and the client stops
 * polling (a closed window cannot change).
 */
export interface ChartWindow {
  readonly startTime: number;
  readonly endTime: number;
}

function tradingMarketChartAtom(
  environmentId: EnvironmentId,
  market: string,
  interval: ChartInterval,
  window: ChartWindow | null,
) {
  return orchestrationEnvironment.tradingMarketChart({
    environmentId,
    input:
      window === null
        ? { market, interval }
        : { market, interval, startTime: window.startTime, endTime: window.endTime },
  });
}

export function refreshTradingMarketChart(
  environmentId: EnvironmentId,
  market: string,
  interval: ChartInterval,
  window: ChartWindow | null = null,
): void {
  appAtomRegistry.refresh(tradingMarketChartAtom(environmentId, market, interval, window));
}

/**
 * How often a mounted chart re-reads the projection.
 *
 * The chart is pull-only: no server push invalidates it, so without a poll a
 * moved price stays frozen at whatever the first read returned. Fifteen seconds
 * is the plan's cadence — slow enough that a flat mission (no open position)
 * puts nothing on the wire, since the poll itself is gated on `enabled`, fast
 * enough that a held position sees a fresh candle within one bar at the widest
 * interval (`1h`).
 */
const CHART_POLL_INTERVAL_MS = 15_000;

/**
 * The atom type returned by the live chart family. The disabled sentinel must
 * match this type exactly so the two branches of the `useMemo` below unify.
 */
type TradingMarketChartAtom = ReturnType<typeof tradingMarketChartAtom>;

/**
 * The sentinel atom returned while the chart is disabled (`market` is null or
 * the caller reports no open position).
 *
 * It holds an `Initial` result — a non-success state — so
 * `Option.getOrNull(AsyncResult.value(result))` yields `null` and the hook
 * returns `{ data: null, error: null, isLoading: false }`. Crucially the polling
 * effect never starts, so nothing is read off the wire. (Putting the sentinel in
 * a success state with a `null` value would be wrong: the live family's success
 * type is the non-null `TradingMarketChartView`, so the two atom value types
 * would not unify.)
 *
 * Why a real atom rather than a branch around `useAtomValue`: React's
 * rules-of-hooks require the same hook calls in the same order every render.
 * Selecting between this atom and the live family atom inside `useMemo` keeps
 * `useAtomValue` unconditional while still keeping the disabled path off the
 * RPC. The atom is built once at module load and shared by every caller.
 */
const DISABLED_CHART_ATOM: TradingMarketChartAtom = Atom.make(
  AsyncResult.initial<TradingMarketChartView>(),
);

export interface TradingMarketChartState {
  readonly data: TradingMarketChartView | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

/**
 * The market chart for one environment+market, polled only while a position is
 * open.
 *
 * Everything here comes from `getTradingMarketChart`, which the gateway builds
 * from its candle series plus the current mark/funding/OI/volume figures. There
 * is no client-side chart state to go stale.
 *
 * `options.enabled` is the position-open gate: when it is `false` (or `market`
 * is null) the hook subscribes to {@link DISABLED_CHART_ATOM} instead of the
 * live family atom, returns an empty state, and starts no interval — a flat
 * mission puts nothing on the wire. The caller is expected to pass `enabled`
 * driven by whether a position is currently open for `market`.
 *
 * `options.window` turns it into the one-shot post-mortem read a finished
 * mission's card makes. The span is closed, so the poll is skipped: re-reading
 * it would return the same bars for as long as the card is mounted.
 */
export function useTradingMarketChart(
  environmentId: EnvironmentId,
  market: string | null,
  interval: ChartInterval,
  options: { readonly enabled: boolean; readonly window?: ChartWindow },
): TradingMarketChartState {
  const enabled = options.enabled && market !== null;
  const chartWindow = options.window ?? null;
  const windowStart = chartWindow?.startTime ?? null;
  const windowEnd = chartWindow?.endTime ?? null;

  // Selecting the atom in `useMemo` keeps `useAtomValue` unconditional
  // (rules-of-hooks) while still routing the disabled path off the RPC.
  // The window is depended on by its two numbers rather than by object
  // identity, so a caller rebuilding the literal each render does not thrash
  // the atom.
  const atom = useMemo(() => {
    if (!enabled || market === null) {
      return DISABLED_CHART_ATOM;
    }
    const bounds =
      windowStart === null || windowEnd === null
        ? null
        : { startTime: windowStart, endTime: windowEnd };
    return tradingMarketChartAtom(environmentId, market, interval, bounds);
  }, [enabled, market, environmentId, interval, windowStart, windowEnd]);

  const result = useAtomValue(atom);
  const data = Option.getOrNull(AsyncResult.value(result));

  const refresh = useCallback(() => {
    if (!enabled || market === null) {
      return;
    }
    const bounds =
      windowStart === null || windowEnd === null
        ? null
        : { startTime: windowStart, endTime: windowEnd };
    refreshTradingMarketChart(environmentId, market, interval, bounds);
  }, [enabled, market, environmentId, interval, windowStart, windowEnd]);

  const isWindowed = windowStart !== null && windowEnd !== null;

  useEffect(() => {
    if (!enabled || isWindowed) {
      return;
    }
    const id = window.setInterval(refresh, CHART_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, isWindowed, refresh]);

  return {
    data,
    error: result._tag === "Failure" ? "Failed to load trading market chart." : null,
    isLoading: result.waiting,
    refresh,
  };
}
