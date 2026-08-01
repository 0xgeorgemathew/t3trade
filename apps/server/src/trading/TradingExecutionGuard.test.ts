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

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
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

      // The permitted set matches the contracts definition exactly.
      assert.isOk(isPermittedUnderExhaustion("cancel"));
      assert.isOk(isPermittedUnderExhaustion("reduce"));
      assert.isOk(isPermittedUnderExhaustion("close"));
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
  // require the full layer (SQL + gateway stubs + reconciled state machine)
  // and are covered end-to-end by ExecutionReactorLoop.test.ts. Skipped here
  // rather than reimplemented locally — the guard logic they add on top of
  // guardAction is the SQL/gateway interaction, not a pure rule.
  it.skip("blockForExhaustion cancels increasing orders and transitions to blocked (covered by ExecutionReactorLoop.test.ts)", () => {
    // See ExecutionReactorLoop.test.ts (the M6 wiring fixture).
  });

  it.skip("reduceOnlyClose submits a reduce-only IOC and reconciles to flat (covered by ExecutionReactorLoop.test.ts)", () => {
    // See ExecutionReactorLoop.test.ts (the M6 wiring fixture).
  });
});
