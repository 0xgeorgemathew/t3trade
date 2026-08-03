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
 * So: on a server whose interim signer is armed, every new thread gets a
 * mission the moment it exists, with the POC authority and the default 1m
 * instruction. Settling the thread revokes it again (see
 * `TradingMissionReactor`), which makes the sidebar's Settle the way out.
 *
 * Arming the signer is the opt-in. It is already the deliberate, one-time act
 * that turns a checkout into a trading lab — nothing here can spend anything
 * without it, and a server that has never been armed sees no behaviour change.
 * The env knobs override that default and adjust what gets created:
 *
 *   - `T3_TRADES_AUTO_MISSION`             — `0` disables the shortcut on an
 *                                            armed server; `1` enables it on an
 *                                            unarmed one.
 *   - `T3_TRADES_AUTO_MISSION_WORKSPACE`   — optional. Narrows the shortcut to
 *                                            threads in the project at this
 *                                            workspace root; unset means every
 *                                            new thread.
 *   - `T3_TRADES_AUTO_MISSION_CAPITAL_USD` — optional mandate size, default 50.
 *   - `T3_TRADES_AUTO_MISSION_INSTRUCTION` — optional instruction, default
 *                                            `POC_DEFAULT_INSTRUCTION`.
 *   - `T3_TRADES_AUTO_MISSION_ACCOUNT`     — optional trading account id.
 *
 * This does not arm execution and does not widen any authority. The mission it
 * creates is the same mission the Settings form creates, under the same POC
 * mandate and the same §16 gates.
 *
 * @module AutoMissionConfig
 */
import { Context, Effect, Layer, Option } from "effect";

import { POC_DEFAULT_INSTRUCTION } from "@t3tools/trading-contracts/strategy";

import { InterimSignerConfig } from "./InterimSignerConfig.ts";

/** A resolved auto-mission target: where it applies and what it creates. */
export interface AutoMissionSettings {
  /**
   * Workspace root whose threads auto-receive a mission, or null for every
   * thread on the installation.
   */
  readonly workspaceRoot: string | null;
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
    /** The configured target, or none when the shortcut is off. */
    readonly resolve: Effect.Effect<Option.Option<AutoMissionSettings>>;
  }
>()("t3/trading/AutoMissionConfig") {}

/**
 * Read the settings out of an env bag. Exposed for tests.
 *
 * `signerArmed` is the default answer to "is this a trading lab"; the explicit
 * knob overrides it in both directions.
 *
 * A capital value that is not a positive finite number falls back to the
 * default rather than failing: this is a convenience knob, and refusing to
 * start the whole feature over a typo'd number would be a worse trade than
 * quietly using the documented default.
 */
export const resolveAutoMission = (
  env: Record<string, string | undefined>,
  signerArmed: boolean,
): Option.Option<AutoMissionSettings> => {
  const knob = env.T3_TRADES_AUTO_MISSION?.trim();
  const enabled = knob === "0" ? false : knob === "1" ? true : signerArmed;
  if (!enabled) return Option.none();

  const capital = Number(env.T3_TRADES_AUTO_MISSION_CAPITAL_USD);
  const allocatedCapitalUsd =
    Number.isFinite(capital) && capital > 0 ? capital : AUTO_MISSION_DEFAULT_CAPITAL_USD;

  const workspaceRoot = env.T3_TRADES_AUTO_MISSION_WORKSPACE?.trim();
  const instruction = env.T3_TRADES_AUTO_MISSION_INSTRUCTION?.trim();
  const tradingAccountId = env.T3_TRADES_AUTO_MISSION_ACCOUNT?.trim();

  return Option.some({
    workspaceRoot: workspaceRoot || null,
    instruction: instruction || POC_DEFAULT_INSTRUCTION,
    allocatedCapitalUsd,
    tradingAccountId: tradingAccountId || AUTO_MISSION_DEFAULT_ACCOUNT_ID,
  });
};

/**
 * Live layer reading `process.env` and the signer. Resolved per call, not at
 * build, so arming the signer or setting the knob takes effect without a
 * restart. A signer that fails to resolve (a malformed key) counts as unarmed:
 * a broken gate must not be the thing that starts missions.
 */
export const AutoMissionConfigLive = Layer.effect(
  AutoMissionConfig,
  Effect.gen(function* () {
    const signer = yield* InterimSignerConfig;
    const armed = signer.resolve.pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );
    return AutoMissionConfig.of({
      resolve: armed.pipe(Effect.map((isArmed) => resolveAutoMission(process.env, isArmed))),
    });
  }),
);
