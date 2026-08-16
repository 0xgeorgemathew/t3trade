import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Plan 29 step 6.2's schema: the entry evidence gets its own table, and the
 * quotes that became orders carry over into it. A quote nobody executed
 * describes an entry that never happened and stays behind.
 */
layer("064_TradingEntryContext", (it) => {
  it.effect("carries consumed quotes over as entry context, leaving unconsumed ones", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });

      const insertQuote = (input: {
        readonly quoteId: string;
        readonly sequence: number;
        readonly side: string;
        readonly consumedAt: number | null;
      }) => sql`
        INSERT INTO trading_entry_quotes (
          quote_id, mission_id, harness_run_id, authority_version,
          execution_sequence, market, side, action_type, order_preference,
          size, requested_size, constrained_by, limit_price, stop_price,
          planned_loss_usd, reserved_risk_usd, notional_usd, best_bid, best_ask,
          round_trip_cost_usd, quoted_at, expires_at, consumed_at,
          setup_kind_at_entry, setup_score_at_entry, regime_at_entry, atr_usd_at_entry
        ) VALUES (
          ${input.quoteId}, 'm1', 'r1', 1, ${input.sequence}, 'ETH', ${input.side},
          'open', 'marketable_ioc', 0.5, 0.5, 'requested', 3010, 2900,
          55, 60, 1500, 2999, 3001, 2, 100, 200, ${input.consumedAt},
          'breakout', 0.8, 'trending', 12.5
        )
      `;
      yield* insertQuote({ quoteId: "q1", sequence: 1, side: "buy", consumedAt: 150 });
      yield* insertQuote({ quoteId: "q2", sequence: 2, side: "sell", consumedAt: null });

      yield* runMigrations({ toMigrationInclusive: 64 });

      const rows = yield* sql<{
        readonly execution_sequence: number;
        readonly entry_price: number;
        readonly setup_kind: string | null;
        readonly atr_usd: number | null;
        readonly recorded_at: number;
      }>`
        SELECT execution_sequence, entry_price, setup_kind, atr_usd, recorded_at
        FROM trading_entry_context WHERE mission_id = 'm1'
      `;
      assert.equal(rows.length, 1);
      // A buy is filled at the ask.
      assert.equal(rows[0]?.execution_sequence, 1);
      assert.equal(rows[0]?.entry_price, 3001);
      assert.equal(rows[0]?.setup_kind, "breakout");
      assert.equal(rows[0]?.atr_usd, 12.5);
      assert.equal(rows[0]?.recorded_at, 150);
    }),
  );
});
