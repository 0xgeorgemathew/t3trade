import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Plan 36 item 2's rebuild: one opening is one trade.
 *
 * The claim worth testing is the collapse, not the DDL. Rows written under the
 * old key are already in every live database — the mission this was found on
 * has a pair 67ms apart — and calibration reads them as two trades unless this
 * migration puts them back together. The other half of the claim matters just
 * as much: a mission's genuinely separate trades must survive it.
 */
layer("071_TradingClosedTradesOpeningKey", (it) => {
  /** Insert a closed trade under the pre-071 schema. */
  const insert = (opts: {
    readonly openedAt: number;
    readonly closedAt: number;
    readonly netPnl: number;
    readonly direction: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_closed_trades (
          mission_id, market, opened_at, closed_at, hold_millis, direction, size,
          realized_pnl, fees_paid, net_pnl, peak_unrealised_pnl,
          trough_unrealised_pnl, giveback_from_peak, fill_count
        ) VALUES (
          'm1', 'ETH', ${opts.openedAt}, ${opts.closedAt},
          ${opts.closedAt - opts.openedAt}, ${opts.direction}, 0.01,
          ${opts.netPnl + 0.45}, 0.45, ${opts.netPnl}, 0, -1.2, 0, 2
        )
      `;
    });

  it.effect("collapses the two rows one close left behind, and keeps the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      // The live pair: identical but for the instant each pass looked.
      yield* insert({
        openedAt: 1_787_039_700_000,
        closedAt: 1_787_039_899_661,
        netPnl: -0.607,
        direction: "short",
      });
      yield* insert({
        openedAt: 1_787_039_700_000,
        closedAt: 1_787_039_899_728,
        netPnl: -0.607,
        direction: "short",
      });
      // A genuinely different trade in the same mission.
      yield* insert({
        openedAt: 1_787_040_000_000,
        closedAt: 1_787_040_100_000,
        netPnl: 0.6,
        direction: "long",
      });

      yield* runMigrations({ toMigrationInclusive: 71 });

      const rows = yield* sql<{
        readonly opened_at: number;
        readonly closed_at: number;
        readonly net_pnl: number;
      }>`
        SELECT opened_at, closed_at, net_pnl FROM trading_closed_trades ORDER BY opened_at
      `;
      assert.equal(rows.length, 2);
      // The survivor of the pair is the earliest observation, carrying its own
      // columns across rather than a mix of both siblings'.
      assert.equal(rows[0]?.closed_at, 1_787_039_899_661);
      assert.equal(rows[0]?.net_pnl, -0.607);
      assert.equal(rows[1]?.opened_at, 1_787_040_000_000);
      assert.equal(rows[1]?.net_pnl, 0.6);
    }),
  );

  it.effect("refuses a second row for an opening it already holds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      // The suite shares one in-memory database, so this starts from empty
      // rather than from what the collapse test left behind.
      yield* sql`DELETE FROM trading_closed_trades`;

      yield* insert({
        openedAt: 1_787_039_700_000,
        closedAt: 1_787_039_899_661,
        netPnl: -0.607,
        direction: "short",
      });
      // The old key would have taken this as a new trade.
      const second = yield* Effect.exit(
        insert({
          openedAt: 1_787_039_700_000,
          closedAt: 1_787_039_899_728,
          netPnl: -0.607,
          direction: "short",
        }),
      );
      assert.isTrue(second._tag === "Failure");

      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_closed_trades
      `;
      assert.equal(rows[0]?.n, 1);
    }),
  );
});
