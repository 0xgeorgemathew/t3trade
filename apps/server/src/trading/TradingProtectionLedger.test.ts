import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  readTakeProfitOrders,
  recordTakeProfitOutcome,
  type ProtectionOrderRow,
} from "./TradingProtectionLedger.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

const MISSION = "mission_ledger";
const CLOID = "c105e".padEnd(32, "0");

/** Migrate the shared in-memory database and start each test from empty. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 71 });
  yield* sql`DELETE FROM trading_protection_orders`;
});

/**
 * Plan 36 item 4. The pass that places a take-profit and then finds the
 * position gone reports the cloid it sent with a size of zero, and the ledger
 * wrote that down as a live order: the mission this was found on carries a
 * `take_profit` row of size 0.0 placed 280ms after its close, `retired_at`
 * still null.
 */
layer("TradingProtectionLedger", (it) => {
  it.effect("records the order a pass rested on a live position", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        placedCloid: CLOID,
        targetPrice: 1_896.75,
        positionSize: -0.01,
        cancelledCloids: [],
      });

      const rows = yield* readTakeProfitOrders(MISSION);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.size, 0.01);
      assert.equal(rows[0]?.retired_at, null);
    }),
  );

  it.effect("writes nothing for an order placed against a position that had gone", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        placedCloid: CLOID,
        targetPrice: 1_896.75,
        // What the "the position left while the take-profit was landing"
        // branch reports.
        positionSize: 0,
        cancelledCloids: [],
      });

      assert.deepStrictEqual(
        [...(yield* readTakeProfitOrders(MISSION))],
        [] as ProtectionOrderRow[],
      );
    }),
  );

  it.effect("retires an order still standing when the position is observed flat", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        placedCloid: CLOID,
        targetPrice: 1_896.75,
        positionSize: -0.01,
        cancelledCloids: [],
      });

      // A later pass finds the mission flat. It cancelled nothing — the
      // exchange retires reduce-only orders with the position — but the row
      // must not go on claiming the order is resting.
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        targetPrice: null,
        positionSize: 0,
        cancelledCloids: [],
      });

      const rows = yield* readTakeProfitOrders(MISSION);
      assert.equal(rows.length, 1);
      assert.isNotNull(rows[0]?.retired_at);
    }),
  );
});
