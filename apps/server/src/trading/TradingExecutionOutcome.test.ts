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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingRequestEntryResult } from "@t3tools/trading-contracts/tools";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { executionRefusedKey, executionSettledKey } from "./ExecutionRefusal.ts";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";
import {
  TradingExecutionReceipts,
  TradingExecutionReceiptsLive,
} from "./TradingExecutionReceipts.ts";
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

/**
 * Set for the one test that needs the budget read to fail. The reader is
 * acquired once at layer build, so the failure has to be switchable from
 * inside it rather than provided per call.
 */
let budgetReadFails = false;

const SwitchableBudgetReader = Layer.succeed(TradingBudgetReader)({
  read: (request: { readonly maximumCumulativeLossUsd: number }) =>
    budgetReadFails
      ? Effect.die("budget read failed")
      : Effect.succeed({
          maximumCumulativeLossUsd: request.maximumCumulativeLossUsd,
          closedPnlUsd: 0,
          netFundingUsd: 0,
          allPaidTradingFeesUsd: 0,
          openPositions: [],
          pendingEntries: [],
          observedAt: 1_000,
        }),
} as unknown as (typeof TradingBudgetReader)["Service"]);

const layer = it.layer(
  TradingExecutionOutcomeLive.pipe(
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(TradingExecutionReceiptsLive),
    Layer.provideMerge(SwitchableBudgetReader),
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
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_fills`;
});

/**
 * Encode a result the way the MCP toolkit does before answering the harness.
 *
 * This is the assertion that matters as much as the field values: the toolkit
 * encodes every tool result against its schema, so a result the schema refuses
 * does not reach the harness at all — it becomes "an internal server error"
 * with the reason stripped off. Reporting `executionId: ""` for the two
 * outcomes that have no record did exactly that, turning every refusal into a
 * mystery the harness could only resolve by waiting for the next wakeup.
 */
const encodeForHarness = Schema.encodeUnknownSync(TradingRequestEntryResult);

const input: AwaitOutcomeInput = {
  missionId: MISSION_ID,
  executionSequence: 0,
  actionType: "open",
  maximumCumulativeLossUsd: 5,
  fallbackTakerFeeBpsPerSide: 5,
  masterAddress: "0x000000000000000000000000000000000000beef",
};

/** An execution record in a terminal status, as the submit path would leave it. */
const insertRecord = (status: string, actionType = "open") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, strategy_version, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at
      ) VALUES (
        'exec-1', ${MISSION_ID}, 1, 0, ${actionType},
        '0xcloid', ${`idem-${status}`}, 'ETH', 'buy', 0.5, 3001, 'ioc',
        0, '0x00000000000000000000000000000000000000ff', ${status},
        '[{"status":"filled"}]', 1000, 1000
      )
    `;
  });

/** The reconciled position the ack for a reduce reports what is left of. */
const writePosition = (size: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_position_snapshots (
        mission_id, market, size, entry_price, unrealised_pnl,
        margin_used, protected_size, observed_at
      ) VALUES (${MISSION_ID}, 'ETH', ${size}, 3000, 0, 10, ${size}, 1000)
    `;
  });

/** Two partial fills under the record's cloid, for the weighted-average ack. */
const writeFills = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO trading_fills (
      fill_id, mission_id, cloid, order_id, market, side, filled_size,
      avg_fill_price, fee_usd, fee_token, closed_pnl, traded_at, observed_at
    ) VALUES
      ('fill-1', ${MISSION_ID}, '0xcloid', 1, 'ETH', 'buy', 0.25, 3000, 0.1, 'USDC', 0, 900, 900),
      ('fill-2', ${MISSION_ID}, '0xcloid', 1, 'ETH', 'buy', 0.25, 3010, 0.1, 'USDC', 0, 950, 950)
  `;
});

layer("TradingExecutionOutcome", (it) => {
  /**
   * §15.4: the IOC limit is derived server-side from the BBO, so the price the
   * intent named and the price that was placed are two different numbers, and
   * neither is the fill. Reporting only "accepted" left the harness modelling
   * its loss against a price nothing used.
   */
  it.effect("reports the placed limit and the size-weighted average fill price", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("filled");
      yield* writeFills;

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      assert.equal(outcome.limitPrice, 3001);
      assert.equal(outcome.avgFillPrice, 3005);
      // And it survives the schema the toolkit encodes against.
      encodeForHarness(outcome);
    }),
  );

  it.effect("leaves the average fill price off when nothing filled", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("rejected");

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      assert.equal(outcome.limitPrice, 3001);
      assert.equal(outcome.avgFillPrice, undefined);
      encodeForHarness(outcome);
    }),
  );

  it.effect("reports the exchange outcome when a record reached a terminal status", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("filled");

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      // The record's own word, not a flattening of it: "accepted" for a filled
      // record cannot say whether the order filled or is still resting.
      assert.equal(outcome.status, "filled");
      assert.equal(outcome.executionId, "exec-1");
      assert.equal(outcome.cloid, "0xcloid");
      assert.equal(outcome.orderResults.length, 1);
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

  it.effect("reports a cancelled record as cancelled, never as accepted", () =>
    // A record the exchange resolved by removing the order from the book. Read
    // as "accepted", it tells the harness it still has a live order.
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("cancelled");

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      assert.equal(outcome.status, "cancelled");
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );

  it.effect("reports a failed record as failed", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("failed");

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      assert.equal(outcome.status, "failed");
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );

  it.effect("states what remains after a reduce", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* insertRecord("filled", "reduce");
      yield* writePosition(0.25);

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome({
        ...input,
        actionType: "reduce",
      });

      assert.equal(outcome.status, "filled");
      assert.equal(outcome.remainingSize, 0.25);
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );

  it.effect("answers a cancel from its recorded settlement", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* (yield* TradingEventInbox).persist({
        missionId: MISSION_ID,
        category: "system",
        deduplicationKey: executionSettledKey(0),
        payload: {},
        occurredAt: 1_000,
        summary: "order 0xabc cancelled",
      });

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome({
        ...input,
        actionType: "cancel",
      });

      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.detail, "order 0xabc cancelled");
    }),
  );

  it.effect(
    "answers a stop move from its recorded settlement, without waiting out the deadline",
    () =>
      // `cancel` and `modify_stop` write no execution record, so this inbox row
      // is the only thing that can answer them. Without it the tool polled for a
      // full twenty seconds and then reported an action that had already
      // succeeded as "still in flight".
      Effect.gen(function* () {
        yield* migrated;
        yield* (yield* TradingEventInbox).persist({
          missionId: MISSION_ID,
          category: "system",
          deduplicationKey: executionSettledKey(0),
          payload: {},
          occurredAt: 1_000,
          summary: "stop moved to 2950; 0.05 of the position is confirmed protected",
        });

        const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome({
          ...input,
          actionType: "modify_stop",
        });

        assert.equal(outcome.status, "succeeded");
        assert.match(outcome.detail ?? "", /stop moved to 2950/);
        assert.doesNotThrow(() => encodeForHarness(outcome));
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
      assert.equal(outcome.executionId, undefined);
      assert.equal(outcome.cloid, "");
      assert.match(outcome.detail ?? "", /mission_active/);
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );

  it.effect("says it does not know yet when nothing has concluded, encodably", () =>
    Effect.gen(function* () {
      yield* migrated;

      // No record and no refusal: `awaitOutcome` polls to its deadline. Drive
      // the test clock past it rather than waiting twenty real seconds.
      const outcomes = yield* TradingExecutionOutcome;
      const fiber = yield* outcomes.awaitOutcome(input).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(30));
      const outcome = yield* Fiber.join(fiber);

      assert.equal(outcome.status, "submitted");
      assert.equal(outcome.executionId, undefined);
      assert.match(outcome.detail ?? "", /still being executed/);
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );
  it.effect("never tells the harness to retry a submission whose outcome is unknown", () =>
    Effect.gen(function* () {
      // The one case that could turn one intended order into two real ones.
      yield* migrated;

      const outcomes = yield* TradingExecutionOutcome;
      const fiber = yield* outcomes.awaitOutcome(input).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(30));
      const outcome = yield* Fiber.join(fiber);

      assert.equal(outcome.status, "submitted");
      assert.equal(outcome.recovery?.retryable, false);
      assert.equal(outcome.recovery?.action, "read_state");
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );

  it.effect("classifies a recorded refusal so the harness knows whether to re-quote", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* (yield* TradingEventInbox).persist({
        missionId: MISSION_ID,
        category: "system",
        deduplicationKey: executionRefusedKey(0),
        payload: {},
        occurredAt: 1_000,
        summary:
          "execution 0 refused: TradingPreviewRejection(account_and_bbo_fresh): BBO aged 5200ms past the 2s window",
      });

      const outcome = yield* (yield* TradingExecutionOutcome).awaitOutcome(input);

      // Nothing was signed, and the only thing wrong was the age of a price.
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.recovery?.action, "re_quote");
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );

  it.effect("answers as soon as the reactor settles, without waiting out a poll", () =>
    Effect.gen(function* () {
      yield* migrated;

      const receipts = yield* TradingExecutionReceipts;
      const outcomes = yield* TradingExecutionOutcome;
      const fiber = yield* outcomes.awaitOutcome(input).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      // The reactor's own order: write the durable record, then signal. The
      // clock never moves, so nothing here can be a poll that happened to land.
      yield* insertRecord("filled");
      yield* receipts.settle({ missionId: MISSION_ID, executionSequence: 0 });

      const outcome = yield* Fiber.join(fiber);
      assert.equal(outcome.status, "filled");
    }),
  );

  it.effect("reports an unreadable budget as unknown, never as exhausted", () =>
    Effect.gen(function* () {
      // §16.4 uses `exhausted` for a mission that must stop trading, and a
      // harness told that stops trading. A failed read says nothing about the
      // budget, so it must not say that word.
      yield* migrated;
      yield* insertRecord("filled");
      budgetReadFails = true;

      const outcome = yield* (yield* TradingExecutionOutcome)
        .awaitOutcome(input)
        .pipe(Effect.ensuring(Effect.sync(() => (budgetReadFails = false))));

      assert.equal(outcome.status, "filled");
      assert.equal(outcome.budget.exhausted, false);
      assert.match(outcome.detail ?? "", /unknown, not exhausted/);
      assert.doesNotThrow(() => encodeForHarness(outcome));
    }),
  );
});
