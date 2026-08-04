/**
 * TradingMissionProjection — the fill receipts the thread cards render.
 *
 * Hyperliquid fills a market order in as many slices as it takes to cross the
 * book, so a single 3 ETH entry lands in `trading_fills` as a dozen rows of a
 * few hundredths each. The projection has to hand the UI the ORDER, because the
 * order is what the operator placed and what the exchange's own trade history
 * shows. Reading the slices back raw put "Sell 0.044 ETH · fee $0.01 · realized
 * -$0.05" on the receipt for a trade that sold three ETH and lost twenty
 * dollars — every figure a true fact about a fraction of the trade, and the
 * card as a whole wrong.
 *
 * In-memory sqlite + migrations, following TradingBudgetReader.test.ts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Schema from "effect/Schema";

import { pocAuthorityDefaults, TradingAuthority } from "@t3tools/trading-contracts/authority";
import { TradingHarnessBinding, TradingMissionControl } from "@t3tools/trading-contracts/mission";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  TradingMissionProjection,
  TradingMissionProjectionLive,
} from "./TradingMissionProjection.ts";

const layer = it.layer(
  TradingMissionProjectionLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const encodeAuthority = Schema.encodeSync(Schema.fromJsonString(TradingAuthority));
const encodeControl = Schema.encodeSync(Schema.fromJsonString(TradingMissionControl));
const encodeHarness = Schema.encodeSync(Schema.fromJsonString(TradingHarnessBinding));

const MISSION_ID = "mission_1";
const THREAD_ID = "thread_1";

/** One projection row, so `getByThreadId` has a mission to hang fills off. */
const seedMission = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM projection_trading_missions`;
  yield* sql`
    INSERT INTO projection_trading_missions (
      mission_id, thread_id, user_id, trading_account_id, instruction, market,
      strategy_family, status, blocked_reason, authority_json, authority_version,
      strategy_json, strategy_version, watches_json, control_json, harness_json,
      created_at, updated_at
    ) VALUES (
      ${MISSION_ID}, ${THREAD_ID}, 'user_1', 'hyperliquid-testnet', 'trade ETH', 'ETH',
      'momentum', 'waiting', NULL, ${encodeAuthority(pocAuthorityDefaults(1000))}, 1,
      NULL, 0, '[]',
      ${encodeControl({
        entriesAllowed: true,
        reentryAllowed: true,
        pauseAfterPositionClose: false,
      })},
      ${encodeHarness({
        provider: "claude",
        providerInstanceId: "provider_1",
        threadId: THREAD_ID,
        status: "available",
      })},
      '2026-08-04T23:00:00.000Z', '2026-08-04T23:20:00.000Z'
    )
  `;
});

/** One partial fill of an order, as the reconciler writes them. */
const seedFill = (fill: {
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
        fill_id, mission_id, cloid, order_id, market, side, filled_size,
        avg_fill_price, fee_usd, fee_token, closed_pnl, traded_at, observed_at
      ) VALUES (
        ${fill.fillId}, ${MISSION_ID}, ${`0xcloid${fill.orderId}`}, ${fill.orderId}, 'ETH',
        ${fill.side}, ${fill.size}, ${fill.price}, ${fill.fee}, 'USDC',
        ${fill.closedPnl}, ${fill.tradedAt}, ${fill.tradedAt}
      )
    `;
  });

const readFills = Effect.gen(function* () {
  const projection = yield* TradingMissionProjection;
  const mission = yield* projection.getByThreadId(THREAD_ID);
  assert.isTrue(Option.isSome(mission));
  return Option.getOrThrow(mission).recentFills;
});

layer("TradingMissionProjection fill receipts", (it) => {
  it.effect("reports one receipt per order, not per partial fill", () =>
    Effect.gen(function* () {
      yield* seedMission;
      // The entry: 3 ETH bought in two slices. The exit: 3 ETH sold in two.
      yield* seedFill({
        fillId: "f1",
        orderId: 10,
        side: "buy",
        size: 0.1852,
        price: 1878.1,
        fee: 0.23,
        closedPnl: 0,
        tradedAt: 1_000,
      });
      yield* seedFill({
        fillId: "f2",
        orderId: 10,
        side: "buy",
        size: 2.8148,
        price: 1877.03,
        fee: 2.3,
        closedPnl: 0,
        tradedAt: 1_001,
      });
      yield* seedFill({
        fillId: "f3",
        orderId: 11,
        side: "sell",
        size: 0.044,
        price: 1870.8,
        fee: 0.01,
        closedPnl: -0.05,
        tradedAt: 2_000,
      });
      yield* seedFill({
        fillId: "f4",
        orderId: 11,
        side: "sell",
        size: 2.956,
        price: 1871.1,
        fee: 2.52,
        closedPnl: -20.43,
        tradedAt: 2_001,
      });

      const fills = yield* readFills;

      assert.equal(fills.length, 2);
      // Newest order first, and it is the whole order: the size, fee and
      // realised result Hyperliquid's own trade history shows for it.
      const exit = fills[0]!;
      assert.equal(exit.side, "sell");
      assert.equal(exit.filledSize, 3);
      assert.closeTo(exit.avgFillPrice, 1871.1, 0.01);
      assert.closeTo(exit.feeUsd, 2.53, 0.001);
      assert.closeTo(exit.closedPnl, -20.48, 0.001);

      const entry = fills[1]!;
      assert.equal(entry.side, "buy");
      assert.equal(entry.filledSize, 3);
      assert.closeTo(entry.avgFillPrice, 1877.1, 0.01);
    }),
  );

  it.effect("weights the average price by size rather than averaging slices", () =>
    Effect.gen(function* () {
      yield* seedMission;
      // A tiny slice at a far price must barely move the order's average; the
      // plain mean of the two would report 1900.
      yield* seedFill({
        fillId: "f1",
        orderId: 20,
        side: "buy",
        size: 0.01,
        price: 2000,
        fee: 0,
        closedPnl: 0,
        tradedAt: 1_000,
      });
      yield* seedFill({
        fillId: "f2",
        orderId: 20,
        side: "buy",
        size: 0.99,
        price: 1800,
        fee: 0,
        closedPnl: 0,
        tradedAt: 1_001,
      });

      const fills = yield* readFills;

      assert.equal(fills.length, 1);
      assert.closeTo(fills[0]!.avgFillPrice, 1802, 0.001);
    }),
  );
});
