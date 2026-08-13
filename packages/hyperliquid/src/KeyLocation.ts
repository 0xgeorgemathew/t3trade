// @effect-diagnostics nodeBuiltinImport:off - resolves the key path from the OS home directory.
/**
 * The ONE canonical on-disk location of the Hyperliquid interim signer key.
 *
 * Every consumer — the dev server, the packaged desktop app, and the live
 * smoke tests — resolves the key through this module, so a machine has
 * exactly one place to arm:
 *
 *   `~/.t3trade/secrets/hyperliquid-interim-signer-key.bin`
 *
 * The directory is T3 Trade's own (`~/.t3trade`), deliberately separate from
 * the `~/.t3` state directory that upstream T3 Code owns: a running T3 Code
 * instance never reads or writes here, and any number of T3 Trade instances
 * (dev servers, worktrees, the .dmg build) share the same read-only key file
 * without conflicting.
 *
 * `T3TRADE_HOME` overrides the base directory for isolated environments.
 * The `T3_TRADES_INTERIM_SIGNER_KEY` env var still outranks the file
 * (see apps/server InterimSignerConfig).
 *
 * @module KeyLocation
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** The well-known secret filename (stored as `<name>.bin`). */
export const INTERIM_SIGNER_SECRET_NAME = "hyperliquid-interim-signer-key";

/** T3 Trade's own home directory: `$T3TRADE_HOME` or `~/.t3trade`. */
export const t3tradeHomeDir = (env: Record<string, string | undefined> = process.env): string => {
  const override = env.T3TRADE_HOME?.trim();
  return override ? override : NodePath.join(NodeOS.homedir(), ".t3trade");
};

/** The secrets directory under the T3 Trade home. */
export const t3tradeSecretsDir = (env: Record<string, string | undefined> = process.env): string =>
  NodePath.join(t3tradeHomeDir(env), "secrets");

/** Absolute path of the interim signer key file. */
export const interimSignerKeyPath = (
  env: Record<string, string | undefined> = process.env,
): string => NodePath.join(t3tradeSecretsDir(env), `${INTERIM_SIGNER_SECRET_NAME}.bin`);
