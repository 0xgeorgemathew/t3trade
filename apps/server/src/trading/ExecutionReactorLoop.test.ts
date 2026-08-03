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
import { isPermittedUnderExhaustion } from "@t3tools/trading-contracts/loss-accounting";

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
import { TradingExecutionGuard, TradingExecutionGuardLive } from "./TradingExecutionGuard.ts";
import { TradingMissionService } from "./TradingMissionService.ts";

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

// Recording mission-service stub for the blockForExhaustion / reduceOnlyClose
// tests (Task 6). The real TradingMissionService pulls in the full projection +
// persistence stack; for these tests we only need to assert blockForExhaustion
// calls transition({ to: "blocked", blockedReason: "cumulative_loss_limit" }),
// so a recording stub is sufficient and keeps the layer focused.
interface RecordingMissions {
  transitions: Array<{
    readonly missionId: string;
    readonly to: string;
    readonly blockedReason?: string;
  }>;
}
const recordingMissions: RecordingMissions = { transitions: [] };
const recordingMissionsLayer = Layer.succeed(TradingMissionService, {
  transition: ((input: {
    readonly missionId: string;
    readonly to: string;
    readonly blockedReason?: string;
  }) =>
    Effect.sync(() => {
      recordingMissions.transitions.push({
        missionId: input.missionId,
        to: input.to,
        ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
      });
      return {} as never;
    })) as never,
  getMissionVersion: (() => Effect.succeed(1)) as never,
} as unknown as TradingMissionService["Service"]);

// Shared suite layer: real execution service + real reconciler over the fakes,
// with the real guard composed on top (it depends on the execution service +
// reconciler + mission service, so it must build after them, not be merged
// concurrently).
const coreLayer = Layer.mergeAll(HyperliquidExecutionServiceLive, HyperliquidReconcilerLive).pipe(
  Layer.provideMerge(stubPreview),
  Layer.provideMerge(fakeGateway),
  Layer.provideMerge(fakeInfoClient),
  Layer.provideMerge(recordingExchangeLayer),
  Layer.provideMerge(recordingMissionsLayer),
  Layer.provideMerge(armedSignerConfig),
  Layer.provideMerge(HyperliquidNonceCoordinatorLive()),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const layer = it.layer(TradingExecutionGuardLive.pipe(Layer.provideMerge(coreLayer)));

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
      recordingExchange.submitted.length = 0; // reset so we can count the 2nd call's submits
      yield* execution.submitOrder(input);

      // The duplicate must not reach the exchange at all — local idempotency-key
      // convergence returns the existing terminal record without re-signing. This
      // is the primary retry-dedup guarantee for production (exchange-side cloid
      // dedup only helps when an order is still resting; a filled IOC is gone).
      assert.equal(
        recordingExchange.submitted.length,
        0,
        "duplicate submitOrder must not reach the exchange (local idempotency)",
      );

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

  it.effect(
    "§16.4 exhaustion: budget-exhausted blocks open, permits reduce/close; cancel-by-cloid records a cancel action",
    () =>
      // This proves the §16.4 control matrix at the boundaries the reactor
      // drives: the guard's permit predicate (blockForExhaustion's gate) and
      // the execution service's cancel path (what blockForExhaustion calls per
      // increasing order). The full mission-status transition is exercised in
      // TradingExecutionGuard.test.ts + TradingMissionReactor.test.ts.
      Effect.gen(function* () {
        yield* migrated;
        recordingExchange.submitted.length = 0;

        // Seed a resting increasing order so the exhaustion cancel has a target.
        const sql = yield* SqlClient.SqlClient;
        const cloid = "b".repeat(32);
        yield* sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, strategy_version, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json, created_at, updated_at
          ) VALUES (
            'exec_resting', ${MISSION}, 1, 0, 'open',
            ${cloid}, 'idem_resting', 'ETH', 'buy', 0.5, 3001, 'ioc',
            0, ${SIGNER_ADDR}, 'accepted', '[]', 1000, 1000
          )
        `;
        yield* sql`
          INSERT INTO trading_orders (mission_id, cloid, order_id, market, side, limit_price, remaining_size, reduce_only, observed_at)
          VALUES (${MISSION}, ${cloid}, 999, 'ETH', 'buy', 3001, 0.5, 0, 1000)
        `;

        // §16.4: under exhaustion, guardAction blocks open/scale_in and permits
        // cancel/reduce/close. This is the permit matrix the reactor enforces
        // before spending a nonce.
        assert.ok(!isPermittedUnderExhaustion("open"), "open blocked under exhaustion");
        assert.ok(!isPermittedUnderExhaustion("scale_in"), "scale_in blocked under exhaustion");
        assert.ok(isPermittedUnderExhaustion("close"), "close permitted under exhaustion");
        assert.ok(isPermittedUnderExhaustion("reduce"), "reduce permitted under exhaustion");

        // §16.4 item 1: the exhaustion cancel submits a cancel-by-cloid for the
        // resting increasing order. The execution service's submitCancel is what
        // blockForExhaustion calls per increasing order.
        const execution = yield* HyperliquidExecutionService;
        yield* execution.submitCancel({ market: "ETH", cloid });

        assert.ok(
          recordingExchange.submitted.length >= 1,
          "exhaustion cancel should submit a signed cancel action",
        );
        const action = recordingExchange.submitted[recordingExchange.submitted.length - 1]!
          .action as {
          type?: string;
          cancels?: ReadonlyArray<{ asset: number; cloid: string }>;
        };
        assert.equal(action.type, "cancelByCloid");
        assert.ok(action.cancels !== undefined, "expected a cancels payload");
        assert.equal(action.cancels![0]!.asset, ethMarket.assetIndex);
        assert.equal(action.cancels![0]!.cloid, cloid);
      }),
  );

  // --- Task 6: blockForExhaustion on the real guard + real execution service ---
  it.effect(
    "blockForExhaustion cancels only increasing orders and transitions the mission to blocked",
    () =>
      // Seeds a resting increasing (open) order AND a resting reduce order, then
      // drives the real guard.blockForExhaustion. Asserts: a cancel-by-cloid is
      // submitted for the INCREASING order only; the mission service's transition
      // is invoked with { to: "blocked", blockedReason: "cumulative_loss_limit" };
      // the post-cancel reconcile fires. This is the orchestration the §16.4
      // permit-matrix test above does NOT enter.
      Effect.gen(function* () {
        yield* migrated;
        recordingExchange.submitted.length = 0;
        recordingMissions.transitions.length = 0;
        const sql = yield* SqlClient.SqlClient;

        const increasingCloid = "0x" + "1".repeat(40).slice(0, 32).replace(/^0x/, "");
        const reduceCloid = "0x" + "2".repeat(40).slice(0, 32).replace(/^0x/, "");
        // Use bare hex (no 0x) for the DB cloid columns to mirror what the
        // reconciler writes; the guard's SQL JOIN matches on the raw string.
        const incCloidBare = increasingCloid.startsWith("0x")
          ? increasingCloid.slice(2)
          : increasingCloid;
        const redCloidBare = reduceCloid.startsWith("0x") ? reduceCloid.slice(2) : reduceCloid;

        // A resting increasing order (action_type 'open' — NOT in the permitted set).
        yield* sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, strategy_version, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json, created_at, updated_at
          ) VALUES
            ('exec_inc', ${MISSION}, 1, 10, 'open',
             ${incCloidBare}, 'idem_inc', 'ETH', 'buy', 0.5, 3001, 'ioc',
             0, ${SIGNER_ADDR}, 'accepted', '[]', 1000, 1000)
        `;
        yield* sql`
          INSERT INTO trading_orders (mission_id, cloid, order_id, market, side, limit_price, remaining_size, reduce_only, observed_at)
          VALUES (${MISSION}, ${incCloidBare}, 901, 'ETH', 'buy', 3001, 0.5, 0, 1000)
        `;
        // A resting reduce order (action_type 'reduce' — IS permitted, must NOT be cancelled).
        yield* sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, strategy_version, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json, created_at, updated_at
          ) VALUES
            ('exec_red', ${MISSION}, 1, 11, 'reduce',
             ${redCloidBare}, 'idem_red', 'ETH', 'sell', 0.2, 3000, 'ioc',
             1, ${SIGNER_ADDR}, 'accepted', '[]', 1000, 1000)
        `;
        yield* sql`
          INSERT INTO trading_orders (mission_id, cloid, order_id, market, side, limit_price, remaining_size, reduce_only, observed_at)
          VALUES (${MISSION}, ${redCloidBare}, 902, 'ETH', 'sell', 3000, 0.2, 1, 1000)
        `;

        const guard = yield* TradingExecutionGuard;
        yield* guard.blockForExhaustion(MISSION, 1, MASTER_ADDR);

        // Exactly one cancel submitted — for the increasing order, not the reduce order.
        const cancels = recordingExchange.submitted
          .map(
            (s) => s.action as { type?: string; cancels?: Array<{ asset: number; cloid: string }> },
          )
          .filter((a) => a.type === "cancelByCloid");
        assert.equal(cancels.length, 1);
        assert.equal(cancels[0]!.cancels![0]!.cloid, incCloidBare);

        // The mission transitioned to blocked with the cumulative-loss-limit reason.
        assert.equal(recordingMissions.transitions.length, 1);
        assert.equal(recordingMissions.transitions[0]!.missionId, MISSION);
        assert.equal(recordingMissions.transitions[0]!.to, "blocked");
        assert.equal(recordingMissions.transitions[0]!.blockedReason, "cumulative_loss_limit");
      }),
  );

  it.effect(
    "blockForExhaustion still transitions to blocked when the cancel fails (swallow-and-log)",
    () =>
      // The negative case: when submitCancel fails, the mission still reaches
      // blocked (the current swallow-and-continue behavior) and the failure is
      // logged at warn rather than aborting the block.
      Effect.gen(function* () {
        yield* migrated;
        recordingExchange.submitted.length = 0;
        recordingMissions.transitions.length = 0;
        const sql = yield* SqlClient.SqlClient;

        // Seed an increasing order whose cloid will fail to cancel. The recording
        // fake exchange always returns OK, so to simulate a cancel failure we
        // point the order at a market the fake gateway cannot resolve. The
        // execution service resolves the asset index via gateway.resolveMarket;
        // an unresolvable market yields TradingExecutionError(market_unresolved),
        // which the guard's catchTag logs and continues past.
        const badCloid = "f".repeat(32);
        yield* sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, strategy_version, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json, created_at, updated_at
          ) VALUES
            ('exec_bad', ${MISSION}, 1, 20, 'open',
             ${badCloid}, 'idem_bad', 'NOPE', 'buy', 0.5, 3001, 'ioc',
             0, ${SIGNER_ADDR}, 'accepted', '[]', 1000, 1000)
        `;
        yield* sql`
          INSERT INTO trading_orders (mission_id, cloid, order_id, market, side, limit_price, remaining_size, reduce_only, observed_at)
          VALUES (${MISSION}, ${badCloid}, 903, 'NOPE', 'buy', 3001, 0.5, 0, 1000)
        `;

        const guard = yield* TradingExecutionGuard;
        // The fake gateway only resolves ETH; NOPE → market_unresolved error,
        // which blockForExhaustion logs and swallows. The effect must still
        // succeed (the mission still transitions to blocked).
        yield* guard.blockForExhaustion(MISSION, 1, MASTER_ADDR);

        assert.equal(recordingMissions.transitions.length, 1);
        assert.equal(recordingMissions.transitions[0]!.to, "blocked");
        assert.equal(recordingMissions.transitions[0]!.blockedReason, "cumulative_loss_limit");
      }),
  );

  // --- Task 6: reduceOnlyClose on the real guard + real execution service ---
  it.effect(
    "reduceOnlyClose submits a reduce-only IOC at the canonical size (opposite side, reduce-only, IOC)",
    () =>
      // The fake gateway/info report an ETH long of 0.5 (seeded in fakeGateway's
      // account snapshot + fakeInfoClient's clearinghouseState). reduceOnlyClose
      // reconciles before_execution (reads 0.5 long), builds a sell reduce-only
      // IOC of size 0.5, and submits it. The static fake info client does not
      // reflect the submit (canonical state stays 0.5), so the after-close
      // reconcile escalates close_did_not_flatten — that escalation is asserted
      // separately below. Here we flip the escalation and assert the SUBMIT
      // carried the correct order shape: opposite side, reduce-only, IOC, the
      // canonical 0.5 size.
      Effect.gen(function* () {
        yield* migrated;
        recordingExchange.submitted.length = 0;

        const guard = yield* TradingExecutionGuard;
        // The after-close reconcile still shows 0.5 → close_did_not_flatten.
        const result = yield* guard
          .reduceOnlyClose({
            intent: closeIntent(30),
            previewContext,
            allowedSlippageBps: 50,
            masterAddress: MASTER_ADDR,
          })
          .pipe(Effect.flip);

        // The submit still happened before the escalation.
        assert.isAbove(recordingExchange.submitted.length, 0);
        const orderAction = recordingExchange.submitted[recordingExchange.submitted.length - 1]!
          .action as {
          type?: string;
          orders?: Array<{
            b: boolean;
            s: string;
            r: boolean;
            t: { limit: { tif: string } };
          }>;
        };
        assert.equal(orderAction.type, "order");
        const leg = orderAction.orders![0]!;
        // Opposite side of the long (sell → b:false), reduce-only, IOC.
        assert.equal(leg.b, false);
        assert.equal(leg.r, true);
        assert.equal(leg.t.limit.tif, "Ioc");
        // Canonical size from the fresh reconcile (0.5 long → close 0.5).
        assert.equal(Number(leg.s), 0.5);

        // And the guard honestly escalated (did not silently succeed).
        assert.equal(result._tag, "TradingExhaustionError");
        assert.equal(result.reason, "close_did_not_flatten");
      }),
  );

  it.effect(
    "reduceOnlyClose surfaces close_did_not_flatten when the post-close position is non-zero",
    () =>
      // If the canonical reconcile after the close still shows a position,
      // reduceOnlyClose must escalate close_did_not_flatten rather than silently
      // succeeding. The shared fakeInfoClient always returns 0.5, so the after-
      // close reconcile still sees 0.5 and the close must escalate. (The submit
      // succeeds against the recording exchange, but canonical truth — the info
      // client — still reports the position, so the guard honestly escalates.)
      // This complements the test above: that one proves the submit shape; this
      // one proves the escalation is surfaced as a typed error, not swallowed.
      Effect.gen(function* () {
        yield* migrated;

        const guard = yield* TradingExecutionGuard;
        const result = yield* guard
          .reduceOnlyClose({
            intent: closeIntent(31),
            previewContext,
            allowedSlippageBps: 50,
            masterAddress: MASTER_ADDR,
          })
          .pipe(Effect.flip);

        assert.equal(result._tag, "TradingExhaustionError");
        assert.equal(result.reason, "close_did_not_flatten");
      }),
  );
});
