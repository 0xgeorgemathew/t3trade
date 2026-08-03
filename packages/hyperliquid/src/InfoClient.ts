/**
 * Hyperliquid Info API client - spec §13.
 *
 * Wraps the POST `api.hyperliquid-testnet.xyz/info` endpoint. Every request is
 * a `{ "type": "...", ... }` body; the response is decoded against the wire
 * schema before it leaves this client.
 *
 * Uses `HttpClient` from `effect/unstable/http` (v4-blessed HTTP path; the repo
 * forbids the global `fetch` in Effect code). Errors are tagged: network/http
 * failures map to `HyperliquidRequestError`; decode failures to
 * `HyperliquidDecodeError`.
 *
 * @module HyperliquidInfoClient
 */
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { HyperliquidEndpoints } from "./config.ts";
import { HyperliquidDecodeError, HyperliquidRequestError } from "./errors.ts";
import {
  WireAllMidsResponse,
  WireCandleSnapshotRequest,
  WireCandleSnapshotResponse,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireMetaAndAssetCtxsResponse,
  WireFrontendOpenOrdersResponse,
  WireOpenOrdersResponse,
  WireUserFillsResponse,
  WireUserFeesResponse,
} from "./wire.ts";

/** POST `type` discriminator + per-call body. */
type InfoRequestBody = { type: string } & Record<string, unknown>;

/** Combined transport error for any Info call. */
type InfoError = HyperliquidRequestError | HyperliquidDecodeError;

export class HyperliquidInfoClient extends Context.Service<
  HyperliquidInfoClient,
  {
    /** Fetch perp metadata + asset contexts (parallel arrays). */
    readonly metaAndAssetCtxs: Effect.Effect<WireMetaAndAssetCtxsResponse, InfoError>;
    /** All mid prices keyed by coin. */
    readonly allMids: Effect.Effect<WireAllMidsResponse, InfoError>;
    /** L2 order book for a coin (≤20 levels per side). */
    readonly l2Book: (coin: string) => Effect.Effect<WireL2BookResponse, InfoError>;
    /** Most-recent candle snapshot for a coin+interval. */
    readonly candleSnapshot: (
      req: WireCandleSnapshotRequest,
    ) => Effect.Effect<WireCandleSnapshotResponse, InfoError>;
    /** Clearinghouse state for a master-wallet address. */
    readonly clearinghouseState: (
      address: string,
    ) => Effect.Effect<WireClearinghouseStateResponse, InfoError>;
    /** Open orders for a master-wallet address. */
    readonly openOrders: (address: string) => Effect.Effect<WireOpenOrdersResponse, InfoError>;
    /**
     * Open orders with the trigger/reduce-only detail (§17.2 step 7). This is
     * the only read that can confirm exchange-native protection; `openOrders`
     * carries neither `isTrigger` nor `reduceOnly`.
     */
    readonly frontendOpenOrders: (
      address: string,
    ) => Effect.Effect<WireFrontendOpenOrdersResponse, InfoError>;
    /** User fills for a master-wallet address (§18 fills, canonical source). */
    readonly userFills: (address: string) => Effect.Effect<WireUserFillsResponse, InfoError>;
    /**
     * User fee schedule for a master-wallet address. The cross (taker) rate
     * feeds the §16.2 Eq-4 fee reserve.
     */
    readonly userFees: (address: string) => Effect.Effect<WireUserFeesResponse, InfoError>;
  }
>()("@t3tools/hyperliquid/InfoClient/HyperliquidInfoClient") {}

/**
 * POST one Info request and decode the JSON body against `schema`.
 *
 * `filterStatusOk` turns a non-2xx into a typed `HttpClientError` before
 * decoding, so the error mapping only needs to distinguish "transport failed"
 * (network or http status) from "body did not match schema". `operation` flows
 * into the error tags so a failure names the call.
 *
 * Plain function (not `Effect.fn`) because the generic `<A>` does not infer
 * cleanly under `Effect.fn`'s curried generator form.
 */
function postInfo<A>(
  client: HttpClient.HttpClient,
  url: string,
  operation: string,
  body: InfoRequestBody,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, InfoError> {
  return Effect.gen(function* () {
    // Execute + filter to 2xx. Any HttpClientError (network or non-2xx status)
    // maps to the tagged request error before decoding touches the body. A
    // HttpBodyError (request body construction failure) has no response and is
    // reported as a network-class failure.
    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(client.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((cause) => {
        if ("response" in cause && cause.response) {
          return new HyperliquidRequestError({
            operation,
            reason: "http_error",
            status: cause.response.status,
            body: cause.reason._tag,
          });
        }
        return new HyperliquidRequestError({
          operation,
          reason: "network",
          body: cause.reason._tag,
        });
      }),
    );

    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        (cause) =>
          new HyperliquidDecodeError({
            operation,
            parseError: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  });
}

const makeHyperliquidInfoClient = Effect.gen(function* () {
  const endpoints = yield* HyperliquidEndpoints;
  // Status filtering happens per-response in `postInfo` (filterStatusOk there),
  // so the raw client is used as-is.
  const client = yield* HttpClient.HttpClient;

  const call = <A>(operation: string, body: InfoRequestBody, schema: Schema.Decoder<A>) =>
    postInfo(client, endpoints.infoHttpUrl, operation, body, schema);

  return HyperliquidInfoClient.of({
    metaAndAssetCtxs: call(
      "metaAndAssetCtxs",
      { type: "metaAndAssetCtxs" },
      WireMetaAndAssetCtxsResponse,
    ),
    allMids: call("allMids", { type: "allMids" }, WireAllMidsResponse),
    l2Book: (coin) => call("l2Book", { type: "l2Book", coin }, WireL2BookResponse),
    candleSnapshot: (req) =>
      call("candleSnapshot", { type: "candleSnapshot", req }, WireCandleSnapshotResponse),
    clearinghouseState: (address) =>
      call(
        "clearinghouseState",
        { type: "clearinghouseState", user: address },
        WireClearinghouseStateResponse,
      ),
    openOrders: (address) =>
      call("openOrders", { type: "openOrders", user: address }, WireOpenOrdersResponse),
    frontendOpenOrders: (address) =>
      call(
        "frontendOpenOrders",
        { type: "frontendOpenOrders", user: address },
        WireFrontendOpenOrdersResponse,
      ),
    userFills: (address) =>
      call("userFills", { type: "userFills", user: address }, WireUserFillsResponse),
    userFees: (address) =>
      call("userFees", { type: "userFees", user: address }, WireUserFeesResponse),
  });
});

/** Live layer. Declared after `makeHyperliquidInfoClient` (const is not hoisted). */
export const HyperliquidInfoClientLive = Layer.effect(
  HyperliquidInfoClient,
  makeHyperliquidInfoClient,
);
