/**
 * Slippage allowances for the two marketable-IOC paths.
 *
 * There is no market order on Hyperliquid. Every "market" fill is a limit order
 * priced to cross, and the crossing distance is a policy number: too tight and
 * the order rests unfilled, too wide and a thin book fills it somewhere the
 * loss model never anticipated.
 *
 * That number was written twice in source — 50 bps at the reactor's entry path,
 * 100 bps at the deterministic exit — and neither was reachable without an edit
 * and a rebuild. Both live here now, so the two paths are visibly two different
 * policies rather than two accidents, and either can be moved on a testnet run
 * without touching code:
 *
 *   - `T3_TRADES_IOC_SLIPPAGE_BPS`      — entry/harness IOC allowance, default 50.
 *   - `T3_TRADES_IOC_EXIT_SLIPPAGE_BPS` — deterministic reduce-only exit, default 100.
 *
 * The exit allowance is wider on purpose. An entry that misses can be retried at
 * leisure; an exit that misses leaves the exposure it was placed to escape.
 *
 * @module IocSlippageConfig
 */
import { Context, Effect, Layer } from "effect";

/** Entry IOC allowance when nothing is configured. */
export const DEFAULT_IOC_SLIPPAGE_BPS = 50;

/** Deterministic reduce-only exit allowance when nothing is configured. */
export const DEFAULT_IOC_EXIT_SLIPPAGE_BPS = 100;

export interface IocSlippageSettings {
  /** Crossing allowance for a harness-requested marketable IOC, in bps. */
  readonly entryBps: number;
  /** Crossing allowance for a deterministic reduce-only exit, in bps. */
  readonly exitBps: number;
}

export class IocSlippageConfig extends Context.Service<
  IocSlippageConfig,
  {
    readonly resolve: Effect.Effect<IocSlippageSettings>;
  }
>()("t3/trading/IocSlippageConfig") {}

/**
 * Read one bps knob, falling back to its default.
 *
 * A value that is not a positive finite number falls back rather than failing.
 * Refusing to trade over a typo'd env var would be a worse trade than pricing
 * at the documented default and logging nothing about it — the defaults are the
 * numbers the code shipped with.
 */
const readBps = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Read the settings out of an env bag. Exposed for tests. */
export const resolveIocSlippage = (
  env: Record<string, string | undefined>,
): IocSlippageSettings => ({
  entryBps: readBps(env.T3_TRADES_IOC_SLIPPAGE_BPS, DEFAULT_IOC_SLIPPAGE_BPS),
  exitBps: readBps(env.T3_TRADES_IOC_EXIT_SLIPPAGE_BPS, DEFAULT_IOC_EXIT_SLIPPAGE_BPS),
});

/**
 * Live layer reading `process.env`. Resolved per call, not at build, so a knob
 * changed between missions takes effect without a restart.
 */
export const IocSlippageConfigLive = Layer.succeed(
  IocSlippageConfig,
  IocSlippageConfig.of({
    resolve: Effect.sync(() => resolveIocSlippage(process.env)),
  }),
);
