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
import { MomentumStrategyState } from "@t3tools/trading-contracts/strategy";

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
  /** The exchange's lifecycle label, when it sent one. */
  readonly direction?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_fills (
        fill_id, mission_id, cloid, order_id, market, side, filled_size,
        avg_fill_price, fee_usd, fee_token, closed_pnl, direction, traded_at,
        observed_at
      ) VALUES (
        ${fill.fillId}, ${MISSION_ID}, ${`0xcloid${fill.orderId}`}, ${fill.orderId}, 'ETH',
        ${fill.side}, ${fill.size}, ${fill.price}, ${fill.fee}, 'USDC',
        ${fill.closedPnl}, ${fill.direction ?? null}, ${fill.tradedAt}, ${fill.tradedAt}
      )
    `;
  });

const readFills = Effect.gen(function* () {
  const projection = yield* TradingMissionProjection;
  const mission = yield* projection.getByThreadId(THREAD_ID);
  assert.isTrue(Option.isSome(mission));
  return Option.getOrThrow(mission).recentFills;
});

const encodeStrategy = Schema.encodeSync(Schema.fromJsonString(MomentumStrategyState));

/** A published range scalp, as the strategy projector would have written it. */
const rangeReversionStrategy: MomentumStrategyState = {
  version: 1,
  name: "ETH 1m range reversion",
  market: "ETH",
  mode: "range_reversion",
  // A range pays whichever edge price reaches first, so both sides are armed.
  direction: "both",
  timeframes: ["1m"],
  belief: {
    summary: "Range between 3,404.80 and 3,412.10 has held for two hours.",
    regime: "ranging",
    evidence: ["excursionSymmetryRatio 1.0", "positionInRangePercent 8.7"],
  },
  entryPlan: {
    explanation: "Fade each boundary back toward the middle.",
    orderPreference: "marketable_ioc",
    conditions: [{ description: "Price touches 3,404.80 with the range intact" }],
  },
  positionManagement: {
    scaleInAllowed: false,
    scaleInConditions: [],
    partialReductionAllowed: true,
  },
  protection: {
    stopMethod: "A 1m close outside the range says it broke rather than held",
    targetProfitUsd: 4.75,
    targetProfitBasis: {
      measurement: "swing_range",
      timeframe: "1m",
      lookbackBars: 120,
      // 65% of the $7.30 height — the capture, not the whole crossing.
      measuredMoveUsd: 4.745,
      expectedHoldBars: 23,
      referencePrice: 3_405.43,
      targetPriceMovePercent: 0.139,
      positionNotionalUsd: 3_405.43,
      rationale: "Range height 7.30 over 120 1m bars; 65% of it is 4.745 of price.",
    },
  },
  exitConditions: [{ description: "Target reached, or a close outside the range" }],
  abandonmentConditions: [],
  reentryConditions: [],
  currentAction: "waiting",
  explanation: "Waiting for the floor.",
  updatedAt: 1_754_356_376_000,
};

layer("TradingMissionProjection strategy card", (it) => {
  // The projection degrades a strategy it cannot decode to "no strategy", which
  // is right for a row published before a field became required and wrong for
  // every new mode. A range scalp has to come back as itself.
  it.effect("reads a range_reversion strategy back rather than degrading it", () =>
    Effect.gen(function* () {
      yield* seedMission;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_trading_missions
        SET strategy_json = ${encodeStrategy(rangeReversionStrategy)}, strategy_version = 1
        WHERE mission_id = ${MISSION_ID}
      `;

      const projection = yield* TradingMissionProjection;
      const mission = yield* projection.getByThreadId(THREAD_ID);
      assert.isTrue(Option.isSome(mission));
      const strategy = Option.getOrThrow(mission).strategy;

      assert.equal(strategy?.mode, "range_reversion");
      assert.equal(strategy?.direction, "both");
      assert.equal(strategy?.protection.targetProfitBasis?.measurement, "swing_range");
      assert.equal(strategy?.protection.targetProfitBasis?.measuredMoveUsd, 4.745);
    }),
  );
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

  // The receipt has to say which half of the position's life it was, and `side`
  // does not: this same "sell" is a close here and would be an open on a short.
  it.effect("carries the exchange's lifecycle label through to the receipt", () =>
    Effect.gen(function* () {
      yield* seedMission;
      yield* seedFill({
        fillId: "f1",
        orderId: 30,
        side: "buy",
        size: 1,
        price: 1878,
        fee: 0.2,
        closedPnl: 0,
        tradedAt: 1_000,
        direction: "Open Long",
      });
      yield* seedFill({
        fillId: "f2",
        orderId: 31,
        side: "sell",
        size: 1,
        price: 1880,
        fee: 0.2,
        closedPnl: 2,
        tradedAt: 2_000,
        direction: "Close Long",
      });
      // An older fill, from before the label was recorded.
      yield* seedFill({
        fillId: "f3",
        orderId: 29,
        side: "buy",
        size: 1,
        price: 1870,
        fee: 0.2,
        closedPnl: 0,
        tradedAt: 500,
      });

      const fills = yield* readFills;

      assert.equal(fills[0]?.direction, "Close Long");
      assert.equal(fills[1]?.direction, "Open Long");
      assert.equal(fills[2]?.direction, undefined);
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

  // The three receipts the operator compared against their CSV export, seeded
  // as the reconciler now writes them: one row per sub-fill, sub-fills of one
  // order sharing an L1 transaction hash. Every figure on the card must equal
  // the exchange's own trade history for that order.
  it.effect("matches the exchange's trade history for the 01:12–01:17 trades", () =>
    Effect.gen(function* () {
      yield* seedMission;
      const seedOrder = (
        orderId: number,
        side: "buy" | "sell",
        tradedAt: number,
        slices: ReadonlyArray<{
          readonly size: number;
          readonly price: number;
          readonly fee: number;
          readonly closedPnl: number;
        }>,
      ) =>
        Effect.forEach(slices, (slice, idx) =>
          seedFill({
            fillId: `${orderId}-${idx}`,
            orderId,
            side,
            size: slice.size,
            price: slice.price,
            fee: slice.fee,
            closedPnl: slice.closedPnl,
            tradedAt: tradedAt + idx,
          }),
        );

      // 01:12:56 · Close Long 1.0632 @ 1879.8784142212, fee 0.899407, pnl -1.453957
      yield* seedOrder(57_431_816_538, "sell", 1_754_356_376_000, [
        { size: 0.2295, price: 1879.6, fee: 0.194149, closedPnl: -0.313857 },
        { size: 0.5, price: 1880.1, fee: 0.423028, closedPnl: -0.684 },
        { size: 0.3337, price: 1879.7378783338, fee: 0.28223, closedPnl: -0.4561 },
      ]);
      // 01:14:26 · Open Long 1.0632 @ 1881.0950056433, fee 0.899989, pnl -0.899989
      yield* seedOrder(57_431_859_025, "buy", 1_754_356_466_000, [
        { size: 0.2133, price: 1880.9, fee: 0.180594, closedPnl: -0.180594 },
        { size: 0.6, price: 1881.3, fee: 0.507968, closedPnl: -0.507968 },
        { size: 0.2499, price: 1880.7692677069, fee: 0.211427, closedPnl: -0.211427 },
      ]);
      // 01:17:53 · Close Long 1.0632 @ 1878.3931715576, fee 0.898696, pnl -3.765964
      yield* seedOrder(57_431_958_896, "sell", 1_754_356_673_000, [
        { size: 0.1226, price: 1878.1, fee: 0.103621, closedPnl: -0.434243 },
        { size: 0.7, price: 1878.5, fee: 0.591637, closedPnl: -2.479521 },
        { size: 0.2406, price: 1878.2317539486, fee: 0.203438, closedPnl: -0.8522 },
      ]);

      const fills = yield* readFills;
      assert.equal(fills.length, 3);

      const [close2, entry, close1] = fills;
      assert.equal(close2!.orderId, 57_431_958_896);
      assert.equal(close2!.side, "sell");
      assert.closeTo(close2!.filledSize, 1.0632, 1e-9);
      assert.closeTo(close2!.avgFillPrice, 1878.3931715576, 1e-6);
      assert.closeTo(close2!.feeUsd, 0.898696, 1e-9);
      assert.closeTo(close2!.closedPnl, -3.765964, 1e-9);

      assert.equal(entry!.orderId, 57_431_859_025);
      assert.equal(entry!.side, "buy");
      assert.closeTo(entry!.filledSize, 1.0632, 1e-9);
      assert.closeTo(entry!.avgFillPrice, 1881.0950056433, 1e-6);
      assert.closeTo(entry!.feeUsd, 0.899989, 1e-9);
      assert.closeTo(entry!.closedPnl, -0.899989, 1e-9);

      assert.equal(close1!.orderId, 57_431_816_538);
      assert.equal(close1!.side, "sell");
      assert.closeTo(close1!.filledSize, 1.0632, 1e-9);
      assert.closeTo(close1!.avgFillPrice, 1879.8784142212, 1e-6);
      assert.closeTo(close1!.feeUsd, 0.899407, 1e-9);
      assert.closeTo(close1!.closedPnl, -1.453957, 1e-9);
    }),
  );
});
