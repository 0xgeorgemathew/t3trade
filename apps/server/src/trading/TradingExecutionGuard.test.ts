/**
 * TradingExecutionGuard unit tests — §16.4 exhaustion enforcement.
 *
 * This file tests the REAL `TradingExecutionGuard` service (not a local
 * re-implementation of the guard logic). The service is constructed via its
 * live layer, with stub (no-op) services for its three dependencies
 * (TradingMissionService, HyperliquidExecutionService, HyperliquidReconciler).
 *
 * `guardAction` and `guardResume` do not touch SQL or the gateway — they
 * decide purely from the supplied `TradingLossBudget` / `isBlocked` flag — so
 * the stubs are sufficient and the real enforcement code path is exercised.
 *
 * `blockForExhaustion` and `reduceOnlyClose` require the full layer (SQL +
 * gateway stubs + a reconciled state machine) and are covered end-to-end by
 * ExecutionReactorLoop.test.ts; they are skipped here rather than reimplemented
 * locally.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isPermittedUnderExhaustion } from "@t3tools/trading-contracts/loss-accounting";
import type { TradingLossBudget } from "@t3tools/trading-contracts/execution";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HyperliquidExecutionService,
  TradingExecutionError,
  type ExecutionInput,
} from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler, type ReconciledState } from "./HyperliquidReconciler.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import {
  TradingExecutionGuard,
  TradingExecutionGuardLive,
  TradingExhaustionError,
} from "./TradingExecutionGuard.ts";

/** No-op stubs — guardAction/guardResume never reach these services. */
const stubMissions = Layer.succeed(TradingMissionService, {
  // The shape is large; cast through unknown so the unit test does not have to
  // enumerate every method. Only the methods the exercised code path touches
  // would need real implementations, and guardAction/guardResume touch none.
} as unknown as TradingMissionService["Service"]);

const stubExecution = Layer.succeed(HyperliquidExecutionService, {
  submitOrder: () => Effect.die("submitOrder should not be called by guardAction/guardResume"),
  submitCancel: () => Effect.die("submitCancel should not be called by guardAction/guardResume"),
} as unknown as HyperliquidExecutionService["Service"]);

const stubReconciler = Layer.succeed(HyperliquidReconciler, {
  reconcile: () => Effect.die("reconcile should not be called by guardAction/guardResume"),
} as unknown as HyperliquidReconciler["Service"]);

/**
 * The real guard layer, built over no-op dependency stubs. guardAction and
 * guardResume are pure over their arguments and never call into the stubs, so
 * this is a faithful (not reimplemented) test of the service.
 */
const layer = it.layer(
  TradingExecutionGuardLive.pipe(
    Layer.provideMerge(stubMissions),
    Layer.provideMerge(stubExecution),
    Layer.provideMerge(stubReconciler),
  ),
);

const nonExhausted: TradingLossBudget = {
  maximumCumulativeLossUsd: 100,
  closedPnlUsd: -10,
  netFundingUsd: 0,
  allPaidTradingFeesUsd: 1,
  realizedMissionResultUsd: -11,
  realizedLossUsedUsd: 11,
  openPositionRiskUsd: 5,
  pendingEntryRiskUsd: 5,
  lossBudgetUsedUsd: 21,
  remainingCumulativeLossUsd: 79,
  exhausted: false,
  observedAt: 1_753_000_000_000,
};

const exhausted: TradingLossBudget = {
  ...nonExhausted,
  remainingCumulativeLossUsd: 0,
  exhausted: true,
};

layer("TradingExecutionGuard — §16.4 exhaustion enforcement", (it) => {
  it.effect("permits every action when the budget is NOT exhausted", () =>
    Effect.gen(function* () {
      const guard = yield* TradingExecutionGuard;

      // Position-increasing actions are permitted when not exhausted. None reject.
      yield* guard.guardAction("open", nonExhausted);
      yield* guard.guardAction("scale_in", nonExhausted);
      yield* guard.guardAction("cancel", nonExhausted);
      yield* guard.guardAction("reduce", nonExhausted);
      yield* guard.guardAction("close", nonExhausted);

      assert.isTrue(true);
    }),
  );

  it.effect("blocks position-increasing actions under exhaustion (open / scale_in)", () =>
    Effect.gen(function* () {
      const guard = yield* TradingExecutionGuard;

      const openErr = yield* Effect.flip(guard.guardAction("open", exhausted));
      assert.equal(openErr.reason, "action_not_permitted_under_exhaustion");

      const scaleErr = yield* Effect.flip(guard.guardAction("scale_in", exhausted));
      assert.equal(scaleErr.reason, "action_not_permitted_under_exhaustion");
    }),
  );

  it.effect("permits cancel/reduce/close under exhaustion (protection preservation)", () =>
    Effect.gen(function* () {
      const guard = yield* TradingExecutionGuard;

      // §16.4: cancel/reduce/close stay permitted under exhaustion so the
      // mission can still unwind its protection. None reject.
      yield* guard.guardAction("cancel", exhausted);
      yield* guard.guardAction("reduce", exhausted);
      yield* guard.guardAction("close", exhausted);
      // Repairing protection is risk management, not risk-taking.
      yield* guard.guardAction("modify_stop", exhausted);

      // The permitted set matches the contracts definition exactly.
      assert.isOk(isPermittedUnderExhaustion("cancel"));
      assert.isOk(isPermittedUnderExhaustion("reduce"));
      assert.isOk(isPermittedUnderExhaustion("close"));
      assert.isOk(isPermittedUnderExhaustion("modify_stop"));
      assert.isNotOk(isPermittedUnderExhaustion("open"));
      assert.isNotOk(isPermittedUnderExhaustion("scale_in"));
    }),
  );

  it.effect("guardResume rejects with reason 'resume_blocked' when the mission is blocked", () =>
    Effect.gen(function* () {
      const guard = yield* TradingExecutionGuard;

      const error = yield* Effect.flip(guard.guardResume("mission_1", true));
      assert.instanceOf(error, TradingExhaustionError);
      assert.equal(error.reason, "resume_blocked");
    }),
  );

  it.effect("guardResume passes when the mission is not blocked", () =>
    Effect.gen(function* () {
      const guard = yield* TradingExecutionGuard;

      // guardResume returns void on success; reaching here means it did not reject.
      yield* guard.guardResume("mission_1", false);
      assert.isTrue(true);
    }),
  );

  // blockForExhaustion cancels increasing orders + transitions the mission to
  // blocked; reduceOnlyClose submits a reduce-only IOC and reconciles. Both
  // blockForExhaustion and reduceOnlyClose own the SQL/gateway interaction
  // (the cancel-by-cloid loop, the mission transition to blocked, the
  // before/after reconcile, the close_did_not_flatten escalation). They need
  // the full layer (SQL + recording fake exchange + reconciler + mission
  // service), which this pure-rule unit file cannot supply without dragging
  // in the entire execution stack. The real coverage lives in
  // ExecutionReactorLoop.test.ts, which builds the real guard on top of the
  // real execution + reconciler + recording fakes and asserts:
  //   - blockForExhaustion cancels only increasing orders, transitions the
  //     mission to blocked/cumulative_loss_limit, and still transitions when a
  //     cancel fails (swallow-and-log).
  //   - reduceOnlyClose submits a sell reduce-only IOC at the canonical size
  //     and escalates close_did_not_flatten when the post-close position is
  //     non-zero.
  // These stubs are kept as signposts pointing at that file; the previous
  // version falsely claimed ExecutionReactorLoop.test.ts covered them when it
  // did not (it only exercised the permit matrix + submitCancel in isolation).
  it.skip("blockForExhaustion — see ExecutionReactorLoop.test.ts (blockForExhaustion cancels increasing orders + transitions to blocked)", () => {});
  it.skip("reduceOnlyClose — see ExecutionReactorLoop.test.ts (reduce-only IOC + close_did_not_flatten escalation)", () => {});
  it.skip("reduceOnlySized — see ExecutionReactorLoop.test.ts (requested size honoured, oversized reduce clamped, reduce-only forced onto the wire)", () => {});
});

// ===========================================================================
// The reduce-only error taxonomy.
//
// A reduce that preview refused is not the loss budget saying no. Relabelling
// it `budget_exhausted` is what happened live: the harness was told its budget
// was gone, inside a payload that also read `exhausted: false`, and spent the
// rest of the mission on a recovery path that could not work while the real
// reason — a stuck execution record tripping preview item 16 — went unsaid.
// The guard's failure channel is `ReduceOnlyError` so the true cause travels.
// ===========================================================================

/** Canonical state the stub reconciler reports: an ETH long of 1. */
const openLongState = {
  position: {
    missionId: "mission_1",
    market: "ETH",
    size: 1,
    entryPrice: 3000,
    unrealisedPnl: 0,
    marginUsed: 300,
    protectedSize: 0,
    observedAt: 1_000,
  },
  openOrders: [],
  canonicalOrders: [],
  fills: [],
  observedAt: 1_000,
} as unknown as ReconciledState;

/** The exact refusal from the incident: preview item 16. */
const previewRejection = new TradingExecutionError({
  stage: "preview_rejected",
  detail: "16: an execution for this mission is already in flight",
});

const answeringReconciler = Layer.succeed(HyperliquidReconciler, {
  reconcile: () => Effect.succeed(openLongState),
} as unknown as HyperliquidReconciler["Service"]);

const rejectingExecution = Layer.succeed(HyperliquidExecutionService, {
  submitOrder: () => Effect.fail(previewRejection),
  submitCancel: () => Effect.die("submitCancel is not part of the reduce path"),
} as unknown as HyperliquidExecutionService["Service"]);

/** Unused by the stubs above, but present in the guard's requirements. */
const stubGateway = Layer.succeed(HyperliquidGateway, {} as HyperliquidGateway["Service"]);
const stubInfo = Layer.succeed(HyperliquidInfoClient, {} as HyperliquidInfoClient["Service"]);

const reduceInput: ExecutionInput = {
  intent: {
    missionId: "mission_1",
    market: "ETH",
    actionType: "reduce",
    side: "sell",
    size: 0.5,
    orderPreference: "marketable_ioc",
    limitPrice: 2990,
    executionSequence: 2,
    reduceOnly: true,
  } as unknown as ExecutionInput["intent"],
  previewContext: {} as unknown as ExecutionInput["previewContext"],
  allowedSlippageBps: 50,
  masterAddress: "0x000000000000000000000000000000000000beef",
};

const reduceLayer = it.layer(
  TradingExecutionGuardLive.pipe(
    Layer.provideMerge(stubMissions),
    Layer.provideMerge(rejectingExecution),
    Layer.provideMerge(answeringReconciler),
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(stubInfo),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

reduceLayer("TradingExecutionGuard — reduce-only error taxonomy", (it) => {
  it.effect(
    "surfaces a preview rejection from reduceOnlySized as itself, not budget_exhausted",
    () =>
      Effect.gen(function* () {
        const guard = yield* TradingExecutionGuard;

        const error = yield* Effect.flip(guard.reduceOnlySized(reduceInput));

        assert.equal(error._tag, "TradingExecutionError");
        assert.notEqual(error._tag, "TradingExhaustionError");
        if (error._tag === "TradingExecutionError") {
          assert.equal(error.stage, "preview_rejected");
          // The checklist item survives to the harness-visible message — that
          // string is an operating instruction, so it has to name the real cause.
          assert.include(error.message, "an execution for this mission is already in flight");
        }
      }),
  );

  it.effect("surfaces a preview rejection from reduceOnlyClose as itself too", () =>
    Effect.gen(function* () {
      const guard = yield* TradingExecutionGuard;

      const error = yield* Effect.flip(guard.reduceOnlyClose(reduceInput));

      // Not `close_did_not_flatten` either: the close never reached the
      // exchange, so there is nothing to have failed to flatten.
      assert.equal(error._tag, "TradingExecutionError");
    }),
  );
});
