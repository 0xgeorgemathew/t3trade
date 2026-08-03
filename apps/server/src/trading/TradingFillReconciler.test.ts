/**
 * The lifetime of a `follow` subscription.
 *
 * `follow` runs three forked loops for one mission — fills, reconnects, and the
 * §18.2 #8 periodic backstop — and they live for as long as the scope they were
 * forked into. That is what lets the reactor retarget them when the active
 * mission changes, and it is what was missing when a revoked mission went on
 * polling the exchange for hours after a successor had taken over.
 *
 * These tests pin both halves: the periodic loop reconciles while the scope is
 * open, and stops the moment it closes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { fakeWebSocketClientLayer } from "@t3tools/hyperliquid/InfoClientTest";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { HyperliquidReconciler, type ReconciledState } from "./HyperliquidReconciler.ts";
import { TradingFillReconciler, TradingFillReconcilerLive } from "./TradingFillReconciler.ts";

const MASTER = "0x00000000000000000000000000000000000000ff";

/** How many times `reconcile` has been called, for the assertions below. */
let reconcileCount = 0;

const emptyState: ReconciledState = {
  position: null,
  openOrders: [],
  canonicalOrders: [],
  fills: [],
  observedAt: 0,
};

const countingReconciler = Layer.succeed(HyperliquidReconciler)({
  reconcile: () =>
    Effect.sync(() => {
      reconcileCount += 1;
      return emptyState;
    }),
} as unknown as HyperliquidReconciler["Service"]);

/** An account that is holding an ETH position, so the periodic loop engages. */
const gatewayHoldingPosition = Layer.succeed(HyperliquidGateway)({
  getAccountSnapshot: () => Effect.succeed({ positions: [{ market: "ETH", size: 0.5 }] } as never),
} as unknown as HyperliquidGateway["Service"]);

const stubInfoClient = Layer.succeed(HyperliquidInfoClient)(
  {} as unknown as HyperliquidInfoClient["Service"],
);

const layer = it.layer(
  TradingFillReconcilerLive.pipe(
    Layer.provideMerge(countingReconciler),
    Layer.provideMerge(gatewayHoldingPosition),
    Layer.provideMerge(stubInfoClient),
    Layer.provideMerge(fakeWebSocketClientLayer([])),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("TradingFillReconciler", (it) => {
  it.effect("stops reconciling as soon as the scope that owns the follow closes", () =>
    Effect.gen(function* () {
      reconcileCount = 0;
      const reconcilers = yield* TradingFillReconciler;

      const scope = yield* Scope.make("sequential");
      yield* reconcilers
        .follow({ missionId: "mission_1", masterAddress: MASTER, market: "ETH" })
        .pipe(Scope.provide(scope));

      // The 5s backstop has fired several times by now.
      yield* TestClock.adjust(Duration.seconds(30));
      const whileOpen = reconcileCount;
      assert.isAbove(whileOpen, 0);

      // Closing the scope is the whole retarget mechanism: a mission the
      // reactor has stopped following must stop touching the exchange.
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(Duration.seconds(60));

      assert.equal(reconcileCount, whileOpen);
    }),
  );
});
