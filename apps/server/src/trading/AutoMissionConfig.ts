/**
 * Auto-mission configuration — the rapid-testing shortcut.
 *
 * Binding a mission to a thread is normally a deliberate act: open Settings,
 * pick a free thread, name an instruction and a mandate, and — because one
 * active mission per user is a domain invariant (§10.1) — revoke whatever was
 * there before. That is the right shape for a product and the wrong shape for a
 * lab, where a testing loop is "open a thread, watch it trade" repeated dozens
 * of times a day.
 *
 * When `T3_TRADES_AUTO_MISSION_WORKSPACE` names a workspace root, every thread
 * created in the project at that root gets a mission the moment it exists, with
 * the POC authority and the default 1m instruction. Point it at a scratch
 * directory; every other project on the machine is unaffected.
 *
 * Three env knobs:
 *
 *   - `T3_TRADES_AUTO_MISSION_WORKSPACE`   — absolute workspace root. REQUIRED;
 *                                            unset leaves the feature off.
 *   - `T3_TRADES_AUTO_MISSION_CAPITAL_USD` — optional mandate size, default 50.
 *   - `T3_TRADES_AUTO_MISSION_INSTRUCTION` — optional instruction, default
 *                                            `POC_DEFAULT_INSTRUCTION`.
 *   - `T3_TRADES_AUTO_MISSION_ACCOUNT`     — optional trading account id.
 *
 * This does not arm execution. The interim signer is still the only gate on
 * spending testnet capital; an auto-created mission on an unarmed server
 * analyses and waits like any other.
 *
 * @module AutoMissionConfig
 */
import { Context, Effect, Layer, Option } from "effect";

import { POC_DEFAULT_INSTRUCTION } from "@t3tools/trading-contracts/strategy";

/** A resolved auto-mission target: where it applies and what it creates. */
export interface AutoMissionSettings {
  /** Workspace root whose threads auto-receive a mission. */
  readonly workspaceRoot: string;
  readonly instruction: string;
  readonly allocatedCapitalUsd: number;
  readonly tradingAccountId: string;
}

export const AUTO_MISSION_DEFAULT_CAPITAL_USD = 50;

/**
 * The account row the server provisions from the interim signer.
 *
 * Spelled out rather than imported from `TradingAccountBootstrap`: that module
 * imports `LOCAL_TRADING_USER_ID` from `TradingMissionReactor`, which is the
 * module that consumes this config, and importing back would close a cycle.
 * `NewMissionForm` mirrors the same literal for the same reason.
 */
export const AUTO_MISSION_DEFAULT_ACCOUNT_ID = "local-hyperliquid-testnet";

export class AutoMissionConfig extends Context.Service<
  AutoMissionConfig,
  {
    /** The configured target, or none when the owner has not enabled it. */
    readonly resolve: Effect.Effect<Option.Option<AutoMissionSettings>>;
  }
>()("t3/trading/AutoMissionConfig") {}

/**
 * Read the settings out of an env bag. Exposed for tests.
 *
 * A capital value that is not a positive finite number falls back to the
 * default rather than failing: this is a convenience knob, and refusing to
 * start the whole feature over a typo'd number would be a worse trade than
 * quietly using the documented default.
 */
export const resolveAutoMissionFromEnv = (
  env: Record<string, string | undefined>,
): Option.Option<AutoMissionSettings> => {
  const workspaceRoot = env.T3_TRADES_AUTO_MISSION_WORKSPACE?.trim();
  if (!workspaceRoot) return Option.none();

  const capital = Number(env.T3_TRADES_AUTO_MISSION_CAPITAL_USD);
  const allocatedCapitalUsd =
    Number.isFinite(capital) && capital > 0 ? capital : AUTO_MISSION_DEFAULT_CAPITAL_USD;

  const instruction = env.T3_TRADES_AUTO_MISSION_INSTRUCTION?.trim();
  const tradingAccountId = env.T3_TRADES_AUTO_MISSION_ACCOUNT?.trim();

  return Option.some({
    workspaceRoot,
    instruction: instruction || POC_DEFAULT_INSTRUCTION,
    allocatedCapitalUsd,
    tradingAccountId: tradingAccountId || AUTO_MISSION_DEFAULT_ACCOUNT_ID,
  });
};

/** Live layer reading `process.env`. Lazy, so the env can be set at runtime. */
export const AutoMissionConfigLive = Layer.succeed(
  AutoMissionConfig,
  AutoMissionConfig.of({
    resolve: Effect.sync(() => resolveAutoMissionFromEnv(process.env)),
  }),
);
