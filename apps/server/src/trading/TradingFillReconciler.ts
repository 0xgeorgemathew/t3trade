/**
 * TradingFillReconciler — fires the §18.2 fill/convergence triggers.
 *
 * The reconciler's `reconcile` is called on `after_submission` and
 * `before_execution` by the mission reactor. This service owns the remaining
 * live triggers that depend on a fill arriving or time passing:
 *
 *   - `after_fill` (§18.2 #5): subscribe to the Hyperliquid `userFills`
 *     WebSocket channel for the master wallet, and reconcile on each frame.
 *   - `periodic_while_position_open` (§18.2 #8): a schedule that reconciles
 *     while a position exists, as a backstop for any frame the socket missed.
 *
 * The WS client resubscribes on reconnect (§13); the periodic loop's next tick
 * after a gap serves as the `websocket_reconnect` convergence.
 *
 * It is single-mission for the POC (one master wallet, one market) — the same
 * scope the mission reactor and interim signer already assume.
 *
 * @module TradingFillReconciler
 */
import { Context, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import type { Scope } from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway, HyperliquidWebSocketClient } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";

import { HyperliquidReconciler, type ReconcileInput } from "./HyperliquidReconciler.ts";

/** The Hyperliquid `userFills` WS channel frame. */
const WireUserFillsFrame = Schema.Struct({
  channel: Schema.Literal("userFills"),
  data: Schema.Array(
    Schema.Struct({
      coin: Schema.String,
      side: Schema.Literals(["B", "A"]),
      oid: Schema.Number,
      time: Schema.Number,
    }),
  ),
});
const decodeUserFillsFrame = Schema.decodeUnknownEffect(WireUserFillsFrame);

export interface TradingFillReconcilerShape {
  /**
   * Subscribe to fills + run the periodic loop for one mission's master wallet.
   * Runs until the calling scope closes (mission exit / shutdown). Requires the
   * read gateway + reconciler's SQL/Info dependencies, plus a scope.
   */
  readonly follow: (
    input: ReconcileInput,
  ) => Effect.Effect<
    void,
    never,
    | Scope
    | HyperliquidGateway
    | HyperliquidInfoClient
    | SqlClient.SqlClient
    | HyperliquidWebSocketClient
  >;
}

export class TradingFillReconciler extends Context.Service<
  TradingFillReconciler,
  TradingFillReconcilerShape
>()("t3/trading/TradingFillReconciler") {}

const make = Effect.gen(function* () {
  const ws = yield* HyperliquidWebSocketClient;
  const reconciler = yield* HyperliquidReconciler;
  const gateway = yield* HyperliquidGateway;

  const follow: TradingFillReconcilerShape["follow"] = (input) =>
    Effect.gen(function* () {
      // §18.2 #5: subscribe to the master wallet's fills. Each frame is a batch
      // of fills; a frame with at least one fill on this mission's market fires
      // `after_fill`. The socket's own resubscribe-on-reconnect covers the
      // transport; the periodic loop closes any data gap.
      const fills = ws.subscribe({ type: "userFills", user: input.masterAddress });
      const consumeFills = Stream.runForEach(fills, (delivery) =>
        Effect.gen(function* () {
          // Skip frames we can't decode rather than crashing the stream — a
          // single malformed frame must not wedge fill convergence.
          const parsed = yield* Effect.option(
            decodeUserFillsFrame({ channel: delivery.channel, data: delivery.data }),
          );
          if (parsed._tag === "None") return;
          const marketFills = parsed.value.data.filter((f) => f.coin === input.market);
          if (marketFills.length === 0) return;
          yield* reconciler.reconcile(input, "after_fill").pipe(Effect.catch(() => Effect.void));
        }),
      );
      yield* Effect.forkScoped(consumeFills);

      // §18.2 #8: periodic backstop while a position is open. Every 5s, if the
      // canonical position is non-flat, reconcile. Closes the gap if the WS
      // socket dropped frames or a fill arrived out-of-band; the first
      // successful reconcile after a disconnect doubles as #2's convergence.
      const periodic = Effect.gen(function* () {
        const snapshot = yield* gateway
          .getAccountSnapshot(input.masterAddress as `0x${string}`)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (snapshot === null) return;
        const open = snapshot.positions.some((p) => p.market === input.market && p.size !== 0);
        if (!open) return;
        yield* reconciler
          .reconcile(input, "periodic_while_position_open")
          .pipe(Effect.catch(() => Effect.void));
      }).pipe(Effect.schedule(Schedule.spaced(Duration.seconds(5))), Effect.forkScoped);
      yield* periodic;
    });

  return { follow } satisfies TradingFillReconcilerShape;
});

export const TradingFillReconcilerLive = Layer.effect(TradingFillReconciler, make);
