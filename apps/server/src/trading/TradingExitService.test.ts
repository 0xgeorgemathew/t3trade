/**
 * Getting out, sized by the server — step 5 of the viability plan.
 *
 * Every test here is a call the harness makes with almost no arguments, and an
 * intent the server derives in full: the side from the canonical position, the
 * size from what is held, the sequence from what has already been spent, and
 * the price from the live book.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { OrderBook } from "@t3tools/trading-contracts/market";
import type { AgentNetPosition } from "@t3tools/trading-contracts/account-snapshot";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";
import { TradingExitService, TradingExitServiceLive } from "./TradingExitService.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";

const freshness = { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 } as const;

const bestBidOffer = {
  bidPrice: 1_999.5,
  bidSize: 10,
  askPrice: 2_000.5,
  askSize: 10,
  freshness,
} as const;

const book: OrderBook = {
  market: "ETH",
  bids: [{ price: 1_999.5, size: 100 }],
  asks: [{ price: 2_000.5, size: 100 }],
  bestBidOffer,
  freshness,
};

/** What the exchange says is held. The only authority on side and size. */
let heldSize = 0.5;

/**
 * How many times the position read has been asked, and how many of those to
 * fail transiently. The plan's own validation: a transient read fails once,
 * then succeeds on one bounded retry.
 */
let positionReads = 0;
let transientFailuresLeft = 0;

const unusedRead = () => Effect.die("not used by TradingExitService tests");

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: () =>
    Effect.succeed({
      market: "ETH",
      assetIndex: 1,
      szDecimals: 4,
      maxLeverage: 25,
      isTradable: true,
    }),
  getMarketSnapshot: unusedRead,
  getMarketHistory: unusedRead,
  getOrderBook: () => Effect.succeed(book),
  getAccountSnapshot: unusedRead,
  // Suspended, so the counter and the failure branch are evaluatedper run rather
  // than once when the effect is described — a retry re-runs the same effect.
  getPosition: () =>
    Effect.suspend(() => {
      positionReads += 1;
      if (transientFailuresLeft > 0) {
        transientFailuresLeft -= 1;
        return Effect.fail({
          _tag: "HyperliquidRequestError",
          reason: "network",
          operation: "clearinghouseState",
        });
      }
      return Effect.succeed({
        market: "ETH",
        size: heldSize,
        entryPrice: 1_980,
        unrealisedPnl: 10,
        freshness,
      } as unknown as AgentNetPosition);
    }),
  getOpenOrders: unusedRead,
  getTakerFeeRateBps: () => Effect.succeed({ feeBps: 4.5, observedAt: 1_000 }),
} as unknown as (typeof HyperliquidGateway)["Service"]);

const layer = it.layer(
  Layer.mergeAll(
    TradingExitServiceLive.pipe(
      Layer.provide(TradingMissionServiceLive),
      Layer.provide(IocSlippageConfigLive),
      Layer.provide(stubGateway),
    ),
    TradingMissionServiceLive,
  ).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const seed = (options?: { readonly withOpenRun?: boolean; readonly position?: number }) =>
  Effect.gen(function* () {
    heldSize = options?.position ?? 0.5;
    positionReads = 0;
    transientFailuresLeft = 0;

    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 65 });
    yield* sql`DELETE FROM trading_missions`;
    yield* sql`DELETE FROM trading_authority_versions`;
    yield* sql`DELETE FROM trading_harness_runs`;
    yield* sql`DELETE FROM trading_execution_records`;
    yield* sql`DELETE FROM trading_execution_sequences`;
    yield* sql`DELETE FROM trading_accounts`;

    const walletJson =
      '{"privyWalletId":"wallet-exit","address":"0x000000000000000000000000000000000000beef","ownership":"user"}';
    yield* sql`
      INSERT INTO trading_accounts (
        account_id, user_id, environment, master_wallet_json,
        execution_wallet_json, status, created_at, updated_at
      ) VALUES ('acct_1', 'user_1', 'hyperliquid_testnet', ${walletJson}, ${walletJson}, 'ready', 0, 0)
    `;

    const missions = yield* TradingMissionService;
    yield* missions.createMission({
      missionId: "mission_1",
      userId: "user_1",
      tradingAccountId: "acct_1",
      instruction: "Trade ETH momentum",
      allocatedCapitalUsd: 1_000,
      harness,
    });
    yield* sql`UPDATE trading_missions SET status = 'position_open' WHERE mission_id = 'mission_1'`;

    if (options?.withOpenRun !== false) {
      yield* sql`
        INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
        VALUES ('run_1', 'mission_1', 'scheduled_reassessment', 'starting', 1000, 1000)
      `;
    }
  });

layer("TradingExitService", (it) => {
  it.effect("derives a whole close from a request carrying nothing but a kind", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({ missionId: "mission_1", kind: "close" });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      const intent = prepared.intent;
      // Nothing below was supplied by the caller.
      assert.strictEqual(intent.actionType, "close");
      assert.strictEqual(intent.side, "sell");
      assert.strictEqual(intent.size, 0.5);
      assert.strictEqual(intent.market, "ETH");
      assert.strictEqual(intent.reduceOnly, true);
      assert.strictEqual(intent.executionSequence, 0);
      assert.strictEqual(prepared.activeHarnessRunId, "run_1");
      // A crossing sell sits below the bid by the slippage allowance.
      assert.isBelow(intent.limitPrice, 1_999.5);
    }),
  );

  it.effect("closes a short by buying, without being told the position is short", () =>
    Effect.gen(function* () {
      yield* seed({ position: -0.25 });
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({ missionId: "mission_1", kind: "close" });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      assert.strictEqual(prepared.intent.side, "buy");
      assert.strictEqual(prepared.intent.size, 0.25);
      assert.isAbove(prepared.intent.limitPrice, 2_000.5);
    }),
  );

  it.effect("rests a patient close reduce-only at the near side instead of crossing", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({
        missionId: "mission_1",
        kind: "close",
        urgency: "patient",
      });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      const intent = prepared.intent;
      // The urgency becomes a post-only preference; the mapper turns that into
      // a reduce-only ALO on the wire. The price is the near side of the book
      // — the ask for a sell — so the order rests as maker.
      assert.strictEqual(intent.orderPreference, "post_only");
      assert.strictEqual(intent.limitPrice, 2_000.5);
      assert.strictEqual(intent.reduceOnly, true);
      assert.strictEqual(intent.size, 0.5);
    }),
  );

  it.effect("rests a patient reduce at the near side too", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({
        missionId: "mission_1",
        kind: "reduce",
        fraction: 0.5,
        urgency: "patient",
      });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      assert.strictEqual(prepared.intent.orderPreference, "post_only");
      assert.strictEqual(prepared.intent.limitPrice, 2_000.5);
      assert.strictEqual(prepared.intent.actionType, "reduce");
      assert.strictEqual(prepared.intent.size, 0.25);
    }),
  );

  it.effect("takes a fraction off and leaves the rest", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({
        missionId: "mission_1",
        kind: "reduce",
        fraction: 0.5,
      });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      assert.strictEqual(prepared.intent.actionType, "reduce");
      assert.strictEqual(prepared.intent.size, 0.25);
      assert.strictEqual(prepared.note, null);
    }),
  );

  it.effect("cannot increase exposure however much is asked for", () =>
    Effect.gen(function* () {
      // Ten times the position. A reduce that crossed through flat would be an
      // unprotected reversal the authority never granted.
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({
        missionId: "mission_1",
        kind: "reduce",
        sizeEth: 5,
      });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      assert.strictEqual(prepared.intent.size, 0.5);
      assert.strictEqual(prepared.intent.side, "sell");
      assert.strictEqual(prepared.intent.reduceOnly, true);
    }),
  );

  it.effect("promotes a reduce that would leave dust into a close, and says so", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({
        missionId: "mission_1",
        kind: "reduce",
        sizeEth: 0.4975,
      });

      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      assert.strictEqual(prepared.intent.actionType, "close");
      assert.strictEqual(prepared.intent.size, 0.5);
      assert.include(prepared.note ?? "", "exchange minimum");
    }),
  );

  it.effect("refuses an exit with nothing held", () =>
    Effect.gen(function* () {
      yield* seed({ position: 0 });
      const exits = yield* TradingExitService;
      const fiber = yield* exits
        .prepare({ missionId: "mission_1", kind: "close" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const prepared = yield* Fiber.join(fiber);

      assert.strictEqual(prepared.outcome, "refused");
      if (prepared.outcome !== "refused") return;
      assert.strictEqual(prepared.reason, "no_position");
    }),
  );

  it.effect("refuses a reduce that names no size", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;
      const prepared = yield* exits.prepare({ missionId: "mission_1", kind: "reduce" });

      assert.strictEqual(prepared.outcome, "refused");
      if (prepared.outcome !== "refused") return;
      assert.strictEqual(prepared.reason, "no_size_named");
    }),
  );

  it.effect("builds a cancel from one cloid, and refuses one without", () =>
    Effect.gen(function* () {
      yield* seed();
      const exits = yield* TradingExitService;

      const prepared = yield* exits.prepare({
        missionId: "mission_1",
        kind: "cancel",
        cloid: "0xdeadbeef",
      });
      assert.strictEqual(prepared.outcome, "ready");
      if (prepared.outcome !== "ready") return;
      assert.strictEqual(prepared.intent.actionType, "cancel");
      assert.strictEqual(prepared.intent.targetCloid, "0xdeadbeef");

      const missing = yield* exits.prepare({ missionId: "mission_1", kind: "cancel" });
      assert.strictEqual(missing.outcome, "refused");
      if (missing.outcome !== "refused") return;
      assert.strictEqual(missing.reason, "no_target_named");
    }),
  );

  it.effect("refuses to size an exit outside a turn that owns the lease", () =>
    Effect.gen(function* () {
      yield* seed({ withOpenRun: false });
      const exits = yield* TradingExitService;
      const fiber = yield* exits
        .prepare({ missionId: "mission_1", kind: "close" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const prepared = yield* Fiber.join(fiber);

      assert.strictEqual(prepared.outcome, "refused");
      if (prepared.outcome !== "refused") return;
      assert.strictEqual(prepared.reason, "harness_run_owns_lease");
    }),
  );

  it.effect("never hands two exits the same execution sequence", () =>
    Effect.gen(function* () {
      // The sequence derives the cloid, so two exits sharing one would reach the
      // exchange as a duplicate of each other.
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const exits = yield* TradingExitService;

      const first = yield* exits.prepare({ missionId: "mission_1", kind: "reduce", fraction: 0.2 });
      assert.strictEqual(first.outcome, "ready");
      if (first.outcome !== "ready") return;
      assert.strictEqual(first.intent.executionSequence, 0);

      // Exits are not held like quotes, so what advances the sequence is the
      // execution the first one wrote.
      yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at
        ) VALUES (
          'exec_1', 'mission_1', 0, 'reduce',
          '0xcloid', 'idem_1', 'ETH', 'sell', 0.1, 1999, 'ioc',
          1, '0xsigner', 'submitted', '[]', 1000, 1000
        )
      `;

      const second = yield* exits.prepare({
        missionId: "mission_1",
        kind: "reduce",
        fraction: 0.2,
      });
      assert.strictEqual(second.outcome, "ready");
      if (second.outcome !== "ready") return;
      assert.strictEqual(second.intent.executionSequence, 1);
    }),
  );
  it.effect("retries a dropped read once, and answers on the second attempt", () =>
    Effect.gen(function* () {
      yield* seed();
      transientFailuresLeft = 1;

      const exits = yield* TradingExitService;
      // The retry waits out the failure's own backoff, so the test clock has to
      // be moved past it rather than the test waiting.
      const fiber = yield* exits
        .prepare({ missionId: "mission_1", kind: "close" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const prepared = yield* Fiber.join(fiber);

      // The old behaviour: one dropped socket ended the turn with
      // `market_data_unavailable` and the harness stood down.
      assert.strictEqual(prepared.outcome, "ready");
      assert.strictEqual(positionReads, 2);
    }),
  );

  it.effect("gives up after one retry rather than hiding an outage", () =>
    Effect.gen(function* () {
      yield* seed();
      transientFailuresLeft = 5;

      const exits = yield* TradingExitService;
      const fiber = yield* exits
        .prepare({ missionId: "mission_1", kind: "close" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const prepared = yield* Fiber.join(fiber);

      assert.strictEqual(prepared.outcome, "refused");
      // Two attempts, not five. A second retry would be a policy, and a policy
      // about retries is a thing that hides an outage.
      assert.strictEqual(positionReads, 2);
    }),
  );
});
