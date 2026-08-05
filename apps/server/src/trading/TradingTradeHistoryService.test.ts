/**
 * The mission reading back its own trades.
 *
 * The two things worth pinning are the two the harness would otherwise get
 * wrong on its own: that a market order's dozen partials are one order rather
 * than a dozen decisions, and that each order is scored against the strategy
 * version that was actually in force when it filled, not against the current
 * one.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  TradingTradeHistoryService,
  TradingTradeHistoryServiceLive,
} from "./TradingTradeHistoryService.ts";

const layer = it.layer(
  TradingTradeHistoryServiceLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const MISSION = "mission_history";

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 47 });
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
});

/** One partial fill, as the reconciler persists them. */
const insertFill = (input: {
  readonly fillId: string;
  readonly orderId: number;
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly price: number;
  readonly fee: number;
  readonly closedPnl: number;
  readonly tradedAt: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_fills (
        fill_id, mission_id, execution_id, cloid, order_id, market, side,
        filled_size, avg_fill_price, fee_usd, fee_token, closed_pnl,
        traded_at, observed_at
      ) VALUES (
        ${input.fillId}, ${MISSION}, NULL, ${`cloid_${input.orderId}`}, ${input.orderId},
        'ETH', ${input.side}, ${input.size}, ${input.price}, ${input.fee}, 'USDC',
        ${input.closedPnl}, ${input.tradedAt}, ${input.tradedAt}
      )
    `;
  });

/** A published strategy version, with only the fields the history reads. */
const insertStrategy = (version: number, targetProfitUsd: number, createdAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Written as text rather than encoded: the history reads one field out of
    // this column with `json_extract`, so the row only has to carry that field.
    const json = `{"protection":{"targetProfitUsd":${targetProfitUsd}}}`;
    yield* sql`
      INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
      VALUES (${MISSION}, ${version}, ${json}, ${createdAt})
    `;
  });

layer("TradingTradeHistoryService", (it) => {
  it.effect("aggregates an order's partials into the order that was placed", () =>
    Effect.gen(function* () {
      yield* migrated;
      // One buy that crossed the book in three slices, at three prices.
      yield* insertFill({
        fillId: "f1",
        orderId: 100,
        side: "buy",
        size: 1,
        price: 3_000,
        fee: 0.3,
        closedPnl: 0,
        tradedAt: 1_000,
      });
      yield* insertFill({
        fillId: "f2",
        orderId: 100,
        side: "buy",
        size: 2,
        price: 3_003,
        fee: 0.6,
        closedPnl: 0,
        tradedAt: 1_100,
      });
      yield* insertFill({
        fillId: "f3",
        orderId: 100,
        side: "buy",
        size: 1,
        price: 3_006,
        fee: 0.3,
        closedPnl: 0,
        tradedAt: 1_200,
      });

      const history = yield* TradingTradeHistoryService;
      const read = yield* history.read({ missionId: MISSION });

      assert.equal(read.orders.length, 1);
      const order = read.orders[0];
      assert.equal(order?.filledSize, 4);
      assert.equal(order?.fillCount, 3);
      // Size-weighted, not the plain mean of the three prices (3,003).
      assert.closeTo(order?.avgFillPrice ?? 0, (3_000 + 2 * 3_003 + 3_006) / 4, 1e-9);
      assert.closeTo(order?.feeUsd ?? 0, 1.2, 1e-9);
      assert.equal(order?.firstFillAt, 1_000);
      assert.equal(order?.lastFillAt, 1_200);
    }),
  );

  it.effect("reports each order net of its own fee, and scores only the closers", () =>
    Effect.gen(function* () {
      yield* migrated;
      // An entry (no realised result yet) and a close that made 10 gross.
      yield* insertFill({
        fillId: "f1",
        orderId: 100,
        side: "buy",
        size: 1,
        price: 3_000,
        fee: 1,
        closedPnl: 0,
        tradedAt: 1_000,
      });
      yield* insertFill({
        fillId: "f2",
        orderId: 200,
        side: "sell",
        size: 1,
        price: 3_010,
        fee: 1,
        closedPnl: 10,
        tradedAt: 2_000,
      });

      const history = yield* TradingTradeHistoryService;
      const read = yield* history.read({ missionId: MISSION });

      assert.equal(read.orders[0]?.orderId, 200);
      assert.equal(read.orders[0]?.netPnlUsd, 9);
      assert.equal(read.summary.realizedPnlUsd, 10);
      assert.equal(read.summary.feesPaidUsd, 2);
      assert.equal(read.summary.netPnlUsd, 8);
      // The entry has no result to score, so it is neither a win nor a loss —
      // counting it as a loss the size of its own fee is the trap here.
      assert.equal(read.summary.winningOrders, 1);
      assert.equal(read.summary.losingOrders, 0);
      assert.equal(read.summary.orderCount, 2);
    }),
  );

  it.effect("attributes each order to the strategy version in force when it filled", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertStrategy(1, 5, 1_000);
      yield* insertStrategy(2, 12, 5_000);
      yield* insertFill({
        fillId: "f1",
        orderId: 100,
        side: "sell",
        size: 1,
        price: 3_010,
        fee: 1,
        closedPnl: 4,
        tradedAt: 2_000,
      });
      yield* insertFill({
        fillId: "f2",
        orderId: 200,
        side: "sell",
        size: 1,
        price: 3_020,
        fee: 1,
        closedPnl: 11,
        tradedAt: 6_000,
      });

      const history = yield* TradingTradeHistoryService;
      const read = yield* history.read({ missionId: MISSION });

      // Newest first: the order under v2, then the one under v1. A loss taken
      // under an abandoned thesis has to stay attached to that thesis.
      assert.equal(read.orders[0]?.strategyVersion, 2);
      assert.equal(read.orders[0]?.targetProfitUsd, 12);
      assert.equal(read.orders[1]?.strategyVersion, 1);
      assert.equal(read.orders[1]?.targetProfitUsd, 5);
    }),
  );

  it.effect("leaves the version off an order that filled before the first publish", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertStrategy(1, 5, 5_000);
      yield* insertFill({
        fillId: "f1",
        orderId: 100,
        side: "buy",
        size: 1,
        price: 3_000,
        fee: 1,
        closedPnl: 0,
        tradedAt: 1_000,
      });

      const history = yield* TradingTradeHistoryService;
      const read = yield* history.read({ missionId: MISSION });

      assert.equal(read.orders[0]?.strategyVersion, undefined);
      assert.equal(read.orders[0]?.targetProfitUsd, undefined);
    }),
  );

  it.effect("summarises every order even when the page shows one", () =>
    Effect.gen(function* () {
      yield* migrated;
      for (let i = 0; i < 4; i++) {
        yield* insertFill({
          fillId: `f${i}`,
          orderId: 100 + i,
          side: "sell",
          size: 1,
          price: 3_000,
          fee: 1,
          closedPnl: 5,
          tradedAt: 1_000 + i,
        });
      }

      const history = yield* TradingTradeHistoryService;
      const read = yield* history.read({ missionId: MISSION, limit: 1 });

      assert.equal(read.orders.length, 1);
      // A summary built from the page would report 5 realised, not 20 — which
      // would flatter any mission that traded more than the page is long.
      assert.equal(read.summary.orderCount, 4);
      assert.equal(read.summary.realizedPnlUsd, 20);
      assert.equal(read.summary.netPnlUsd, 16);
    }),
  );

  it.effect("answers a mission that has never traded with zeroes, not an error", () =>
    Effect.gen(function* () {
      yield* migrated;
      const history = yield* TradingTradeHistoryService;
      const read = yield* history.read({ missionId: MISSION });

      assert.deepEqual([...read.orders], []);
      assert.equal(read.summary.orderCount, 0);
      assert.equal(read.summary.netPnlUsd, 0);
      assert.equal(read.summary.firstFillAt, undefined);
    }),
  );
});
