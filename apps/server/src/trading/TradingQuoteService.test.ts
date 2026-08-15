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
import { TradingQuoteService, TradingQuoteServiceLive } from "./TradingQuoteService.ts";

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

const unusedRead = () => Effect.die("not used by TradingQuoteService tests");

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
  getOrderBook: () => Effect.succeed(book),
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
    TradingQuoteServiceLive.pipe(
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
 * A mission with a published strategy and one open harness run — the state a
 * quote is only cut inside. Each test starts from the same clean slate.
 */
const seed = (options?: { readonly withOpenRun?: boolean }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 60 });
    yield* sql`DELETE FROM trading_missions`;
    yield* sql`DELETE FROM trading_authority_versions`;
    yield* sql`DELETE FROM trading_harness_runs`;
    yield* sql`DELETE FROM trading_entry_quotes`;
    yield* sql`DELETE FROM trading_execution_records`;
    yield* sql`DELETE FROM trading_execution_sequences`;
    yield* sql`DELETE FROM trading_accounts`;

    // The master wallet is the §10.6 identity every account and fee read uses.
    const walletJson =
      '{"privyWalletId":"wallet-quote","address":"0x000000000000000000000000000000000000beef","ownership":"user"}';
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
    // A quote runs the real preview, which requires a published strategy.
    yield* sql`UPDATE trading_missions SET strategy_version = 1, status = 'waiting' WHERE mission_id = 'mission_1'`;

    if (options?.withOpenRun !== false) {
      yield* sql`
        INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
        VALUES ('run_1', 'mission_1', 'scheduled_reassessment', 'starting', 1000, 1000)
      `;
    }
  });

const quoteALong = Effect.gen(function* () {
  const quotes = yield* TradingQuoteService;
  return yield* quotes.quote({
    missionId: "mission_1",
    market: "ETH",
    side: "buy",
    stopPrice: 1_980,
    sizeEth: 0.05,
  });
});

layer("TradingQuoteService", (it) => {
  it.effect("derives the whole order from a side, a stop, and a size", () =>
    Effect.gen(function* () {
      yield* seed();

      const result = yield* quoteALong;

      assert.strictEqual(result.outcome, "quoted");
      if (result.outcome !== "quoted") return;
      const quote = result.quote;

      // Nothing here was supplied by the caller.
      assert.strictEqual(quote.strategyVersion, 1);
      assert.strictEqual(quote.harnessRunId, "run_1");
      assert.strictEqual(quote.executionSequence, 0);
      assert.strictEqual(quote.size, 0.05);
      assert.strictEqual(quote.constrainedBy, "requested");
      // A marketable buy has to cross, so the limit sits above the ask.
      assert.isAbove(quote.limitPrice, bestBidOffer.askPrice);
      // Planned loss is size x the distance from the fill price to the stop.
      assert.closeTo(quote.plannedLossAtStopUsd, 0.05 * (2_000.5 - 1_980), 1e-9);
      assert.isAbove(quote.expiresAt, quote.quotedAt);
    }),
  );

  it.effect("proposes the size a ceiling allows instead of refusing the one asked for", () =>
    Effect.gen(function* () {
      yield* seed();
      const quotes = yield* TradingQuoteService;

      // 200 ETH is far past both the leverage and the gross-notional ceilings
      // a $1,000 allocation carries.
      const result = yield* quotes.quote({
        missionId: "mission_1",
        market: "ETH",
        side: "buy",
        stopPrice: 1_980,
        sizeEth: 200,
      });

      assert.strictEqual(result.outcome, "quoted");
      if (result.outcome !== "quoted") return;
      assert.isBelow(result.quote.size, 200);
      assert.strictEqual(result.quote.requestedSize, 200);
      assert.notStrictEqual(result.quote.constrainedBy, "requested");
      assert.isAbove(result.warnings.length, 0);
    }),
  );

  it.effect("refuses a stop on the winning side, and says so in the harness's terms", () =>
    Effect.gen(function* () {
      yield* seed();
      const quotes = yield* TradingQuoteService;

      const result = yield* quotes.quote({
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

  it.effect("will not quote outside a turn that owns the decision lease", () =>
    Effect.gen(function* () {
      yield* seed({ withOpenRun: false });

      const result = yield* quoteALong;

      assert.strictEqual(result.outcome, "refused");
      if (result.outcome !== "refused") return;
      assert.strictEqual(result.reason, "harness_run_owns_lease");
    }),
  );

  it.effect("hands each quote its own sequence, so two orders never share a cloid", () =>
    Effect.gen(function* () {
      yield* seed();

      const first = yield* quoteALong;
      const second = yield* quoteALong;

      assert.strictEqual(first.outcome, "quoted");
      assert.strictEqual(second.outcome, "quoted");
      if (first.outcome !== "quoted" || second.outcome !== "quoted") return;
      assert.strictEqual(first.quote.executionSequence, 0);
      assert.strictEqual(second.quote.executionSequence, 1);
    }),
  );

  it.effect("allocates distinct sequences when quotes are requested concurrently", () =>
    Effect.gen(function* () {
      yield* seed();

      const results = yield* Effect.all([quoteALong, quoteALong, quoteALong], {
        concurrency: "unbounded",
      });
      const sequences = results.flatMap((result) =>
        result.outcome === "quoted" ? [result.quote.executionSequence] : [],
      );

      assert.deepStrictEqual(
        [...sequences].sort((a, b) => a - b),
        [0, 1, 2],
      );
      assert.strictEqual(new Set(sequences).size, 3);
    }),
  );

  it.effect("turns a quote back into the intent the server built for it", () =>
    Effect.gen(function* () {
      yield* seed();
      const quotes = yield* TradingQuoteService;
      const quoted = yield* quoteALong;
      if (quoted.outcome !== "quoted") return assert.fail("expected a quote");

      const consumed = yield* quotes.consume({
        quoteId: quoted.quote.quoteId,
        missionId: "mission_1",
      });

      assert.strictEqual(consumed.outcome, "ready");
      if (consumed.outcome !== "ready") return;
      assert.strictEqual(consumed.replay, false);
      assert.strictEqual(consumed.intent.size, quoted.quote.size);
      assert.strictEqual(consumed.intent.executionSequence, quoted.quote.executionSequence);
      assert.strictEqual(consumed.intent.stop?.stopPrice, 1_980);
      assert.strictEqual(consumed.activeHarnessRunId, "run_1");
    }),
  );

  it.effect("replays the same execution rather than cutting a second one", () =>
    Effect.gen(function* () {
      yield* seed();
      const quotes = yield* TradingQuoteService;
      const quoted = yield* quoteALong;
      if (quoted.outcome !== "quoted") return assert.fail("expected a quote");

      const first = yield* quotes.consume({
        quoteId: quoted.quote.quoteId,
        missionId: "mission_1",
      });
      const again = yield* quotes.consume({
        quoteId: quoted.quote.quoteId,
        missionId: "mission_1",
      });

      assert.strictEqual(first.outcome, "ready");
      assert.strictEqual(again.outcome, "ready");
      if (first.outcome !== "ready" || again.outcome !== "ready") return;
      // Same sequence means the same cloid, so the exchange sees one order.
      assert.strictEqual(again.replay, true);
      assert.strictEqual(again.intent.executionSequence, first.intent.executionSequence);
    }),
  );

  it.effect("tells a stale quote to re-quote instead of filling it at yesterday's price", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const quotes = yield* TradingQuoteService;
      const quoted = yield* quoteALong;
      if (quoted.outcome !== "quoted") return assert.fail("expected a quote");

      // The test clock starts at zero, so "already expired" is a negative
      // deadline rather than a small positive one.
      yield* sql`UPDATE trading_entry_quotes SET expires_at = -1 WHERE quote_id = ${quoted.quote.quoteId}`;

      const consumed = yield* quotes.consume({
        quoteId: quoted.quote.quoteId,
        missionId: "mission_1",
      });

      assert.strictEqual(consumed.outcome, "refused");
      if (consumed.outcome !== "refused") return;
      assert.strictEqual(consumed.reason, "quote_expired");
      assert.include(consumed.detail, "trading_quote_entry");
    }),
  );

  it.effect("refuses a quote whose turn has since released the lease", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const quotes = yield* TradingQuoteService;
      const quoted = yield* quoteALong;
      if (quoted.outcome !== "quoted") return assert.fail("expected a quote");

      yield* sql`UPDATE trading_harness_runs SET status = 'completed' WHERE run_id = 'run_1'`;

      const consumed = yield* quotes.consume({
        quoteId: quoted.quote.quoteId,
        missionId: "mission_1",
      });

      assert.strictEqual(consumed.outcome, "refused");
      if (consumed.outcome !== "refused") return;
      assert.strictEqual(consumed.reason, "lease_lost");
    }),
  );

  it.effect("will not hand one mission's quote to another", () =>
    Effect.gen(function* () {
      yield* seed();
      const quotes = yield* TradingQuoteService;
      const quoted = yield* quoteALong;
      if (quoted.outcome !== "quoted") return assert.fail("expected a quote");

      const consumed = yield* quotes.consume({
        quoteId: quoted.quote.quoteId,
        missionId: "mission_2",
      });

      assert.strictEqual(consumed.outcome, "refused");
      if (consumed.outcome !== "refused") return;
      assert.strictEqual(consumed.reason, "quote_mission_mismatch");
    }),
  );
});
