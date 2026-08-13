/**
 * HyperliquidExecutionService unit tests — PROMPT-04 Task 11 (D2).
 *
 * Covers the §17.2 submit sequence's two retry/load-bearing guarantees:
 *
 *   1. Retry idempotency (§17.2 / §15.5): calling `submitOrder` twice with the
 *      same intent (same missionId + executionSequence + actionType ⇒ same
 *      idempotency_key + cloid) yields ONE execution record and ONE risk
 *      reservation. The second call reads the record back and returns it
 *      without re-signing or re-reserving. The exchange is submitted to exactly
 *      once (the recording fake asserts this).
 *
 *      Covered on the rejected path, the accepted path, and the unresolved
 *      `submitted` path — all three, because this guard is the ONLY thing
 *      between a retry and a duplicate position. Hyperliquid does not
 *      deduplicate on cloid for marketable IOCs (they never rest), so a retry
 *      that gets past the check fills a second time for real.
 *
 *   2. submitCancel (§16.4): with a recording fake exchange, calling
 *      `submitCancel` results in a signed action whose payload carries
 *      `cancels` (the cancel-by-cloid shape from OrderMapper).
 *
 * Layer assembly: the execution service's `make` pulls in the signer config,
 * the gateway, the preview service, the nonce coordinator, the exchange
 * client, and Crypto (for the execution-id UUID). The heavy/IO-bound deps
 * (gateway, preview, exchange) are stubbed; the nonce coordinator is live
 * (pure in-memory, no persist sink); the signer is armed directly via
 * `Layer.succeed` so the test does not depend on process.env; Crypto is
 * provided as the synchronous built-in. SQL is the in-memory sqlite layer,
 * migrated to 040 so the 038/039/040 execution tables + additive columns
 * exist.
 */
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidExchangeClient, type SignedAction } from "@t3tools/hyperliquid/ExchangeClient";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidNonceCoordinatorLive } from "@t3tools/hyperliquid/NonceCoordinator";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import { addressFromPrivateKey } from "@t3tools/hyperliquid/Signing";
import type {
  MarketBestBidOffer,
  OrderBook,
  ResolvedMarket,
} from "@t3tools/trading-contracts/market";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HyperliquidExecutionService,
  HyperliquidExecutionServiceLive,
  type ExecutionInput,
} from "./HyperliquidExecutionService.ts";
import { InterimSigner, InterimSignerConfig } from "./InterimSignerConfig.ts";
import { TradingPreviewService, type TradingPreview } from "./TradingPreviewService.ts";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/**
 * Canonical Ethereum test vector (matches InterimSignerConfig.test.ts): private
 * key = 32 bytes of 0x01 derives to 0x7e5f…bdf. The signer is armed directly
 * from these bytes so the test does not touch process.env.
 */
const VALID_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SIGNER_ADDR = addressFromPrivateKey(hexToBytes(VALID_KEY));

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const armedSigner = new InterimSigner({
  address: SIGNER_ADDR,
  privateKeyBytes: hexToBytes(VALID_KEY),
});

const MISSION = "mission_exec";

/**
 * A canonical ETH market resolution (assetIndex 1, szDecimals 3). `symbol` is
 * the literal `"ETH"` (TradingMarket), so cast through `unknown` rather than
 * widening the fixture's string to the literal.
 */
const ethMarket = {
  symbol: "ETH",
  assetIndex: 1,
  szDecimals: 3,
  maxLeverage: 3,
  available: true,
} as unknown as ResolvedMarket;

/** A 3000/3001 BBO with non-stale freshness. */
const bbo: MarketBestBidOffer = {
  bidPrice: 3000,
  bidSize: 1,
  askPrice: 3001,
  askSize: 1,
  freshness: { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 },
};

const orderBook: OrderBook = {
  market: "ETH",
  bids: [{ price: 3000, size: 1 }],
  asks: [{ price: 3001, size: 1 }],
  bestBidOffer: bbo,
  freshness: { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 },
} as OrderBook;

// ---------------------------------------------------------------------------
// A recording fake exchange client. Captures every signed action submitted so
// the retry test can assert the exchange was hit exactly once across two
// calls, and the cancel test can inspect the action payload shape.
// ---------------------------------------------------------------------------

/**
 * The exchange's real per-order response shape: rows nested under
 * `response.data.statuses`, each a single-key object naming the outcome.
 *
 * `{error: …}` makes the inspector produce a `rejected` final status — the
 * terminal state the retry fast-path returns early on. Two rows are supplied
 * on the ok path because a position increase carrying a stop goes out as a
 * grouped normalTpsl action (entry + linked stop), and the exchange answers
 * one row per leg.
 */
const rowsResponse = (statuses: ReadonlyArray<unknown>) =>
  ({ status: "ok", response: { type: "order", data: { statuses } } }) as const;

const ERR_RESPONSE = rowsResponse([{ error: "Order has invalid price" }]);

const OK_RESPONSE = rowsResponse([
  { filled: { totalSz: "0.5", avgPx: "3001.0", oid: 999 } },
  { resting: { oid: 1_000 } },
]);

/**
 * A mutable recording exchange: holds the canned response and the list of
 * submitted signed actions in a plain object. Mutable so one shared `it.layer`
 * can serve every test — each test sets the response it wants and reads the
 * captured submissions.
 */
interface RecordingExchange {
  submitted: SignedAction[];
  response: ReturnType<typeof rowsResponse>;
}

const recordingExchange: RecordingExchange = {
  submitted: [],
  response: ERR_RESPONSE,
};

const recordingExchangeLayer = Layer.succeed(HyperliquidExchangeClient, {
  submit: (signed: SignedAction) =>
    Effect.sync(() => {
      recordingExchange.submitted.push(signed);
      return recordingExchange.response;
    }),
} as unknown as HyperliquidExchangeClient["Service"]);

/** Reset the recorder before each test. */
const resetRecorder = () =>
  Effect.sync(() => {
    recordingExchange.submitted = [];
    recordingExchange.response = ERR_RESPONSE;
  });

// ---------------------------------------------------------------------------
// Stub gateway: returns the ETH market + a fixed order book. The execution
// service only touches `resolveMarket` and `getOrderBook` on the submit path.
// ---------------------------------------------------------------------------

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: () => Effect.succeed(ethMarket),
  getOrderBook: () => Effect.succeed(orderBook),
  getMarketSnapshot: () => Effect.die("not used"),
  getMarketHistory: () => Effect.die("not used"),
  getAccountSnapshot: () => Effect.die("not used"),
  getPosition: () => Effect.die("not used"),
  getOpenOrders: () => Effect.die("not used"),
  getTakerFeeRateBps: () => Effect.die("not used"),
} as unknown as HyperliquidGateway["Service"]);

// ---------------------------------------------------------------------------
// Stub preview: always returns a fixed reserved-risk value. The 17-check
// §16.3 checklist is exercised in TradingPreviewService.test.ts; here we
// isolate the submit sequence, so the preview is a green stub.
// ---------------------------------------------------------------------------

const stubPreview = (reservedRiskUsd: number) =>
  Layer.succeed(
    TradingPreviewService,
    TradingPreviewService.of({
      preview: () =>
        Effect.succeed({ intent: null as never, reservedRiskUsd } satisfies TradingPreview),
    }),
  );

// ---------------------------------------------------------------------------
// Armed signer config (no process.env dependency).
// ---------------------------------------------------------------------------

const armedSignerConfig = Layer.succeed(InterimSignerConfig, {
  resolve: Effect.succeed(Option.some(armedSigner)),
});

/** Migrate the shared in-memory db to 040, then truncate the execution tables. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 40 });
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_risk_reservations`;
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_orders`;
});

/** Build an open intent (actionType "open", IOC buy). */
const openIntent = (executionSequence: number) =>
  ({
    missionId: MISSION,
    strategyVersion: 1,
    executionSequence,
    actionType: "open",
    market: "ETH",
    side: "buy",
    size: 0.5,
    orderPreference: "marketable_ioc",
    limitPrice: 3001,
    stop: { stopPrice: 2950, plannedLossAtStopUsd: 25 },
    reduceOnly: false,
  }) as ExecutionInput["intent"];

/**
 * A minimal `PreviewContext`. The stub preview ignores it, but the type must
 * still be supplied to `submitOrder`. Fields that the real checklist reads are
 * populated with benign values; nothing here is exercised because the preview
 * is stubbed green.
 */
const previewContext = {
  mission: { id: MISSION } as never,
  currentStrategyVersion: 1,
  currentAuthorityVersion: 1,
  expectedAuthorityVersion: 1,
  activeHarnessRunId: "run_1",
  requestingHarnessRunId: "run_1",
  approvedExecutionWalletAddress: SIGNER_ADDR,
  bbo,
  accountObservedAt: 1_000,
  pendingExecution: null,
  budget: {} as never,
  takerFeeRateBps: 4.5,
  stopSlippageReserveBps: 10,
  nowMs: 1_000,
} as ExecutionInput["previewContext"];

// ---------------------------------------------------------------------------
// The shared suite layer: the real execution service over stubbed deps + the
// in-memory nonce coordinator (no persist sink) + the built-in Crypto. The
// exchange client is the mutable recorder above so tests can set the canned
// response and read captured submissions.
// ---------------------------------------------------------------------------

const layer = it.layer(
  HyperliquidExecutionServiceLive.pipe(
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(stubPreview(25)),
    Layer.provideMerge(recordingExchangeLayer),
    Layer.provideMerge(armedSignerConfig),
    Layer.provideMerge(IocSlippageConfigLive),
    Layer.provideMerge(HyperliquidNonceCoordinatorLive()),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

// ===========================================================================
// Tests
// ===========================================================================

layer("HyperliquidExecutionService", (it) => {
  it.effect(
    "retry idempotency: two submitOrder calls with the same intent ⇒ ONE record, ONE reservation, ONE exchange submit",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        yield* resetRecorder();
        recordingExchange.response = ERR_RESPONSE;

        const service = yield* HyperliquidExecutionService;
        const intent = openIntent(0);
        const execInput: ExecutionInput = {
          intent,
          previewContext,
          allowedSlippageBps: 10,
          masterAddress: "0xmaster",
        };

        // First call: exchange returns err ⇒ final status "rejected". The
        // record is persisted, the reservation is reserved then released (the
        // rejected path releases it).
        const first = yield* service.submitOrder(execInput);
        assert.equal(first.status, "rejected");

        // Second call: SAME intent ⇒ same idempotency_key + cloid. The record
        // is already terminal ("rejected"), so the fast-path returns it
        // WITHOUT signing or re-reserving.
        const second = yield* service.submitOrder(execInput);
        assert.equal(second.status, "rejected");
        assert.equal(second.executionId, first.executionId);

        // Exactly ONE execution record (idempotency_key is UNIQUE).
        const sql = yield* SqlClient.SqlClient;
        const recRows = yield* sql<{ readonly c: number }>`
          SELECT COUNT(*) AS c FROM trading_execution_records WHERE mission_id = ${MISSION}
        `;
        assert.equal(recRows[0]?.c, 1);

        // Exactly ONE reservation (ON CONFLICT(execution_id) DO NOTHING).
        const resRows = yield* sql<{ readonly c: number }>`
          SELECT COUNT(*) AS c FROM trading_risk_reservations WHERE mission_id = ${MISSION}
        `;
        assert.equal(resRows[0]?.c, 1);

        // The exchange was submitted to exactly ONCE — the retry never signed.
        assert.equal(recordingExchange.submitted.length, 1);
        // The signed action carries the deterministic order shape. An entry
        // carrying a stop goes out as a grouped normalTpsl action (§17.2 step
        // 3): the IOC parent and its linked reduce-only child in one action.
        const signedAction = recordingExchange.submitted[0]!;
        const action = signedAction.action as {
          orders?: ReadonlyArray<unknown>;
          grouping?: string;
        };
        assert.ok(Array.isArray(action.orders) && action.orders.length === 2);
        assert.equal(action.grouping, "normalTpsl");
      }),
  );

  it.effect(
    "retry idempotency on the successful path: a retry of a live order never reaches the exchange twice",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        yield* resetRecorder();
        // The exchange accepts. This is the path that actually spends capital,
        // and the one the rejected-path test above cannot speak for.
        recordingExchange.response = OK_RESPONSE;

        const service = yield* HyperliquidExecutionService;
        const execInput: ExecutionInput = {
          intent: openIntent(0),
          previewContext,
          allowedSlippageBps: 10,
          masterAddress: "0xmaster",
        };

        // The canned response reports the entry leg filled, so the record
        // settles terminal at `filled` straight from the submit response.
        const first = yield* service.submitOrder(execInput);
        assert.equal(first.status, "filled");

        // The retry must stop at the persisted record. Nothing downstream will
        // catch it if it does not: the live testnet run shows a resubmitted
        // marketable IOC opening a SECOND order under the same cloid and
        // filling again, doubling the position.
        const second = yield* service.submitOrder(execInput);
        assert.equal(second.status, "filled");
        assert.equal(second.executionId, first.executionId);
        assert.equal(recordingExchange.submitted.length, 1);
      }),
  );

  it.effect("an unresolved `submitted` record is not retried blind", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* resetRecorder();
      recordingExchange.response = OK_RESPONSE;

      const service = yield* HyperliquidExecutionService;
      const execInput: ExecutionInput = {
        intent: openIntent(0),
        previewContext,
        allowedSlippageBps: 10,
        masterAddress: "0xmaster",
      };
      yield* service.submitOrder(execInput);

      // Simulate the crash window: the POST went out, the process died before
      // the response was recorded, so the record is stuck at "submitted" and
      // whether an order exists is unknown. Resubmitting on that evidence is
      // how a position silently doubles.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE trading_execution_records SET status = 'submitted' WHERE mission_id = ${MISSION}`;

      const retry = yield* service.submitOrder(execInput);
      assert.equal(retry.status, "submitted");
      assert.equal(recordingExchange.submitted.length, 1);
    }),
  );

  it.effect(
    "submitCancel: signs and submits a cancel-by-cloid action (payload carries `cancels`)",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        yield* resetRecorder();

        const service = yield* HyperliquidExecutionService;
        const cloid = "a".repeat(32);
        yield* service.submitCancel({ market: "ETH", cloid });

        // The fake exchange captured exactly one signed action, and the action
        // payload is the cancel-by-cloid shape built by OrderMapper.
        assert.equal(recordingExchange.submitted.length, 1);
        const action = recordingExchange.submitted[0]!.action as {
          type?: string;
          cancels?: ReadonlyArray<{ asset: number; cloid: string }>;
        };
        assert.equal(action.type, "cancelByCloid");
        assert.ok(action.cancels !== undefined, "expected a `cancels` field on the action");
        assert.equal(action.cancels!.length, 1);
        assert.equal(action.cancels![0]!.asset, ethMarket.assetIndex);
        assert.equal(action.cancels![0]!.cloid, cloid);
      }),
  );

  // --- the mandatory-stop gate, submission half (§16.3 item 17, §17) -------
  //
  // The preview in this suite is stubbed green, which is exactly what makes
  // these tests meaningful: they prove the submission gate stands on its own
  // rather than inheriting preview's verdict. Both refusals happen before any
  // persist and before any nonce is spent, so nothing reaches the exchange and
  // no execution record is written.

  it.effect("refuses to submit a position increase carrying no stop", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* resetRecorder();
      recordingExchange.response = OK_RESPONSE;

      const service = yield* HyperliquidExecutionService;
      const { stop: _dropped, ...stopless } = openIntent(0);
      const failure = yield* service
        .submitOrder({
          intent: stopless as ExecutionInput["intent"],
          previewContext,
          allowedSlippageBps: 10,
          masterAddress: "0xmaster",
        })
        .pipe(Effect.flip);

      assert.equal(failure.stage, "missing_stop");
      assert.equal(recordingExchange.submitted.length, 0);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM trading_execution_records WHERE mission_id = ${MISSION}`;
      assert.equal(rows[0]!.count, 0);
    }),
  );

  it.effect("refuses to submit a long whose stop sits above the wire price", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* resetRecorder();
      recordingExchange.response = OK_RESPONSE;

      const service = yield* HyperliquidExecutionService;
      const failure = yield* service
        .submitOrder({
          intent: {
            ...openIntent(0),
            stop: { stopPrice: 3_200, plannedLossAtStopUsd: 25 },
          } as ExecutionInput["intent"],
          previewContext,
          allowedSlippageBps: 10,
          masterAddress: "0xmaster",
        })
        .pipe(Effect.flip);

      assert.equal(failure.stage, "missing_stop");
      assert.ok(failure.detail?.includes("wrong side"));
      assert.equal(recordingExchange.submitted.length, 0);
    }),
  );

  it.effect("submits a reduce-only close that carries no stop", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* resetRecorder();
      recordingExchange.response = OK_RESPONSE;

      const service = yield* HyperliquidExecutionService;
      const { stop: _dropped, ...base } = openIntent(0);
      const record = yield* service.submitOrder({
        intent: {
          ...base,
          actionType: "close",
          side: "sell",
          reduceOnly: true,
        } as ExecutionInput["intent"],
        previewContext,
        allowedSlippageBps: 10,
        masterAddress: "0xmaster",
      });

      assert.equal(record.status, "filled");
      assert.equal(record.stopPrice, undefined);
      assert.equal(recordingExchange.submitted.length, 1);
    }),
  );
});
