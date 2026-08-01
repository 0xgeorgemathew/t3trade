/**
 * Live testnet execution smoke — PROMPT-04 acceptance ("Hyperliquid accepts
 * the order").
 *
 * Gated behind `T3_TRADES_LIVE_EXECUTION=1` AND an armed signer (the
 * `<repo>/.t3/secrets/hyperliquid-interim-signer-key.bin` file or the
 * `T3_TRADES_INTERIM_SIGNER_KEY` env var). Skipped otherwise — this is the
 * only test that talks to the live `/exchange` endpoint.
 *
 * The first probe is a signed `noop` action: Hyperliquid accepts it and
 * returns `{"response":{"type":"ok"}}` without placing any order. This proves
 * the full signing path (msgpack → keccak → EIP-712 phantom agent → POST) is
 * byte-correct against the real exchange, without spending capital. A real
 * order placement follows the same path once the noop is confirmed.
 *
 * Run with:
 *   T3_TRADES_LIVE_EXECUTION=1 vp run --filter @t3tools/hyperliquid test
 *
 * @module HyperliquidExecutionSmoke
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
// This live test loads the signer key from the worktree's gitignored secret
// file and uses the wall clock for the nonce — intentional direct node use.
// eslint-disable-next-line effect(nodeBuiltinImport)
import * as path from "node:path";
// eslint-disable-next-line effect(nodeBuiltinImport)
import * as fs from "node:fs/promises";

import { HyperliquidExchangeClient, HyperliquidExchangeClientLive } from "./ExchangeClient.ts";
import { createL1ActionHash, signL1ActionForWire } from "./Signing.ts";

/** Resolve the repo root from this file's location (packages/hyperliquid/src). */
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SECRET_PATH = path.join(REPO_ROOT, ".t3/secrets/hyperliquid-interim-signer-key.bin");

/** Load the signer key from env or the well-known secret file. */
const loadSignerKey: Effect.Effect<Option.Option<Uint8Array>> = Effect.gen(function* () {
  const fromEnv = process.env.T3_TRADES_INTERIM_SIGNER_KEY?.trim();
  const raw =
    fromEnv ??
    (yield* Effect.promise(() => fs.readFile(SECRET_PATH, "utf8").catch(() => ""))).trim();
  if (!raw) return Option.none();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (hex.length !== 64) return Option.none();
  return Option.some(Uint8Array.from(Buffer.from(hex, "hex")));
});

const isLive = process.env.T3_TRADES_LIVE_EXECUTION === "1";
const describeLive = isLive ? describe : describe.skip;

const exchangeLayer = HyperliquidExchangeClientLive.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer))),
);

describeLive("HyperliquidExecutionSmoke — live /exchange", () => {
  it.live(
    "a signed noop action is accepted by testnet (signing path byte-correct)",
    () =>
      Effect.gen(function* () {
        const keyOpt = yield* loadSignerKey;
        if (Option.isNone(keyOpt)) {
          yield* Effect.logWarning(
            "[execution-smoke] signer not armed; set T3_TRADES_INTERIM_SIGNER_KEY",
          );
          return;
        }
        const privateKey = keyOpt.value;

        const action = { type: "noop" } as Record<string, unknown>;
        const nonce = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const actionHash = createL1ActionHash({ action, nonce });
        const signature = signL1ActionForWire({ action, nonce, privateKey, isTestnet: true });

        // The action hash is the byte-critical output; log it (never the key)
        // so a cross-SDK comparison is possible.
        yield* Effect.logInfo("[execution-smoke]", { actionHash, signatureR: signature.r });

        const exchange = yield* HyperliquidExchangeClient;
        const response = yield* exchange.submit({ action, nonce, signature });
        // A noop returns {"status":"ok","response":{"type":"default"}}.
        yield* Effect.logInfo("[execution-smoke] response", {
          status: "status" in response ? response.status : undefined,
          responseType: response.response.type,
        });
        expect(response.response.type).toBe("default");
      }).pipe(Effect.provide(exchangeLayer)),
    30_000,
  );
});
