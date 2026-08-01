import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import type { MarketBestBidOffer } from "@t3tools/trading-contracts/market";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";
import type { TradingMission } from "@t3tools/trading-contracts/mission";

import { previewOrder, type PreviewContext } from "./TradingPreviewService.ts";

/** A well-formed intent that clears every check. */
const goodIntent = (overrides: Partial<TradingOrderIntent> = {}): TradingOrderIntent => ({
  missionId: "mission_1",
  strategyVersion: 1,
  executionSequence: 0,
  actionType: "open",
  market: "ETH",
  side: "buy",
  size: 0.05,
  orderPreference: "marketable_ioc",
  limitPrice: 3_750,
  stop: { stopPrice: 3_700, plannedLossAtStopUsd: 12 },
  reduceOnly: false,
  ...overrides,
});

const goodMission = (overrides: Partial<TradingMission> = {}): TradingMission =>
  ({
    id: "mission_1",
    userId: "user_1",
    tradingAccountId: "acct_1",
    instruction: "trade eth",
    market: "ETH",
    strategyFamily: "momentum",
    harness: {
      provider: "claude",
      providerInstanceId: "claude",
      threadId: "thread_1",
      status: "available",
    },
    authority: {
      allocatedCapitalUsd: 1_000,
      allowedDirections: ["long", "short"],
      maximumLeverage: 3,
      maximumGrossNotionalUsd: 3_000,
      maximumCumulativeLossUsd: 100,
      maximumPlannedRiskPerPositionUsd: 20,
      marginModes: ["isolated"],
      allowScaleIn: true,
      allowPartialReduction: true,
      allowReentry: true,
      allowDirectionReversal: false,
      riskPolicy: {
        feeRateSource: "hyperliquid_user_fees",
        fallbackTakerFeeBpsPerSide: 5,
        stopSlippageReserveBps: 25,
        positivePnlExpandsLossBudget: false,
      },
      validUntil: "revoked",
    },
    strategy: undefined,
    status: "executing",
    blockedReason: undefined,
    control: { entriesAllowed: true, reentryAllowed: true, pauseAfterPositionClose: false },
    authorityVersion: 1,
    strategyVersion: 1,
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    ...overrides,
  }) as unknown as TradingMission;

const freshBbo = (now: number): MarketBestBidOffer => ({
  bidPrice: 3_748,
  bidSize: 1,
  askPrice: 3_749,
  askSize: 1,
  freshness: { observedAt: now, source: "info_api", staleAfterMillis: 2_000 },
});

const goodCtx = (now: number, overrides: Partial<PreviewContext> = {}): PreviewContext => ({
  mission: goodMission(),
  currentStrategyVersion: 1,
  currentAuthorityVersion: 1,
  expectedAuthorityVersion: 1,
  activeHarnessRunId: "run_1",
  approvedExecutionWalletAddress: "0xapproved",
  bbo: freshBbo(now),
  accountObservedAt: now,
  hasPendingExecution: false,
  budget: {
    maximumCumulativeLossUsd: 100,
    closedPnlUsd: 0,
    netFundingUsd: 0,
    allPaidTradingFeesUsd: 0,
    openPositions: [],
    pendingEntries: [],
    observedAt: now,
  },
  takerFeeRateBps: 5,
  stopSlippageReserveBps: 25,
  nowMs: now,
  ...overrides,
});

const rejectionItem = (intent: TradingOrderIntent, ctx: PreviewContext) =>
  previewOrder(intent, ctx).pipe(
    Effect.flip,
    Effect.map((r) => r.item),
  );

describe("previewOrder — §16.3 checklist", () => {
  const now = 1_700_000_000_000;

  it.effect("passes a well-formed intent and reserves the planned risk + slippage", () =>
    Effect.gen(function* () {
      const preview = yield* previewOrder(goodIntent(), goodCtx(now));
      expect(preview.intent.missionId).toBe("mission_1");
      // 12 planned + 0.05 * 3750 * 0.0025 = 12 + 4.6875 ≈ 16.69
      expect(preview.reservedRiskUsd).toBeGreaterThan(12);
    }),
  );

  it.effect("item 1: rejects when the mission is not active (§16.3 mission_active)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent(),
        goodCtx(now, { mission: goodMission({ status: "paused" }) }),
      );
      expect(item).toBe("mission_active");
    }),
  );

  it.effect("item 2: rejects when entries are not allowed (entries_allowed)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent(),
        goodCtx(now, {
          mission: goodMission({
            control: {
              entriesAllowed: false,
              reentryAllowed: true,
              pauseAfterPositionClose: false,
            },
          }),
        }),
      );
      expect(item).toBe("entries_allowed");
    }),
  );

  it.effect("item 3: rejects a stale strategy version (strategy_version_current)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(goodIntent({ strategyVersion: 2 }), goodCtx(now));
      expect(item).toBe("strategy_version_current");
    }),
  );

  it.effect("item 4: rejects a stale authority version (authority_version_current)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent(),
        goodCtx(now, { currentAuthorityVersion: 2, expectedAuthorityVersion: 1 }),
      );
      expect(item).toBe("authority_version_current");
    }),
  );

  it.effect("item 5: rejects when no harness run owns the lease (harness_run_owns_lease)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(goodIntent(), goodCtx(now, { activeHarnessRunId: null }));
      expect(item).toBe("harness_run_owns_lease");
    }),
  );

  it.effect("item 6: rejects a disallowed direction (direction_permitted)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent({ side: "sell" }),
        goodCtx(now, {
          mission: goodMission({
            authority: { ...goodMission().authority, allowedDirections: ["long"] },
          }),
        }),
      );
      expect(item).toBe("direction_permitted");
    }),
  );

  it.effect("item 7: rejects a non-ETH market (market_is_eth)", () =>
    Effect.gen(function* () {
      // The intent type pins market to "ETH"; cast to simulate a bad value.
      const item = yield* rejectionItem(
        goodIntent({ market: "BTC" as unknown as "ETH" }),
        goodCtx(now),
      );
      expect(item).toBe("market_is_eth");
    }),
  );

  it.effect("item 8: rejects when no execution wallet is armed (execution_wallet_approved)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent(),
        goodCtx(now, { approvedExecutionWalletAddress: null }),
      );
      expect(item).toBe("execution_wallet_approved");
    }),
  );

  it.effect("item 9: rejects a stale BBO (account_and_bbo_fresh)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(goodIntent(), goodCtx(now, { bbo: freshBbo(now - 5_000) }));
      expect(item).toBe("account_and_bbo_fresh");
    }),
  );

  it.effect("item 10: rejects a non-positive size (size_and_price_valid)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(goodIntent({ size: 0 }), goodCtx(now));
      expect(item).toBe("size_and_price_valid");
    }),
  );

  it.effect("item 11: rejects a sub-minimum notional (exchange_minimum_met)", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(goodIntent({ size: 0.0001 }), goodCtx(now));
      expect(item).toBe("exchange_minimum_met");
    }),
  );

  it.effect("item 12: rejects leverage above the authority ceiling (leverage_within_limits)", () =>
    Effect.gen(function* () {
      // 10 ETH * 3750 = 37500 / 1000 = 37.5x >> 3x cap.
      const item = yield* rejectionItem(goodIntent({ size: 10 }), goodCtx(now));
      expect(item).toBe("leverage_within_limits");
    }),
  );

  it.effect("item 13: rejects gross notional above the authority ceiling", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent({ size: 2 }),
        goodCtx(now, {
          mission: goodMission({
            authority: {
              ...goodMission().authority,
              maximumGrossNotionalUsd: 1_000,
              maximumLeverage: 100,
            },
          }),
        }),
      );
      expect(item).toBe("gross_notional_within_authority");
    }),
  );

  it.effect("item 13 (scale-in): rejects when existing + proposed breaches gross notional", () =>
    Effect.gen(function* () {
      // Existing 0.7 ETH @ 3750 = $2625 notional; proposed 0.1 ETH @ 3750 = $375.
      // The $375 order alone is under a $2900 ceiling, but combined ($3000) breaches.
      const item = yield* rejectionItem(
        goodIntent({ size: 0.1 }),
        goodCtx(now, {
          mission: goodMission({
            authority: {
              ...goodMission().authority,
              maximumGrossNotionalUsd: 2_900,
              maximumLeverage: 100,
            },
          }),
          budget: {
            maximumCumulativeLossUsd: 100,
            closedPnlUsd: 0,
            netFundingUsd: 0,
            allPaidTradingFeesUsd: 0,
            openPositions: [
              {
                missionId: "mission_1",
                direction: "long",
                size: 0.7,
                weightedEntryPrice: 3_750,
                stopPrice: 3_700,
                paidFeesUsd: 0,
                estimatedExitFeeUsd: 0,
                stopSlippageReserveUsd: 0,
              },
            ],
            pendingEntries: [],
            observedAt: now,
          },
        }),
      );
      expect(item).toBe("gross_notional_within_authority");
    }),
  );

  it.effect("item 14: rejects planned loss above the per-position ceiling", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent({ stop: { stopPrice: 3_700, plannedLossAtStopUsd: 50 } }),
        goodCtx(now),
      );
      expect(item).toBe("planned_loss_within_per_position_ceiling");
    }),
  );

  it.effect("item 15: rejects when the proposed risk would exhaust the budget", () =>
    Effect.gen(function* () {
      const item = yield* rejectionItem(
        goodIntent({ stop: { stopPrice: 3_700, plannedLossAtStopUsd: 20 } }),
        goodCtx(now, {
          budget: {
            maximumCumulativeLossUsd: 100,
            closedPnlUsd: -90,
            netFundingUsd: 0,
            allPaidTradingFeesUsd: 0,
            openPositions: [],
            pendingEntries: [],
            observedAt: now,
          },
        }),
      );
      expect(item).toBe("reservations_plus_proposed_within_budget");
    }),
  );

  it.effect(
    "item 16: rejects when a conflicting execution is pending (no_conflicting_execution_pending)",
    () =>
      Effect.gen(function* () {
        const item = yield* rejectionItem(
          goodIntent(),
          goodCtx(now, { hasPendingExecution: true }),
        );
        expect(item).toBe("no_conflicting_execution_pending");
      }),
  );

  it.effect("item 17: rejects a stop on the wrong side of entry (valid_stop_defined)", () =>
    Effect.gen(function* () {
      // Long entry but stop above the entry price.
      const item = yield* rejectionItem(
        goodIntent({ stop: { stopPrice: 3_800, plannedLossAtStopUsd: 12 } }),
        goodCtx(now),
      );
      expect(item).toBe("valid_stop_defined");
    }),
  );
});
