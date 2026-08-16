/**
 * TradingWorkingOrderService — plan 29 step 2.4.
 *
 * The properties worth proving are about ordering and identity: that a
 * replacement only ever goes out after the old order is confirmed GONE (two
 * resting entries are double exposure), that the replacement carries the
 * approved size/side/stop and nothing else, that the wait accumulates through
 * re-prices instead of resetting, and that every terminal outcome says so in
 * one line the reactor can hand the model.
 *
 * The exchange is a small state machine (a position, a book, a set of resting
 * orders) and the records table is a real in-memory SQLite, because the loop
 * derives its state from both — a stub on either side could not distinguish
 * "re-priced at the near side" from "re-placed at the stale price".
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import type {
  TradingExecutionRecord,
  TradingOrderIntent,
} from "@t3tools/trading-contracts/execution";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import {
  makeTradingWorkingOrderService,
  type TradingWorkingOrderService,
  type WorkingOrderInput,
  WORKING_ORDER_MAX_WAIT_MILLIS,
} from "./TradingWorkingOrderService.ts";

const MISSION = "mission_working";
const MASTER = "0xmaster";
/** All passes decide against this instant; records are seeded relative to it. */
const NOW = 1_000_000;
const CLOID = "0xworkingentry0000000000000000001";

const INPUT: WorkingOrderInput = {
  missionId: MISSION,
  masterAddress: MASTER,
  market: "ETH",
  missionStatus: "waiting",
  nowMs: NOW,
  allowedSlippageBps: 20,
};

/** A resting non-reduce-only limit — the working entry's wire shape. */
const restingEntry = (
  cloid: string,
  limitPrice: number,
  overrides: Partial<AgentOpenOrder> = {},
): AgentOpenOrder =>
  ({
    market: "ETH",
    orderId: 11,
    cloid,
    side: "buy",
    limitPrice,
    size: 0.5,
    remainingSize: 0.5,
    status: "open",
    createdAt: NOW - 30_000,
    reduceOnly: false,
    isTrigger: false,
    orderType: "Limit",
    ...overrides,
  }) as AgentOpenOrder;

/** What a working-entry placement does, as far as canonical state shows. */
type PlacementBehaviour = "rest" | "fill" | "no_fill";

/**
 * The exchange as far as this service can tell: a position, a book, resting
 * orders, and a record of what was asked of it.
 */
interface FakeExchange {
  positionSize: number;
  bestBid: number;
  bestAsk: number;
  orders: AgentOpenOrder[];
  cancels: string[];
  placements: Array<{ readonly intent: TradingOrderIntent; readonly reservedRiskUsd: number }>;
  /** What the next working-entry placement does to canonical state. */
  placementBehaviour: PlacementBehaviour;
  /** Every exchange touch, in order. */
  log: Array<"cancel" | "place">;
}

const makeFake = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: 0,
  bestBid: 2_998,
  bestAsk: 3_002,
  orders: [],
  cancels: [],
  placements: [],
  placementBehaviour: "rest",
  log: [],
  ...overrides,
});

const gatewayLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.succeed({
        positions:
          fake.positionSize === 0
            ? []
            : [
                {
                  market: "ETH",
                  size: fake.positionSize,
                  entryPrice: 3_000,
                  unrealisedPnl: 0,
                  marginUsed: 100,
                },
              ],
      }),
    getOpenOrders: () => Effect.succeed(fake.orders),
    getOrderBook: () =>
      Effect.succeed({ bestBidOffer: { bidPrice: fake.bestBid, askPrice: fake.bestAsk } }),
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const executionLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitCancel: (input: { readonly cloid: string }) =>
      Effect.sync(() => {
        fake.log.push("cancel");
        fake.cancels.push(input.cloid);
        fake.orders = fake.orders.filter((o) => o.cloid !== input.cloid);
      }),
    /**
     * The constrained preview-free path, faked at the exchange boundary: the
     * intent and the carried reservation are recorded verbatim, and the
     * placement behaves as the test wants canonical state to show. The fake
     * does NOT build the grouped action — the real path grouping entry and
     * stop child is the execution service's own suite; what this suite proves
     * is that the intent handed to it always carries the approved stop.
     */
    submitWorkingEntry: (input: {
      readonly intent: TradingOrderIntent;
      readonly reservedRiskUsd: number;
    }) =>
      Effect.sync(() => {
        fake.log.push("place");
        fake.placements.push({ intent: input.intent, reservedRiskUsd: input.reservedRiskUsd });
        const cloid = `0xplaced${fake.placements.length}`;
        const record = {
          cloid,
          status: "accepted",
        } as TradingExecutionRecord;
        if (fake.placementBehaviour === "rest") {
          fake.orders.push(
            restingEntry(cloid, input.intent.limitPrice, { side: input.intent.side }),
          );
        } else if (fake.placementBehaviour === "fill") {
          fake.positionSize = input.intent.side === "buy" ? input.intent.size : -input.intent.size;
        }
        // "no_fill": the IOC went out and nothing came back — no position,
        // nothing resting. That is the cross that failed.
        return record;
      }),
    submitOrder: () => Effect.die("the working loop must never use the preview path"),
    submitProtectiveStop: () => Effect.die("not used"),
    submitReduceOnlyIoc: () => Effect.die("not used"),
    submitReduceOnlyAlo: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

/** Seed one execution record; `ageMsAgo` and `movedMsAgo` set the timestamps. */
const seedRecord = Effect.fn("seedRecord")(function* (input: {
  readonly cloid: string;
  readonly ageMsAgo: number;
  readonly movedMsAgo?: number | undefined;
  readonly status?: string | undefined;
  readonly size?: number | undefined;
  readonly stopPrice?: number | undefined;
  readonly side?: "buy" | "sell" | undefined;
  readonly actionType?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const {
    cloid,
    ageMsAgo,
    movedMsAgo = ageMsAgo,
    status = "accepted",
    size = 0.5,
    stopPrice = 2_950,
    side = "buy",
    actionType = "open",
  } = input;
  yield* sql`
    INSERT INTO trading_execution_records (
      execution_id, mission_id, execution_sequence, action_type,
      cloid, idempotency_key, market, side, size, limit_price, time_in_force,
      reduce_only, signer_address, status, order_results_json, created_at, updated_at,
      stop_price, planned_loss_at_stop_usd
    ) VALUES (
      ${`exec_${cloid}`}, ${MISSION}, ${cloid.length}, ${actionType},
      ${cloid}, ${`idem_${cloid}`}, 'ETH', ${side}, ${size}, 2_990, 'alo',
      0, ${MASTER}, ${status}, '[]', ${NOW - ageMsAgo}, ${NOW - movedMsAgo},
      ${stopPrice}, 8
    )
  `.pipe(Effect.orDie);
});

/** Seed the reservation the original approval reserved. */
const seedReservation = Effect.fn("seedReservation")(function* (cloid: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO trading_risk_reservations (
      reservation_id, mission_id, execution_id, cloid, action_type,
      reserved_risk_usd, status, reserved_at
    ) VALUES (
      ${`res_${cloid}`}, ${MISSION}, ${`exec_${cloid}`}, ${cloid}, 'open',
      12.5, 'reserved', ${NOW}
    )
  `.pipe(Effect.orDie);
});

const runWith = <A, E>(
  fake: FakeExchange,
  body: (service: TradingWorkingOrderService["Service"]) => Effect.Effect<A, E>,
  seed: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    // A seed that fails is a broken fixture, not a behaviour to assert on:
    // it dies loudly rather than surfacing as a test outcome.
    yield* runMigrations().pipe(Effect.orDie);
    yield* seed;
    const service = yield* makeTradingWorkingOrderService;
    return yield* body(service);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(gatewayLayer(fake), executionLayer(fake), NodeSqliteClient.layerMemory()),
    ),
  );

/**
 * The service polls inside the confirmation window. Under TestClock those
 * sleeps never advance on their own, so the body runs forked and the clock is
 * advanced in steps until the body is done — a single advance is not enough,
 * because a sleep scheduled after it would never fire.
 */
const runWithClock = <A, E>(
  fake: FakeExchange,
  body: (service: TradingWorkingOrderService["Service"]) => Effect.Effect<A, E>,
  seed: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    const fiber = yield* runWith(fake, body, seed).pipe(Effect.forkChild);
    for (let step = 0; step < 120; step++) {
      yield* Effect.yieldNow;
      if (fiber.pollUnsafe() !== undefined) break;
      yield* TestClock.adjust("1 second");
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped);

const runReconcile = (
  fake: FakeExchange,
  input: WorkingOrderInput = INPUT,
  seed: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) => runWithClock(fake, (service) => service.reconcile(input), seed);

// --- what the loop does while the entry simply rests --------------------------

it.effect("does nothing when no working entry exists", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runReconcile(fake);

    assert.equal(outcome.status, "no_working_order");
    assert.deepEqual(fake.cancels, []);
    assert.deepEqual(fake.placements, []);
  }),
);

it.effect("does nothing while a position exists — the stop machinery owns it", () =>
  Effect.gen(function* () {
    // A filled entry: the position (even a partially filled one) is the stop
    // machinery's world, not this loop's.
    const fake = makeFake({ positionSize: 0.5, orders: [restingEntry(CLOID, 2_990)] });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 120_000 }),
    );

    assert.equal(outcome.status, "position_open");
    assert.deepEqual(fake.cancels, []);
    assert.deepEqual(fake.placements, []);
    // The resting entry was not touched either.
    assert.equal(fake.orders.length, 1);
  }),
);

it.effect("rests untouched while under both the cadence and the max wait", () =>
  Effect.gen(function* () {
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_990)] });
    // Placed 10s ago (under the 15s cadence) and 80s under the 90s max wait.
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 10_000 }),
    );

    assert.equal(outcome.status, "resting");
    assert.deepEqual(fake.cancels, []);
    assert.deepEqual(fake.placements, []);
  }),
);

it.effect("does not re-price an entry already at the near side", () =>
  Effect.gen(function* () {
    // Churn, not ownership: the book's near side for a buy is the 2998 bid.
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_998)] });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 30_000 }),
    );

    assert.equal(outcome.status, "resting");
    assert.deepEqual(fake.placements, []);
  }),
);

// --- the re-price ---------------------------------------------------------------

it.effect("re-prices on cadence to the near side with the identical size and stop", () =>
  Effect.gen(function* () {
    // The order rests at 2990, 20s after it was placed (past the 15s cadence),
    // and the market has moved up: the near side is now the 2998 bid.
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_990)] });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      Effect.gen(function* () {
        yield* seedRecord({ cloid: CLOID, ageMsAgo: 20_000 });
        yield* seedReservation(CLOID);
      }),
    );

    assert.equal(outcome.status, "repriced");
    // Cancel first, confirm, then place — never the other way around.
    assert.deepEqual(fake.log, ["cancel", "place"]);
    assert.deepEqual(fake.cancels, [CLOID]);
    assert.equal(fake.placements.length, 1);

    const placed = fake.placements[0]!;
    // The envelope is the approval's, unchanged: side, size, stop.
    assert.equal(placed.intent.side, "buy");
    assert.equal(placed.intent.size, 0.5);
    assert.equal(placed.intent.stop?.stopPrice, 2_950);
    assert.equal(placed.intent.stop?.plannedLossAtStopUsd, 8);
    // The new price is the CURRENT near side, still post-only.
    assert.equal(placed.intent.limitPrice, 2_998);
    assert.equal(placed.intent.orderPreference, "post_only");
    // The reservation is carried from the approval, not recomputed.
    assert.equal(placed.reservedRiskUsd, 12.5);
    // The replacement rests under its own cloid, replacing the old one.
    assert.equal(fake.orders.length, 1);
    assert.equal(fake.orders[0]!.cloid, "0xplaced1");
  }),
);

it.effect("re-prices a sell at the ask — the near side flips with the side", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      orders: [restingEntry(CLOID, 3_010, { side: "sell" })],
    });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 20_000, side: "sell" }),
    );

    assert.equal(outcome.status, "repriced");
    assert.equal(fake.placements[0]!.intent.side, "sell");
    // A sell joins the ask, not the bid.
    assert.equal(fake.placements[0]!.intent.limitPrice, 3_002);
  }),
);

it.effect("the wait accumulates through re-prices instead of resetting", () =>
  Effect.gen(function* () {
    // A lineage: the original approval 80s ago, already re-priced once 20s
    // ago. Under the 90s max wait — so the pass re-prices again — but the
    // wait reported is the ORIGINAL's 80s, not the replacement's 20s.
    const replacement = "0xworkingentry00000000000000002";
    const fake = makeFake({ orders: [restingEntry(replacement, 2_990)] });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      Effect.gen(function* () {
        yield* seedRecord({ cloid: CLOID, ageMsAgo: 80_000, status: "cancelled" });
        yield* seedRecord({ cloid: replacement, ageMsAgo: 20_000 });
      }),
    );

    assert.equal(outcome.status, "repriced");
    assert.equal(outcome.repriceCount, 1);
    assert.equal(outcome.waitMillis, 80_000);
    // The cancel named the resting order, not the original.
    assert.deepEqual(fake.cancels, [replacement]);
  }),
);

it.effect("the stop child is re-armed on every replacement — the intent always carries it", () =>
  Effect.gen(function* () {
    // The grouped action the real execution service builds derives its stop
    // child from the intent's stop. A replacement whose intent lost the stop
    // would rest an entry whose fill finds no protection — the one invariant
    // this loop must never break. Both placement kinds are checked: the
    // re-price and the cross.
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_990)] });
    const crossedFake = makeFake({
      placementBehaviour: "fill",
      orders: [restingEntry(CLOID, 2_990)],
    });
    const reprice = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 20_000 }),
    );
    const cross = yield* runReconcile(
      crossedFake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: WORKING_ORDER_MAX_WAIT_MILLIS + 1_000 }),
    );

    assert.equal(reprice.status, "repriced");
    assert.equal(cross.status, "crossed");
    for (const placed of [...fake.placements, ...crossedFake.placements]) {
      assert.deepEqual(placed.intent.stop, { stopPrice: 2_950, plannedLossAtStopUsd: 8 });
    }
  }),
);

// --- the cross -------------------------------------------------------------------

it.effect("crosses with a marketable IOC once the max wait is up", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      placementBehaviour: "fill",
      orders: [restingEntry(CLOID, 2_990)],
    });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      Effect.gen(function* () {
        yield* seedRecord({ cloid: CLOID, ageMsAgo: WORKING_ORDER_MAX_WAIT_MILLIS + 1_000 });
        yield* seedReservation(CLOID);
      }),
    );

    assert.equal(outcome.status, "crossed");
    // The resting entry was cancelled before anything crossed.
    assert.deepEqual(fake.cancels, [CLOID]);
    assert.equal(fake.placements.length, 1);
    const placed = fake.placements[0]!;
    // The cross is the urgency-"now" path: a marketable IOC, same envelope.
    assert.equal(placed.intent.orderPreference, "marketable_ioc");
    assert.equal(placed.intent.size, 0.5);
    assert.equal(placed.intent.stop?.stopPrice, 2_950);
    assert.equal(placed.reservedRiskUsd, 12.5);
    // The proof of a cross is a position.
    assert.equal(fake.positionSize, 0.5);
    // The handed-back intent is the one that crossed, so the caller can run
    // the post-fill protection reconcile against it.
    assert.isDefined(outcome.placedIntent);
    assert.equal(outcome.placedIntent?.actionType, "open");
    // And the model is told, in one line.
    assert.ok(outcome.summary?.includes("crossed"));
  }),
);

it.effect("a cross that does not fill abandons and says so", () =>
  Effect.gen(function* () {
    // The IOC went out and the book took nothing: no position, nothing
    // resting. The entry is over and the model must hear it.
    const fake = makeFake({
      placementBehaviour: "no_fill",
      orders: [restingEntry(CLOID, 2_990)],
    });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: WORKING_ORDER_MAX_WAIT_MILLIS + 1_000 }),
    );

    assert.equal(outcome.status, "abandoned");
    assert.deepEqual(fake.cancels, [CLOID]);
    assert.ok(outcome.summary?.includes("did not fill"));
    assert.equal(fake.positionSize, 0);
  }),
);

// --- the abandon -----------------------------------------------------------------

it.effect("abandons an entry that left the book without filling", () =>
  Effect.gen(function* () {
    // Cancelled by hand, expired, or a replacement that never confirmed —
    // from here they are all "gone without a fill", and the entry is not
    // resurrected.
    const fake = makeFake();
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 30_000 }),
    );

    assert.equal(outcome.status, "abandoned");
    assert.ok(outcome.summary?.includes("left the book unfilled"));
    assert.deepEqual(fake.placements, []);
  }),
);

it.effect("abandons the entry when the mission stops wanting new exposure", () =>
  Effect.gen(function* () {
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_990)] });
    const outcome = yield* runReconcile(
      fake,
      { ...INPUT, missionStatus: "paused" },
      seedRecord({ cloid: CLOID, ageMsAgo: 10_000 }),
    );

    assert.equal(outcome.status, "abandoned");
    assert.deepEqual(fake.cancels, [CLOID]);
    assert.ok(outcome.summary?.includes("paused"));
    assert.deepEqual(fake.placements, []);
  }),
);

it.effect("a filled-then-closed lineage is history, not a working order", () =>
  Effect.gen(function* () {
    // The record is still `accepted` (the reconciler has a one-minute grace
    // before it settles) but a fill exists under its cloid: it did its job.
    // Reporting that as an abandonment would tell the model a lie.
    const sql = Effect.gen(function* () {
      yield* seedRecord({ cloid: CLOID, ageMsAgo: 30_000 });
      const client = yield* SqlClient.SqlClient;
      yield* client`
        INSERT INTO trading_fills (
          fill_id, mission_id, execution_id, cloid, order_id, market, side,
          filled_size, avg_fill_price, fee_usd, fee_token, closed_pnl,
          direction, crossed, traded_at, observed_at
        ) VALUES (
          'fill_1', ${MISSION}, ${`exec_${CLOID}`}, ${CLOID}, 11, 'ETH', 'buy',
          0.5, 2990, 0.1, 'USDC', 0, 'Open Long', 0, ${NOW - 5_000}, ${NOW}
        )
      `.pipe(Effect.orDie);
    });
    const fake = makeFake();
    const outcome = yield* runReconcile(fake, INPUT, sql);

    assert.equal(outcome.status, "no_working_order");
    assert.deepEqual(fake.cancels, []);
  }),
);

// --- the hard constraint on the preview-free path -------------------------------

it.effect("refuses to work an order whose size no longer matches the approval", () =>
  Effect.gen(function* () {
    // The resting order drifted from the approved 0.5 — a mutated intent
    // wearing the approval's cloid. The preview-free path has no checklist to
    // catch that; this refusal is the check. Nothing is cancelled, nothing is
    // placed, and the pass says why.
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_990, { size: 0.4 })] });
    const outcome = yield* runReconcile(
      fake,
      INPUT,
      seedRecord({ cloid: CLOID, ageMsAgo: 30_000 }),
    );

    assert.equal(outcome.status, "failed");
    assert.ok(outcome.detail?.includes("does not match the approved"));
    assert.deepEqual(fake.cancels, []);
    assert.deepEqual(fake.placements, []);
  }),
);

// --- the direct withdrawal -------------------------------------------------------

it.effect("withdraws resting entries directly, without replacing them", () =>
  Effect.gen(function* () {
    const fake = makeFake({ orders: [restingEntry(CLOID, 2_990)] });
    const outcome = yield* runWithClock(fake, (service) =>
      service.abandon({
        missionId: MISSION,
        masterAddress: MASTER,
        market: "ETH",
        nowMs: NOW,
      }),
    );

    assert.equal(outcome.found, true);
    assert.deepEqual(outcome.cancelledCloids, [CLOID]);
    assert.deepEqual(fake.placements, []);
    // A reduce-only trigger or a cloid-less UI order is not ours to cancel.
    assert.equal(fake.cancels.length, 1);
  }),
);

it.effect("the direct withdrawal leaves reduce-only and trigger orders alone", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      orders: [
        { ...restingEntry("0xstop", 2_950), reduceOnly: true, isTrigger: true },
        { ...restingEntry("0xui", 2_995), cloid: undefined },
      ],
    });
    const outcome = yield* runWithClock(fake, (service) =>
      service.abandon({
        missionId: MISSION,
        masterAddress: MASTER,
        market: "ETH",
        nowMs: NOW,
      }),
    );

    assert.equal(outcome.found, false);
    assert.deepEqual(fake.cancels, []);
  }),
);
