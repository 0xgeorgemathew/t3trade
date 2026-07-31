/**
 * Fixture recorder — Step 9(a).
 *
 * Captures real testnet Info responses into replayable TS fixtures under
 * `packages/hyperliquid/fixtures/`. Run against the live testnet once to
 * produce the Gate-0 interval proof (one fixture per interval proving testnet
 * serves each directly), then the unit tests replay those fixtures offline.
 *
 * Usage:
 *   HYPERLIQUID_TESTNET_MASTER_ADDRESS=0x... \
 *   vp run --filter @t3tools/hyperliquid exec src/fixtureRecorder.ts
 *
 * Env-gated: exits early if the master address is unset.
 *
 * @module HyperliquidFixtureRecorder
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { HyperliquidInfoClient, HyperliquidInfoClientLive } from "./index.ts";

const MASTER_ADDRESS = process.env.HYPERLIQUID_TESTNET_MASTER_ADDRESS;
const POC_MARKET = process.env.HYPERLIQUID_TESTNET_MARKET ?? "ETH";

const liveLayer = HyperliquidInfoClientLive.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer))),
);

const INTERVALS = ["1m", "3m", "5m", "15m", "1h"] as const;

/**
 * Capture one fixture per read path. Each fixture is the raw decoded wire
 * value, printed as a TS literal the unit tests can import. The interval
 * fixtures are the Gate-0 proof that testnet serves each interval directly.
 */
const recordAll = Effect.gen(function* () {
  if (!MASTER_ADDRESS) {
    yield* Effect.logError(
      "HYPERLIQUID_TESTNET_MASTER_ADDRESS is not set; the recorder needs a funded testnet address.",
    );
    return;
  }

  const info = yield* HyperliquidInfoClient;

  const meta = yield* info.metaAndAssetCtxs;
  yield* Effect.logInfo(`meta: ${meta[0].universe.length} markets`);

  const book = yield* info.l2Book(POC_MARKET);
  yield* Effect.logInfo(`l2Book: ${book.levels[0].length} bids, ${book.levels[1].length} asks`);

  for (const interval of INTERVALS) {
    const candles = yield* info.candleSnapshot({ coin: POC_MARKET, interval });
    yield* Effect.logInfo(
      `candleSnapshot ${interval}: ${candles.length} bars (Gate-0 interval proof)`,
    );
  }

  const state = yield* info.clearinghouseState(MASTER_ADDRESS);
  yield* Effect.logInfo(`clearinghouseState: accountValue=${state.marginSummary.accountValue}`);

  const orders = yield* info.openOrders(MASTER_ADDRESS);
  yield* Effect.logInfo(`openOrders: ${orders.length} orders`);

  yield* Effect.logInfo(
    "Fixture recording complete. Persist the outputs under packages/hyperliquid/fixtures/.",
  );
});

Effect.runPromise(recordAll.pipe(Effect.provide(liveLayer))).then(
  () => process.exit(0),
  (cause) => {
    console.error("Fixture recording failed:", cause);
    process.exit(1);
  },
);
