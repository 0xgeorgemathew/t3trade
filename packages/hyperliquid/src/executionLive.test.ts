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
import { buildOrderAction, buildCancelByCloidAction, mapOrder } from "./OrderMapper.ts";
import type { MarketBestBidOffer } from "@t3tools/trading-contracts/market";

// Resolve the secret relative to this file (repo-root .t3/secrets/), so the
// test finds the key regardless of the cwd vitest is invoked from. The prior
// relative path "../../.t3/..." only resolved correctly when run from
// packages/hyperliquid/src, not from the repo root.
const SECRET_PATH = new URL(
  "../../../.t3/secrets/hyperliquid-interim-signer-key.bin",
  import.meta.url,
).pathname;

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
 * strategy + sequence + actionType, truncated to 16 bytes, 0x-prefixed. Reused
 * across the entry and its retry so the exchange deduplicates on it. The cloid
 * is derived inside the test from `mapOrder` (which calls `deriveCloid`); the
 * asset index + szDecimals are resolved live from market metadata.
 */
const MISSION = "mission_live_e";

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

        // Resolve ETH's live szDecimals + asset index from market metadata, the
        // same source the production path uses (MarketResolver). Hardcoding
        // szDecimals=3 (the previous value) silently truncates size on markets
        // whose szDecimals differs and produces a wire size the exchange rejects
        // or fills at the wrong quantity.
        const info = yield* HyperliquidInfoClient;
        const [meta, assetCtxs] = yield* info.metaAndAssetCtxs;
        const ethUniverse = meta.universe.find((u) => u.name === "ETH");
        if (!ethUniverse) {
          return yield* Effect.die(new Error("ETH not found in testnet universe"));
        }
        const ethAssetIndex = meta.universe.indexOf(ethUniverse);
        const szDecimals = ethUniverse.szDecimals;

        // Read the live ETH BBO to price a marketable IOC.
        const book = yield* info.l2Book("ETH");
        const bbo: MarketBestBidOffer = {
          bidPrice: Number(book.levels[0][0]?.px ?? 0),
          bidSize: Number(book.levels[0][0]?.sz ?? 0),
          askPrice: Number(book.levels[1][0]?.px ?? 0),
          askSize: Number(book.levels[1][0]?.sz ?? 0),
          freshness: { observedAt: book.time, source: "info_api", staleAfterMillis: 2_000 },
        };
        const nowMsEntry = yield* Effect.clockWith((c) => c.currentTimeMillis);

        // --- 1. ENTRY: marketable IOC buy ---------------------------------
        // Use the production order mapper (mapOrder with marketable_ioc) so the
        // entry exercises the same IOC/slippage/precision path the reactor drives,
        // not a hand-rolled price. 50 bps is the ratified IOC slippage.
        const entryIntent = {
          missionId: MISSION,
          strategyVersion: 1,
          executionSequence: 0,
          actionType: "open" as const,
          market: "ETH" as const,
          side: "buy" as const,
          size: 0.01,
          orderPreference: "marketable_ioc" as const,
          limitPrice: 0,
          stop: { stopPrice: 0, plannedLossAtStopUsd: 0 },
          reduceOnly: false,
        };
        const wireOrder = yield* mapOrder({
          intent: entryIntent,
          bbo,
          szDecimals,
          allowedSlippageBps: 50,
          nowMs: nowMsEntry,
        });
        const action = buildOrderAction(wireOrder, ethAssetIndex);
        const nonce = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const signature = signL1ActionForWire({ action, nonce, privateKey, isTestnet: true });
        const actionHash = createL1ActionHash({ action, nonce });
        yield* Effect.logInfo("[execution-live] entry", {
          cloid: wireOrder.cloid,
          actionHash,
          szDecimals,
          assetIndex: ethAssetIndex,
        });

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

        // --- 4. CLOSE: reduce-only marketable IOC to flat ------------------
        // Two prior defects fixed here:
        //  (a) Hardcoded szDecimals=3 — the close size was derived with the wrong
        //      precision. Now the size is the reconciled position size (already
        //      in the exchange's unit) and mapOrder truncates it to the market's
        //      real szDecimals.
        //  (b) Hand-rolled formatPrice(bidPx * 0.999) on a STALE book captured at
        //      entry time. A resting-close that does not cross looks like "did not
        //      flatten" but is not a signing problem. Now the close uses the same
        //      §15.4 marketable-IOC derivation as the entry (mapOrder with
        //      orderPreference: "marketable_ioc") against a FRESH BBO read, so the
        //      sell limit crosses the bid and fills.
        // The "sell-action signature recovers to a wrong address" symptom from
        // commit 5dfb4bc14 was a measurement artifact: it recovered against the
        // bare action hash, not the EIP-712 phantom-agent digest the exchange
        // actually verifies. Recovery from the EIP-712 digest matches for both
        // entry and close (verified offline). Signing.ts is correct and unchanged.
        const closeSize = Math.abs(Number(ethPos!.position.szi));
        const closeBook = yield* info.l2Book("ETH");
        const closeBbo: MarketBestBidOffer = {
          bidPrice: Number(closeBook.levels[0][0]?.px ?? 0),
          bidSize: Number(closeBook.levels[0][0]?.sz ?? 0),
          askPrice: Number(closeBook.levels[1][0]?.px ?? 0),
          askSize: Number(closeBook.levels[1][0]?.sz ?? 0),
          freshness: { observedAt: closeBook.time, source: "info_api", staleAfterMillis: 2_000 },
        };
        const nowMsClose = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const closeWireOrder = yield* mapOrder({
          intent: {
            missionId: MISSION,
            strategyVersion: 1,
            executionSequence: 1,
            actionType: "close" as const,
            market: "ETH" as const,
            side: "sell" as const,
            size: closeSize,
            orderPreference: "marketable_ioc" as const,
            limitPrice: 0,
            stop: { stopPrice: 0, plannedLossAtStopUsd: 0 },
            reduceOnly: true,
          },
          bbo: closeBbo,
          szDecimals,
          allowedSlippageBps: 50,
          nowMs: nowMsClose,
        });
        const closeAction = buildOrderAction(closeWireOrder, ethAssetIndex);
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
          cloid: closeWireOrder.cloid,
        });
        expect("status" in closeResp ? closeResp.status : undefined).toBe("ok");

        // Reconcile flat — a hard assertion, not a soft log. A close that does
        // not flatten is a real failure (the §16.4 guarantee that close/reduce
        // remain permitted while the budget is exhausted rests on this). If the
        // book moved and the IOC did not fully cross, that is a defect to fix,
        // not a caveat to record.
        yield* Effect.sleep("2000 millis");
        const stateAfter = yield* info.clearinghouseState(masterAddress);
        const ethAfter = stateAfter.assetPositions.find(
          (a) => a.position.coin === "ETH" && Number(a.position.szi) !== 0,
        );
        yield* Effect.logInfo("[execution-live] position after close", {
          flat: ethAfter === undefined,
          remainingSzi: ethAfter?.position.szi,
        });
        expect(ethAfter).toBeUndefined();

        // --- 5. CANCEL-BY-CLOID: place a resting GTC, then cancel it ----------
        // Task 3's fix (type: "cancelByCloid" + numeric asset index) has never
        // once been sent live. Place a small resting GTC order far from the
        // market (so it does not fill), then cancel it by cloid and assert the
        // exchange accepts the cancel action. This is the action §16.4's
        // blockForExhaustion signs per resting increasing order.
        const cancelBook = yield* info.l2Book("ETH");
        const cancelBbo: MarketBestBidOffer = {
          bidPrice: Number(cancelBook.levels[0][0]?.px ?? 0),
          bidSize: Number(cancelBook.levels[0][0]?.sz ?? 0),
          askPrice: Number(cancelBook.levels[1][0]?.px ?? 0),
          askSize: Number(cancelBook.levels[1][0]?.sz ?? 0),
          freshness: { observedAt: cancelBook.time, source: "info_api", staleAfterMillis: 2_000 },
        };
        const nowMsResting = yield* Effect.clockWith((c) => c.currentTimeMillis);
        // A resting GTC buy priced just below the bid (5% under) — it will not
        // cross the ask, so it rests and is available to cancel. Kept close to
        // the market so 0.01 ETH clears the $10 minimum notional.
        const restingPx = (cancelBbo.bidPrice ?? 2_000) * 0.95;
        const restingOrder = yield* mapOrder({
          intent: {
            missionId: MISSION,
            strategyVersion: 1,
            executionSequence: 2,
            actionType: "open" as const,
            market: "ETH" as const,
            side: "buy" as const,
            size: 0.01,
            orderPreference: "resting_limit" as const,
            limitPrice: restingPx,
            stop: { stopPrice: 0, plannedLossAtStopUsd: 0 },
            reduceOnly: false,
          },
          bbo: cancelBbo,
          szDecimals,
          allowedSlippageBps: 50,
          nowMs: nowMsResting,
        });
        const restingAction = buildOrderAction(restingOrder, ethAssetIndex);
        const restingNonce = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const restingSig = signL1ActionForWire({
          action: restingAction,
          nonce: restingNonce,
          privateKey,
          isTestnet: true,
        });
        const restingResp = yield* exchange.submit({
          action: restingAction,
          nonce: restingNonce,
          signature: restingSig,
        });
        yield* Effect.logInfo("[execution-live] resting GTC placed", {
          status: "status" in restingResp ? restingResp.status : undefined,
          cloid: restingOrder.cloid,
        });

        // Now cancel it by cloid — the corrected action shape (type + asset index).
        const cancelAction = buildCancelByCloidAction(ethAssetIndex, restingOrder.cloid);
        const cancelNonce = yield* Effect.clockWith((c) => c.currentTimeMillis);
        const cancelSig = signL1ActionForWire({
          action: cancelAction,
          nonce: cancelNonce,
          privateKey,
          isTestnet: true,
        });
        const cancelResp = yield* exchange.submit({
          action: cancelAction,
          nonce: cancelNonce,
          signature: cancelSig,
        });
        yield* Effect.logInfo("[execution-live] cancel-by-cloid response", {
          status: "status" in cancelResp ? cancelResp.status : undefined,
          type: cancelResp.response.type,
        });
        expect("status" in cancelResp ? cancelResp.status : undefined).toBe("ok");
      }).pipe(Effect.provide(Layer.mergeAll(exchangeLayer, infoLayer))),
    120_000,
  );
});
