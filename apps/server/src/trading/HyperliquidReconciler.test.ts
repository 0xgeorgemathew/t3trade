/**
 * HyperliquidReconciler unit tests — PROMPT-04 Task 11 (D2).
 *
 * Covers the persist functions (position upsert, fill idempotency, order
 * replace, reservation release) and the full `reconcile` entry point with a
 * fake InfoClient + fake gateway. Fill identity is the load-bearing thing under
 * test: every partial of an order must land as its own row. `tid` is the
 * identity; `hash` is not one (it is shared by every fill of an action) and
 * keying on it collapsed an order into a single under-reported row.
 *
 * Pattern: a single `it.layer` shares one in-memory sqlite db (migrated to
 * 040) + a MUTABLE fake gateway/info pair. Each test seeds the db, swaps the
 * canned payloads on the shared fakes, runs the real `reconcile`, and asserts
 * against the shared db. Mutability avoids rebuilding the layer per test.
 */
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

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
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { TradingEventInboxLive } from "./TradingEventInbox.ts";
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

/** Migrate the shared in-memory db, then truncate the 038 tables. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 60 });
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_risk_reservations`;
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_event_inbox`;
  yield* sql`DELETE FROM trading_account_observations`;
  yield* sql`DELETE FROM trading_closed_trades`;
  yield* sql`DELETE FROM trading_missions`;
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
    getUserFeeRatesBps: () => Effect.die("not used"),
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
        leverage: { type: "isolated", value: 10 },
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
      leverage: ap.position.leverage?.value,
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

/**
 * One sub-fill of an order, shaped as `userFills` returns it — every field the
 * identity and the money columns are read from is explicit.
 */
const subFill = (f: {
  readonly oid: number;
  readonly time: number;
  readonly px: string;
  readonly sz: string;
  readonly fee: string;
  readonly closedPnl: string;
  readonly tid?: number;
  readonly hash?: string;
}) => ({
  coin: "ETH",
  side: "A" as const,
  px: f.px,
  sz: f.sz,
  time: f.time,
  fee: f.fee,
  oid: f.oid,
  cloid: "beef".padEnd(32, "0"),
  feeToken: "USDC",
  closedPnl: f.closedPnl,
  ...(f.tid !== undefined ? { tid: f.tid } : {}),
  ...(f.hash !== undefined ? { hash: f.hash } : {}),
});

/**
 * The 01:12:56 close from the exchange's own trade history: 1.0632 ETH at an
 * average of 1879.8784142212, fee 0.899407, closedPnl -1.453957 — matched in
 * three slices that all share one L1 transaction hash.
 */
const CLOSE_ORDER_ID = 57_431_816_538;
const CLOSE_HASH = "0xbl0ck";
const CLOSE_SUBFILLS = [
  { sz: "0.2295", px: "1879.6", fee: "0.194149", closedPnl: "-0.313857", tid: 1 },
  { sz: "0.5", px: "1880.1", fee: "0.423028", closedPnl: "-0.684000", tid: 2 },
  { sz: "0.3337", px: "1879.7378783338", fee: "0.282230", closedPnl: "-0.456100", tid: 3 },
] as const;
const CLOSE_TOTAL = {
  size: 1.0632,
  avgPrice: 1879.8784142212,
  fee: 0.899407,
  closedPnl: -1.453957,
};

const closeFills = (options: { readonly withTid: boolean }) =>
  CLOSE_SUBFILLS.map((f) =>
    subFill({
      oid: CLOSE_ORDER_ID,
      time: 1_754_356_376_000,
      px: f.px,
      sz: f.sz,
      fee: f.fee,
      closedPnl: f.closedPnl,
      hash: CLOSE_HASH,
      ...(options.withTid ? { tid: f.tid } : {}),
    }),
  );

/** Sum the mission's fills the way the projection's receipt query does. */
const readOrderTotals = (orderId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly rows: number;
      readonly size: number;
      readonly avg_price: number;
      readonly fee: number;
      readonly closed_pnl: number;
    }>`
      SELECT
        COUNT(*) AS rows,
        SUM(filled_size) AS size,
        SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_price,
        SUM(fee_usd) AS fee,
        SUM(closed_pnl) AS closed_pnl
      FROM trading_fills
      WHERE mission_id = ${MISSION} AND order_id = ${orderId}
    `;
    return rows[0]!;
  });

/** Insert the mission row whose `created_at` floors the fill read. */
const seedMission = (createdAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        strategy_family, harness_json, status, control_json, authority_version,
        strategy_version, version, created_at, updated_at
      ) VALUES (
        ${MISSION}, 'user', 'account', 'trade', 'ETH', 'momentum', '{}',
        'active', '{}', 1, 1, 1, ${createdAt}, ${createdAt}
      )
    `;
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
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(NodeCrypto.layer),
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
  // 1c. The hash-collision regression: every sub-fill of one order carries the
  //     SAME `hash` (it is the L1 transaction hash of the action, not a fill
  //     id). Keying identity on it kept one slice's size and overwrote fee and
  //     PnL with another slice's, so a 1.0632 ETH close was reported as 0.2295
  //     ETH costing $0.33 with -$0.20 realised.
  // -------------------------------------------------------------------------
  it.effect("keeps every sub-fill of one order that shares an L1 hash", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* setState({ fills: closeFills({ withTid: true }) });

      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");
      // A second pass must not duplicate them — identity is still stable.
      yield* reconciler.reconcile(input, "after_fill");

      const totals = yield* readOrderTotals(CLOSE_ORDER_ID);
      assert.equal(totals.rows, 3);
      assert.closeTo(totals.size, CLOSE_TOTAL.size, 1e-9);
      assert.closeTo(totals.avg_price, CLOSE_TOTAL.avgPrice, 1e-6);
      assert.closeTo(totals.fee, CLOSE_TOTAL.fee, 1e-9);
      assert.closeTo(totals.closed_pnl, CLOSE_TOTAL.closedPnl, 1e-9);
    }),
  );

  // -------------------------------------------------------------------------
  // 1d. Same, with no `tid` on the wire: the content+ordinal fallback must
  //     still separate slices that share a hash.
  // -------------------------------------------------------------------------
  it.effect("separates hash-sharing sub-fills when the wire carries no tid", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* setState({ fills: closeFills({ withTid: false }) });

      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");
      yield* reconciler.reconcile(input, "after_fill");

      const totals = yield* readOrderTotals(CLOSE_ORDER_ID);
      assert.equal(totals.rows, 3);
      assert.closeTo(totals.size, CLOSE_TOTAL.size, 1e-9);
      assert.closeTo(totals.fee, CLOSE_TOTAL.fee, 1e-9);
    }),
  );

  // -------------------------------------------------------------------------
  // 1e. Healing: a row written under the old hash-keyed identity is replaced
  //     by the order's canonical set rather than left to double-count.
  // -------------------------------------------------------------------------
  it.effect("replaces a legacy hash-keyed row with the order's canonical fills", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      // What the old identity left behind: one row per (order, transaction),
      // holding the first slice's size and the last slice's fee and PnL.
      yield* sql`
        INSERT INTO trading_fills (
          fill_id, mission_id, cloid, order_id, market, side, filled_size,
          avg_fill_price, fee_usd, fee_token, closed_pnl, traded_at, observed_at
        ) VALUES (
          ${CLOSE_HASH}, ${MISSION}, NULL, ${CLOSE_ORDER_ID}, 'ETH', 'sell',
          0.2295, 1879.8, 0.33, 'USDC', -0.2, 1754356376000, 1754356376000
        )
      `;
      yield* setState({ fills: closeFills({ withTid: true }) });

      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");

      const totals = yield* readOrderTotals(CLOSE_ORDER_ID);
      assert.equal(totals.rows, 3);
      assert.closeTo(totals.size, CLOSE_TOTAL.size, 1e-9);
      assert.closeTo(totals.fee, CLOSE_TOTAL.fee, 1e-9);
      assert.closeTo(totals.closed_pnl, CLOSE_TOTAL.closedPnl, 1e-9);
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

  // The exchange's leverage is a SETTING, not a measurement of this position,
  // so it is the one column the flat-clear leaves standing: the receipts that
  // quote it are read long after the position they belong to has closed.
  it.effect("records the exchange's leverage and keeps it once the mission goes flat", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const sql = yield* SqlClient.SqlClient;
      const readLeverage = Effect.gen(function* () {
        const rows = yield* sql<{ readonly leverage: number | null }>`
          SELECT leverage FROM trading_position_snapshots
          WHERE mission_id = ${MISSION} AND market = 'ETH'
        `;
        return rows[0]?.leverage ?? null;
      });

      yield* setState({ account: snapshotFromClearinghouse(longClearinghouse) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readLeverage, 10);

      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readLeverage, 10);
    }),
  );

  // A sell is an open on a short and a close on a long, and the fill row cannot
  // tell the two apart. The exchange labels it; this is that label surviving.
  it.effect("records the exchange's own lifecycle label on each fill", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* setState({
        fills: [{ ...fillAt(5_000, "1ab3".padEnd(32, "0"), "1", 700), dir: "Close Long" }],
      });

      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly direction: string | null }>`
        SELECT direction FROM trading_fills WHERE mission_id = ${MISSION} AND order_id = 700
      `;
      assert.equal(rows[0]?.direction, "Close Long");
    }),
  );

  // A fill the exchange sent without one is stored without one, and the card
  // falls back to naming the order rather than guessing at a direction.
  it.effect("stores no lifecycle for a fill the exchange did not label", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* setState({ fills: [fillAt(5_000, "2cd4".padEnd(32, "0"), "1", 701)] });

      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly direction: string | null }>`
        SELECT direction FROM trading_fills WHERE mission_id = ${MISSION} AND order_id = 701
      `;
      assert.equal(rows[0]?.direction, null);
    }),
  );

  // -------------------------------------------------------------------------
  // The high-water mark `pnl_giveback` reads. The exchange reports what a
  // position is worth now and never what it was worth at its best, so this
  // column is the only memory of the difference — and it has to survive the
  // reconcile that observes the give-back.
  // -------------------------------------------------------------------------
  const readPeak = () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly peak_unrealised_pnl: number | null }>`
        SELECT peak_unrealised_pnl FROM trading_position_snapshots
        WHERE mission_id = ${MISSION} AND market = 'ETH'
      `;
      return rows[0]?.peak_unrealised_pnl ?? null;
    });

  const clearinghouseWithPnl = (unrealizedPnl: string): WireClearinghouseStateResponse => ({
    ...longClearinghouse,
    assetPositions: [
      {
        position: { ...longClearinghouse.assetPositions[0]!.position, unrealizedPnl },
        type: "oneWay",
      },
    ],
  });

  it.effect("ratchets the peak up and holds it when the position gives profit back", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;

      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("20")) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), 20);

      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("35")) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), 35);

      // The give-back: current PnL falls, the peak does not follow it down.
      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("12")) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), 35);
    }),
  );

  it.effect("clears the peak when the mission goes flat, so the next position starts its own", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;

      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("35")) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), 35);

      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), null);

      // A fresh position inherits nothing from the one before it.
      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("4")) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), 4);
    }),
  );

  // A position that has never been in profit has no winner to give back, and
  // recording its worst loss as a "peak" would arm a give-back on a trade that
  // is simply losing — the stop's job, not this column's.
  it.effect("records no peak for a position that has only ever lost", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;

      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("-30")) });
      yield* reconciler.reconcile(input, "after_position_update");
      assert.equal(yield* readPeak(), 0);
    }),
  );

  // -------------------------------------------------------------------------
  // The closing self-review. A mission that closes a trade otherwise goes
  // quiet: the snapshot is blanked and the next turn starts from an empty
  // account with no memory of what the last one did. The excursions the review
  // reports cannot be reconstructed from the fills afterwards, which is why the
  // review is assembled on the pass that clears them.
  // -------------------------------------------------------------------------
  const readInboxSummaries = () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly summary: string; readonly payload_json: string }>`
        SELECT summary, payload_json FROM trading_event_inbox
        WHERE mission_id = ${MISSION} AND deduplication_key LIKE 'trade_closed:%'
      `;
    });

  /** A closing sell, priced and dated by the caller. */
  const sellFill = (time: number, closedPnl: string, fee: string) => ({
    coin: "ETH",
    side: "A" as const,
    px: "3020",
    sz: "2",
    time,
    fee,
    oid: 900,
    cloid: "c105e".padEnd(32, "0"),
    feeToken: "USDC",
    closedPnl,
  });

  it.effect("queues a review of the trade when a held position goes flat", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const openedAt = yield* Clock.currentTimeMillis;

      // Open at +20, run up to +35, then close — the exchange reports 25
      // realised, so 10 of the peak was given back.
      yield* setState({
        account: snapshotFromClearinghouse(clearinghouseWithPnl("20")),
        fills: [],
      });
      yield* reconciler.reconcile(input, "after_position_update");
      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("35")) });
      yield* reconciler.reconcile(input, "after_position_update");

      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        fills: [sellFill(openedAt + 1_000, "25", "1")],
      });
      const state = yield* reconciler.reconcile(input, "after_fill");

      const review = state.closedTrade;
      assert.equal(review?.direction, "long");
      assert.equal(review?.realizedPnlUsd, 25);
      assert.equal(review?.feesPaidUsd, 1);
      assert.equal(review?.netPnlUsd, 24);
      // The high-water mark survived the pass that cleared it.
      assert.equal(review?.peakUnrealisedPnlUsd, 35);
      assert.equal(review?.givebackFromPeakUsd, 10);
      assert.equal(review?.exitPrice, 3_020);

      // And it is in the inbox, which is where the wakeup reads it from.
      const queued = yield* readInboxSummaries();
      assert.equal(queued.length, 1);
      assert.match(queued[0]?.summary ?? "", /trade_closed: long 2 ETH/);
      assert.match(queued[0]?.summary ?? "", /NET \$24\.00/);
    }),
  );

  it.effect("records how far offside the trade went before it came back", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const openedAt = yield* Clock.currentTimeMillis;

      // Down 30 before it recovered to close at a small win. Afterwards the
      // fills alone cannot tell this apart from a trade that went straight up.
      yield* setState({
        account: snapshotFromClearinghouse(clearinghouseWithPnl("-30")),
        fills: [],
      });
      yield* reconciler.reconcile(input, "after_position_update");
      yield* setState({ account: snapshotFromClearinghouse(clearinghouseWithPnl("5")) });
      yield* reconciler.reconcile(input, "after_position_update");

      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        fills: [sellFill(openedAt + 1_000, "5", "1")],
      });
      const state = yield* reconciler.reconcile(input, "after_fill");

      assert.equal(state.closedTrade?.worstUnrealisedPnlUsd, -30);
      assert.equal(state.closedTrade?.peakUnrealisedPnlUsd, 5);
    }),
  );

  it.effect("keeps the closed trade after the turn that reads it", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const openedAt = yield* Clock.currentTimeMillis;

      yield* setState({
        account: snapshotFromClearinghouse(clearinghouseWithPnl("18")),
        fills: [],
      });
      yield* reconciler.reconcile(input, "after_position_update");
      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        fills: [sellFill(openedAt + 1_000, "18", "1")],
      });
      yield* reconciler.reconcile(input, "after_fill");

      // The inbox copy is a message the closing turn consumes. This row is what
      // calibration reads later, and `peak_unrealised_pnl` exists nowhere else
      // once the position snapshot has been cleared.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly net_pnl: number;
        readonly peak_unrealised_pnl: number;
        readonly direction: string;
      }>`
        SELECT net_pnl, peak_unrealised_pnl, direction
        FROM trading_closed_trades WHERE mission_id = ${MISSION}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.net_pnl, 17);
      assert.equal(rows[0]?.peak_unrealised_pnl, 18);
      assert.equal(rows[0]?.direction, "long");

      // A second pass over the same close does not count the trade twice.
      yield* reconciler.reconcile(input, "after_fill");
      const again = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_closed_trades WHERE mission_id = ${MISSION}
      `;
      assert.equal(again[0]?.c, 1);
    }),
  );

  it.effect("reviews nothing on a pass that finds the mission already flat", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;

      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse), fills: [] });
      const first = yield* reconciler.reconcile(input, "after_position_update");
      const second = yield* reconciler.reconcile(input, "after_position_update");

      assert.equal(first.closedTrade, null);
      assert.equal(second.closedTrade, null);
      assert.equal((yield* readInboxSummaries()).length, 0);
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
  // 3b. Abandoned executions: a record left mid-submission blocks every later
  //     entry through preview item 16, so a reconcile that finds no trace of it
  //     on the exchange has to settle it.
  // -------------------------------------------------------------------------

  /** Seed one mid-submission execution record + its reserved reservation. */
  const seedMidSubmission = (execId: string, cloid: string, updatedAt: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, strategy_version, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at,
          stop_price, planned_loss_at_stop_usd
        ) VALUES (
          ${execId}, ${MISSION}, ${1}, ${7}, ${"open"},
          ${cloid}, ${`idem_${execId}`}, ${"ETH"}, ${"buy"}, ${1}, ${3000},
          ${"ioc"}, ${0}, ${"0xsigner"}, ${"submitted"}, ${"[]"}, ${updatedAt}, ${updatedAt},
          ${null}, ${null}
        )
      `;
      yield* sql`
        INSERT INTO trading_risk_reservations (
          reservation_id, mission_id, execution_id, cloid, action_type,
          reserved_risk_usd, status, reserved_at
        ) VALUES (
          ${`res_${execId}`}, ${MISSION}, ${execId}, ${cloid}, ${"open"},
          ${10}, ${"reserved"}, ${updatedAt}
        )
      `;
    });

  const statusOf = (execId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM trading_execution_records WHERE execution_id = ${execId}
      `;
      return rows[0]?.status;
    });

  it.effect("fails an execution the exchange never saw, and releases its reservation", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const execId = "exec_abandoned";
      yield* seedMidSubmission(execId, "a".repeat(32), yield* Clock.currentTimeMillis);
      // Past the one-minute window, so silence now counts as evidence.
      yield* TestClock.adjust(Duration.minutes(2));

      // Nothing resting, nothing filled — the submission never reached the book.
      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse), orders: [] });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "before_execution");

      assert.equal(yield* statusOf(execId), "failed");
      const reservations = yield* sql<{ readonly status: string }>`
        SELECT status FROM trading_risk_reservations WHERE execution_id = ${execId}
      `;
      assert.equal(reservations[0]?.status, "released");
    }),
  );

  it.effect("leaves a record alone while its order is still resting", () =>
    Effect.gen(function* () {
      yield* migrated;
      const execId = "exec_resting";
      const cloid = "b".repeat(32);
      yield* seedMidSubmission(execId, cloid, yield* Clock.currentTimeMillis);
      yield* TestClock.adjust(Duration.minutes(2));

      // The exchange is holding the order — it reached the book, so the record
      // is genuinely in flight no matter how long ago it was written.
      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        orders: [order("b", 900, "buy", 3000, 1)],
      });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "before_execution");

      assert.equal(yield* statusOf(execId), "submitted");
    }),
  );

  it.effect("leaves a record alone that was written moments ago", () =>
    Effect.gen(function* () {
      yield* migrated;
      const execId = "exec_inflight";
      const now = yield* Clock.currentTimeMillis;
      yield* seedMidSubmission(execId, "c".repeat(32), now);

      // Silence this early proves nothing: the POST may still be in the air,
      // and settling it here is what would let a duplicate order go out.
      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse), orders: [] });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_submission");

      assert.equal(yield* statusOf(execId), "submitted");
    }),
  );

  // -------------------------------------------------------------------------
  // 3c. Accepted executions: `accepted` means the exchange took the order and
  //     it rests. Nothing about that settles itself — the submit response is
  //     the last word the submit path hears — so the reconciler has to carry
  //     the record to a terminal once canonical state resolves it.
  // -------------------------------------------------------------------------

  /** Seed one acknowledged (resting) execution record + its reservation. */
  const seedAccepted = (execId: string, cloid: string, updatedAt: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, strategy_version, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at,
          stop_price, planned_loss_at_stop_usd
        ) VALUES (
          ${execId}, ${MISSION}, ${1}, ${8}, ${"open"},
          ${cloid}, ${`idem_${execId}`}, ${"ETH"}, ${"buy"}, ${1}, ${3000},
          ${"gtc"}, ${0}, ${"0xsigner"}, ${"accepted"}, ${"[]"}, ${updatedAt}, ${updatedAt},
          ${null}, ${null}
        )
      `;
      yield* sql`
        INSERT INTO trading_risk_reservations (
          reservation_id, mission_id, execution_id, cloid, action_type,
          reserved_risk_usd, status, reserved_at
        ) VALUES (
          ${`res_${execId}`}, ${MISSION}, ${execId}, ${cloid}, ${"open"},
          ${10}, ${"reserved"}, ${updatedAt}
        )
      `;
    });

  const reservationStatusOf = (execId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM trading_risk_reservations WHERE execution_id = ${execId}
      `;
      return rows[0]?.status;
    });

  it.effect(
    "settles an accepted record that filled and left the book, releasing its reservation",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const execId = "exec_accepted_filled";
        const cloid = "d".repeat(32);
        yield* seedAccepted(execId, cloid, yield* Clock.currentTimeMillis);

        // The order is gone from the book and a canonical fill carries its cloid.
        yield* setState({
          account: snapshotFromClearinghouse(longClearinghouse),
          orders: [],
          fills: [fillAt(5_000, cloid, "1", 910, "0xhash_accepted")],
        });
        const reconciler = yield* HyperliquidReconciler;
        yield* reconciler.reconcile(input, "after_fill");

        assert.equal(yield* statusOf(execId), "filled");
        // Same pass: the settler runs before the reservation release.
        assert.equal(yield* reservationStatusOf(execId), "released");
      }),
  );

  it.effect("leaves an accepted record alone while its order still rests, unfilled", () =>
    Effect.gen(function* () {
      yield* migrated;
      const execId = "exec_accepted_resting";
      yield* seedAccepted(execId, "e".repeat(32), yield* Clock.currentTimeMillis);
      yield* TestClock.adjust(Duration.minutes(2));

      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        orders: [order("e", 911, "buy", 2950, 1)],
        fills: [],
      });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "periodic_while_position_open");

      assert.equal(yield* statusOf(execId), "accepted");
      assert.equal(yield* reservationStatusOf(execId), "reserved");
    }),
  );

  // The precedence case: a PARTIALLY filled order that is still resting. A
  // fill exists, so a fill-first settler would call it `filled` and release the
  // reservation while the remainder is still working — live size with nothing
  // reserved behind it. Live state has to win.
  it.effect("leaves an accepted record alone while it rests PARTIALLY filled", () =>
    Effect.gen(function* () {
      yield* migrated;
      const execId = "exec_accepted_partial";
      const cloid = "1".repeat(32);
      yield* seedAccepted(execId, cloid, yield* Clock.currentTimeMillis);
      yield* TestClock.adjust(Duration.minutes(2));

      yield* setState({
        account: snapshotFromClearinghouse(longClearinghouse),
        // Half filled; the other half is still on the book under the cloid.
        orders: [{ ...order("1", 912, "buy", 2950, 1), remainingSize: 0.5 }],
        fills: [fillAt(5_000, cloid, "0.5", 912, "0xhash_partial")],
      });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_fill");

      assert.equal(yield* statusOf(execId), "accepted");
      assert.equal(yield* reservationStatusOf(execId), "reserved");
    }),
  );

  it.effect("cancels an accepted record that left the book without filling", () =>
    Effect.gen(function* () {
      yield* migrated;
      const execId = "exec_accepted_cancelled";
      yield* seedAccepted(execId, "2".repeat(32), yield* Clock.currentTimeMillis);
      // Past the grace window, so absence from the book counts as evidence.
      yield* TestClock.adjust(Duration.minutes(2));

      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        orders: [],
        fills: [],
      });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "periodic_while_position_open");

      assert.equal(yield* statusOf(execId), "cancelled");
      assert.equal(yield* reservationStatusOf(execId), "released");
    }),
  );

  it.effect("leaves an accepted record alone when it vanished only moments ago", () =>
    Effect.gen(function* () {
      yield* migrated;
      const execId = "exec_accepted_recent";
      yield* seedAccepted(execId, "3".repeat(32), yield* Clock.currentTimeMillis);

      // Not yet visible is not the same as gone; settling here would call a
      // live order cancelled and release the risk behind it.
      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        orders: [],
        fills: [],
      });
      const reconciler = yield* HyperliquidReconciler;
      yield* reconciler.reconcile(input, "after_submission");

      assert.equal(yield* statusOf(execId), "accepted");
      assert.equal(yield* reservationStatusOf(execId), "reserved");
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

  // -------------------------------------------------------------------------
  // §18.2 external actions: a position that moved with no order of T3's behind
  // it is somebody acting on the exchange directly, and the harness has to be
  // told — it is still managing a position that may no longer exist.
  // -------------------------------------------------------------------------
  it.effect("classifies a hand-closed position as external_close and writes it to the inbox", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      const sql = yield* SqlClient.SqlClient;

      // Baseline: long 2 ETH, and the fill that opened it carries T3's cloid.
      yield* setState({
        account: snapshotFromClearinghouse(longClearinghouse),
        fills: [fillAt(1_000, "c0ffee".padEnd(32, "0"), "2", 100, "0xopen")],
      });
      const opened = yield* reconciler.reconcile(input, "after_fill");
      assert.deepEqual([...opened.externalChanges], []);

      // Now the exchange reports flat, and no NEW fill carries a cloid — the
      // position was closed from the Hyperliquid UI.
      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse) });
      const closed = yield* reconciler.reconcile(input, "periodic_while_position_open");

      assert.equal(closed.externalChanges.length, 1);
      assert.equal(closed.externalChanges[0]?.kind, "external_close");

      const events = yield* sql<{ readonly summary: string; readonly category: string }>`
        SELECT summary, category FROM trading_event_inbox
        WHERE mission_id = ${MISSION} AND deduplication_key LIKE 'external_%'
      `;
      assert.equal(events.length, 1);
      assert.equal(events[0]?.category, "exchange");
      assert.include(events[0]?.summary ?? "", "external_close");
    }),
  );

  it.effect("attributes a change to T3 when a fill under one of its cloids explains it", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;

      yield* setState({
        account: snapshotFromClearinghouse(longClearinghouse),
        fills: [fillAt(1_000, "c0ffee".padEnd(32, "0"), "2", 100, "0xopen")],
      });
      const opened = yield* reconciler.reconcile(input, "after_fill");

      // Flat again — but this time a fill with T3's cloid landed after the
      // previous observation, which is a stop-out or a close T3 asked for.
      yield* setState({
        account: snapshotFromClearinghouse(flatClearinghouse),
        fills: [
          fillAt(1_000, "c0ffee".padEnd(32, "0"), "2", 100, "0xopen"),
          fillAt(opened.observedAt + 1, "beefed".padEnd(32, "0"), "2", 101, "0xclose"),
        ],
      });
      const closed = yield* reconciler.reconcile(input, "after_fill");

      assert.deepEqual([...closed.externalChanges], []);
    }),
  );

  it.effect("says nothing on the first pass, when there is no baseline to diff", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      yield* setState({ account: snapshotFromClearinghouse(longClearinghouse), fills: [] });

      const first = yield* reconciler.reconcile(input, "server_startup");
      assert.deepEqual([...first.externalChanges], []);
    }),
  );

  it.effect("reports a balance jump on a flat mission as an external_transfer", () =>
    Effect.gen(function* () {
      yield* migrated;
      const reconciler = yield* HyperliquidReconciler;
      yield* setState({ account: snapshotFromClearinghouse(flatClearinghouse), fills: [] });
      yield* reconciler.reconcile(input, "server_startup");

      const funded: WireClearinghouseStateResponse = {
        ...flatClearinghouse,
        marginSummary: { accountValue: "1500", totalMarginUsed: "0" },
        withdrawable: "1500",
      };
      yield* setState({ account: snapshotFromClearinghouse(funded) });
      const after = yield* reconciler.reconcile(input, "periodic_while_position_open");

      assert.equal(after.externalChanges.length, 1);
      assert.equal(after.externalChanges[0]?.kind, "external_transfer");
    }),
  );

  // -------------------------------------------------------------------------
  // The account-wide userFills read must not hand a new mission the previous
  // mission's history: a fresh thread opened showing the old thread's fills.
  // -------------------------------------------------------------------------
  it.effect("keeps only fills traded since the mission started", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedMission(10_000);
      yield* setState({
        fills: [
          // A previous mission's fill, still inside the userFills window.
          fillAt(9_000, "0ldm1s".padEnd(32, "0"), "1", 100, "0xold"),
          fillAt(11_000, "c0ffee".padEnd(32, "0"), "1", 101, "0xnew"),
        ],
      });
      const reconciler = yield* HyperliquidReconciler;

      const state = yield* reconciler.reconcile(input, "after_fill");

      assert.deepEqual(
        state.fills.map((f) => f.tradedAt),
        [11_000],
      );
      const rows = yield* sql<{ readonly traded_at: number }>`
        SELECT traded_at FROM trading_fills WHERE mission_id = ${MISSION}
      `;
      assert.deepEqual(
        rows.map((r) => r.traded_at),
        [11_000],
      );
    }),
  );

  it.effect("deletes pre-mission fills an earlier build already adopted", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedMission(10_000);
      yield* sql`
        INSERT INTO trading_fills (
          fill_id, mission_id, cloid, order_id, market, side, filled_size,
          avg_fill_price, fee_usd, fee_token, closed_pnl, traded_at, observed_at
        ) VALUES (
          'stale', ${MISSION}, NULL, 42, 'ETH', 'sell', 1, 1800, 0.5, 'USDC', -1, 9_000, 9_000
        )
      `;
      yield* setState({ fills: [fillAt(11_000, "c0ffee".padEnd(32, "0"), "1", 101, "0xnew")] });
      const reconciler = yield* HyperliquidReconciler;

      yield* reconciler.reconcile(input, "after_fill");

      const rows = yield* sql<{ readonly fill_id: string }>`
        SELECT fill_id FROM trading_fills WHERE mission_id = ${MISSION}
      `;
      assert.deepEqual(
        rows.map((r) => r.fill_id),
        ["0xnew-101-11000-3000-1-0"],
      );
    }),
  );
});
