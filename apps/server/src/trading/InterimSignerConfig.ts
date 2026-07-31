/**
 * Interim testnet signer configuration - PROMPT-04 Step 0.
 *
 * The signing path needs an owner-approved Hyperliquid API wallet whose key
 * is approved (via the testnet UI) under the master account. Privy replaces
 * this in PROMPT-06; until then the interim key lives in server config only.
 *
 * Two env knobs, both optional so the live-submit gate stays on the owner:
 *
 *   - `T3_TRADES_INTERIM_SIGNER_KEY`   — `0x`-prefixed 32-byte hex EVM private key.
 *   - `T3_TRADES_INTERIM_SIGNER_ADDRESS` — the wallet's address (the owner knows
 *                                        it when they approve the wallet).
 *
 * When either is absent the signer resolves to `Option.none()` and every
 * signable action is rejected with `interim_signer_not_configured`. This is
 * deliberate: this is the only code path that spends testnet capital, so the
 * gate must fail closed until the owner explicitly arms it.
 *
 * The key never touches `trading_accounts.master_wallet_json` (whose schema
 * is key-less and Privy-bound by design - §10.1). It is held as raw bytes by
 * the caller and never persisted here.
 *
 * @module InterimSignerConfig
 */
import { Context, Effect, Option, Schema } from "effect";
import * as Layer from "effect/Layer";

/** The key is invalid or the env shape was wrong. */
export class InterimSignerError extends Schema.TaggedErrorClass<InterimSignerError>()(
  "InterimSignerError",
  {
    reason: Schema.Literals([
      "interim_signer_not_configured",
      "invalid_private_key",
      "invalid_address",
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Read the interim signer from `process.env`. Exposed for tests; production
 * goes through the `InterimSignerConfig` service.
 */
export const resolveInterimSignerFromEnv = (
  env: Record<string, string | undefined>,
): Effect.Effect<Option.Option<InterimSigner>, InterimSignerError> =>
  Effect.gen(function* () {
    const keyRaw = env.T3_TRADES_INTERIM_SIGNER_KEY?.trim();
    const addressRaw = env.T3_TRADES_INTERIM_SIGNER_ADDRESS?.trim();
    if (!keyRaw || !addressRaw) return Option.none();

    if (!HEX_PRIV_RE.test(keyRaw)) {
      return yield* new InterimSignerError({ reason: "invalid_private_key" });
    }
    if (!HEX_ADDR_RE.test(addressRaw)) {
      return yield* new InterimSignerError({ reason: "invalid_address" });
    }

    return Option.some(
      new InterimSigner({
        address: addressRaw.toLowerCase(),
        privateKeyBytes: hexToBytes(keyRaw),
      }),
    );
  });

/** Live layer reading from `process.env` lazily on each resolve. */
export const InterimSignerConfigLive = Layer.effect(
  InterimSignerConfig,
  Effect.succeed(
    InterimSignerConfig.of({
      resolve: resolveInterimSignerFromEnv(process.env),
    }),
  ),
);
