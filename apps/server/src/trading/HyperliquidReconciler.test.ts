/**
 * HyperliquidReconciler unit tests — PROMPT-04 Task 11 (D2).
 *
 * Covers the persist functions (position upsert, fill idempotency, order
 * replace, reservation release) and the full `reconcile` entry point with a
 * fake InfoClient + fake gateway. The fill identity `f.hash ?? cloid-time-idx`
 * is the load-bearing fix under test: two same-ms partials of one order must
 * land as two rows, not collapse on a bare cloid.
 *
 * Pattern: a single `it.layer` shares one in-memory sqlite db (migrated to
 * 040) + a MUTABLE fake gateway/info pair. Each test seeds the db, swaps the
 * canned payloads on the shared fakes, runs the real `reconcile`, and asserts
 * against the shared db. Mutability avoids rebuilding the layer per test.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import type {
  WireClearinghouseStateResponse,
  WireUserFillsResponse,
} from "@t3tools/hyperliquid/wire";
import type {
  AgentAccountSnapshot,
  AgentOpenOrder,
} from "@t3tools/trading-contracts/account-snapshot";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HyperliquidReconciler,
  HyperliquidReconcilerLive,
  type ReconcileInput,
} from "./HyperliquidReconciler.ts";

const MASTER = "0x000000000000000000000000000000000000beef";
const MISSION = "mission_reconcile";
const input: ReconcileInput = {
  missionId: MISSION,
  masterAddress: MASTER,
  market: "ETH",
};

/** Migrate the shared in-memory db to 040, then truncate the 038 tables. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 40 });
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_risk_reservations`;
  yield* sql`DELETE FROM trading_execution_records`;
});

// ---------------------------------------------------------------------------
// Mutable fakes: the gateway (account snapshot + open orders) and InfoClient
// (userFills) each read their current payload from a Ref so a test can flip
// the canned response between reconciles without rebuilding the layer.
// ---------------------------------------------------------------------------

interface FakeState {
  readonly account: AgentAccountSnapshot;
  readonly orders: ReadonlyArray<AgentOpenOrder>;
  readonly fills: WireUserFillsResponse;
}

/** Build a mutable fake gateway that reads account + orders from a Ref. */
const makeMutableGateway = (ref: Ref.Ref<FakeState>) =>
  Layer.succeed(HyperliquidGateway, {
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getOrderBook: () => Effect.die("not used"),
    getAccountSnapshot: () => Effect.map(Ref.get(ref), (s) => s.account),
    getPosition: () => Effect.die("not used"),
    getOpenOrders: () => Effect.map(Ref.get(ref), (s) => s.orders),
    getTakerFeeRateBps: () => Effect.die("not used"),
  });

/**
 * Build a mutable fake InfoClient whose `userFills` reads the current payload
 * from a Ref (so a test can swap fills between reconciles). All other InfoClient
 * methods die — the reconciler only touches `userFills`. Built directly via
 * `HyperliquidInfoClient.of` rather than `makeFakeInfoClient` because the fake
 * helper returns a static (non-Ref-backed) service.
 */
const makeMutableInfo = (ref: Ref.Ref<FakeState>) =>
  Layer.succeed(
    HyperliquidInfoClient,
    HyperliquidInfoClient.of({
      metaAndAssetCtxs: Effect.die("not used"),
      allMids: Effect.die("not used"),
      l2Book: () => Effect.die("not used"),
      candleSnapshot: () => Effect.die("not used"),
      clearinghouseState: () => Effect.die("not used"),
      openOrders: () => Effect.die("not used"),
      frontendOpenOrders: () => Effect.die("not used"),
      userFills: () => Effect.map(Ref.get(ref), (s) => s.fills),
      userFees: () => Effect.die("not used"),
    }),
  );

// --- canned payloads --------------------------------------------------------

/** Flat clearinghouse (no ETH position). */
const flatClearinghouse: WireClearinghouseStateResponse = {
  marginSummary: { accountValue: "1000", totalMarginUsed: "0" },
  withdrawable: "1000",
  assetPositions: [],
  time: 1_000,
};

/** Long 2 ETH @ 3000, upnl 20, liq 2500. */
const longClearinghouse: WireClearinghouseStateResponse = {
  marginSummary: { accountValue: "1020", totalMarginUsed: "600" },
  withdrawable: "420",
  assetPositions: [
    {
      position: {
        coin: "ETH",
        szi: "2",
        entryPx: "3000",
        unrealizedPnl: "20",
        cumulativeFunding: "0",
        marginUsed: "600",
        liquidationPx: "2500",
      },
      type: "oneWay",
    },
  ],
  time: 1_000,
};

const snapshotFromClearinghouse = (wire: WireClearinghouseStateResponse): AgentAccountSnapshot =>
  // Cast through `unknown`: `market`/`address` are literal types in the
  // contract (TradingMarket = "ETH", EvmAddress), and the wire strings are
  // widened `string`. The runtime values are correct for the POC tests.
  ({
    address: MASTER as `0x${string}`,
    accountValue: Number(wire.marginSummary.accountValue),
    marginUsed: Number(wire.marginSummary.totalMarginUsed),
    withdrawable: Number(wire.withdrawable),
    positions: wire.assetPositions.map((ap) => ({
      market: ap.position.coin,
      size: Number(ap.position.szi),
      entryPrice: Number(ap.position.entryPx),
      unrealisedPnl: Number(ap.position.unrealizedPnl),
      cumulativeFunding: Number(ap.position.cumulativeFunding ?? "0"),
      marginUsed: Number(ap.position.marginUsed),
      liquidationPx:
        ap.position.liquidationPx === null || ap.position.liquidationPx === undefined
          ? undefined
          : Number(ap.position.liquidationPx),
    })),
    freshness: { observedAt: 1_000, source: "info_api", staleAfterMillis: 5_000 },
  }) as unknown as AgentAccountSnapshot;

const fillAt = (
  time: number,
  cloid: string | undefined,
  size: string,
  oid = 100,
  hash?: string,
) => ({
  coin: "ETH",
  side: "B" as const,
  px: "3000",
  sz: size,
  time,
  fee: "0.5",
  oid,
  cloid,
  feeToken: "USDC",
  closedPnl: "0",
  ...(hash !== undefined ? { hash } : {}),
});

const order = (
  cloidChar: string,
  orderId: number,
  side: "buy" | "sell",
  price: number,
  size: number,
): AgentOpenOrder => ({
  market: "ETH",
  orderId,
  cloid: cloidChar.repeat(32),
  side,
  limitPrice: price,
  size,
  remainingSize: size,
  status: "open",
  createdAt: 1_000,
  reduceOnly: false,
  isTrigger: false,
});

const INITIAL_STATE: FakeState = {
  account: snapshotFromClearinghouse(flatClearinghouse),
  orders: [],
  fills: [],
};

// Build the Ref once outside the layer so the suite-scoped layer and every
// test share the same mutable cell. (it.layer memoises the layer, so this is
// safe: the Ref is constructed a single time at module load.)
const stateRef = Ref.makeUnsafe<FakeState>(INITIAL_STATE);

const layer = it.layer(
  HyperliquidReconcilerLive.pipe(
    Layer.provideMerge(makeMutableGateway(stateRef)),
    Layer.provideMerge(makeMutableInfo(stateRef)),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

// ===========================================================================
// Tests
// ===========================================================================

layer("HyperliquidReconciler", (it) => {
  /** Helper: swap the canned state on the shared Ref. */
  const setState = (patch: Partial<FakeState>) => Ref.update(stateRef, (s) => ({ ...s, ...patch }));

  // -------------------------------------------------------------------------
  // 1a. Fill upsert idempotency: persist the same fill twice ⇒ one row.
  // -------------------------------------------------------------------------
  it.effect("persists the same fill twice ⇒ one row (idempotent on fill_id)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* setState({
        fills: [fillAt(5_000, "c0ffee".padEnd(32, "0"), "1", 100, "0xhash1")],
      });
      const reconciler = yield* HyperliquidReconciler;

      // Reconcile twice (a retry); the second is a no-op for fills.
      yield* reconciler.reconcile(input, "after_fill");
      yield* reconciler.reconcile(input, "after_fill");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly c: number }>`
          SELECT COUNT(*) AS c FROM trading_fills WHERE mission_id = ${MISSION}
        `;
      assert.equal(rows[0]?.c, 1);
    }),
  );

  // -------------------------------------------------------------------------
  // 1b. The cloid-time-idx composite fix: two same-ms partials of one order
  //     (same cloid, same time, no hash) ⇒ TWO rows, not one.
  // -------------------------------------------------------------------------
  it.effect(
    "persists two same-ms partials of one order (same cloid/time, no hash) ⇒ TWO rows",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        // Two partials of the SAME order: identical cloid + time + oid, no
        // hash, different sizes. A bare-cloid identity would collide and the
        // idempotent upsert would drop one; the `cloid-time-idx` composite
        // (idx 0 vs 1) must keep them distinct.
        const cloid = "dead".padEnd(32, "0");
        yield* setState({
          fills: [fillAt(5_000, cloid, "0.5", 100), fillAt(5_000, cloid, "0.5", 100)],
        });

        const reconciler = yield* HyperliquidReconciler;
        const state = yield* reconciler.reconcile(input, "after_fill");

        // Canonical read mapped both to distinct fill_ids.
        assert.equal(state.fills.length, 2);
        assert.notEqual(state.fills[0]!.fillId, state.fills[1]!.fillId);

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly c: number }>`
          SELECT COUNT(*) AS c FROM trading_fills
          WHERE mission_id = ${MISSION} AND cloid = ${cloid}
        `;
        assert.equal(rows[0]?.c, 2);
      }),
  );

  // -------------------------------------------------------------------------
  // 2. Position snapshot upsert: open then flat clears the row.
  // -------------------------------------------------------------------------
  it.effect("upserts an open position, then clears it when flat (size 0, entry NULL)", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const sql = yield* SqlClient.SqlClient;

      // First: a long ETH position.
      yield* setState({ account: snapshotFromClearinghouse(longClearinghouse) });
      yield* reconciler.reconcile(input, "after_position_update");
      const openRow = yield* sql<{ readonly size: number; readonly entry_price: number | null }>`
        SELECT size, entry_price FROM trading_position_snapshots
        WHERE mission_id = ${MISSION} AND market = 'ETH'
      `;
      assert.ok(openRow[0] !== undefined);
      assert.equal(openRow[0].size, 2);
      assert.equal(openRow[0].entry_price, 3000);

      // Then flat (size 0) — the row is cleared in place.
      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse) });
      yield* reconciler.reconcile(input, "after_position_update");
      const flatRow = yield* sql<{ readonly size: number; readonly entry_price: number | null }>`
        SELECT size, entry_price FROM trading_position_snapshots
        WHERE mission_id = ${MISSION} AND market = 'ETH'
      `;
      assert.ok(flatRow[0] !== undefined);
      assert.equal(flatRow[0].size, 0);
      assert.equal(flatRow[0].entry_price, null);
    }),
  );

  // -------------------------------------------------------------------------
  // 3. Reservation release: a reserved reservation tied to a filled
  //    execution record flips to 'released' after reconcile.
  // -------------------------------------------------------------------------
  it.effect("releases a reserved reservation whose execution reached a terminal", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const execId = "exec_filled_1";

      // Seed a FILLED execution record + a reserved reservation tied to it.
      yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, strategy_version, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at,
          stop_price, planned_loss_at_stop_usd
        ) VALUES (
          ${execId}, ${MISSION}, ${1}, ${0}, ${"open"},
          ${"f".repeat(32)}, ${`idem_${execId}`}, ${"ETH"}, ${"buy"}, ${1}, ${3000},
          ${"ioc"}, ${0}, ${"0xsigner"}, ${"filled"}, ${"[]"}, ${1_000}, ${1_000},
          ${null}, ${null}
        )
      `;
      yield* sql`
        INSERT INTO trading_risk_reservations (
          reservation_id, mission_id, execution_id, cloid, action_type,
          reserved_risk_usd, status, reserved_at
        ) VALUES (
          ${`res_${execId}`}, ${MISSION}, ${execId}, ${"f".repeat(32)}, ${"open"},
          ${10}, ${"reserved"}, ${1_000}
        )
      `;

      // Flat position + no fills/orders so only the reservation query touches
      // the seeded rows.
      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse) });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");

      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM trading_risk_reservations WHERE execution_id = ${execId}
      `;
      assert.equal(rows[0]?.status, "released");
    }),
  );

  // -------------------------------------------------------------------------
  // 4. Order replace: persist one set, then another ⇒ the new set wins
  //    (delete + re-insert — local rows never survive a canonical read that
  //    omits them).
  // -------------------------------------------------------------------------
  it.effect("replaces the mission's open orders with the canonical set on each reconcile", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const sql = yield* SqlClient.SqlClient;

      // First: two resting buy orders.
      yield* setState({
        orders: [order("a", 1, "buy", 2950, 1), order("b", 2, "buy", 2900, 2)],
      });
      yield* reconciler.reconcile(input, "after_submission");
      let rows = yield* sql<{ readonly cloid: string }>`
        SELECT cloid FROM trading_orders WHERE mission_id = ${MISSION} ORDER BY cloid
      `;
      assert.equal(rows.length, 2);

      // Then: a single sell order. persistOpenOrders deletes the mission's
      // rows then re-inserts, so the two buys must be gone.
      yield* setState({ orders: [order("c", 3, "sell", 3100, 1)] });
      yield* reconciler.reconcile(input, "after_submission");
      rows = yield* sql<{ readonly cloid: string }>`
        SELECT cloid FROM trading_orders WHERE mission_id = ${MISSION} ORDER BY cloid
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.cloid, "c".repeat(32));
    }),
  );
});
