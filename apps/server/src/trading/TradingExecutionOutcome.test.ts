/**
 * What `trading_request_entry` tells the harness.
 *
 * The tool used to report `status: "submitted"` the instant the request was
 * dispatched, so a request the reactor went on to refuse read as a request that
 * had entered. These tests pin the three answers that replaced that: the
 * exchange's own outcome, the recorded refusal, and — only when neither has
 * landed — an explicit "not known yet".
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { executionRefusedKey } from "./ExecutionRefusal.ts";
import { TradingBudgetReaderLive } from "./TradingBudgetReader.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";
import {
  TradingExecutionOutcome,
  TradingExecutionOutcomeLive,
  type AwaitOutcomeInput,
} from "./TradingExecutionOutcome.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

const MISSION_ID = "mission-outcome";

/**
 * The gateway is reached only for the live taker fee rate. Failing it exercises
 * the authority's fallback rate, which keeps these tests off the network
 * without pretending the fee read always succeeds.
 */
const FailingGateway = Layer.succeed(HyperliquidGateway)({
  getTakerFeeRateBps: () => Effect.die("no network in this test"),
} as unknown as HyperliquidGateway["Service"]);

const layer = it.layer(
  TradingExecutionOutcomeLive.pipe(
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(TradingBudgetReaderLive),
    Layer.provideMerge(FailingGateway),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_event_inbox`;
});

const input: AwaitOutcomeInput = {
  missionId: MISSION_ID,
  executionSequence: 0,
  maximumCumulativeLossUsd: 5,
  fallbackTakerFeeBpsPerSide: 5,
  masterAddress: "0x000000000000000000000000000000000000beef",
};

/** An execution record in a terminal status, as the submit path would leave it. */
const insertRecord = (status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, strategy_version, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at
      ) VALUES (
        'exec-1', ${MISSION_ID}, 1, 0, 'open',
        '0xcloid', ${`idem-${status}`}, 'ETH', 'buy', 0.5, 3001, 'ioc',
        0, '0x00000000000000000000000000000000000000ff', ${status},
        '[{"status":"filled"}]', 1000, 1000
      )
    `;
  });

layer("TradingExecutionOutcome", (it) => {
  it.effect("reports the exchange outcome when a record reached a terminal status", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("filled");

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      assert.equal(outcome.status, "accepted");
      assert.equal(outcome.executionId, "exec-1");
      assert.equal(outcome.cloid, "0xcloid");
      assert.equal(outcome.orderResults.length, 1);
      // `detail` carries the record's own status: "accepted" alone cannot say
      // whether the order filled or is resting.
      assert.equal(outcome.detail, "filled");
    }),
  );

  it.effect("reports a rejected record as rejected", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("rejected");

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.detail, "rejected");
    }),
  );

  it.effect("reports the recorded reason when the request was refused before signing", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* (yield* TradingEventInbox).persist({
        missionId: MISSION_ID,
        category: "system",
        deduplicationKey: executionRefusedKey(0),
        payload: {},
        occurredAt: 1_000,
        summary: "execution 0 refused: mission_active: mission status is initializing",
      });

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      // No record exists: nothing was signed and no order was placed. The
      // harness has to be able to tell that apart from an exchange rejection.
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.executionId, "");
      assert.equal(outcome.cloid, "");
      assert.match(outcome.detail ?? "", /mission_active/);
    }),
  );
});
