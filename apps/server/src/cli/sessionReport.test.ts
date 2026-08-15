// @effect-diagnostics preferSchemaOverJson:off - fixture rows are raw JSON columns, seeded as text.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { formatSessionReport, readSessionReport } from "./sessionReport.ts";

const layer = it.layer(Layer.provideMerge(NodeSqliteClient.layerMemory(), NodeServices.layer));

const MISSION = "mission_1";
const EMPTY_MISSION = "mission_empty";

const insertMission = (missionId: string, updatedAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO trading_missions (
      mission_id, user_id, trading_account_id, instruction, market, strategy_family,
      harness_json, status, control_json, authority_version, strategy_version, version,
      created_at, updated_at
    ) VALUES (
      ${missionId}, 'local', 'acct_1', 'Trade ETH', 'ETH', 'momentum',
      '{}', 'analysing', '{}', 3, 1, 1, 0, ${updatedAt}
    )
  `;
  });

/**
 * A small but complete session: a published plan, four wakes (one silent, one
 * still open), two closed trades — a long that paid the half-spread and got
 * price improvement, a short that slipped past the bid — and the open quotes
 * both entries joined to.
 */
const seedSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM trading_entry_quotes`;
  yield* sql`DELETE FROM trading_closed_trades`;
  yield* sql`DELETE FROM trading_harness_runs`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
  yield* sql`DELETE FROM trading_missions`;

  // The mission lived 100 minutes and held positions for 50 of them.
  yield* insertMission(MISSION, 100 * 60_000);

  yield* sql`
    INSERT INTO trading_harness_runs (
      run_id, mission_id, cause, status, started_at, created_at,
      outcome, stand_down_code, published_plan, execute_attempted
    ) VALUES
      ('run_1', ${MISSION}, 'scheduled_reassessment', 'completed', 1000, 1000,
        'no_setup', 'insufficient_volatility', 1, 0),
      ('run_2', ${MISSION}, 'scheduled_reassessment', 'completed', 2000, 2000,
        'no_decision', 'not_published', 0, 0),
      ('run_3', ${MISSION}, 'scheduled_reassessment', 'completed', 3000, 3000,
        'entered', NULL, 1, 1),
      ('run_4', ${MISSION}, 'scheduled_reassessment', 'starting', 4000, 4000,
        NULL, NULL, 0, 1)
  `;

  yield* sql`
    INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
    VALUES (${MISSION}, 1, '{}', 1000)
  `;

  yield* sql`
    INSERT INTO trading_entry_quotes (
      quote_id, mission_id, harness_run_id, strategy_version, authority_version,
      execution_sequence, market, side, action_type, order_preference, size,
      requested_size, constrained_by, limit_price, stop_price, planned_loss_usd,
      reserved_risk_usd, notional_usd, best_bid, best_ask, round_trip_cost_usd,
      quoted_at, expires_at, consumed_at
    ) VALUES
      ('quote_a', ${MISSION}, 'run_3', 1, 3, 1, 'ETH', 'buy', 'open', 'taker',
        2, 2, 'none', 3001, 2990, 20, 20, 6000, 2999, 3001, 5, 500, 60000, 1000),
      ('quote_b', ${MISSION}, 'run_3', 1, 3, 2, 'ETH', 'sell', 'open', 'taker',
        3, 3, 'none', 100, 95, 15, 15, 300, 100.4, 100.6, 2, 2399000, 2500000, 2400000)
  `;

  yield* sql`
    INSERT INTO trading_closed_trades (
      mission_id, market, opened_at, closed_at, hold_millis, direction, size,
      entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
      peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak, fill_count
    ) VALUES
      (${MISSION}, 'ETH', 0, ${30 * 60_000}, ${30 * 60_000}, 'long', 2,
        3000, 3010, 20, 2, 18, 25, -5, 5, 2),
      (${MISSION}, 'ETH', ${40 * 60_000}, ${60 * 60_000}, ${20 * 60_000}, 'short', -3,
        100, 101, -3, 1, -4, 0, -4, 0, 1)
  `;
});

const seedEmptySession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM trading_entry_quotes`;
  yield* sql`DELETE FROM trading_closed_trades`;
  yield* sql`DELETE FROM trading_harness_runs`;
  yield* sql`DELETE FROM momentum_strategy_versions`;
  yield* sql`DELETE FROM trading_missions`;

  yield* insertMission(EMPTY_MISSION, 1000);
});

layer("session-report", (it) => {
  it.effect("prints a session's eight numbers from its recorded evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedSession;

      const report = yield* readSessionReport(sql, { missionId: MISSION });
      if (report === null) {
        assert.fail("expected a report for a seeded mission");
      }
      // Long: 18 net on 6000 notional is 30 bps, and its fill 1 inside the ask
      // is -1 bps of price improvement. Short: -4 net on 300 notional is
      // -133.3 bps, plus 0.4 past the quoted bid. Fees 3 on 6300 notional.
      assert.deepEqual(formatSessionReport(report).split("\n"), [
        "mission: mission_1 (ETH, created 1970-01-01T00:00:00.000Z)",
        "trades: 2",
        "win rate: 50% (1 of 2)",
        "net bps per trade: -51.7",
        "cost fees: 4.8 bps of entry notional (round trip; 2 of 2 trades priced)",
        "cost spread, entry side: 3.7 bps of entry notional (2 of 2 trades with entry quotes)",
        "cost slippage, entry side: -1.3 bps of entry notional (2 of 2 trades with entry quotes)",
        "cost spread/slippage, exit side: n/a (no exit quotes recorded)",
        "plan versions published: 1",
        "wakes taken: 4",
        "wakes that changed nothing: 1",
        "wakes with no decision: 1",
        "time in market: 50%",
        "stand-down codes:",
        "  insufficient_volatility 1",
        "  not_published 1",
      ]);
    }),
  );

  it.effect("prints n/a instead of dividing by zero for a session with no trades", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedEmptySession;

      const report = yield* readSessionReport(sql, { missionId: EMPTY_MISSION });
      if (report === null) {
        assert.fail("expected a report for a seeded mission");
      }
      assert.deepEqual(formatSessionReport(report).split("\n"), [
        "mission: mission_empty (ETH, created 1970-01-01T00:00:00.000Z)",
        "trades: 0",
        "win rate: n/a (no closed trades)",
        "net bps per trade: n/a (no closed trades)",
        "cost fees: n/a (no closed trades)",
        "cost spread, entry side: n/a (no closed trades)",
        "cost slippage, entry side: n/a (no closed trades)",
        "cost spread/slippage, exit side: n/a (no exit quotes recorded)",
        "plan versions published: 0",
        "wakes taken: 0",
        "wakes that changed nothing: 0",
        "wakes with no decision: 0",
        "time in market: 0%",
        "stand-down codes: none",
      ]);
    }),
  );

  it.effect("returns null for a mission that does not exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedSession;

      assert.strictEqual(yield* readSessionReport(sql, { missionId: "missing" }), null);
    }),
  );
});
