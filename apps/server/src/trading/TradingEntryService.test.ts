import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { AgentMarketSnapshot, OrderBook } from "@t3tools/trading-contracts/market";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";
import { TradingBudgetReaderLive } from "./TradingBudgetReader.ts";
import { TradingCostEstimatorLive } from "./TradingCostEstimator.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingEntryService, TradingEntryServiceLive } from "./TradingEntryService.ts";

const freshness = { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 } as const;

const bestBidOffer = {
  bidPrice: 1_999.5,
  bidSize: 10,
  askPrice: 2_000.5,
  askSize: 10,
  freshness,
} as const;

const snapshot: AgentMarketSnapshot = {
  market: "ETH",
  markPrice: 2_000,
  midPrice: 2_000,
  oraclePrice: 2_000,
  fundingRate8h: 0.0001,
  openInterest: 1_000,
  dayVolumeUsd: 1_000_000,
  bestBidOffer,
  freshness,
  change24hPercent: 0.5,
};

const book: OrderBook = {
  market: "ETH",
  bids: [{ price: 1_999.5, size: 100 }],
  asks: [{ price: 2_000.5, size: 100 }],
  bestBidOffer,
  freshness,
};

/** A book that lost a side — one read that can answer differently in a second. */
const oneSidedBook: OrderBook = {
  ...book,
  asks: [],
  bestBidOffer: { ...bestBidOffer, askPrice: undefined, askSize: undefined },
};

/** What the stub gateway serves. `seed()` puts the two-sided book back. */
let servedBook: OrderBook = book;

const unusedRead = () => Effect.die("not used by TradingEntryService tests");

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: () =>
    Effect.succeed({
      market: "ETH",
      assetIndex: 1,
      szDecimals: 4,
      maxLeverage: 25,
      isTradable: true,
    }),
  getMarketSnapshot: () => Effect.succeed(snapshot),
  getMarketHistory: unusedRead,
  getOrderBook: () => Effect.succeed(servedBook),
  getAccountSnapshot: unusedRead,
  getPosition: unusedRead,
  getOpenOrders: unusedRead,
  getTakerFeeRateBps: () => Effect.succeed({ feeBps: 4.5, observedAt: 1_000 }),
  getUserFeeRatesBps: () =>
    Effect.succeed({
      takerFeeBps: 4.5,
      makerFeeBps: 4.5,
      observedAt: 1_000,
      makerRateSource: "hyperliquid_user_fees",
    }),
} as unknown as (typeof HyperliquidGateway)["Service"]);

const layer = it.layer(
  Layer.mergeAll(
    TradingEntryServiceLive.pipe(
      Layer.provide(TradingMissionServiceLive),
      Layer.provide(IocSlippageConfigLive),
      Layer.provide(TradingBudgetReaderLive),
      Layer.provide(TradingCostEstimatorLive.pipe(Layer.provide(stubGateway))),
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

/**
 * A mission with a published strategy and one open harness run — the state an
 * entry is only prepared inside. Each test starts from the same clean slate.
 */
const seed = (options?: { readonly withOpenRun?: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    servedBook = book;
    yield* runMigrations({ toMigrationInclusive: 65 });
    yield* sql`DELETE FROM trading_missions`;
    yield* sql`DELETE FROM trading_authority_versions`;
    yield* sql`DELETE FROM trading_harness_runs`;
    yield* sql`DELETE FROM trading_entry_context`;
    yield* sql`DELETE FROM trading_execution_records`;
    yield* sql`DELETE FROM trading_execution_sequences`;
    yield* sql`DELETE FROM trading_accounts`;

    // The master wallet is the §10.6 identity every account and fee read uses.
    const walletJson =
      '{"privyWalletId":"wallet-entry","address":"0x000000000000000000000000000000000000beef","ownership":"user"}';
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
    // Preparing runs the real preview, which requires a live mission.
    yield* sql`UPDATE trading_missions SET status = 'waiting' WHERE mission_id = 'mission_1'`;

    if (options?.withOpenRun !== false) {
      yield* sql`
        INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
        VALUES ('run_1', 'mission_1', 'scheduled_reassessment', 'starting', 1000, 1000)
      `;
    }
  });

const enterALong = Effect.gen(function* () {
  const entries = yield* TradingEntryService;
  return yield* entries.prepare({
    missionId: "mission_1",
    market: "ETH",
    side: "buy",
    stopPrice: 1_980,
    sizeEth: 0.05,
  });
});

layer("TradingEntryService", (it) => {
  it.effect("derives the whole order from a side, a stop, and a size", () =>
    Effect.gen(function* () {
      yield* seed();

      const result = yield* enterALong;

      assert.strictEqual(result.outcome, "prepared");
      if (result.outcome !== "prepared") return;

      // Nothing here was supplied by the caller.
      assert.strictEqual(result.activeHarnessRunId, "run_1");
      assert.strictEqual(result.intent.executionSequence, 0);
      assert.strictEqual(result.size, 0.05);
      assert.strictEqual(result.constrainedBy, "requested");
      // A marketable buy has to cross, so the limit sits above the ask.
      assert.isAbove(result.intent.limitPrice, bestBidOffer.askPrice);
      // Planned loss is size x the distance from the fill price to the stop.
      assert.closeTo(result.plannedLossAtStopUsd, 0.05 * (2_000.5 - 1_980), 1e-9);
      assert.strictEqual(result.intent.stop?.stopPrice, 1_980);
    }),
  );

  it.effect("records the entry's evidence before the order goes out", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;

      const result = yield* enterALong;
      assert.strictEqual(result.outcome, "prepared");
      if (result.outcome !== "prepared") return;

      const rows = yield* sql<{
        readonly execution_sequence: number;
        readonly entry_price: number;
        readonly stop_price: number;
        readonly best_ask: number;
      }>`
        SELECT execution_sequence, entry_price, stop_price, best_ask
        FROM trading_entry_context WHERE mission_id = 'mission_1'
      `;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.execution_sequence, result.intent.executionSequence);
      // A buy is filled at the ask, not at the padded crossing limit.
      assert.strictEqual(rows[0]?.entry_price, bestBidOffer.askPrice);
      assert.strictEqual(rows[0]?.best_ask, bestBidOffer.askPrice);
      assert.strictEqual(rows[0]?.stop_price, 1_980);
    }),
  );

  it.effect("proposes the size a ceiling allows instead of refusing the one asked for", () =>
    Effect.gen(function* () {
      yield* seed();
      const entries = yield* TradingEntryService;

      // 200 ETH is far past both the leverage and the gross-notional ceilings
      // a $1,000 allocation carries.
      const result = yield* entries.prepare({
        missionId: "mission_1",
        market: "ETH",
        side: "buy",
        stopPrice: 1_980,
        sizeEth: 200,
      });

      assert.strictEqual(result.outcome, "prepared");
      if (result.outcome !== "prepared") return;
      assert.isBelow(result.size, 200);
      assert.notStrictEqual(result.constrainedBy, "requested");
      assert.isAbove(result.notes.length, 0);
    }),
  );

  it.effect("refuses a stop on the winning side, and says so in the harness's terms", () =>
    Effect.gen(function* () {
      yield* seed();
      const entries = yield* TradingEntryService;

      const result = yield* entries.prepare({
        missionId: "mission_1",
        market: "ETH",
        side: "buy",
        stopPrice: 2_100,
        sizeEth: 0.05,
      });

      assert.strictEqual(result.outcome, "refused");
      if (result.outcome !== "refused") return;
      assert.strictEqual(result.reason, "stop_on_wrong_side");
    }),
  );

  it.effect("will not prepare an entry outside a turn that owns the decision lease", () =>
    Effect.gen(function* () {
      yield* seed({ withOpenRun: false });

      const result = yield* enterALong;

      assert.strictEqual(result.outcome, "refused");
      if (result.outcome !== "refused") return;
      assert.strictEqual(result.reason, "harness_run_owns_lease");
    }),
  );

  // The §16.3 checklist runs here rather than on the reactor, so the refusal
  // it produces has to reach the harness classified as the preview rejection
  // it is. A bare reason string classifies as `read_state`, which reads to a
  // harness as "look again" for a rule that is not going to change.
  it.effect("classifies a checklist refusal as the preview rejection it is", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE trading_missions
        SET control_json = json_set(control_json, '$.entriesAllowed', json('false'))
        WHERE mission_id = 'mission_1'
      `;

      const result = yield* enterALong;

      assert.strictEqual(result.outcome, "refused");
      if (result.outcome !== "refused") return;
      assert.strictEqual(result.reason, "entries_allowed");
      assert.strictEqual(result.recovery.action, "stand_down");
      assert.strictEqual(result.recovery.reason, "preview_entries_allowed");
      assert.strictEqual(result.recovery.retryable, false);
    }),
  );

  // The opposite end of the same range: a read that could answer differently
  // in a second must not tell the harness the answer is settled.
  it.effect("says a book that went one-sided is worth one more attempt", () =>
    Effect.gen(function* () {
      yield* seed();
      const entries = yield* TradingEntryService;

      servedBook = oneSidedBook;

      const result = yield* entries.prepare({
        missionId: "mission_1",
        market: "ETH",
        side: "buy",
        stopPrice: 1_980,
        sizeEth: 0.05,
      });

      assert.strictEqual(result.outcome, "refused");
      if (result.outcome !== "refused") return;
      assert.strictEqual(result.reason, "market_data_unavailable");
      assert.strictEqual(result.recovery.retryable, true);
      assert.strictEqual(result.recovery.action, "retry");
    }),
  );

  it.effect("hands each entry its own sequence, so two orders never share a cloid", () =>
    Effect.gen(function* () {
      yield* seed();

      const first = yield* enterALong;
      const second = yield* enterALong;

      assert.strictEqual(first.outcome, "prepared");
      assert.strictEqual(second.outcome, "prepared");
      if (first.outcome !== "prepared" || second.outcome !== "prepared") return;
      assert.strictEqual(first.intent.executionSequence, 0);
      assert.strictEqual(second.intent.executionSequence, 1);
    }),
  );

  it.effect("allocates distinct sequences when entries are prepared concurrently", () =>
    Effect.gen(function* () {
      yield* seed();

      const results = yield* Effect.all([enterALong, enterALong, enterALong], {
        concurrency: "unbounded",
      });
      const sequences = results.flatMap((result) =>
        result.outcome === "prepared" ? [result.intent.executionSequence] : [],
      );

      assert.deepStrictEqual(
        [...sequences].sort((a, b) => a - b),
        [0, 1, 2],
      );
      assert.strictEqual(new Set(sequences).size, 3);
    }),
  );

  // Plan 29 step 4.1: the stand-down of the old schema is `intent:
  // "stand_aside"`, and it must skip the entry-sizing lift exactly as the
  // stand-down did — a plan that declined to trade does not size an entry
  // toward a target it is not aiming at.
  it.effect("skips the target-sizing lift on a stand-aside plan, applies it on a long", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;

      // The plan's target, as the reshaped document stores it: a $50 rung at a
      // level $100 above the entry. Sizing toward it lifts the 0.05 ETH
      // request to whatever the ceilings allow.
      const planJson = (intent: "long" | "stand_aside") =>
        `{"market":"ETH","intent":"${intent}","entry":{"triggers":[],"urgency":"now"},` +
        `"stop":{"method":"swing low"},"target":{"profitUsd":50,"price":2100.5},` +
        `"invalidation":[],"reassess":{"afterMinutes":90},"because":"x","updatedAt":1000}`;
      yield* sql`
        INSERT INTO trading_plan_history (mission_id, version, strategy_json, created_at)
        VALUES ('mission_1', 1, ${planJson("long")}, 1000)
      `;

      const lifted = yield* enterALong;
      assert.strictEqual(lifted.outcome, "prepared");

      yield* sql`
        UPDATE trading_plan_history
        SET strategy_json = ${planJson("stand_aside")}
        WHERE mission_id = 'mission_1' AND version = 1
      `;
      const skipped = yield* enterALong;
      assert.strictEqual(skipped.outcome, "prepared");

      if (lifted.outcome !== "prepared" || skipped.outcome !== "prepared") return;
      // The lift is real (the long plan's target raised the size above the
      // bare request), and the stand-aside skips it: same target fields, no
      // lift — the request is sized exactly as a plan with no target is.
      assert.isAbove(lifted.size, 0.05);
      assert.strictEqual(skipped.size, 0.05);
      assert.strictEqual(skipped.constrainedBy, "requested");
    }),
  );
});
