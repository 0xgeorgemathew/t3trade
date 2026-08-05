/**
 * TradingFillReconciler — fires the §18.2 fill/convergence triggers.
 *
 * The reconciler's `reconcile` is called on `after_submission` and
 * `before_execution` by the mission reactor. This service owns the remaining
 * live triggers that depend on a fill arriving, a reconnect, or time passing:
 *
 *   - `after_fill` (§18.2 #5): subscribe to the Hyperliquid `userFills`
 *     WebSocket channel for the master wallet, and reconcile on each frame.
 *   - `websocket_reconnect` (§18.2 #2): the WS client resubscribes on reconnect
 *     (§13); this service re-reads canonical state from the Info API rather
 *     than trusting replayed WS data.
 *   - `periodic_while_position_open` (§18.2 #8): a schedule that reconciles
 *     while a position exists, as a backstop for any frame the socket missed.
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
import { NON_TERMINAL_EXECUTION_STATUSES } from "@t3tools/trading-contracts/execution";

import { HyperliquidReconciler, type ReconcileInput } from "./HyperliquidReconciler.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";

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
  readonly follow: (input: ReconcileInput) => Effect.Effect<
    void,
    never,
    | Scope
    | HyperliquidGateway
    | HyperliquidInfoClient
    | SqlClient.SqlClient
    | HyperliquidWebSocketClient
    // A reconcile that finds the exchange moved a position T3 did not move
    // wakes the harness with the classified event, so `follow` needs the same
    // gate every other wake goes through.
    | TradingTurnCoordinator
  >;
}

export class TradingFillReconciler extends Context.Service<
  TradingFillReconciler,
  TradingFillReconcilerShape
>()("t3/trading/TradingFillReconciler") {}

/**
 * Whether T3's own tables still believe this mission holds a position.
 *
 * The periodic gate reads the exchange, so a position closed by hand reads as
 * "flat, nothing to do" — and the pass that would have noticed the close never
 * runs. Local belief is what makes the disagreement visible: while T3 thinks it
 * holds something, one more reconcile is always worth it.
 */
const holdsPositionLocally = (missionId: string, market: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly size: number }>`
      SELECT size FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND market = ${market} AND size != 0
    `;
    return rows.length > 0;
  }).pipe(Effect.orElseSucceed(() => false));

/** Whether any execution record for this mission is still non-terminal. */
const hasUnsettledExecutions = (missionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM trading_execution_records
      WHERE mission_id = ${missionId}
        AND ${sql.in("status", NON_TERMINAL_EXECUTION_STATUSES)}
    `;
    return (rows[0]?.count ?? 0) > 0;
  }).pipe(Effect.orElseSucceed(() => false));

const make = Effect.gen(function* () {
  const ws = yield* HyperliquidWebSocketClient;
  const reconciler = yield* HyperliquidReconciler;
  const gateway = yield* HyperliquidGateway;

  const follow: TradingFillReconcilerShape["follow"] = (input) =>
    Effect.gen(function* () {
      const coordinator = yield* TradingTurnCoordinator;

      /**
       * Reconcile, and wake the mission when the pass found something T3 did
       * not do.
       *
       * A hand-closed position is a fact the harness has to learn about within
       * one interval, not on whatever wake happens next: it is still managing a
       * position that no longer exists. `position_updated` is the §11.2 cause
       * for exactly that; the classified `external_*` event rides along in the
       * wakeup's `pendingEvents`, which is where the harness reads what
       * happened. A blocked or queued run is fine — the event stays pending and
       * the next run claims it.
       *
       * A position closing is the other wake worth spending a turn on, however
       * it closed. That turn is the mission's only chance to score the thesis
       * against the outcome while the numbers are still in front of it, and the
       * review the reconciler queued is what it reads — so the same
       * `position_updated` cause carries it.
       */
      const reconcileAndWake = (trigger: Parameters<typeof reconciler.reconcile>[1]) =>
        reconciler.reconcile(input, trigger).pipe(
          Effect.flatMap((state) =>
            state.externalChanges.length === 0 && state.closedTrade === null
              ? Effect.void
              : coordinator
                  .requestRun({ missionId: input.missionId, cause: "position_updated" })
                  .pipe(Effect.asVoid),
          ),
          Effect.catch(() => Effect.void),
        );

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
          yield* reconcileAndWake("after_fill");
        }),
      );
      yield* Effect.forkScoped(consumeFills);

      // §18.2 #2: on each WS reconnect the socket has already resubscribed, but
      // replayed frames cannot be trusted against canonical state — re-read via
      // the Info API. The reconciler is idempotent so a redundant read is safe.
      const consumeReconnects = Stream.runForEach(ws.reconnects, () =>
        reconcileAndWake("websocket_reconnect"),
      );
      yield* Effect.forkScoped(consumeReconnects);

      // §18.2 #8: periodic backstop while a position is open. Every 5s, if the
      // canonical position is non-flat, reconcile. Closes the gap if the WS
      // socket dropped frames or a fill arrived out-of-band.
      //
      // A flat mission also reconciles, but only when it has an execution
      // record still sitting in a non-terminal status. Nothing else settles
      // those: the submit response is the last word the submit path hears, so a
      // record left at `accepted` or `submitted` on a flat mission stayed there
      // until the next server start — holding a risk reservation the budget
      // kept counting, and holding preview item 16's lock against every new
      // intent. The count is a cheap local read, so the gate still costs
      // nothing on the ordinary flat mission with nothing outstanding.
      const periodic = Effect.gen(function* () {
        const snapshot = yield* gateway
          .getAccountSnapshot(input.masterAddress as `0x${string}`)
          .pipe(Effect.orElseSucceed(() => null));
        if (snapshot === null) return;
        const open = snapshot.positions.some((p) => p.market === input.market && p.size !== 0);
        if (
          !open &&
          !(yield* holdsPositionLocally(input.missionId, input.market)) &&
          !(yield* hasUnsettledExecutions(input.missionId))
        ) {
          return;
        }
        yield* reconcileAndWake("periodic_while_position_open");
      }).pipe(Effect.schedule(Schedule.spaced(Duration.seconds(5))), Effect.forkScoped);
      yield* periodic;
    });

  return { follow } satisfies TradingFillReconcilerShape;
});

export const TradingFillReconcilerLive = Layer.effect(TradingFillReconciler, make);
