/**
 * Interim testnet signer configuration - PROMPT-04 Step 0.
 *
 * The signing path needs the private key of a Hyperliquid wallet authorized
 * to trade for the master account. For the POC this is the master account's
 * own key (a master wallet can sign for its own account directly, so no
 * separate agent-approval step is required). Privy replaces this in
 * PROMPT-06; until then the interim key lives in server config only.
 *
 * Two env knobs:
 *
 *   - `T3_TRADES_INTERIM_SIGNER_KEY`     — `0x`-prefixed 32-byte hex EVM private
 *                                       key. REQUIRED to arm the gate.
 *   - `T3_TRADES_INTERIM_SIGNER_ADDRESS` — optional. When set, it must match
 *                                       the address derived from the key (a
 *                                       mismatch is rejected). When unset, the
 *                                       address is derived from the key.
 *
 * When the key is absent the signer resolves to `Option.none()` and every
 * signable action is rejected with `interim_signer_not_configured`. This is
 * deliberate: this is the only code path that spends testnet capital, so the
 * gate must fail closed until the owner explicitly arms it.
 *
 * The key never touches `trading_accounts.master_wallet_json` (whose schema
 * is key-less and Privy-bound by design - §10.1). It is held as raw bytes in
 * memory and never persisted by this module.
 *
 * @module InterimSignerConfig
 */
import { Context, Effect, Option, Schema } from "effect";
import * as Layer from "effect/Layer";
import { addressFromPrivateKey } from "@t3tools/hyperliquid/Signing";
import { ServerConfig } from "../config.ts";

/** The secret file could not be read — absent, unreadable, or wrong perms. */
export class SecretFileReadError extends Schema.TaggedErrorClass<SecretFileReadError>()(
  "SecretFileReadError",
  { path: Schema.String, cause: Schema.Unknown },
) {}

/**
 * Read a file as UTF-8 text. Read errors (absence, perms) are caught upstream.
 *
 * `tryPromise`, not `promise`: a rejection from `promise` becomes a DEFECT, and
 * a defect walks straight past the `orElseSucceed` that turns an absent key
 * file into "unarmed". With `promise` the fail-closed fallback never fired —
 * a missing file killed the caller instead.
 *
 * Exported so the regression test can drive the real reader; a fake one is
 * exactly what let the defect through.
 */
export const readFileText = (path: string): Effect.Effect<string, SecretFileReadError> =>
  Effect.tryPromise({
    try: () => import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")),
    catch: (cause) => new SecretFileReadError({ path, cause }),
  });

/** The key is invalid or the env shape was wrong. */
export class InterimSignerError extends Schema.TaggedErrorClass<InterimSignerError>()(
  "InterimSignerError",
  {
    reason: Schema.Literals([
      "interim_signer_not_configured",
      "invalid_private_key",
      "address_mismatch",
    ]),
  },
) {
  override get message(): string {
    return `InterimSignerError(${this.reason})`;
  }
}

/** A loaded interim signer: the execution-wallet address and its raw key bytes. */
export class InterimSigner extends Schema.Class<InterimSigner>("InterimSigner")({
  /** The execution-wallet address (signer of record on each execution). */
  address: Schema.String,
  /** Raw 32-byte secp256k1 private key. Never logged, never persisted. */
  privateKeyBytes: Schema.Uint8Array,
}) {}

/**
 * Resolves the interim signer from server config, or `Option.none()` when the
 * owner has not armed it. Lookups are lazy so the env can be set at runtime.
 */
export class InterimSignerConfig extends Context.Service<
  InterimSignerConfig,
  {
    /** The interim signer, or none when not configured (fail-closed). */
    readonly resolve: Effect.Effect<Option.Option<InterimSigner>, InterimSignerError>;
  }
>()("t3/trading/InterimSignerConfig") {}

const HEX_PRIV_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** The well-known secret filename under the state dir's `secrets/` folder. */
export const INTERIM_SIGNER_SECRET_NAME = "hyperliquid-interim-signer-key";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Normalise a key string (with or without `0x`, with surrounding whitespace). */
function normaliseKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

/**
 * Build an `InterimSigner` from a raw key string, deriving the address and
 * cross-checking it against an optional explicit address.
 */
function buildSigner(
  keyRaw: string,
  explicitAddress: string | undefined,
): Effect.Effect<InterimSigner, InterimSignerError> {
  return Effect.gen(function* () {
    const normalised = normaliseKey(keyRaw);
    if (!HEX_PRIV_RE.test(normalised)) {
      return yield* new InterimSignerError({ reason: "invalid_private_key" });
    }
    const privateKeyBytes = hexToBytes(normalised);
    const derived = addressFromPrivateKey(privateKeyBytes);

    if (explicitAddress !== undefined) {
      const explicit = explicitAddress.trim();
      if (!HEX_ADDR_RE.test(explicit)) {
        return yield* new InterimSignerError({ reason: "invalid_private_key" });
      }
      if (explicit.toLowerCase() !== derived) {
        return yield* new InterimSignerError({ reason: "address_mismatch" });
      }
    }
    return new InterimSigner({ address: derived, privateKeyBytes });
  });
}

/**
 * Resolve the interim signer from env vars. Exposed for tests.
 *
 * The address is derived from the key. When an explicit
 * `T3_TRADES_INTERIM_SIGNER_ADDRESS` is supplied it must match the derived
 * address or the resolve fails with `address_mismatch`.
 */
export const resolveInterimSignerFromEnv = (
  env: Record<string, string | undefined>,
): Effect.Effect<Option.Option<InterimSigner>, InterimSignerError> =>
  Effect.gen(function* () {
    const keyRaw = env.T3_TRADES_INTERIM_SIGNER_KEY?.trim();
    if (!keyRaw) return Option.none();
    const signer = yield* buildSigner(keyRaw, env.T3_TRADES_INTERIM_SIGNER_ADDRESS);
    return Option.some(signer);
  });

/**
 * Resolve the interim signer from the well-known secret file, returning
 * `Option.none()` when the file is absent. Used as a fallback when the env
 * var is unset so a dev server in a worktree picks up the key written to
 * `.t3/secrets/` without an explicit env export.
 *
 * `readFile` is injected so this stays pure and testable.
 */
export const resolveInterimSignerFromFile = (
  readFile: (path: string) => Effect.Effect<string, SecretFileReadError>,
  secretsDir: string,
  explicitAddress?: string,
): Effect.Effect<Option.Option<InterimSigner>, InterimSignerError> =>
  Effect.gen(function* () {
    const path = `${secretsDir}/${INTERIM_SIGNER_SECRET_NAME}.bin`;
    // A read failure (file absent, perms, etc.) means the file source is not
    // armed → none. orElseSucceed absorbs any read error into the absent branch.
    const keyRaw = yield* readFile(path).pipe(
      Effect.map((text) => Option.some(text)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(keyRaw)) return Option.none();
    const signer = yield* buildSigner(keyRaw.value, explicitAddress);
    return Option.some(signer);
  });

/**
 * Resolve the interim signer from env, then the well-known secret file.
 * Either source arms the gate; both absent leaves it fail-closed.
 */
export const resolveInterimSigner = (
  env: Record<string, string | undefined>,
  readFile: (path: string) => Effect.Effect<string, SecretFileReadError>,
  secretsDir: string,
): Effect.Effect<Option.Option<InterimSigner>, InterimSignerError> =>
  Effect.gen(function* () {
    const fromEnv = yield* resolveInterimSignerFromEnv(env);
    if (Option.isSome(fromEnv)) return fromEnv;
    return yield* resolveInterimSignerFromFile(
      readFile,
      secretsDir,
      env.T3_TRADES_INTERIM_SIGNER_ADDRESS,
    );
  });

/** Live layer reading from `process.env`, then the well-known secret file. */
export const InterimSignerConfigLive = Layer.effect(
  InterimSignerConfig,
  Effect.gen(function* () {
    const { secretsDir } = yield* ServerConfig;
    return InterimSignerConfig.of({
      resolve: resolveInterimSigner(process.env, readFileText, secretsDir),
    });
  }),
);
