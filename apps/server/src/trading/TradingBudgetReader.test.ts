/**
 * TradingBudgetReader unit tests — Task 2 (stop-aware open-position risk).
 *
 * These tests seed reconciled-truth tables directly (trading_fills,
 * trading_position_snapshots, trading_risk_reservations,
 * trading_execution_records) and assert the reader assembles the §16.2
 * `LossBudgetInput` correctly. The reader is the single place that gathers
 * inputs for `evaluateLossBudget`; the contract math itself is exercised
 * separately in trading-contracts.
 *
 * In-memory sqlite layer + migrations through 040 (the stop_price column on
 * trading_execution_records, Task 1). Pattern copied from
 * TradingTurnCoordinator.test.ts (the `it.layer` + `Layer.provideMerge` chain
 * ending in `NodeSqliteClient.layerMemory()` + `NodeServices.layer`, with a
 * `migrated` effect run at the top of each test).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TradingBudgetReader, makeTradingBudgetReader } from "./TradingBudgetReader.ts";
import { evaluateLossBudget, openPositionRisk } from "@t3tools/trading-contracts/loss-accounting";

/**
 * The reader only depends on SqlClient, so we can build it directly off the
 * memory sqlite layer (no need for the full trading layer stack).
 */
const layer = it.layer(
  Layer.effect(TradingBudgetReader, makeTradingBudgetReader).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/**
 * Run migrations through 040 (stop_price + planned_loss_at_stop_usd on
 * trading_execution_records, mark_px on trading_position_snapshots) and
 * truncate the execution-domain tables so each test starts clean. it.layer
 * shares one in-memory database across the suite.
 */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 63 });
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM trading_risk_reservations`;
  yield* sql`DELETE FROM trading_execution_records`;
});

/**
 * The canonical input: 100 USD ceiling, 5 bps taker fee. The reader must feed
 * `LossBudgetInput` with these exact `maximumCumulativeLossUsd` /
 * `takerFeeRateBps` (they are caller-supplied policy/observable, not
 * reconciled state).
 */
const read = (missionId = "mission_1") =>
  Effect.gen(function* () {
    const reader = yield* TradingBudgetReader;
    return yield* reader.read({
      missionId,
      maximumCumulativeLossUsd: 100,
      takerFeeRateBps: 5,
    });
  });

layer("TradingBudgetReader — stop-aware open-position risk", (it) => {
  it.effect("threads the stop into openPositionRisk for a long (distance × size + exit fee)", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      // A long 2 ETH @ 3000, stop at 2900 → directional loss-to-stop = 200 USD.
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used, protected_size, observed_at)
        VALUES ('mission_1', 'ETH', 2, 3000, 0, 0, 0, 1_700_000_000_000)
      `;
      // The mission's latest execution record carries the stop (Task 1 column).
      yield* sql`
        INSERT INTO trading_execution_records
          (execution_id, mission_id, execution_sequence, action_type, cloid,
           idempotency_key, market, side, size, limit_price, time_in_force, reduce_only,
           signer_address, status, order_results_json, created_at, updated_at, stop_price)
        VALUES
          ('exec_1', 'mission_1', 1, 'open', 'cloid_1',
           'idem_1', 'ETH', 'buy', 2, 3000, 'ioc', 0,
           '0xsigner', 'placed', '{}', 1_700_000_000_000, 1_700_000_000_000, 2900)
      `;

      const result = yield* read();

      // openPositions has one long with the threaded stop.
      assert.equal(result.openPositions.length, 1);
      const position = result.openPositions[0]!;
      assert.equal(position.direction, "long");
      assert.equal(position.size, 2);
      assert.equal(position.weightedEntryPrice, 3000);
      assert.equal(position.stopPrice, 2900);

      // Eq 3 exit-fee estimate = size × entry × takerFeeRateBps / 10_000.
      // 2 × 3000 × 5 / 10_000 = 3 USD.
      assert.equal(position.estimatedExitFeeUsd, 3);

      // The full notional (2 × 3000 = 6000) is NOT the risk — only the
      // distance × size term flows through LossBudgetInput.openPositions;
      // evaluateLossBudget (tested in trading-contracts) turns (3000−2900) × 2
      // + 3 into the openPositionRiskUsd term. Here we only assert the reader
      // fed the right inputs so that the contract's openPositionRisk would
      // compute 203 USD, NOT the 6000 USD notional a fabricated 0 stop would
      // imply.
      assert.isOk(position.stopPrice! < position.weightedEntryPrice!);
    }),
  );

  it.effect("a long with no stop record reserves only fee terms, never entry × size", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      // A long position but NO execution record carrying a stop_price.
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used, protected_size, observed_at)
          VALUES ('mission_1', 'ETH', 1, 3000, 0, 0, 0, 1_700_000_000_000)
      `;
      // An execution record WITHOUT stop_price (e.g. a cancel record) — the
      // LEFT JOIN must not fabricate a stop.
      yield* sql`
        INSERT INTO trading_execution_records
          (execution_id, mission_id, execution_sequence, action_type, cloid,
           idempotency_key, market, side, size, limit_price, time_in_force, reduce_only,
           signer_address, status, order_results_json, created_at, updated_at)
        VALUES
          ('exec_1', 'mission_1', 1, 'cancel', 'cloid_1',
           'idem_1', 'ETH', 'buy', 1, 3000, 'ioc', 0,
           '0xsigner', 'placed', '{}', 1_700_000_000_000, 1_700_000_000_000)
      `;

      const result = yield* read();

      // stopPrice is genuinely undefined (a legal input — stop_price is optional
      // on the contract, and every record written before migration 040 has NULL).
      assert.equal(result.openPositions.length, 1);
      const position = result.openPositions[0]!;
      assert.equal(position.direction, "long");
      assert.equal(position.stopPrice, undefined);

      // The real assertion: feed the reader's output through the contract and
      // confirm the open-position risk is bounded by the fee terms — NOT the
      // 3000 USD notional the previous "fabricate a 0 stop" path produced.
      const risk = openPositionRisk(position);
      const notional = position.weightedEntryPrice! * position.size;
      assert.equal(risk, position.estimatedExitFeeUsd + position.stopSlippageReserveUsd);
      assert.notEqual(risk, notional);
      assert.isBelow(risk, notional);

      // And end-to-end through evaluateLossBudget: with a 100 USD ceiling and no
      // other activity, the budget is NOT exhausted by this one missing-stop
      // position. The previous defect exhausted it instantly (3000 > 100).
      const budget = evaluateLossBudget({ ...result, maximumCumulativeLossUsd: 100 });
      assert.isBelow(budget.openPositionRiskUsd, notional);
      assert.equal(budget.exhausted, false);
    }),
  );

  it.effect("threads the stop into openPositionRisk for a short (symmetric to the long case)", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      // A short 2 ETH @ 3000, stop at 3100 → directional loss-to-stop = 200 USD.
      // Negative size encodes the short direction (per the reader).
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used, protected_size, observed_at)
        VALUES ('mission_1', 'ETH', -2, 3000, 0, 0, 0, 1_700_000_000_000)
      `;
      yield* sql`
        INSERT INTO trading_execution_records
          (execution_id, mission_id, execution_sequence, action_type, cloid,
           idempotency_key, market, side, size, limit_price, time_in_force, reduce_only,
           signer_address, status, order_results_json, created_at, updated_at, stop_price)
        VALUES
          ('exec_1', 'mission_1', 1, 'open', 'cloid_1',
           'idem_1', 'ETH', 'sell', 2, 3000, 'ioc', 0,
           '0xsigner', 'placed', '{}', 1_700_000_000_000, 1_700_000_000_000, 3100)
      `;

      const result = yield* read();

      assert.equal(result.openPositions.length, 1);
      const position = result.openPositions[0]!;
      assert.equal(position.direction, "short");
      assert.equal(position.size, 2);
      assert.equal(position.weightedEntryPrice, 3000);
      assert.equal(position.stopPrice, 3100);
      // Eq 3 exit-fee estimate (size is absolute): 2 × 3000 × 5 / 10_000 = 3.
      assert.equal(position.estimatedExitFeeUsd, 3);
      // For a short, the stop is ABOVE the entry (loss-to-stop is positive).
      assert.isOk(position.stopPrice! > position.weightedEntryPrice!);
    }),
  );

  it.effect(
    "excludes released reservations from pendingEntries (only status='reserved' counts)",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const sql = yield* SqlClient.SqlClient;

        // Two reservations for the mission: one reserved (counts), one released
        // (does not count, per §16.2 Eq 4 — a released reservation no longer
        // holds budget). The reserved_risk_usd is the full Eq 4 value stored at
        // preview time.
        yield* sql`
        INSERT INTO trading_execution_records
          (execution_id, mission_id, execution_sequence, action_type, cloid,
           idempotency_key, market, side, size, limit_price, time_in_force, reduce_only,
           signer_address, status, order_results_json, created_at, updated_at)
        VALUES
          ('exec_1', 'mission_1', 1, 'open', 'cloid_1',
           'idem_1', 'ETH', 'buy', 1, 3000, 'ioc', 0,
           '0xsigner', 'placed', '{}', 1, 2),
          ('exec_2', 'mission_1', 2, 'open', 'cloid_2',
           'idem_2', 'ETH', 'buy', 1, 3000, 'ioc', 0,
           '0xsigner', 'placed', '{}', 1, 2)
      `;
        yield* sql`
        INSERT INTO trading_risk_reservations
          (reservation_id, mission_id, execution_id, cloid, action_type, reserved_risk_usd, status, reserved_at, released_at)
        VALUES
          ('res_1', 'mission_1', 'exec_1', 'cloid_1', 'open', 10, 'reserved', 1, NULL),
          ('res_2', 'mission_1', 'exec_2', 'cloid_2', 'open', 25, 'released', 1, 2)
      `;

        const result = yield* read();

        // Only the reserved reservation appears; the released one is excluded.
        assert.equal(result.pendingEntries.length, 1);
        const pending = result.pendingEntries[0]!;
        assert.equal(pending.missionId, "mission_1");
        // The reservation's reserved_risk_usd maps onto plannedLossAtStopUsd
        // (the additive terms are zeroed since they were summed at preview time).
        assert.equal(pending.plannedLossAtStopUsd, 10);
        assert.equal(pending.estimatedEntryFeeUsd, 0);
        assert.equal(pending.estimatedExitFeeUsd, 0);
        assert.equal(pending.stopSlippageReserveUsd, 0);
      }),
  );

  it.effect("uses takerFeeRateBps for the estimated exit fee (size × entry × bps / 10_000)", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      // 3 ETH @ 2000, takerFeeRateBps = 5 → exit fee = 3 × 2000 × 5 / 10_000 = 3 USD.
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used, protected_size, observed_at)
        VALUES ('mission_1', 'ETH', 3, 2000, 0, 0, 0, 1_700_000_000_000)
      `;
      // A stop record so the reader is exercising the full openPositions path.
      yield* sql`
        INSERT INTO trading_execution_records
          (execution_id, mission_id, execution_sequence, action_type, cloid,
           idempotency_key, market, side, size, limit_price, time_in_force, reduce_only,
           signer_address, status, order_results_json, created_at, updated_at, stop_price)
        VALUES
          ('exec_1', 'mission_1', 1, 'open', 'cloid_1',
           'idem_1', 'ETH', 'buy', 3, 2000, 'ioc', 0,
           '0xsigner', 'placed', '{}', 1, 2, 1900)
      `;

      const result = yield* read();

      assert.equal(result.openPositions.length, 1);
      // 3 × 2000 × 5 / 10_000 = 3 USD.
      assert.equal(result.openPositions[0]!.estimatedExitFeeUsd, 3);
    }),
  );

  it.effect("sums closed_pnl and fee_usd across fills for the realised terms", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      // Two fills: closed_pnl −5 + −3 = −8; fee_usd 1 + 2 = 3.
      yield* sql`
        INSERT INTO trading_fills
          (fill_id, mission_id, execution_id, cloid, order_id, market, side,
           filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at, closed_pnl)
        VALUES
          ('fill_1', 'mission_1', NULL, NULL, 1, 'ETH', 'sell', 1, 3000, 1, 'USDC', 1, 1, -5),
          ('fill_2', 'mission_1', NULL, NULL, 2, 'ETH', 'sell', 1, 2990, 2, 'USDC', 2, 2, -3)
      `;

      const result = yield* read();

      assert.equal(result.closedPnlUsd, -8);
      assert.equal(result.allPaidTradingFeesUsd, 3);
      // Funding is not yet tracked per-fill in the POC schema.
      assert.equal(result.netFundingUsd, 0);
      // No positions or reservations.
      assert.equal(result.openPositions.length, 0);
      assert.equal(result.pendingEntries.length, 0);
    }),
  );

  // --- the resting-entry notional the aggregate exposure caps count ---------

  /** Per-mission sequences are unique; one counter keeps the seeds legal. */
  let execSequence = 0;

  /** One execution record, with the shape the caller wants. */
  const seedExec = (
    sql: SqlClient.SqlClient,
    row: {
      readonly execution_id: string;
      readonly action_type: string;
      readonly reduce_only: number;
      readonly time_in_force: string;
      readonly status: string;
      readonly size: number;
      readonly limit_price: number;
      readonly stop_price?: number | null;
    },
  ) =>
    sql`
      INSERT INTO trading_execution_records
        (execution_id, mission_id, execution_sequence, action_type, cloid,
         idempotency_key, market, side, size, limit_price, time_in_force, reduce_only,
         signer_address, status, order_results_json, created_at, updated_at, stop_price)
      VALUES
        (${row.execution_id}, 'mission_1', ${++execSequence}, ${row.action_type},
         ${`cloid_${row.execution_id}`}, ${`idem_${row.execution_id}`}, 'ETH', 'buy',
         ${row.size}, ${row.limit_price}, ${row.time_in_force}, ${row.reduce_only},
         '0xsigner', ${row.status}, '{}', 1, 2, ${row.stop_price ?? null})
    `;

  it.effect("sums the notional of accepted, unfilled resting entries", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      // Two resting patient entries: 0.5 @ 2990 and 0.2 @ 3000 → 2095.
      yield* seedExec(sql, {
        execution_id: "exec_1",
        action_type: "open",
        reduce_only: 0,
        time_in_force: "alo",
        status: "accepted",
        size: 0.5,
        limit_price: 2_990,
        stop_price: 2_950,
      });
      yield* seedExec(sql, {
        execution_id: "exec_2",
        action_type: "scale_in",
        reduce_only: 0,
        time_in_force: "alo",
        status: "accepted",
        size: 0.2,
        limit_price: 3_000,
        stop_price: 2_950,
      });

      const result = yield* read();
      assert.equal(result.pendingEntryNotionalUsd, 0.5 * 2_990 + 0.2 * 3_000);
    }),
  );

  it.effect(
    "excludes TP-shaped, reduce-only, stop-less, filled and cancelled records from the pending entry notional",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const sql = yield* SqlClient.SqlClient;

        // The one record that counts: 0.1 @ 3000 = 300.
        yield* seedExec(sql, {
          execution_id: "exec_counted",
          action_type: "open",
          reduce_only: 0,
          time_in_force: "alo",
          status: "accepted",
          size: 0.1,
          limit_price: 3_000,
          stop_price: 2_950,
        });
        // A take-profit as it is recorded today (reduce-only; the take-profit
        // path does not write records at all, but if one ever lands it is a
        // reduce-only order removing notional, not adding it).
        yield* seedExec(sql, {
          execution_id: "exec_tp",
          action_type: "take_profit_3100",
          reduce_only: 1,
          time_in_force: "alo",
          status: "accepted",
          size: 0.9,
          limit_price: 3_100,
          stop_price: null,
        });
        // The defensive half: a take-profit-shaped record that somehow carries
        // reduce_only = 0 still stays out of the sum (the NOT LIKE).
        yield* seedExec(sql, {
          execution_id: "exec_tp_defensive",
          action_type: "take_profit_3100",
          reduce_only: 0,
          time_in_force: "alo",
          status: "accepted",
          size: 0.9,
          limit_price: 3_100,
          stop_price: 2_950,
        });
        // A resting patient exit: reduce-only, exposure-reducing.
        yield* seedExec(sql, {
          execution_id: "exec_exit",
          action_type: "close",
          reduce_only: 1,
          time_in_force: "alo",
          status: "accepted",
          size: 0.9,
          limit_price: 3_010,
          stop_price: null,
        });
        // Filled, cancelled, and non-ALO records rest nothing.
        yield* seedExec(sql, {
          execution_id: "exec_filled",
          action_type: "open",
          reduce_only: 0,
          time_in_force: "alo",
          status: "filled",
          size: 0.5,
          limit_price: 2_990,
          stop_price: 2_950,
        });
        yield* seedExec(sql, {
          execution_id: "exec_cancelled",
          action_type: "open",
          reduce_only: 0,
          time_in_force: "alo",
          status: "cancelled",
          size: 0.5,
          limit_price: 2_990,
          stop_price: 2_950,
        });
        yield* seedExec(sql, {
          execution_id: "exec_ioc",
          action_type: "open",
          reduce_only: 0,
          time_in_force: "ioc",
          status: "accepted",
          size: 0.5,
          limit_price: 2_990,
          stop_price: 2_950,
        });
        // An entry record without a stop: not the working loop's population
        // (the mandatory-stop gate owns that defect) and not this sum's.
        yield* seedExec(sql, {
          execution_id: "exec_stopless",
          action_type: "open",
          reduce_only: 0,
          time_in_force: "alo",
          status: "accepted",
          size: 0.5,
          limit_price: 2_990,
          stop_price: null,
        });

        const result = yield* read();
        assert.equal(result.pendingEntryNotionalUsd, 300);
      }),
  );

  it.effect("pending entry notional is zero when nothing rests", () =>
    Effect.gen(function* () {
      yield* migrated;

      const result = yield* read();
      assert.equal(result.pendingEntryNotionalUsd, 0);
    }),
  );
});
