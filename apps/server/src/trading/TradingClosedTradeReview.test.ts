/**
 * The scorecard a mission grades itself on — plan 34 step 3.
 *
 * `opened_at` is when the reconciler first SAW the position, and the fills
 * that opened it traded a few hundred milliseconds before that. A window
 * starting at the observation excluded every one of them, so the review a
 * mission reads back reported the closing side's fees as the whole fee load
 * and the last closing chunk as the whole position. The fixture below is the
 * real mission the fault was found on, replayed fill for fill.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { buildClosedTradeReview } from "./TradingClosedTradeReview.ts";

const layer = it.layer(
  Layer.mergeAll(NodeSqliteClient.layerMemory()).pipe(Layer.provideMerge(NodeServices.layer)),
);

const MISSION_ID = "mission_closed_trade_review";
const MARKET = "ETH";

/** When the entry's four partial fills traded. */
const ENTRY_TRADED_AT = 1_787_004_680_144;
/** When the reconcile pass first observed the position — 307ms later. */
const OPENED_AT = ENTRY_TRADED_AT + 307;
const CLOSED_AT = 1_787_005_359_003;

/**
 * Mission 38502fa8's eleven fills: one short opened in four taker partials,
 * two take-profit rungs that filled as maker, and the close in two partials.
 */
const FILLS: ReadonlyArray<{
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly price: number;
  readonly fee: number;
  readonly closedPnl: number;
  readonly tradedAt: number;
}> = [
  {
    side: "sell",
    size: 0.0287,
    price: 1_905.1,
    fee: 0.024604,
    closedPnl: 0,
    tradedAt: ENTRY_TRADED_AT,
  },
  {
    side: "sell",
    size: 0.3838,
    price: 1_905.1,
    fee: 0.329029,
    closedPnl: 0,
    tradedAt: ENTRY_TRADED_AT,
  },
  {
    side: "sell",
    size: 0.0524,
    price: 1_905.2,
    fee: 0.044924,
    closedPnl: 0,
    tradedAt: ENTRY_TRADED_AT,
  },
  {
    side: "sell",
    size: 0.0091,
    price: 1_905.3,
    fee: 0.007802,
    closedPnl: 0,
    tradedAt: ENTRY_TRADED_AT,
  },
  {
    side: "buy",
    size: 0.0956,
    price: 1_903.7,
    fee: 0.027299,
    closedPnl: 0.134796,
    tradedAt: 1_787_005_232_315,
  },
  {
    side: "buy",
    size: 0.0131,
    price: 1_903.7,
    fee: 0.00374,
    closedPnl: 0.018471,
    tradedAt: 1_787_005_249_664,
  },
  {
    side: "buy",
    size: 0.01,
    price: 1_903.7,
    fee: 0.002855,
    closedPnl: 0.0141,
    tradedAt: 1_787_005_253_300,
  },
  {
    side: "buy",
    size: 0.0063,
    price: 1_903.7,
    fee: 0.001798,
    closedPnl: 0.008883,
    tradedAt: 1_787_005_253_915,
  },
  {
    side: "buy",
    size: 0.01,
    price: 1_903.7,
    fee: 0.002855,
    closedPnl: 0.0141,
    tradedAt: 1_787_005_255_091,
  },
  {
    side: "buy",
    size: 0.0766,
    price: 1_904.9,
    fee: 0.065661,
    closedPnl: 0.016086,
    tradedAt: 1_787_005_358_725,
  },
  {
    side: "buy",
    size: 0.2624,
    price: 1_904.8,
    fee: 0.224918,
    closedPnl: 0.081344,
    tradedAt: 1_787_005_358_725,
  },
];

const seedFills = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 69 });
  yield* sql`DELETE FROM trading_fills`;
  let index = 0;
  for (const fill of FILLS) {
    index += 1;
    yield* sql`
      INSERT INTO trading_fills (
        fill_id, mission_id, order_id, market, side, filled_size, avg_fill_price,
        fee_usd, fee_token, traded_at, observed_at, closed_pnl
      ) VALUES (
        ${`fill_${index}`}, ${MISSION_ID}, ${index}, ${MARKET}, ${fill.side}, ${fill.size},
        ${fill.price}, ${fill.fee}, 'USDC', ${fill.tradedAt}, ${CLOSED_AT}, ${fill.closedPnl}
      )
    `;
  }
});

/** The snapshot row as it stood on the pass that found the position gone. */
const previous = {
  // What was left when it went flat — the last closing chunk, not the exposure.
  size: -0.339,
  observed_at: CLOSED_AT,
  entry_price: 1_905.11,
  peak_unrealised_pnl: 0.62,
  trough_unrealised_pnl: -0.21,
  opened_at: OPENED_AT,
} as const;

layer("TradingClosedTradeReview", (it) => {
  it.effect("counts the fills that opened the trade, not only the ones that closed it", () =>
    Effect.gen(function* () {
      yield* seedFills;

      const review = yield* buildClosedTradeReview({
        missionId: MISSION_ID,
        market: MARKET,
        previous,
        closedAt: CLOSED_AT,
      });

      assert.isNotNull(review);
      assert.equal(review!.fillCount, 11);
      assert.closeTo(review!.feesPaidUsd, 0.735485, 1e-9);
      assert.closeTo(review!.realizedPnlUsd, 0.28778, 1e-9);
      // The number the mission actually made: −$0.45, not the −$0.04 the
      // close-side-only window reported.
      assert.closeTo(review!.netPnlUsd, -0.447705, 1e-9);
      // The exposure the trade carried, signed short.
      assert.closeTo(review!.sizeEth, -0.474, 1e-9);
      assert.equal(review!.direction, "short");
    }),
  );

  it.effect("prices the exit off the closing side alone", () =>
    Effect.gen(function* () {
      yield* seedFills;

      const review = yield* buildClosedTradeReview({
        missionId: MISSION_ID,
        market: MARKET,
        previous,
        closedAt: CLOSED_AT,
      });

      // Seven buys between 1,903.7 and 1,904.9 — the opening sells at 1,905.1
      // are not in it, which is what makes an exit price separable at all.
      assert.isDefined(review!.exitPrice);
      assert.isAbove(review!.exitPrice!, 1_903.6);
      assert.isBelow(review!.exitPrice!, 1_905);
    }),
  );

  it.effect("leaves a trade whose fills all trade after the observation unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`DELETE FROM trading_fills`;
      yield* sql`
        INSERT INTO trading_fills (
          fill_id, mission_id, order_id, market, side, filled_size, avg_fill_price,
          fee_usd, fee_token, traded_at, observed_at, closed_pnl
        ) VALUES
          ('a', ${MISSION_ID}, 1, ${MARKET}, 'buy', 1, 100, 0.05, 'USDC', 2000, 3000, 0),
          ('b', ${MISSION_ID}, 2, ${MARKET}, 'sell', 1, 110, 0.055, 'USDC', 2500, 3000, 10)
      `;

      const review = yield* buildClosedTradeReview({
        missionId: MISSION_ID,
        market: MARKET,
        previous: {
          size: 1,
          observed_at: 3_000,
          entry_price: 100,
          peak_unrealised_pnl: 10,
          trough_unrealised_pnl: 0,
          opened_at: 1_900,
        },
        closedAt: 3_000,
      });

      assert.equal(review!.fillCount, 2);
      assert.closeTo(review!.sizeEth, 1, 1e-9);
      assert.closeTo(review!.netPnlUsd, 10 - 0.105, 1e-9);
    }),
  );
});
