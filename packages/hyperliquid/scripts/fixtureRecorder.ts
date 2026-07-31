/**
 * Fixture recorder — Step 9(a).
 *
 * Captures real testnet Info responses as raw JSON fixtures under
 * `packages/hyperliquid/fixtures/`. The unit tests (`wire.test.ts`) replay
 * those fixtures offline, so the decode boundary is proven against what the
 * exchange actually sends, not hand-written approximations. The per-interval
 * candle fixtures are the Gate-0 proof that testnet serves each interval
 * directly.
 *
 * Each response is captured raw (pre-decode) so fixtures keep fields the wire
 * schemas deliberately ignore, then decode-checked against the wire schema so
 * a recording that no longer decodes fails here, not later in a test.
 *
 * Usage (market fixtures need no credentials):
 *   node packages/hyperliquid/scripts/fixtureRecorder.ts
 *
 * With `HYPERLIQUID_TESTNET_MASTER_ADDRESS=0x...` set, the account fixtures
 * (clearinghouseState, openOrders) are recorded too.
 *
 * @module HyperliquidFixtureRecorder
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { TESTNET_ENDPOINTS } from "../src/config.ts";
import {
  WireAllMidsResponse,
  WireCandleSnapshotResponse,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireMetaAndAssetCtxsResponse,
  WireOpenOrdersResponse,
} from "../src/wire.ts";

const MASTER_ADDRESS = process.env.HYPERLIQUID_TESTNET_MASTER_ADDRESS;
const POC_MARKET = process.env.HYPERLIQUID_TESTNET_MARKET ?? "ETH";

const FIXTURES_DIR = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

const INTERVALS = [
  { interval: "1m", millis: 60_000 },
  { interval: "3m", millis: 180_000 },
  { interval: "5m", millis: 300_000 },
  { interval: "15m", millis: 900_000 },
  { interval: "1h", millis: 3_600_000 },
] as const;

/** Bars per candle fixture — enough to prove the shape, small enough to commit. */
const FIXTURE_BARS = 20;

/**
 * POST one raw Info request, decode-check it against `schema`, and write the
 * RAW body (not the decoded value, which would strip unread fields) to
 * `fixtures/<name>.json`.
 */
const record = Effect.fn("fixtureRecorder.record")(function* <A>(
  name: string,
  body: Record<string, unknown>,
  schema: Schema.Decoder<A>,
) {
  const client = yield* HttpClient.HttpClient;
  const raw = yield* HttpClientRequest.post(TESTNET_ENDPOINTS.infoHttpUrl).pipe(
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
  );
  yield* Schema.decodeUnknownEffect(schema)(raw);
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(FIXTURES_DIR, `${name}.json`),
      `${JSON.stringify(raw, null, 2)}\n`,
    ),
  );
  yield* Effect.logInfo(`recorded fixtures/${name}.json`);
  return raw;
});

const recordAll = Effect.gen(function* () {
  yield* Effect.promise(() => NodeFSP.mkdir(FIXTURES_DIR, { recursive: true }));

  yield* record("metaAndAssetCtxs", { type: "metaAndAssetCtxs" }, WireMetaAndAssetCtxsResponse);
  yield* record("allMids", { type: "allMids" }, WireAllMidsResponse);
  yield* record("l2Book", { type: "l2Book", coin: POC_MARKET }, WireL2BookResponse);

  const now = Date.now();
  for (const { interval, millis } of INTERVALS) {
    yield* record(
      `candles.${interval}`,
      {
        type: "candleSnapshot",
        req: { coin: POC_MARKET, interval, startTime: now - millis * FIXTURE_BARS, endTime: now },
      },
      WireCandleSnapshotResponse,
    );
  }

  if (MASTER_ADDRESS) {
    yield* record(
      "clearinghouseState",
      { type: "clearinghouseState", user: MASTER_ADDRESS },
      WireClearinghouseStateResponse,
    );
    yield* record(
      "openOrders",
      { type: "openOrders", user: MASTER_ADDRESS },
      WireOpenOrdersResponse,
    );
  } else {
    yield* Effect.logInfo(
      "HYPERLIQUID_TESTNET_MASTER_ADDRESS unset; skipped the account fixtures (clearinghouseState, openOrders).",
    );
  }
});

Effect.runPromise(
  recordAll.pipe(Effect.provide(FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer)))),
).then(
  () => process.exit(0),
  (cause) => {
    console.error("Fixture recording failed:", cause);
    process.exit(1);
  },
);
