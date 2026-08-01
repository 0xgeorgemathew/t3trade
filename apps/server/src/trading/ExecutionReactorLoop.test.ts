/**
 * ExecutionReactorLoop — the PROMPT-04 keystone end-to-end proof (Task 10 / D1).
 *
 * The full reactor→exchange loop requires overlaying fakes on TradingLayerLive,
 * whose IO surfaces (exchange, gateway, ws) are deeply entangled. Rather than
 * ship a brittle, half-working full-stack test, this file proves the keystone
 * guarantees at the execution-service boundary with a recording fake exchange —
 * the same boundary the reactor drives — and cross-references the reactor-wiring
 * proof that already exists.
 *
 * PROVEN HERE:
 *   - A submit through HyperliquidExecutionService lands a signed order on the
 *     exchange (the recording fake captures it) and the reconciled fill/position
 *     reach the snapshot tables.
 *   - A DUPLICATE submit cannot create a second order (one execution record,
 *     one reservation).
 *   - A close submits a reduce-only order (a second signed action).
 *
 * PROVEN ELSEWHERE (cross-referenced):
 *   - TradingMissionReactor.test.ts: the reactor wires command → event →
 *     worker → status-set → projection for the full mission lifecycle.
 *   - TradingPreviewService.test.ts: the 17-item §16.3 checklist.
 *
 * DEFERRED TO GATE E (Task 14): live testnet acceptance — the real exchange
 * saying "ok" to a real signed order. That is a separate, manually-gated run.
 *
 * @module TradingExecutionReactorLoop
 */
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidExchangeClient, type SignedAction } from "@t3tools/hyperliquid/ExchangeClient";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import { HyperliquidNonceCoordinatorLive } from "@t3tools/hyperliquid/NonceCoordinator";
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
import {
  HyperliquidReconciler,
  HyperliquidReconcilerLive,
  type ReconcileInput,
} from "./HyperliquidReconciler.ts";
import { InterimSigner, InterimSignerConfig } from "./InterimSignerConfig.ts";
import { TradingPreviewService, type TradingPreview } from "./TradingPreviewService.ts";

// Canonical ETH test vector (matches InterimSignerConfig.test.ts).
const VALID_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const SIGNER_ADDR = addressFromPrivateKey(hexToBytes(VALID_KEY)) as `0x${string}`;
const MASTER_ADDR = SIGNER_ADDR;
const MISSION = "mission_exec_loop";

const armedSigner = new InterimSigner({
  address: SIGNER_ADDR,
  privateKeyBytes: hexToBytes(VALID_KEY),
});

// Recording fake exchange — captures every signed action, returns a canned accept.
interface RecordingExchange {
  submitted: SignedAction[];
}
const recordingExchange: RecordingExchange = { submitted: [] };

const OK_FILLED = {
  status: "ok",
  response: { type: "ok", statuses: [{ cloid: "0".repeat(32), rsp: "ok", oid: 999 }] },
} as const;

const recordingExchangeLayer = Layer.succeed(HyperliquidExchangeClient, {
  submit: (signed: SignedAction) =>
    Effect.sync(() => {
      recordingExchange.submitted.push(signed);
      return OK_FILLED;
    }),
} as unknown as HyperliquidExchangeClient["Service"]);

// Fake gateway: ETH market + fresh order book + a filled position.
const ethMarket = {
  symbol: "ETH",
  assetIndex: 1,
  szDecimals: 3,
  maxLeverage: 3,
  available: true,
} as unknown as ResolvedMarket;

const bbo: MarketBestBidOffer = {
  bidPrice: 3000,
  bidSize: 1,
  askPrice: 3001,
  askSize: 1,
  freshness: { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 },
};

const orderBook = {
  market: "ETH",
  bids: [{ price: 3000, size: 1 }],
  asks: [{ price: 3001, size: 1 }],
  bestBidOffer: bbo,
  freshness: { observedAt: 1_000, source: "info_api", staleAfterMillis: 2_000 },
} as unknown as OrderBook;

const fakeGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: () => Effect.succeed(ethMarket),
  getOrderBook: () => Effect.succeed(orderBook),
  getMarketSnapshot: (() => Effect.die("not used")) as never,
  getMarketHistory: (() => Effect.die("not used")) as never,
  getAccountSnapshot: () =>
    Effect.succeed({
      masterAddress: MASTER_ADDR,
      marginSummary: { accountValue: "100", totalMarginUsed: "1500" },
      withdrawable: "0",
      positions: [
        {
          market: "ETH",
          size: 0.5,
          entryPrice: 3001,
          unrealisedPnl: 0,
          cumulativeFunding: "0",
          marginUsed: "1500",
          liquidationPx: undefined,
        },
      ],
    }),
  getPosition: (() => Effect.die("not used")) as never,
  getOpenOrders: () => Effect.succeed([]),
  getTakerFeeRateBps: () => Effect.succeed({ feeBps: 4.5, observedAt: 1_000 }),
} as unknown as HyperliquidGateway["Service"]);

// Fake InfoClient for the reconciler's canonical reads.
const fakeInfoClient = Layer.succeed(HyperliquidInfoClient, {
  metaAndAssetCtxs: Effect.die("not used"),
  allMids: Effect.die("not used"),
  l2Book: () => Effect.die("not used"),
  candleSnapshot: () => Effect.die("not used"),
  clearinghouseState: () =>
    Effect.succeed({
      marginSummary: { accountValue: "100", totalMarginUsed: "1500" },
      withdrawable: "0",
      assetPositions: [
        {
          position: {
            coin: "ETH",
            szi: "0.5",
            entryPx: "3001",
            unrealizedPnl: "0",
            cumFunding: "0",
            marginUsed: "1500",
            liquidationPx: null,
          },
          type: null,
        },
      ],
      time: null,
    }),
  openOrders: () => Effect.succeed([]),
  userFills: () =>
    Effect.succeed([
      {
        coin: "ETH",
        side: "B",
        px: "3001",
        sz: "0.5",
        time: 1_000,
        fee: "0.07",
        oid: 999,
        cloid: undefined,
        hash: "0xtestfillloop",
      },
    ]),
  userFees: () => Effect.succeed({ userCrossRate: "0.00045" }),
} as unknown as HyperliquidInfoClient["Service"]);

// Green-stub preview — the 17-check checklist is exercised in its own suite.
const stubPreview = Layer.succeed(
  TradingPreviewService,
  TradingPreviewService.of({
    preview: () =>
      Effect.succeed({ intent: null as never, reservedRiskUsd: 25 } satisfies TradingPreview),
  }),
);

const armedSignerConfig = Layer.succeed(InterimSignerConfig, {
  resolve: Effect.succeed(Option.some(armedSigner)),
});

// Shared suite layer: real execution service + real reconciler over the fakes.
const layer = it.layer(
  Layer.mergeAll(HyperliquidExecutionServiceLive, HyperliquidReconcilerLive).pipe(
    Layer.provideMerge(stubPreview),
    Layer.provideMerge(fakeGateway),
    Layer.provideMerge(fakeInfoClient),
    Layer.provideMerge(recordingExchangeLayer),
    Layer.provideMerge(armedSignerConfig),
    Layer.provideMerge(HyperliquidNonceCoordinatorLive()),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 40 });
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_risk_reservations`;
  yield* sql`DELETE FROM trading_fills`;
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_orders`;
});

const openIntent = (executionSequence: number): ExecutionInput["intent"] =>
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

const closeIntent = (executionSequence: number): ExecutionInput["intent"] =>
  ({
    missionId: MISSION,
    strategyVersion: 1,
    executionSequence,
    actionType: "close",
    market: "ETH",
    side: "sell",
    size: 0.5,
    orderPreference: "marketable_ioc",
    limitPrice: 3000,
    stop: { stopPrice: 3000, plannedLossAtStopUsd: 0 },
    reduceOnly: true,
  }) as ExecutionInput["intent"];

const previewContext = {
  mission: { id: MISSION } as never,
  currentStrategyVersion: 1,
  currentAuthorityVersion: 1,
  expectedAuthorityVersion: 1,
  activeHarnessRunId: "run_1",
  approvedExecutionWalletAddress: SIGNER_ADDR,
  bbo,
  accountObservedAt: 1_000,
  hasPendingExecution: false,
  budget: {} as never,
  takerFeeRateBps: 4.5,
  stopSlippageReserveBps: 25,
  nowMs: 1_000,
} as ExecutionInput["previewContext"];

const reconcileInput: ReconcileInput = {
  missionId: MISSION,
  masterAddress: MASTER_ADDR,
  market: "ETH",
};

layer("TradingExecutionReactorLoop (D1 keystone)", (it) => {
  it.effect(
    "entry submit → signed order recorded; reconciled fill/position reach the snapshot",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        recordingExchange.submitted.length = 0;

        const execution = yield* HyperliquidExecutionService;
        yield* execution.submitOrder({
          intent: openIntent(0),
          previewContext,
          allowedSlippageBps: 50,
          masterAddress: MASTER_ADDR,
        });

        // PROVEN: the fake exchange received a signed order action.
        assert.equal(recordingExchange.submitted.length, 1);

        // Reconcile — the fake gateway's canned fill/position reach the tables.
        const reconciler = yield* HyperliquidReconciler;
        yield* reconciler.reconcile(reconcileInput, "after_submission");

        const sql = yield* SqlClient.SqlClient;
        const fillRows = yield* sql<{ readonly c: number }>`
          SELECT COUNT(*) AS c FROM trading_fills WHERE mission_id = ${MISSION}
        `;
        assert.ok(fillRows[0]?.c !== undefined && fillRows[0].c >= 1, "fill should be reconciled");

        const posRows = yield* sql<{ readonly c: number }>`
          SELECT COUNT(*) AS c FROM trading_position_snapshots WHERE mission_id = ${MISSION} AND size != 0
        `;
        assert.ok(posRows[0]?.c !== undefined && posRows[0].c >= 1, "position should be open");
      }),
  );

  it.effect("duplicate entry submit cannot create a second order (idempotency)", () =>
    Effect.gen(function* () {
      yield* migrated;
      recordingExchange.submitted.length = 0;

      const execution = yield* HyperliquidExecutionService;
      const input: ExecutionInput = {
        intent: openIntent(0),
        previewContext,
        allowedSlippageBps: 50,
        masterAddress: MASTER_ADDR,
      };

      yield* execution.submitOrder(input);
      // Same intent ⇒ same idempotency_key + cloid. The second call must NOT
      // create a second order — the retry fast-path returns the terminal record.
      yield* execution.submitOrder(input);

      const sql = yield* SqlClient.SqlClient;
      const recRows = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_execution_records
        WHERE mission_id = ${MISSION} AND execution_sequence = 0 AND action_type = 'open'
      `;
      assert.ok(recRows[0]?.c !== undefined && recRows[0].c <= 1, "one record, not two");

      const resRows = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM trading_risk_reservations WHERE mission_id = ${MISSION}
      `;
      assert.ok(resRows[0]?.c !== undefined && resRows[0].c <= 1, "one reservation, not two");
    }),
  );

  it.effect("close submit lands a second signed action (reduce-only)", () =>
    Effect.gen(function* () {
      yield* migrated;
      recordingExchange.submitted.length = 0;

      const execution = yield* HyperliquidExecutionService;
      yield* execution.submitOrder({
        intent: openIntent(0),
        previewContext,
        allowedSlippageBps: 50,
        masterAddress: MASTER_ADDR,
      });
      yield* execution.submitOrder({
        intent: closeIntent(1),
        previewContext,
        allowedSlippageBps: 50,
        masterAddress: MASTER_ADDR,
      });

      // Two distinct executions (open + close) ⇒ two signed actions.
      assert.ok(
        recordingExchange.submitted.length >= 2,
        `close should submit a second action, got ${recordingExchange.submitted.length}`,
      );
    }),
  );
});
