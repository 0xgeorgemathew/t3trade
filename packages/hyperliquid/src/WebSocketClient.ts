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

/**
 * §13: bounded exponential backoff for socket reconnects, capped at 30s,
 * ≤10 tries. Applied per outage — a successful connection resets it.
 */
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
/** Parse a raw JSON string into `unknown` (v4 idiom over raw JSON.parse). */
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
/** Encode an outbound subscribe payload to its JSON wire string. */
const encodeSubscribe = (sub: WsSubscription): string =>
  JSON.stringify({ method: "subscribe", subscription: sub });
const encodeUnsubscribe = (sub: WsSubscription): string =>
  JSON.stringify({ method: "unsubscribe", subscription: sub });

/** Canonical identity for a subscription (field order fixed). */
const keyFor = (sub: WsSubscription): string =>
  JSON.stringify([sub.type, sub.coin ?? null, sub.user ?? null, sub.interval ?? null]);

/** Read a string property off an unknown payload, when present. */
const stringField = (data: unknown, field: string): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
};

/**
 * Whether a frame on `sub.type`'s channel belongs to `sub` specifically.
 *
 * Two subscriptions can share a channel (two coins on `l2Book`; two intervals
 * on `candle`), so the channel name alone under-routes. The exchange stamps
 * the payload with the coin (`coin` on book/trade payloads, `s` on candles)
 * and interval (`i` on candles); when the subscription pins one of those and
 * the payload names a different one, the frame is not for this subscriber.
 * A payload that carries no such stamp (e.g. `allMids`) matches by channel.
 */
const matchesSubscription = (sub: WsSubscription, data: unknown): boolean => {
  const payload = Array.isArray(data) ? data[0] : data;
  if (sub.coin !== undefined) {
    const coin = stringField(payload, "coin") ?? stringField(payload, "s");
    if (coin !== undefined && coin !== sub.coin) return false;
  }
  if (sub.interval !== undefined) {
    const interval = stringField(payload, "i");
    if (interval !== undefined && interval !== sub.interval) return false;
  }
  return true;
};

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
    /**
     * Emits once per successful reconnect (§18.2 trigger #2). The socket owns
     * resubscription; this signal lets a consumer re-read canonical state from
     * the Info API rather than trusting replayed WS data. Completes only when
     * the layer's scope closes.
     */
    readonly reconnects: Stream.Stream<void>;
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
  // A second PubSub signals each successful reconnect (§18.2 trigger #2) so the
  // fill reconciler can re-read canonical state. Bounded at 1: only the most
  // recent reconnect matters, and a consumer that lags must not wedge the socket.
  const reconnectSignal = yield* Effect.acquireRelease(
    PubSub.bounded<void>({ capacity: 1 }),
    PubSub.shutdown,
  );

  // Active subscriptions keyed by canonical identity, refcounted so two
  // subscribers to the same channel share one exchange-side subscription and
  // the unsubscribe goes out only when the last one leaves. Resubscribe after
  // a reconnect replays exactly what is open.
  const active = new Map<string, { readonly sub: WsSubscription; count: number }>();

  /** The live WebSocket, when one is open. */
  let socket: WebSocket | null = null;
  let open = false;
  /** True while the connect loop is running (prevents duplicate sockets). */
  let connecting = false;

  const sendString = (json: string) =>
    Effect.sync(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(json);
      }
    });

  /**
   * Handle one inbound text frame: parse, decode the envelope, fan out one
   * delivery per active subscription the frame belongs to. Never throws — a
   * single bad frame must not wedge the socket loop.
   */
  const handleFrame = (raw: string) =>
    parseJson(raw).pipe(
      Effect.flatMap(decodeWsMessage),
      Effect.flatMap((msg) => {
        // `subscriptionResponse` acks are not data deliveries.
        if (msg.channel === "subscriptionResponse") return Effect.void;
        const deliveries: WsDelivery[] = [];
        for (const entry of active.values()) {
          if (entry.sub.type === msg.channel && matchesSubscription(entry.sub, msg.data)) {
            deliveries.push({ subscription: entry.sub, channel: msg.channel, data: msg.data });
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
   * with `true` when a connection that had opened closes again (a completed
   * session — reconnect with a fresh backoff), and fails when the connection
   * never opened (a connect failure — retry under the backoff schedule). The
   * returned finalizer closes the underlying socket so a scope shutdown tears
   * it down cleanly.
   */
  const openSocket: Effect.Effect<boolean, HyperliquidRequestError> = Effect.callback<
    boolean,
    HyperliquidRequestError
  >((resume) => {
    let ws: WebSocket;
    let wasOpen = false;
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
      const isReconnect = wasOpen;
      open = true;
      wasOpen = true;
      // Resubscribe everything that was active before the (re)connect.
      for (const entry of active.values()) {
        ws.send(encodeSubscribe(entry.sub));
      }
      if (isReconnect) {
        // §18.2 trigger #2: a reconnect happened. The socket has resubscribed;
        // consumers re-read canonical state from the Info API. Fire-and-forget:
        // a slow consumer must not block the socket loop.
        Effect.runFork(PubSub.publish(reconnectSignal, undefined));
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      // Detached: the onmessage callback must not block on PubSub publish.
      Effect.runFork(handleFrame(event.data));
    };

    ws.onclose = () => {
      open = false;
      if (wasOpen) {
        // A completed session: reconnect immediately with a fresh schedule.
        resume(Effect.succeed(true));
      } else {
        // Never opened: a connect failure the backoff schedule retries.
        resume(
          Effect.fail(new HyperliquidRequestError({ operation: "ws_connect", reason: "network" })),
        );
      }
    };

    return Effect.sync(() => {
      open = false;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    });
  });

  /**
   * Connect, stay connected, reconnect forever. Each outage gets a fresh §13
   * backoff schedule (retry wraps a single connect attempt; forever restarts
   * after a completed session). On exhaustion — ten straight connect failures
   * — log and leave the socket closed: the gateway's staleness gate catches
   * the gap, and a later subscribe re-attempts connection.
   */
  const connectLoop = Effect.acquireRelease(
    Effect.sync(() => {
      connecting = true;
    }),
    () =>
      Effect.sync(() => {
        connecting = false;
      }),
  ).pipe(
    Effect.andThen(openSocket.pipe(Effect.retry(reconnectSchedule), Effect.forever)),
    Effect.catch((err: HyperliquidRequestError) =>
      Effect.logError("HyperliquidWebSocketClient: reconnect attempts exhausted", {
        operation: err.operation,
      }),
    ),
    Effect.scoped,
  );

  yield* Effect.forkScoped(connectLoop);

  return HyperliquidWebSocketClient.of({
    subscribe: (subscription) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const key = keyFor(subscription);
          const existing = active.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            active.set(key, { sub: subscription, count: 1 });
            yield* sendString(encodeSubscribe(subscription));
          }
          if (!open && !connecting) {
            yield* Effect.forkScoped(connectLoop);
          }
          return key;
        }),
      ).pipe(
        Stream.flatMap((key) =>
          Stream.fromPubSub(inbound).pipe(
            // Only this subscription's deliveries.
            Stream.filter((delivery) => keyFor(delivery.subscription) === key),
          ),
        ),
        // Drop the refcount when the stream's scope closes; the exchange-side
        // unsubscribe goes out when the last subscriber leaves.
        Stream.ensuring(
          Effect.gen(function* () {
            const key = keyFor(subscription);
            const entry = active.get(key);
            if (!entry) return;
            entry.count -= 1;
            if (entry.count <= 0) {
              active.delete(key);
              yield* sendString(encodeUnsubscribe(subscription));
            }
          }),
        ),
      ),
    isConnected: Effect.sync(() => open),
    reconnects: Stream.fromPubSub(reconnectSignal),
  });
});

/** Live layer. Declared after `makeHyperliquidWebSocketClient` (const is not hoisted). */
export const HyperliquidWebSocketClientLive = Layer.effect(
  HyperliquidWebSocketClient,
  makeHyperliquidWebSocketClient,
);
