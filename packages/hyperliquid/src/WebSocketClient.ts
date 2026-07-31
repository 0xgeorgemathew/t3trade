/**
 * Hyperliquid WebSocket client - spec §13.
 *
 * Opens a WebSocket to `api.hyperliquid-testnet.xyz/ws`, exposes per-channel
 * `Stream`s, and recovers via bounded exponential backoff with automatic
 * resubscribe. The reconnect strategy is §13-mandated: after a reconnect the
 * gateway re-reads canonical state from the Info API rather than trusting
 * replayed WS data; this client only owns the socket and resubscription.
 *
 * The socket runs under the layer's scope so it closes when the layer closes.
 *
 * @module HyperliquidWebSocketClient
 */
import { Context, Duration, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import type { Scope } from "effect/Scope";
import { HyperliquidEndpoints } from "./config.ts";
import { HyperliquidRequestError } from "./errors.ts";
import { WireWsMessage } from "./wire.ts";

/** What a caller wants to subscribe to. */
export interface WsSubscription {
  readonly type: string;
  readonly coin?: string;
  readonly user?: string;
  readonly interval?: string;
}

/**
 * A message delivered to a subscriber, tagged with the subscription so the
 * gateway can route to the right consumer even when two subscriptions share a
 * channel type (e.g. two coins on `l2Book`).
 */
export interface WsDelivery {
  readonly subscription: WsSubscription;
  readonly channel: string;
  /** Raw `data` payload; decoded per-channel by the gateway. */
  readonly data: unknown;
}

/** §13: bounded exponential backoff for socket reconnects, capped at 30s, ≤10 tries. */
const reconnectSchedule = Schedule.max([
  Schedule.exponential("1 seconds").pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
  ),
  Schedule.recurs(10),
]);

/** Parse an inbound WS text frame into the envelope schema. */
const decodeWsMessage = Schema.decodeUnknownEffect(WireWsMessage);
/** Parse a raw string into `unknown` (v4 idiom over raw JSON.parse). */
const parseJson = Schema.decodeUnknownEffect(Schema.Unknown);
/** Encode an outbound subscribe payload to its JSON wire string. */
const encodeSubscribe = (sub: WsSubscription): string =>
  JSON.stringify({ method: "subscribe", subscription: sub });
const encodeUnsubscribe = (sub: WsSubscription): string =>
  JSON.stringify({ method: "unsubscribe", subscription: sub });

export class HyperliquidWebSocketClient extends Context.Service<
  HyperliquidWebSocketClient,
  {
    /**
     * Subscribe to a channel and return its message stream.
     *
     * The stream ends when the caller's scope closes (unsubscribe is sent then).
     * Socket-level reconnects are transparent: the client resubscribes and keeps
     * the same stream open.
     */
    readonly subscribe: (
      subscription: WsSubscription,
    ) => Stream.Stream<WsDelivery, HyperliquidRequestError, Scope>;
    /** True when the socket is open and accepting messages. */
    readonly isConnected: Effect.Effect<boolean>;
  }
>()("@t3tools/hyperliquid/WebSocketClient/HyperliquidWebSocketClient") {}

const makeHyperliquidWebSocketClient = Effect.gen(function* () {
  const endpoints = yield* HyperliquidEndpoints;

  // One PubSub fans every inbound message to every active subscriber. Shut down
  // with the layer so a dropped scope does not leak the queue.
  const inbound = yield* Effect.acquireRelease(
    PubSub.bounded<WsDelivery>({ capacity: 256 }),
    PubSub.shutdown,
  );

  // Active subscriptions, keyed by the JSON of their subscription payload, so
  // resubscribe after a reconnect replays exactly what was open.
  const active = new Map<string, WsSubscription>();

  /** The live WebSocket, when one is open. */
  let socket: WebSocket | null = null;
  let open = false;

  const keyFor = (sub: WsSubscription): string => encodeSubscribe(sub);

  const sendString = (json: string) =>
    Effect.sync(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(json);
      }
    });

  const sendSubscribe = (sub: WsSubscription) => sendString(encodeSubscribe(sub));
  const sendUnsubscribe = (sub: WsSubscription) => sendString(encodeUnsubscribe(sub));

  /**
   * Handle one inbound text frame: parse, decode the envelope, fan out to every
   * active subscription whose type matches the channel. Never throws — a single
   * bad frame must not wedge the socket loop.
   */
  const handleFrame = (raw: string) =>
    parseJson(raw).pipe(
      Effect.flatMap(decodeWsMessage),
      Effect.flatMap((msg) => {
        // `subscriptionResponse` acks are not data deliveries.
        if (msg.channel === "subscriptionResponse") return Effect.void;
        const deliveries: WsDelivery[] = [];
        for (const sub of active.values()) {
          if (sub.type === msg.channel) {
            deliveries.push({ subscription: sub, channel: msg.channel, data: msg.data });
          }
        }
        if (deliveries.length === 0) return Effect.void;
        return Effect.forEach(deliveries, (d) => PubSub.publish(inbound, d), { discard: true });
      }),
      // Drop bad frames; never propagate to the socket lifecycle.
      Effect.catch(() => Effect.void),
    );

  /**
   * Open the socket and wire its events into the PubSub. The effect resolves
   * when the socket closes (so the reconnect schedule re-enters); it fails with
   * a transient error on connect failure. The returned finalizer closes the
   * underlying socket so a scope shutdown tears it down cleanly.
   */
  const openSocket: Effect.Effect<unknown, HyperliquidRequestError> = Effect.callback<
    unknown,
    HyperliquidRequestError
  >((resume) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoints.webSocketUrl);
    } catch (cause) {
      resume(
        Effect.fail(
          new HyperliquidRequestError({
            operation: "ws_connect",
            reason: "network",
            body: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      );
      return;
    }
    socket = ws;

    ws.onopen = () => {
      open = true;
      // Resubscribe everything that was active before the (re)connect.
      for (const sub of active.values()) {
        ws.send(encodeSubscribe(sub));
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      // Detached: the onmessage callback must not block on PubSub publish.
      Effect.runFork(handleFrame(event.data));
    };

    ws.onerror = () => {
      // The close handler drives reconnect; onerror just flags state.
      open = false;
    };

    ws.onclose = () => {
      open = false;
      // Resolve with a transient failure so the reconnect schedule re-enters.
      resume(
        Effect.fail(new HyperliquidRequestError({ operation: "ws_close", reason: "network" })),
      );
    };

    return Effect.sync(() => {
      open = false;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    });
  });

  // §13: bounded exponential backoff. On exhaustion, log and leave the socket
  // closed — the gateway's staleness gate catches the gap, and a new subscribe
  // re-attempts connection. Run detached so it does not block layer build.
  const connectWithBackoff = openSocket.pipe(
    Effect.retry(reconnectSchedule),
    Effect.catch((err: HyperliquidRequestError) =>
      Effect.logError("HyperliquidWebSocketClient: reconnect attempts exhausted", {
        operation: err.operation,
      }),
    ),
  );

  yield* Effect.forkScoped(connectWithBackoff);

  return HyperliquidWebSocketClient.of({
    subscribe: (subscription) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const key = keyFor(subscription);
          active.set(key, subscription);
          yield* sendSubscribe(subscription);
          if (!open) {
            yield* Effect.forkScoped(connectWithBackoff.pipe(Effect.ignore));
          }
        }),
      ).pipe(
        Stream.flatMap(() =>
          Stream.fromPubSub(inbound).pipe(
            // Filter to this subscription's channel.
            Stream.filter((delivery) => delivery.subscription.type === subscription.type),
          ),
        ),
        // Unsubscribe when the stream's scope closes.
        Stream.ensuring(sendUnsubscribe(subscription)),
      ),
    isConnected: Effect.sync(() => open),
  });
});

/** Live layer. Declared after `makeHyperliquidWebSocketClient` (const is not hoisted). */
export const HyperliquidWebSocketClientLive = Layer.effect(
  HyperliquidWebSocketClient,
  makeHyperliquidWebSocketClient,
);
