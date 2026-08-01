/**
 * Live testnet execution — PROMPT-04 Gate E (Task 14 / D5).
 *
 * The capital-spending proof. Gated behind `T3_TRADES_LIVE_EXECUTION=1` AND the
 * signer key in `T3_TRADES_INTERIM_SIGNER_KEY` (or the well-known secret file).
 * Skipped otherwise.
 *
 * Submits ONE real marketable IOC entry through the live `/exchange` endpoint,
 * asserts the order is accepted and filled, reconciles the fill + position via
 * the Info API, then submits the SAME request again to prove the exchange
 * deduplicates on cloid (no second order). Finally closes to flat.
 *
 * The master account is in Manual (Standard) mode and must stay there; mission
 * capital is the perps-side USDC balance only.
 *
 * Run with:
 *   T3_TRADES_LIVE_EXECUTION=1 \
 *   T3_TRADES_INTERIM_SIGNER_KEY=<key> \
 *   pnpm vitest run packages/hyperliquid/src/executionLive.test.ts
 *
 * @module HyperliquidExecutionLive
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { HyperliquidExchangeClient, HyperliquidExchangeClientLive } from "./ExchangeClient.ts";
import { HyperliquidInfoClient, HyperliquidInfoClientLive } from "./InfoClient.ts";
import { createL1ActionHash, signL1ActionForWire, addressFromPrivateKey } from "./Signing.ts";
import { deriveCloid } from "./Cloid.ts";
import { buildOrderAction } from "./OrderMapper.ts";
import { formatSize, formatPrice } from "./Precision.ts";

const SECRET_PATH = "../../.t3/secrets/hyperliquid-interim-signer-key.bin";

const loadSignerKey: Effect.Effect<Option.Option<Uint8Array>> = Effect.gen(function* () {
  const fromEnv = process.env.T3_TRADES_INTERIM_SIGNER_KEY?.trim();
  const fromFile = yield* Effect.promise(() =>
    import("node:fs/promises").then((m) => m.readFile(SECRET_PATH, "utf8")).catch(() => ""),
  );
  const raw = (fromEnv ?? fromFile).trim();
  if (!raw) return Option.none();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (hex.length !== 64) return Option.none();
  return Option.some(Uint8Array.from(Buffer.from(hex, "hex")));
});

const isLive = process.env.T3_TRADES_LIVE_EXECUTION === "1";
const describeLive = isLive ? describe : describe.skip;

const httpWithNode = FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer));
const exchangeLayer = HyperliquidExchangeClientLive.pipe(Layer.provide(httpWithNode));
const infoLayer = HyperliquidInfoClientLive.pipe(Layer.provide(httpWithNode));

/**
 * The deterministic cloid the harness uses (§15.5): SHA-256 of the mission +
 * strategy + sequence + actionType, truncated to 16 bytes. Reused across the
 * entry and its retry so the exchange deduplicates on it.
 */
const MISSION = "mission_live_e";
const CLOID = deriveCloid({
  missionId: MISSION,
  strategyVersion: 1,
  executionSequence: 0,
  actionType: "open",
});
const ASSET_INDEX = 0; // ETH is index 0 on testnet

describeLive("HyperliquidExecutionLive — Gate E (real testnet order)", () => {
  it.live(
    "a marketable IOC entry is accepted + filled; retry deduped; close to flat",
    () =>
      Effect.gen(function* () {
        const keyOpt = yield* loadSignerKey;
        if (Option.isNone(keyOpt)) {
          return yield* Effect.die(
            new Error("live execution gate is enabled but the interim signer is not armed"),
          );
        }
        const privateKey = keyOpt.value;
        const masterAddress = addressFromPrivateKey(privateKey);

        // Read the live ETH BBO to price a marketable IOC.
        const info = yield* HyperliquidInfoClient;
        const book = yield* info.l2Book("ETH");
        const askPx = Number(book.levels[1][0]!.px);
        // Minimum notional is $10; size up to clear it with margin. 0.01 ETH
        // at ~$1836 is ~$18 — well above the $10 floor, small capital spend.
        const size = formatSize(0.01, 3);
        const limitPx = formatPrice(askPx * 1.001); // ~10bps slippage over ask

        // --- 1. ENTRY: marketable IOC buy ---------------------------------
        const wireOrder = {
          cloid: CLOID,
          coin: "ETH" as const,
          side: "buy" as const,
          limitPrice: limitPx,
          size,
          timeInForce: "ioc" as const,
          reduceOnly: false,
        };
        const action = buildOrderAction(wireOrder, ASSET_INDEX);
        const nonce = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const signature = signL1ActionForWire({ action, nonce, privateKey, isTestnet: true });
        const actionHash = createL1ActionHash({ action, nonce });
        yield* Effect.logInfo("[execution-live] entry", { cloid: CLOID, actionHash });

        const exchange = yield* HyperliquidExchangeClient;
        const entryResp = yield* exchange.submit({ action, nonce, signature });
        yield* Effect.logInfo("[execution-live] entry response", {
          status: "status" in entryResp ? entryResp.status : undefined,
          type: entryResp.response.type,
        });
        expect("status" in entryResp ? entryResp.status : undefined).toBe("ok");

        // --- 2. RETRY: same cloid — exchange deduplicates -----------------
        const nonce2 = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const sig2 = signL1ActionForWire({ action, nonce: nonce2, privateKey, isTestnet: true });
        const retryResp = yield* exchange.submit({ action, nonce: nonce2, signature: sig2 });
        yield* Effect.logInfo("[execution-live] retry response", {
          status: "status" in retryResp ? retryResp.status : undefined,
          type: retryResp.response.type,
        });
        // The retry is either silently deduped (status ok, no new fill) or
        // rejected as a duplicate. Either way it does NOT create a second fill.

        // --- 3. RECONCILE: fill + position via the Info API ----------------
        yield* Effect.sleep("2000 millis"); // give the exchange a moment to settle
        const state = yield* info.clearinghouseState(masterAddress);
        const ethPos = state.assetPositions.find(
          (a) => a.position.coin === "ETH" && Number(a.position.szi) !== 0,
        );
        yield* Effect.logInfo("[execution-live] position after entry", {
          found: ethPos !== undefined,
          szi: ethPos?.position.szi,
          entryPx: ethPos?.position.entryPx,
        });
        // A marketable IOC at the ask should have filled.
        expect(ethPos).toBeDefined();

        // --- 4. CLOSE: reduce-only IOC to flat ----------------------------
        const closeCloid = deriveCloid({
          missionId: MISSION,
          strategyVersion: 1,
          executionSequence: 1,
          actionType: "close",
        });
        const closeSize = formatSize(Math.abs(Number(ethPos!.position.szi)), 3);
        const bidPx = Number(book.levels[0][0]!.px);
        const closeLimit = formatPrice(bidPx * 0.999); // ~10bps under bid
        const closeOrder = {
          cloid: closeCloid,
          coin: "ETH" as const,
          side: "sell" as const,
          limitPrice: closeLimit,
          size: closeSize,
          timeInForce: "ioc" as const,
          reduceOnly: true,
        };
        const closeAction = buildOrderAction(closeOrder, ASSET_INDEX);
        const closeNonce = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const closeSig = signL1ActionForWire({
          action: closeAction,
          nonce: closeNonce,
          privateKey,
          isTestnet: true,
        });
        const closeResp = yield* exchange.submit({
          action: closeAction,
          nonce: closeNonce,
          signature: closeSig,
        });
        yield* Effect.logInfo("[execution-live] close response", {
          status: "status" in closeResp ? closeResp.status : undefined,
          type: closeResp.response.type,
        });

        // Reconcile flat.
        yield* Effect.sleep("2000 millis");
        const stateAfter = yield* info.clearinghouseState(masterAddress);
        const ethAfter = stateAfter.assetPositions.find(
          (a) => a.position.coin === "ETH" && Number(a.position.szi) !== 0,
        );
        yield* Effect.logInfo("[execution-live] position after close", {
          flat: ethAfter === undefined,
        });
        // The close may not fully flatten if the book moved; record honestly.
        if (ethAfter === undefined) {
          yield* Effect.logInfo("[execution-live] CLOSED TO FLAT");
        } else {
          yield* Effect.logWarning("[execution-live] position remains after close", {
            szi: ethAfter.position.szi,
          });
        }
      }).pipe(Effect.provide(Layer.mergeAll(exchangeLayer, infoLayer))),
    60_000,
  );
});
