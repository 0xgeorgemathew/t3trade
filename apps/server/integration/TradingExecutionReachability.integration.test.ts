// @effect-diagnostics nodeBuiltinImport:off
/**
 * PROMPT-04 remediation Task 8: the end-to-end reachability proof.
 *
 * The suite had two half-proofs of the trading execution path:
 *   - `ExecutionReactorLoop.test.ts` proves submit → exchange → reconcile at the
 *     execution-service boundary (it builds `HyperliquidExecutionServiceLive`
 *     directly, never through the reactor).
 *   - `TradingMissionReactor.test.ts` proves the reactor wires command → event →
 *     worker → status-set → projection, but never attaches the execution path
 *     (its `processExecutionRequested` is never driven end-to-end).
 *
 * This file closes that gap. It drives the real orchestration engine with the
 * real `TradingMissionReactorLive` attached, overlaying recording fakes for the
 * Hyperliquid exchange/gateway/info/ws surfaces so no network is touched. Then
 * it dispatches the command the `trading_request_entry` tool raises and asserts
 * the full chain lands:
 *
 *   trading_request_entry → command (`trading.execution.requested`)
 *                        → decider → event (`trading.execution-requested`)
 *                        → reactor (`processExecutionRequested`)
 *                        → signed order on the (fake) exchange
 *                        → reconciled fill/position in the snapshot tables
 *                        → projection surfaces via `getByThreadId`.
 *
 * The reactor's IO surfaces (exchange/gateway/info/ws) are PROVIDED internally
 * by `TradingLayerLive`, not REQUIRED — so fakes supplied as dependencies do
 * not override them (verified: the reactor's submit hits the real Hyperliquid
 * API). The clean overlay is to rebuild the trading layer with the fakes
 * substituted at the foundation (mirroring runtimeLayer.ts, swapping the HTTP
 * clients for recording fakes). The §16.3 preview checklist is stubbed green
 * here — it is proven in its own suite and at the execution-service boundary;
 * this test's job is the reachability chain, not the checklist.
 *
 * @module TradingExecutionReachability
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TradingMissionId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { HyperliquidExchangeClient, type SignedAction } from "@t3tools/hyperliquid/ExchangeClient";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import { HyperliquidWebSocketClient } from "@t3tools/hyperliquid/WebSocketClient";
import { addressFromPrivateKey } from "@t3tools/hyperliquid/Signing";
import type {
  MarketBestBidOffer,
  OrderBook,
  ResolvedMarket,
} from "@t3tools/trading-contracts/market";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ServerConfig, deriveServerPaths } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import {
  TradingMissionReactor,
  TradingMissionReactorLive,
} from "../src/trading/TradingMissionReactor.ts";
import { WatchEvaluatorLive } from "../src/trading/WatchEvaluator.ts";
import { TradingMissionProjection } from "../src/trading/TradingMissionProjection.ts";
import { TradingMissionService } from "../src/trading/TradingMissionService.ts";
import { TradingStrategyService } from "../src/trading/TradingStrategyService.ts";

// --- test identities --------------------------------------------------------
// Canonical ETH test vector (matches InterimSignerConfig.test.ts /
// ExecutionReactorLoop.test.ts). The signer address IS the master wallet
// address the fake gateway/info respond to, so the reconciled reads line up
// with the mission's trading account.
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

const PROJECT_ID = ProjectId.make("project-exec-reach");
const THREAD_ID = ThreadId.make("thread-exec-reach");
const MISSION_ID = TradingMissionId.make("mission-exec-reach");
const TRADING_ACCOUNT_ID = "acct-exec-reach";

// The interim signer is armed via `T3_TRADES_INTERIM_SIGNER_KEY` (the same env
// var the production `InterimSignerConfigLive` reads). TradingLayerLive builds
// InterimSignerConfigLive internally, so the override has to happen through the
// env that layer captures at build time rather than a layer substitution. The
// derived address equals SIGNER_ADDR, which the fake gateway/info respond to.
const setInterimSignerEnv = (): string | undefined => {
  const prev = process.env.T3_TRADES_INTERIM_SIGNER_KEY;
  process.env.T3_TRADES_INTERIM_SIGNER_KEY = VALID_KEY;
  return prev;
};
const restoreInterimSignerEnv = (prev: string | undefined) => {
  if (prev === undefined) {
    delete process.env.T3_TRADES_INTERIM_SIGNER_KEY;
  } else {
    process.env.T3_TRADES_INTERIM_SIGNER_KEY = prev;
  }
};

const NOW = "2026-08-01T00:00:00.000Z";

// --- recording fake exchange ------------------------------------------------
interface RecordingExchange {
  submitted: SignedAction[];
  positionSize: number;
  filledAt: number | null;
}
const recordingExchange: RecordingExchange = {
  submitted: [],
  positionSize: 0,
  filledAt: null,
};

/**
 * The real `/exchange` order response: rows nested under `response.data`,
 * each a single-key object naming the outcome. The entry request is a
 * position increase carrying a stop, so it goes out as a grouped normalTpsl
 * action and comes back with one row per leg (§17.2 steps 3–4).
 */
const OK_FILLED = {
  status: "ok",
  response: {
    type: "order",
    data: {
      statuses: [
        { filled: { totalSz: "0.5", avgPx: "3000.0", oid: 999 } },
        { resting: { oid: 1_000 } },
      ],
    },
  },
} as const;

/**
 * Reduce-only triggers the fake exchange has accepted, surfaced back through
 * `getOpenOrders`.
 *
 * Without this the fake would accept a protective stop and then report no
 * resting orders, so §17.2 step 7 could never confirm protection and the
 * reactor would (correctly) escalate to the emergency close. Modelling the
 * accepted stop as resting is what lets this test exercise the whole chain
 * through to a protected position.
 */
const restingProtection: AgentOpenOrder[] = [];

/** Turn a submitted reduce-only trigger leg into the order it becomes. */
const recordProtectiveLegs = (signed: SignedAction): void => {
  const orders = (signed.action as { orders?: ReadonlyArray<unknown> }).orders ?? [];
  for (const leg of orders) {
    const o = leg as {
      b?: boolean;
      s?: string;
      p?: string;
      r?: boolean;
      c?: string;
      t?: { trigger?: { triggerPx?: string } };
    };
    if (o.r !== true || o.t?.trigger === undefined) continue;
    restingProtection.push({
      market: "ETH",
      orderId: 5_000 + restingProtection.length,
      cloid: o.c,
      side: o.b === true ? "buy" : "sell",
      limitPrice: Number(o.p ?? 0),
      size: Number(o.s ?? 0),
      remainingSize: Number(o.s ?? 0),
      status: "open",
      createdAt: 1_000,
      reduceOnly: true,
      isTrigger: true,
      triggerPrice: Number(o.t.trigger.triggerPx ?? 0),
      orderType: "Stop Market",
    } as AgentOpenOrder);
  }
};

/** Apply the filled entry leg to the fake's canonical account state. */
const recordFilledEntry = (signed: SignedAction, filledAt: number): void => {
  const orders = (signed.action as { orders?: ReadonlyArray<unknown> }).orders ?? [];
  const entry = orders.find((leg) => {
    const order = leg as { r?: boolean; t?: { trigger?: unknown } };
    return order.r !== true && order.t?.trigger === undefined;
  }) as { b?: boolean; s?: string } | undefined;
  if (entry === undefined) return;

  const size = Number(entry.s ?? 0);
  recordingExchange.positionSize += entry.b === true ? size : -size;
  recordingExchange.filledAt = filledAt;
};

const recordingExchangeLayer = Layer.succeed(HyperliquidExchangeClient, {
  submit: (signed: SignedAction) =>
    Effect.gen(function* () {
      const filledAt = yield* Clock.currentTimeMillis;
      recordingExchange.submitted.push(signed);
      recordFilledEntry(signed, filledAt);
      recordProtectiveLegs(signed);
      return OK_FILLED;
    }),
} as unknown as HyperliquidExchangeClient["Service"]);

// --- fake gateway: ETH market + fresh BBO + exchange-owned position state ---
const ethMarket = {
  symbol: "ETH",
  assetIndex: 1,
  szDecimals: 3,
  maxLeverage: 3,
  available: true,
} as unknown as ResolvedMarket;

// A fresh BBO/order book computed at call time so the execution service's
// freshness window (bbo observed within the last 2s) always passes.
const freshOrderBook = (): OrderBook => {
  // A fixed far-future timestamp (well past any test's nowMs) so the BBO is
  // always "fresh" within the 2s window without reading the wall clock.
  const now = 9_999_999_999_999;
  const freshness = { observedAt: now, source: "info_api" as const, staleAfterMillis: 2_000 };
  const bestBidOffer: MarketBestBidOffer = {
    bidPrice: 3000,
    bidSize: 1,
    askPrice: 3001,
    askSize: 1,
    freshness,
  };
  return {
    market: "ETH",
    bids: [{ price: 3000, size: 1 }],
    asks: [{ price: 3001, size: 1 }],
    bestBidOffer,
    freshness,
  } as unknown as OrderBook;
};

const fakeGatewayLayer = Layer.succeed(HyperliquidGateway, {
  resolveMarket: () => Effect.succeed(ethMarket),
  getOrderBook: () => Effect.sync(() => freshOrderBook()),
  getMarketSnapshot: (() => Effect.die("not used")) as never,
  getMarketHistory: (() => Effect.die("not used")) as never,
  getAccountSnapshot: () =>
    Effect.sync(() => ({
      masterAddress: MASTER_ADDR,
      accountValue: 100,
      marginSummary: { accountValue: "100", totalMarginUsed: "1500" },
      withdrawable: "0",
      positions:
        recordingExchange.positionSize === 0
          ? []
          : [
              {
                market: "ETH",
                size: recordingExchange.positionSize,
                entryPrice: 3001,
                unrealisedPnl: 0,
                cumulativeFunding: "0",
                marginUsed: "1500",
                liquidationPx: undefined,
              },
            ],
    })),
  getPosition: (() => Effect.die("not used")) as never,
  getOpenOrders: () => Effect.sync(() => restingProtection),
  getTakerFeeRateBps: () => Effect.succeed({ feeBps: 4.5, observedAt: 1_000 }),
  // The wakeup composer prices its round trip through TradingCostEstimatorLive,
  // which reads both rates at once.
  getUserFeeRatesBps: () =>
    Effect.succeed({
      takerFeeBps: 4.5,
      makerFeeBps: 1,
      observedAt: 1_000,
      makerRateSource: "hyperliquid_user_fees",
    }),
} as unknown as HyperliquidGateway["Service"]);

// --- fake InfoClient for the reconciler's canonical reads -------------------
// The canned fill (oid 999, ETH, buy 0.5 @ 3001) is what the reconciler
// persists to `trading_fills`, and the canned position (ETH, 0.5 long) is what
// reaches `trading_position_snapshots`. These are the rows the projection's
// execution surfaces join.
const fakeInfoClientLayer = Layer.succeed(HyperliquidInfoClient, {
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
    Effect.sync(() =>
      recordingExchange.filledAt === null
        ? []
        : [
            {
              coin: "ETH",
              side: "B",
              px: "3001",
              sz: "0.5",
              time: recordingExchange.filledAt,
              fee: "0.07",
              oid: 999,
              cloid: undefined,
              hash: "0xtestfillreach",
            },
          ],
    ),
  userFees: () => Effect.succeed({ userCrossRate: "0.00045" }),
} as unknown as HyperliquidInfoClient["Service"]);

// --- fake WebSocket client: empty streams, always connected -----------------
// The reactor's startup poll calls `TradingFillReconciler.follow` once an active
// mission exists; that subscribes to the WS. Returning empty streams keeps the
// forked consumers idle without touching the network.
const fakeWebSocketLayer = Layer.succeed(HyperliquidWebSocketClient, {
  subscribe: () => Stream.empty,
  isConnected: Effect.succeed(true),
  reconnects: Stream.empty,
} as unknown as HyperliquidWebSocketClient["Service"]);

// --- trading layer rebuilt with fakes at the foundation ---------------------
// TradingLayerLive builds its IO surfaces (exchange/gateway/info/ws) internally
// (via exchangeWithHttp/gatewayWithRead/infoWithHttp), so those services are
// PROVIDED, not REQUIRED — fakes supplied as dependencies do NOT override them,
// and the reactor's submit hits the real Hyperliquid API. The clean override is
// to rebuild the trading layer with the fakes substituted at the foundation
// (mirroring runtimeLayer.ts, swapping the HTTP clients for the recording
// fakes). This does not modify runtimeLayer.ts; it composes the same live
// service layers around a faked foundation.
import { TradingExecutionReceiptsLive } from "../src/trading/TradingExecutionReceipts.ts";
import { TradingMissionServiceLive } from "../src/trading/TradingMissionService.ts";
import { TradingStrategyServiceLive } from "../src/trading/TradingStrategyService.ts";
import { TradingWatchServiceLive } from "../src/trading/TradingWatchService.ts";
import { TradingEventInboxLive } from "../src/trading/TradingEventInbox.ts";
import { TradingExecutionGuardLive } from "../src/trading/TradingExecutionGuard.ts";
import { TradingFillReconcilerLive } from "../src/trading/TradingFillReconciler.ts";
import { TradingProtectionServiceLive } from "../src/trading/TradingProtectionService.ts";
import { TradingWorkingOrderServiceLive } from "../src/trading/TradingWorkingOrderService.ts";
import { TradingEmergencyCloseServiceLive } from "../src/trading/TradingEmergencyCloseService.ts";
import { TradingControlServiceLive } from "../src/trading/TradingControlService.ts";
import { TradingBudgetReaderLive } from "../src/trading/TradingBudgetReader.ts";
import {
  TradingPreviewService,
  type TradingPreview,
} from "../src/trading/TradingPreviewService.ts";
import { TradingTurnCoordinatorLive } from "../src/trading/TradingTurnCoordinator.ts";
import { TradingCostEstimatorLive } from "../src/trading/TradingCostEstimator.ts";
import { TradingWakeupComposerLive } from "../src/trading/TradingWakeupComposer.ts";
import { IocSlippageConfigLive } from "../src/trading/IocSlippageConfig.ts";
import { InterimSignerConfigLive } from "../src/trading/InterimSignerConfig.ts";
import { AutoMissionConfigLive } from "../src/trading/AutoMissionConfig.ts";
import { HyperliquidExecutionServiceLive } from "../src/trading/HyperliquidExecutionService.ts";
import { HyperliquidReconcilerLive } from "../src/trading/HyperliquidReconciler.ts";
import { HyperliquidNonceCoordinatorLive } from "@t3tools/hyperliquid/NonceCoordinator";

// The faked foundation: the four IO clients are the recording fakes rather than
// the real HTTP/WS clients. Everything else (mission/strategy/watch/coordinator/
// preview/budget/guard/execution/reconciler/fillReconciler) is the real live
// layer, so the full reactor→submit→reconcile chain is exercised.
const tradingFoundationWithFakes = Layer.mergeAll(
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
  InterimSignerConfigLive,
  IocSlippageConfigLive,
  AutoMissionConfigLive.pipe(Layer.provide(InterimSignerConfigLive)),
  recordingExchangeLayer,
  fakeGatewayLayer,
  fakeInfoClientLayer,
  fakeWebSocketLayer,
  // The reactor opens an execution latch; the outcome service waits on it. One
  // instance, as in runtimeLayer.ts, or the two never meet.
  TradingExecutionReceiptsLive,
  HyperliquidNonceCoordinatorLive(),
  NodeCrypto.layer,
);

// Green-stub preview — the 17-check §16.3 checklist is exercised in its own
// suite (TradingPreviewService.test.ts) and at the execution-service boundary
// (ExecutionReactorLoop.test.ts). This test proves the reachability chain, not
// the checklist, so the preview is stubbed to green (the same approach
// ExecutionReactorLoop.test.ts takes) to keep the focus on command → event →
// reactor → exchange → reconcile → projection.
const stubPreview = Layer.succeed(
  TradingPreviewService,
  TradingPreviewService.of({
    preview: () =>
      Effect.succeed({ intent: null as never, reservedRiskUsd: 20 } satisfies TradingPreview),
  }),
);

const tradingWithPreview = Layer.mergeAll(
  stubPreview,
  TradingBudgetReaderLive,
  TradingWatchServiceLive,
  TradingEventInboxLive,
).pipe(Layer.provideMerge(tradingFoundationWithFakes));

// The wakeup prices the round trip on any position it finds open, through the
// same estimator `trading_estimate_costs` uses.
const composerWithDeps = TradingWakeupComposerLive.pipe(
  Layer.provide(TradingCostEstimatorLive),
  Layer.provideMerge(tradingWithPreview),
);

const coordinatorWithDeps = TradingTurnCoordinatorLive.pipe(
  Layer.provideMerge(tradingWithPreview),
  Layer.provideMerge(composerWithDeps),
);

const tradingExecutionCore = Layer.mergeAll(
  HyperliquidExecutionServiceLive,
  HyperliquidReconcilerLive,
).pipe(Layer.provideMerge(tradingWithPreview));

// `coordinatorWithDeps` supplies TradingMissionService / HyperliquidGateway /
// HyperliquidWebSocketClient, which the guard and fill reconciler both need.
// mergeAll builds in parallel, so it has to be a provideMerge underneath them
// rather than a sibling in the same merge.
const tradingProtectionForTest = TradingProtectionServiceLive.pipe(
  Layer.provideMerge(coordinatorWithDeps),
  Layer.provideMerge(tradingExecutionCore),
);

// Plan 29 step 2.4: the working-order loop, same place runtimeLayer.ts builds
// it — on the execution core, beside the protection service. Plain `provide`
// (not provideMerge): it sits inside the merge below.
const tradingWorkingOrderForTest = TradingWorkingOrderServiceLive.pipe(
  Layer.provide(tradingExecutionCore),
);

const tradingLayerForTest = Layer.mergeAll(
  TradingExecutionGuardLive,
  TradingFillReconcilerLive,
  TradingEmergencyCloseServiceLive,
  TradingControlServiceLive,
  tradingWorkingOrderForTest,
).pipe(Layer.provideMerge(tradingProtectionForTest));

// --- layer composition ------------------------------------------------------
// The real TradingMissionReactorLive provided with the faked trading layer
// (`provideMerge` so the reactor's remaining orchestration deps flow outward),
// then the orchestration engine + projection pipeline + persistence. The engine
// projects each dispatched event synchronously via
// projectionPipeline.projectEvent, so the full orchestration reactor is not
// needed for the projection half of this proof — only the trading reactor
// (which the test starts) is.
function buildLayer(workspaceDir: string, rootDir: string, dbPath: string) {
  return TradingMissionReactorLive.pipe(
    Layer.provideMerge(tradingLayerForTest),
    Layer.provideMerge(WatchEvaluatorLive.pipe(Layer.provide(tradingLayerForTest))),
    Layer.provideMerge(OrchestrationEngineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    // The reactor resolves a mission's harness driver kind by provider
    // instance id; this test configures no provider instances, so the lookup
    // finds nothing and the binding falls back.
    Layer.provideMerge(makeProviderRegistryLayer()),
    Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
    // Upstream's projection pipeline now reads per-thread background liveness
    // and plan progress, so every layer stack that builds it has to supply
    // them — including the fork's own integration harnesses.
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(NodeServices.layer),
  );
}

// --- poll helper (mirrors the harness's waitFor) ----------------------------
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 40_000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);
  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({ schedule: retrySchedule, times: maxRetries, while: (e) => e === RETRY_SIGNAL }),
    Effect.mapError((e) =>
      e === RETRY_SIGNAL ? new Error(`waitFor timed out: ${description}`) : e,
    ),
    Effect.orDie,
  );
}

it.live(
  "trading execution reachability: request_entry → command → event → reactor → exchange → reconcile → projection",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-exec-reach-",
      });
      const workspaceDir = path.join(rootDir, "workspace");
      const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
        Effect.provideService(Path.Path, path),
      );
      yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });

      const layer = buildLayer(workspaceDir, rootDir, dbPath);

      // Use a single shared runtime so every dispatch/read observes the same
      // engine, reactors, and SQL connection. Acquire/use/release so the runtime
      // (and its reactor scopes) tear down at the end of the test. The interim
      // signer env must be set before the layer builds (InterimSignerConfigLive
      // captures process.env at build time); restore it on release.
      const prevSignerKey = setInterimSignerEnv();
      yield* Effect.acquireUseRelease(
        // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The reachability proof needs ONE runtime shared across many separate runPromise calls so dispatch, the reactors, and the SQL connection are the same instances; it.effect's per-test layer cannot express that shared lifetime.
        Effect.sync(() => ManagedRuntime.make(layer)),
        (runtime) =>
          Effect.gen(function* () {
            // Load the services the test drives and observes.
            const engine = (yield* Effect.promise(() =>
              runtime.runPromise(Effect.service(OrchestrationEngineService)),
            )) as OrchestrationEngineShape;
            const projection = yield* Effect.promise(() =>
              runtime.runPromise(Effect.service(TradingMissionProjection)),
            );
            const tradingReactor = yield* Effect.promise(() =>
              runtime.runPromise(Effect.service(TradingMissionReactor)),
            );

            // Run the test body inside the runtime so SQL / dispatch resolve.
            yield* Effect.promise(() =>
              runtime.runPromise(
                Effect.gen(function* () {
                  const scope = yield* Scope.make();

                  // Start the trading reactor: its event-stream consumer turns a
                  // `trading.execution-requested` event into the write side
                  // (preview → guard → submit → reconcile). The engine projects
                  // each dispatched event synchronously, so no orchestration
                  // reactor is needed for the projection half.
                  yield* tradingReactor.start().pipe(Scope.provide(scope));

                  const commandId = (n: string) => CommandId.make(`cmd-exec-reach-${n}`);

                  // 1. Seed project + thread (a mission is bound to a real thread).
                  const modelSelection = {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5",
                  };
                  yield* engine.dispatch({
                    type: "project.create",
                    commandId: commandId("project"),
                    projectId: PROJECT_ID,
                    title: "Execution Reachability",
                    workspaceRoot: workspaceDir,
                    defaultModelSelection: modelSelection,
                    createdAt: NOW,
                  });
                  yield* engine.dispatch({
                    type: "thread.create",
                    commandId: commandId("thread"),
                    threadId: THREAD_ID,
                    projectId: PROJECT_ID,
                    title: "Execution Reachability Thread",
                    modelSelection,
                    interactionMode: "default",
                    runtimeMode: "full-access",
                    branch: null,
                    worktreePath: null,
                    createdAt: NOW,
                  });

                  // 2. Seed the trading account with the master wallet the fakes
                  //    respond to. createMission does NOT create the account; the
                  //    reactor's execution handler reads master_wallet_json via
                  //    getMasterWalletAddress.
                  const sql = yield* SqlClient.SqlClient;
                  const masterWalletJson =
                    '{"privyWalletId":"privy-master","address":"' +
                    MASTER_ADDR +
                    '","ownership":"user"}';
                  const executionWalletJson =
                    '{"privyWalletId":"privy-exec","address":"' +
                    SIGNER_ADDR +
                    '","hyperliquidAgentName":"test-agent","status":"approved","approvedAt":1000}';
                  yield* sql`
                INSERT INTO trading_accounts (
                  account_id, user_id, environment, master_wallet_json,
                  execution_wallet_json, status, created_at, updated_at
                ) VALUES (
                  ${TRADING_ACCOUNT_ID}, ${"local"}, ${"hyperliquid_testnet"}, ${masterWalletJson},
                  ${executionWalletJson}, ${"ready"}, 1000, 1000
                )
              `;

                  // 3. Create the mission (decider →
                  //    trading.mission-create-requested → reactor → mission row +
                  //    announceStatus("initializing") → projection).
                  yield* engine.dispatch({
                    type: "trading.mission.create",
                    commandId: commandId("mission-create"),
                    threadId: THREAD_ID,
                    missionId: MISSION_ID,
                    tradingAccountId: TRADING_ACCOUNT_ID,
                    instruction: "Trade ETH momentum",
                    allocatedCapitalUsd: 1_000,
                    createdAt: NOW,
                  });

                  // Wait for the mission to be projected (the projection row must
                  // exist before getByThreadId can return execution surfaces).
                  yield* waitFor(
                    projection.getByThreadId(THREAD_ID).pipe(Effect.orDie),
                    (m) => Option.isSome(m) && m.value.id === MISSION_ID,
                    "mission projected after create",
                  );

                  yield* tradingReactor.drain;

                  // §11.1 `initializing → analysing`: creating the mission started
                  // its first run, and the reactor advanced it. This test used to
                  // walk the status graph by hand, which hid the fact that nothing
                  // drove it — a real mission stayed in `initializing` forever and
                  // §16.3 item 1 refused every entry.
                  const missions = yield* TradingMissionService;
                  assert.equal((yield* missions.getMission(MISSION_ID)).status, "analysing");

                  // Publish a momentum strategy so the mission's strategyVersion is
                  // 1 (the §16.3 preview rejects an intent whose strategyVersion
                  // does not match the mission's current published version). The
                  // body is the canonical ETH test vector from contracts.test.ts.
                  const strategies = yield* TradingStrategyService;
                  const published = yield* strategies.publishMomentumStrategy({
                    missionId: MISSION_ID,
                    expectedVersion: 0,
                    strategy: {
                      name: "ETH 5m breakout continuation",
                      market: "ETH",
                      mode: "breakout_continuation",
                      direction: "long",
                      timeframes: ["5m", "15m"],
                      belief: {
                        summary: "Breakout confirmed on 1.6x relative volume.",
                        regime: "trending",
                        confidence: 0.7,
                        evidence: ["5m close 3001", "relative volume 1.6x"],
                      },
                      entryPlan: {
                        explanation: "Enter on a retest that holds.",
                        initialNotionalUsd: 1_500,
                        maximumIntendedNotionalUsd: 3_000,
                        orderPreference: "marketable_ioc",
                        conditions: [
                          {
                            description: "Retest of 3,000 holds",
                            timeframe: "5m",
                            priceLevel: 3_000,
                          },
                        ],
                      },
                      positionManagement: {
                        scaleInAllowed: true,
                        scaleInConditions: [{ description: "New 5m high on rising volume" }],
                        partialReductionAllowed: true,
                        trailingMethod: "fixed stop for the POC",
                      },
                      protection: {
                        stopMethod: "Below the last accepted swing low",
                        stopPrice: 2_950,
                        targetProfitUsd: 25,
                        // Publishing checks the target against the basis it
                        // claims to come from: (25 / 3,000) x 3,000 = 25.
                        targetProfitBasis: {
                          measurement: "excursion_quantile",
                          timeframe: "5m",
                          lookbackBars: 120,
                          measuredMoveUsd: 25,
                          expectedHoldBars: 10,
                          referencePrice: 3_000,
                          targetPriceMovePercent: 0.833,
                          positionNotionalUsd: 3_000,
                          historicalHitRatePercent: 50,
                          rationale: "Median 10-bar upside excursion over 120 5m bars.",
                        },
                        maximumPlannedLossUsd: 20,
                      },
                      exitConditions: [
                        { description: "5m close under 2,890", timeframe: "5m", priceLevel: 2_890 },
                      ],
                      abandonmentConditions: [{ description: "Regime flips to mean-reverting" }],
                      reentryConditions: [{ description: "Fresh breakout above 3,100" }],
                      currentAction: "entering",
                      explanation: "Long ETH momentum, protected at 2,950.",
                      plainSummary:
                        "ETH is trending up; I am buying and will sell if it drops to 2,950.",
                    },
                  });
                  assert.equal(published.outcome, "accepted", "strategy publish must be accepted");

                  // §11.1 `analysing → waiting`: the publish itself ends analysis,
                  // which is what makes `executing` reachable on the next step.
                  assert.equal((yield* missions.getMission(MISSION_ID)).status, "waiting");

                  // 4. THE KEYSTONE DISPATCH: the command the
                  //    `trading_request_entry` tool handler raises. This is what
                  //    the prompt requires to be driven end-to-end. (We dispatch
                  //    the command directly rather than through the MCP tool
                  //    boundary because the tool only adds the capability check +
                  //    commandId generation; the command shape is identical — see
                  //    handlers.ts trading_request_entry.)
                  recordingExchange.submitted.length = 0;
                  recordingExchange.positionSize = 0;
                  recordingExchange.filledAt = null;
                  restingProtection.length = 0;
                  yield* engine.dispatch({
                    type: "trading.execution.requested",
                    commandId: commandId("exec-request"),
                    threadId: THREAD_ID,
                    missionId: MISSION_ID,
                    intent: {
                      missionId: MISSION_ID,
                      strategyVersion: 1,
                      executionSequence: 0,
                      actionType: "open",
                      market: "ETH",
                      side: "buy",
                      size: 0.5,
                      orderPreference: "marketable_ioc",
                      limitPrice: 3001,
                      stop: { stopPrice: 2950, plannedLossAtStopUsd: 20 },
                      reduceOnly: false,
                    },
                    expectedAuthorityVersion: 1,
                    activeHarnessRunId: "run_exec_reach_1",
                    createdAt: NOW,
                  });

                  // 5. The decider emits `trading.execution-requested` (dot → dash).
                  const events = yield* waitFor(
                    Stream.runCollect(engine.readEvents(0)).pipe(
                      Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
                    ),
                    (evts) =>
                      evts.some(
                        (e) =>
                          e.type === "trading.execution-requested" &&
                          e.payload.missionId === MISSION_ID,
                      ),
                    "trading.execution-requested event emitted by decider",
                  );
                  const execEvent = events.find(
                    (
                      e,
                    ): e is Extract<OrchestrationEvent, { type: "trading.execution-requested" }> =>
                      e.type === "trading.execution-requested" &&
                      e.payload.missionId === MISSION_ID,
                  );
                  assert.ok(execEvent, "decider must emit trading.execution-requested");
                  assert.equal(execEvent!.payload.intent.market, "ETH");

                  // 6. The reactor processes it and lands a signed order on the
                  //    exchange. Drain first (the worker is a queue), then poll for
                  //    the side effect.
                  yield* tradingReactor.drain;
                  yield* waitFor(
                    Effect.sync(() => recordingExchange.submitted.length),
                    (n) => n >= 1,
                    "signed order recorded by fake exchange",
                  );
                  assert.ok(
                    recordingExchange.submitted.length >= 1,
                    `expected at least one signed order, got ${recordingExchange.submitted.length}`,
                  );

                  // 7. The reconciled fill appears in recentFills via getByThreadId,
                  //    and the position card shows the reconciled size. Both are
                  //    read live from the 037 tables on every call, so no separate
                  //    projection refresh is needed; we just wait for the reactor's
                  //    after_submission reconcile.
                  const projected = yield* waitFor(
                    projection.getByThreadId(THREAD_ID).pipe(Effect.orDie),
                    (m) =>
                      Option.isSome(m) &&
                      m.value.recentFills.some((f) => f.market === "ETH" && f.filledSize > 0) &&
                      m.value.position !== null &&
                      m.value.position.size !== 0,
                    "reconciled fill + position in projection",
                  );

                  assert.ok(Option.isSome(projected), "mission must be projected");
                  const mission = projected.value;
                  // recentFills: the canned ETH buy reached the snapshot table.
                  const ethFill = mission.recentFills.find((f) => f.market === "ETH");
                  assert.ok(ethFill, "recentFills must contain the reconciled ETH fill");
                  assert.equal(ethFill!.side, "buy");
                  assert.ok(ethFill!.filledSize > 0, "fill size must be positive");
                  assert.equal(ethFill!.orderId, 999);

                  // position card: the reconciled size (0.5 long) shows up.
                  assert.ok(mission.position, "position card must be present after reconcile");
                  assert.equal(mission.position!.market, "ETH");
                  assert.equal(mission.position!.size, 0.5);

                  // 8. The reactor's announceStatus("initializing") from
                  //    mission-create drove a status-set → projection refresh, so
                  //    the projection row's mission-level fields are populated too.
                  assert.equal(mission.id, MISSION_ID);
                  assert.equal(mission.threadId, THREAD_ID);
                  // §11.1: the request moved the mission `waiting → executing`, and
                  // the reactor settled it on the reconciled position — 0.5 long, so
                  // `position_open` rather than back to `waiting`.
                  assert.equal(mission.status, "position_open");

                  yield* Scope.close(scope, Exit.void);
                }),
              ),
            );
          }),
        (runtime) =>
          Effect.promise(() => runtime.dispose()).pipe(
            Effect.ensuring(Effect.sync(() => restoreInterimSignerEnv(prevSignerKey))),
          ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
