/**
 * Test implementations of the Hyperliquid clients.
 *
 * The repo pattern for external I/O is an in-process fake (see
 * `TestProviderAdapter`), not MSW/nock. These fakes return canned wire payloads
 * decoded through the real schemas, so consuming services test against the same
 * decode boundary the live client uses. Provide via `Layer.succeed(Service,
 * fake)` in test layers.
 *
 * @module HyperliquidTest
 */
import { Effect, Layer } from "effect";
import { HyperliquidInfoClient } from "./InfoClient.ts";
import {
  HyperliquidWebSocketClient,
  type WsDelivery,
  type WsSubscription,
} from "./WebSocketClient.ts";
import { Stream } from "effect";
import type {
  WireAllMidsResponse,
  WireCandleSnapshotRequest,
  WireCandleSnapshotResponse,
  WireClearinghouseStateResponse,
  WireL2BookResponse,
  WireMetaAndAssetCtxsResponse,
  WireOpenOrdersResponse,
} from "./wire.ts";

/** Canned responses for the fake Info client. All optional; unset throws. */
export interface FakeInfoResponses {
  metaAndAssetCtxs?: WireMetaAndAssetCtxsResponse;
  allMids?: WireAllMidsResponse;
  l2Book?: (coin: string) => WireL2BookResponse;
  candleSnapshot?: (req: WireCandleSnapshotRequest) => WireCandleSnapshotResponse;
  clearinghouseState?: (address: string) => WireClearinghouseStateResponse;
  openOrders?: (address: string) => WireOpenOrdersResponse;
}

/**
 * Build a fake Info client from canned responses. Unset methods fail with a
 * descriptive error so a test notices a missing fixture rather than silently
 * returning undefined.
 */
export function makeFakeInfoClient(responses: FakeInfoResponses): HyperliquidInfoClient {
  const fail = (op: string) => Effect.die(`FakeInfoClient: no canned response for ${op}`);
  return HyperliquidInfoClient.of({
    metaAndAssetCtxs: responses.metaAndAssetCtxs
      ? Effect.succeed(responses.metaAndAssetCtxs)
      : fail("metaAndAssetCtxs"),
    allMids: responses.allMids ? Effect.succeed(responses.allMids) : fail("allMids"),
    l2Book: (coin) => (responses.l2Book ? Effect.succeed(responses.l2Book(coin)) : fail("l2Book")),
    candleSnapshot: (req) =>
      responses.candleSnapshot
        ? Effect.succeed(responses.candleSnapshot(req))
        : fail("candleSnapshot"),
    clearinghouseState: (address) =>
      responses.clearinghouseState
        ? Effect.succeed(responses.clearinghouseState(address))
        : fail("clearinghouseState"),
    openOrders: (address) =>
      responses.openOrders ? Effect.succeed(responses.openOrders(address)) : fail("openOrders"),
  });
}

/** A fake Info client layer with canned responses. */
export const fakeInfoClientLayer = (responses: FakeInfoResponses) =>
  Layer.succeed(HyperliquidInfoClient, makeFakeInfoClient(responses));

/**
 * Build a fake WebSocket client from a queue of canned deliveries. Each
 * subscribe returns a stream that emits the deliveries whose subscription
 * type matches.
 */
export function makeFakeWebSocketClient(
  deliveries: ReadonlyArray<WsDelivery>,
): HyperliquidWebSocketClient {
  return HyperliquidWebSocketClient.of({
    subscribe: (subscription: WsSubscription) =>
      Stream.fromIterable(deliveries).pipe(
        Stream.filter((d) => d.subscription.type === subscription.type),
      ),
    isConnected: Effect.succeed(true),
  });
}

/** A fake WebSocket client layer with canned deliveries. */
export const fakeWebSocketClientLayer = (deliveries: ReadonlyArray<WsDelivery>) =>
  Layer.succeed(HyperliquidWebSocketClient, makeFakeWebSocketClient(deliveries));
