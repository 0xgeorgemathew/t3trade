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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
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

/** A flat account: the periodic loop engages only for unfinished business. */
const gatewayFlat = Layer.succeed(HyperliquidGateway)({
  getAccountSnapshot: () => Effect.succeed({ positions: [] } as never),
} as unknown as HyperliquidGateway["Service"]);

const flatLayer = TradingFillReconcilerLive.pipe(
  Layer.provideMerge(countingReconciler),
  Layer.provideMerge(gatewayFlat),
  Layer.provideMerge(stubInfoClient),
  Layer.provideMerge(fakeWebSocketClientLayer([])),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(NodeServices.layer),
);

/** An execution record parked in a non-terminal status. */
const insertStrandedExecution = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO trading_execution_records (
      execution_id, mission_id, strategy_version, execution_sequence, action_type,
      cloid, idempotency_key, market, side, size, limit_price, time_in_force,
      reduce_only, signer_address, status, order_results_json, created_at, updated_at
    ) VALUES (
      'exec-stranded', 'mission_1', 1, 0, 'open',
      '0xcloid', 'idem-stranded', 'ETH', 'buy', 0.5, 3001, 'ioc',
      0, ${MASTER}, 'accepted', '[]', 0, 0
    )
  `;
});

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

/**
 * A flat mission still has to settle its own paperwork.
 *
 * `accepted` and `submitted` records do not settle themselves — the submit
 * response is the last word the submit path hears — and while one exists it
 * holds a risk reservation the loss budget keeps counting and holds preview
 * item 16's lock against every new intent. Gating the periodic pass on an open
 * position left them parked until the next server start.
 */
it.effect("leaves a flat mission with nothing outstanding alone", () =>
  Effect.gen(function* () {
    reconcileCount = 0;
    yield* runMigrations({ toMigrationInclusive: 43 });
    const reconcilers = yield* TradingFillReconciler;

    const scope = yield* Scope.make("sequential");
    yield* reconcilers
      .follow({ missionId: "mission_1", masterAddress: MASTER, market: "ETH" })
      .pipe(Scope.provide(scope));
    yield* TestClock.adjust(Duration.seconds(30));
    yield* Scope.close(scope, Exit.void);

    assert.equal(reconcileCount, 0);
  }).pipe(Effect.provide(flatLayer)),
);

it.effect("settles a stranded execution record on a flat mission", () =>
  Effect.gen(function* () {
    reconcileCount = 0;
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* insertStrandedExecution;
    const reconcilers = yield* TradingFillReconciler;

    const scope = yield* Scope.make("sequential");
    yield* reconcilers
      .follow({ missionId: "mission_1", masterAddress: MASTER, market: "ETH" })
      .pipe(Scope.provide(scope));
    yield* TestClock.adjust(Duration.seconds(30));
    yield* Scope.close(scope, Exit.void);

    assert.isAbove(reconcileCount, 0);
  }).pipe(Effect.provide(flatLayer)),
);
