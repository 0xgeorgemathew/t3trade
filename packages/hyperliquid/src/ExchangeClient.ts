/**
 * Hyperliquid exchange (write) client — POST /exchange.
 *
 * The mirror of `InfoClient` for the write path. Submits a signed action
 * (action + signature + nonce) to `/exchange` and decodes the response. The
 * exchange URL is testnet for the POC (mainnet is out of scope, §10.1).
 *
 * This client signs nothing and holds no key — it only transports an already-
 * signed payload. Signing happens in the nonce lane inside the execution
 * service, so the client is a thin POST helper.
 *
 * @module HyperliquidExchangeClient
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { HyperliquidEndpoints } from "./config.ts";
import { HyperliquidDecodeError, HyperliquidRequestError } from "./errors.ts";
import { WireExchangeResponse } from "./wire.ts";

/** Combined transport error for any exchange call. */
type ExchangeError = HyperliquidRequestError | HyperliquidDecodeError;

/** A signed action ready to POST to /exchange. */
export interface SignedAction {
  readonly action: Record<string, unknown>;
  readonly nonce: number;
  /** Signature in the exchange's `{ r, s, v }` shape (v ∈ {27, 28}). */
  readonly signature: { readonly r: `0x${string}`; readonly s: `0x${string}`; readonly v: 27 | 28 };
}

/**
 * The exchange write client.
 */
export class HyperliquidExchangeClient extends Context.Service<
  HyperliquidExchangeClient,
  {
    /** POST a signed action to /exchange and decode the response. */
    readonly submit: (signed: SignedAction) => Effect.Effect<WireExchangeResponse, ExchangeError>;
  }
>()("@t3tools/hyperliquid/ExchangeClient/HyperliquidExchangeClient") {}

function postExchange(
  client: HttpClient.HttpClient,
  url: string,
  signed: SignedAction,
): Effect.Effect<WireExchangeResponse, ExchangeError> {
  return Effect.gen(function* () {
    const body = {
      action: signed.action,
      signature: signed.signature,
      nonce: signed.nonce,
    };

    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(client.execute),
      // The exchange returns 200 even on logical errors (the error is in the
      // body's response.type/statuses), so do NOT filterStatusOk here — decode
      // the body and let the per-order inspection (§17.2 step 4) decide.
      Effect.mapError((cause) => {
        if ("response" in cause && cause.response) {
          return new HyperliquidRequestError({
            operation: "exchange",
            reason: "http_error",
            status: cause.response.status,
            body: cause.reason._tag,
          });
        }
        return new HyperliquidRequestError({
          operation: "exchange",
          reason: "network",
          body: cause.reason._tag,
        });
      }),
    );

    return yield* HttpClientResponse.schemaBodyJson(WireExchangeResponse)(response).pipe(
      Effect.mapError(
        (cause) =>
          new HyperliquidDecodeError({
            operation: "exchange",
            parseError: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );
  });
}

export const makeExchangeClient = Effect.gen(function* () {
  const endpoints = yield* HyperliquidEndpoints;
  const client = yield* HttpClient.HttpClient;
  return HyperliquidExchangeClient.of({
    submit: (signed) => postExchange(client, endpoints.exchangeHttpUrl, signed),
  });
});

/** Live layer. Declared after `makeExchangeClient` (const is not hoisted). */
export const HyperliquidExchangeClientLive = Layer.effect(
  HyperliquidExchangeClient,
  makeExchangeClient,
);
