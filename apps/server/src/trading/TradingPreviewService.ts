/**
 * trading_preview_order — the §16.3 position-increase checklist, in order.
 *
 * Before any position-increasing action is signed, T3 runs the full 17-item
 * checklist from risk §16.3 in its listed order. Every item has a rejection
 * reason; a rejection test pins each. Risk is reserved BEFORE signing and
 * reconciled after every state change.
 *
 * This service is pure validation over already-loaded state. It reads no
 * exchange and mutates no tables — it returns either the validated preview
 * (with the reservation it requires) or the first failing reason. The
 * execution service reserves the risk and persists the record only after a
 * successful preview.
 *
 * @module TradingPreviewService
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";

import type { TradingMission } from "@t3tools/trading-contracts/mission";
import type { MarketBestBidOffer } from "@t3tools/trading-contracts/market";
import { MARKET_FRESHNESS } from "@t3tools/trading-contracts/market";
import { ACCOUNT_FRESHNESS } from "@t3tools/trading-contracts/account-snapshot";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";
import {
  evaluateLossBudget,
  isPermittedUnderExhaustion,
} from "@t3tools/trading-contracts/loss-accounting";
import {
  checkStopInformation,
  describeStopGateDefect,
} from "@t3tools/trading-contracts/protection";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";

/** One of the 17 §16.3 checklist items, in order. */
export const PREVIEW_CHECKLIST_ITEMS = [
  "mission_active",
  "entries_allowed",
  "strategy_version_current",
  "authority_version_current",
  "harness_run_owns_lease",
  "direction_permitted",
  "market_is_eth",
  "execution_wallet_approved",
  "account_and_bbo_fresh",
  "size_and_price_valid",
  "exchange_minimum_met",
  "leverage_within_limits",
  "gross_notional_within_authority",
  "planned_loss_within_per_position_ceiling",
  "reservations_plus_proposed_within_budget",
  "no_conflicting_execution_pending",
  "valid_stop_defined",
] as const;
export type PreviewChecklistItem = (typeof PREVIEW_CHECKLIST_ITEMS)[number];

/** A preview was rejected. `item` names the §16.3 row that failed. */
export class TradingPreviewRejection extends Schema.TaggedErrorClass<TradingPreviewRejection>()(
  "TradingPreviewRejection",
  {
    item: Schema.Literals(PREVIEW_CHECKLIST_ITEMS),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `TradingPreviewRejection(${this.item}): ${this.detail}`;
  }
}

/** State the checklist inspects. All of it is already-reconciled truth. */
export interface PreviewContext {
  readonly mission: TradingMission;
  /** The harness run's published strategy version; must match the intent. */
  readonly currentStrategyVersion: number;
  /** The authority version the mission currently holds. */
  readonly currentAuthorityVersion: number;
  /**
   * The authority version the requesting harness run observed when it decided
   * (§18 optimistic versioning). Must equal `currentAuthorityVersion`, else a
   * stale run is rejected before it mutates durable state.
   */
  readonly expectedAuthorityVersion: number;
  /** The harness run id that owns the decision lease for this mission. */
  readonly activeHarnessRunId: string | null;
  /**
   * The armed execution-wallet address for this mission's account. Until
   * PROMPT-06's approved-wallet registry, this is the interim signer's own
   * address (or null when the signer is unarmed); preview item 8 fail-closes
   * on null. The signer-to-wallet match is enforced at sign time.
   */
  readonly approvedExecutionWalletAddress: string | null;
  /** Fresh BBO for the market (§15.4: 2s window). */
  readonly bbo: MarketBestBidOffer;
  /** Account freshness observedAt (§13: 5s window). */
  readonly accountObservedAt: number;
  /** Whether an execution for this mission is already in flight. */
  readonly hasPendingExecution: boolean;
  /** Current loss-budget snapshot inputs (realised, open, pending). */
  readonly budget: Parameters<typeof evaluateLossBudget>[0];
  /**
   * The master wallet's taker fee rate in bps, read from `userFees` (or the
   * authority fallback when stale). Both the entry and exit side pay this.
   */
  readonly takerFeeRateBps: number;
  /**
   * The authority's stop-slippage reserve in bps of protected notional. Sourced
   * from `TradingRiskPolicy.stopSlippageReserveBps`, not hardcoded.
   */
  readonly stopSlippageReserveBps: number;
  /** Wall-clock now, for freshness tests. */
  readonly nowMs: number;
}

/** A validated preview — the intent cleared all 17 items. */
export interface TradingPreview {
  readonly intent: TradingOrderIntent;
  /** The USD risk this execution must reserve before signing. */
  readonly reservedRiskUsd: number;
}

const bps = (basisPoints: number): number => basisPoints / 10_000;

/** One §16.3 check. Returns void on pass, throws the rejection on fail. */
type Check = (
  intent: TradingOrderIntent,
  ctx: PreviewContext,
) => Effect.Effect<void, TradingPreviewRejection>;

const reject = (
  item: PreviewChecklistItem,
  detail: string,
): Effect.Effect<never, TradingPreviewRejection> => new TradingPreviewRejection({ item, detail });

// --- the 17 checks, in spec order ----------------------------------------

const isActive: Check = (_intent, ctx) =>
  ctx.mission.status === "executing" || ctx.mission.status === "position_open"
    ? Effect.void
    : reject(
        "mission_active",
        `mission status is ${ctx.mission.status}, not executing/position_open`,
      );

const entriesAllowed: Check = (_intent, ctx) =>
  ctx.mission.control.entriesAllowed && !ctx.mission.status.includes("blocked")
    ? Effect.void
    : reject("entries_allowed", "mission control disallows entries or mission is blocked");

const strategyVersionCurrent: Check = (intent, ctx) =>
  intent.strategyVersion === ctx.currentStrategyVersion
    ? Effect.void
    : reject(
        "strategy_version_current",
        `intent v${intent.strategyVersion} ≠ current v${ctx.currentStrategyVersion}`,
      );

const authorityVersionCurrent: Check = (_intent, ctx) =>
  // §18 optimistic versioning: the harness run decided against
  // `expectedAuthorityVersion`; if the mission has since moved to a newer
  // authority, the run is stale and must not mutate durable state.
  ctx.expectedAuthorityVersion === ctx.currentAuthorityVersion
    ? Effect.void
    : reject(
        "authority_version_current",
        `intent saw authority v${ctx.expectedAuthorityVersion} ≠ current v${ctx.currentAuthorityVersion}`,
      );

const harnessRunOwnsLease: Check = (_intent, ctx) =>
  ctx.activeHarnessRunId !== null
    ? Effect.void
    : reject("harness_run_owns_lease", "no harness run currently owns the decision lease");

const directionPermitted: Check = (intent, ctx) => {
  const wants = intent.side === "buy" ? "long" : "short";
  return ctx.mission.authority.allowedDirections.includes(wants as never)
    ? Effect.void
    : reject("direction_permitted", `authority does not permit ${wants}`);
};

const marketIsEth: Check = (intent, _ctx) =>
  intent.market === "ETH"
    ? Effect.void
    : reject("market_is_eth", `POC trades ETH only; got ${intent.market}`);

const executionWalletApproved: Check = (_intent, ctx) =>
  // Armed-signer gate (not an approved-wallet registry check). Until PROMPT-06
  // introduces the approved-execution-wallet registry, this is a fail-closed
  // null check: the mission's account must name *some* execution wallet, which
  // the interim signer resolves to its own armed address. Preview rejects here
  // so an unarmed signer is visible before a nonce is spent; the actual
  // signer-to-wallet match happens in InterimSignerConfig at sign time.
  ctx.approvedExecutionWalletAddress !== null
    ? Effect.void
    : reject(
        "execution_wallet_approved",
        "no armed execution wallet for this mission's account (interim signer unresolved)",
      );

const accountAndBboFresh: Check = (_intent, ctx) => {
  const bboAge = ctx.nowMs - ctx.bbo.freshness.observedAt;
  if (bboAge > MARKET_FRESHNESS.bboStaleAfterMillis) {
    return reject("account_and_bbo_fresh", `BBO aged ${bboAge}ms past the 2s window`);
  }
  const accountAge = ctx.nowMs - ctx.accountObservedAt;
  if (accountAge > ACCOUNT_FRESHNESS.accountStateStaleAfterMillis) {
    return reject("account_and_bbo_fresh", `account aged ${accountAge}ms past the 5s window`);
  }
  return Effect.void;
};

const sizeAndPriceValid: Check = (intent, _ctx) =>
  intent.size > 0 && intent.limitPrice > 0
    ? Effect.void
    : reject("size_and_price_valid", "size and limit price must both be positive");

const exchangeMinimumMet: Check = (intent, _ctx) => {
  const notional = intent.size * intent.limitPrice;
  return notional >= MIN_NOTIONAL_USD
    ? Effect.void
    : reject(
        "exchange_minimum_met",
        `notional $${notional.toFixed(2)} below the $${MIN_NOTIONAL_USD} minimum`,
      );
};

/**
 * Existing open-position gross notional, from the budget snapshot. A scale-in
 * onto an existing position must clear the leverage and gross-notional ceilings
 * against `existing + proposed`, not the proposed order alone.
 */
const existingNotional = (ctx: PreviewContext): number =>
  ctx.budget.openPositions.reduce((sum, p) => sum + p.size * (p.weightedEntryPrice ?? 0), 0);

const leverageWithinLimits: Check = (intent, ctx) => {
  // Combined leverage: the mission's total notional (existing + proposed) over
  // allocated capital. Checking the new order alone lets a scale-in bypass the
  // ceiling by staying under it per-order while breaching it in aggregate.
  const combined = existingNotional(ctx) + intent.size * intent.limitPrice;
  const leverage = combined / ctx.mission.authority.allocatedCapitalUsd;
  return leverage <= ctx.mission.authority.maximumLeverage
    ? Effect.void
    : reject(
        "leverage_within_limits",
        `${leverage.toFixed(2)}x combined exceeds max ${ctx.mission.authority.maximumLeverage}x`,
      );
};

const grossNotionalWithinAuthority: Check = (intent, ctx) => {
  const combined = existingNotional(ctx) + intent.size * intent.limitPrice;
  return combined <= ctx.mission.authority.maximumGrossNotionalUsd
    ? Effect.void
    : reject(
        "gross_notional_within_authority",
        `$${combined.toFixed(2)} combined exceeds max gross $${ctx.mission.authority.maximumGrossNotionalUsd}`,
      );
};

/**
 * The loss this intent plans to take if its stop executes. A reduce-only
 * action carries no stop and plans no new loss, so it contributes zero to the
 * ceiling, the budget test, and the reservation.
 */
const plannedLossOf = (intent: TradingOrderIntent): number =>
  intent.stop?.plannedLossAtStopUsd ?? 0;

const plannedLossWithinCeiling: Check = (intent, ctx) =>
  plannedLossOf(intent) <= ctx.mission.authority.maximumPlannedRiskPerPositionUsd
    ? Effect.void
    : reject(
        "planned_loss_within_per_position_ceiling",
        `$${plannedLossOf(intent)} exceeds per-position ceiling $${ctx.mission.authority.maximumPlannedRiskPerPositionUsd}`,
      );

const reservationsPlusProposedWithinBudget: Check = (intent, ctx) => {
  const budget = evaluateLossBudget(ctx.budget);
  if (budget.exhausted && !isPermittedUnderExhaustion(intent.actionType)) {
    return reject(
      "reservations_plus_proposed_within_budget",
      "budget exhausted; action not permitted under §16.4",
    );
  }
  const afterProposed = budget.remainingCumulativeLossUsd - plannedLossOf(intent);
  return afterProposed >= 0
    ? Effect.void
    : reject(
        "reservations_plus_proposed_within_budget",
        `proposed risk would drive remaining to $${afterProposed.toFixed(2)}`,
      );
};

const noConflictingExecution: Check = (_intent, ctx) =>
  !ctx.hasPendingExecution
    ? Effect.void
    : reject(
        "no_conflicting_execution_pending",
        "an execution for this mission is already in flight",
      );

/**
 * §16.3 item 17 / §17: the mandatory-stop gate, first of its two evaluations.
 *
 * The execution service runs the identical `checkStopInformation` again just
 * before it signs, so an intent that reaches the wire without a stop has had to
 * defeat both. A reduce-only action is exempt — it is the exit, not an
 * increase.
 */
const validStopDefined: Check = (intent, _ctx) => {
  const gateInput = {
    actionType: intent.actionType,
    side: intent.side,
    referencePrice: intent.limitPrice,
    stop: intent.stop,
  };
  const defect = checkStopInformation(gateInput);
  return defect === null
    ? Effect.void
    : reject("valid_stop_defined", describeStopGateDefect(defect, gateInput));
};

// The ordered list — §16.3 listed order is load-bearing.
const CHECKS: ReadonlyArray<{ item: PreviewChecklistItem; run: Check }> = [
  { item: "mission_active", run: isActive },
  { item: "entries_allowed", run: entriesAllowed },
  { item: "strategy_version_current", run: strategyVersionCurrent },
  { item: "authority_version_current", run: authorityVersionCurrent },
  { item: "harness_run_owns_lease", run: harnessRunOwnsLease },
  { item: "direction_permitted", run: directionPermitted },
  { item: "market_is_eth", run: marketIsEth },
  { item: "execution_wallet_approved", run: executionWalletApproved },
  { item: "account_and_bbo_fresh", run: accountAndBboFresh },
  { item: "size_and_price_valid", run: sizeAndPriceValid },
  { item: "exchange_minimum_met", run: exchangeMinimumMet },
  { item: "leverage_within_limits", run: leverageWithinLimits },
  { item: "gross_notional_within_authority", run: grossNotionalWithinAuthority },
  { item: "planned_loss_within_per_position_ceiling", run: plannedLossWithinCeiling },
  { item: "reservations_plus_proposed_within_budget", run: reservationsPlusProposedWithinBudget },
  { item: "no_conflicting_execution_pending", run: noConflictingExecution },
  { item: "valid_stop_defined", run: validStopDefined },
];

/**
 * The preview service. Runs the §16.3 checklist and returns the validated
 * preview with the risk it must reserve, or the first rejection.
 */
export class TradingPreviewService extends Context.Service<
  TradingPreviewService,
  {
    readonly preview: (
      intent: TradingOrderIntent,
      ctx: PreviewContext,
    ) => Effect.Effect<TradingPreview, TradingPreviewRejection>;
  }
>()("t3/trading/TradingPreviewService") {}

/** Pure preview — runs all 17 checks in order, returns the validated preview. */
export const previewOrder = (
  intent: TradingOrderIntent,
  ctx: PreviewContext,
): Effect.Effect<TradingPreview, TradingPreviewRejection> =>
  Effect.gen(function* () {
    for (const { run } of CHECKS) {
      yield* run(intent, ctx);
    }
    // Eq 4: reservedRisk = plannedLossAtStop + entryFee + exitFee + slippageReserve.
    // Both the entry and the stop-out exit pay the taker rate; the slippage
    // reserve is the authority's bps on the protected notional. The execution
    // service persists this reservation before signing (§16.3: "reserve before
    // signing").
    const notional = intent.size * intent.limitPrice;
    const rate = bps(ctx.takerFeeRateBps);
    const estimatedEntryFeeUsd = notional * rate;
    const estimatedExitFeeUsd = notional * rate;
    const stopSlippageReserveUsd = notional * bps(ctx.stopSlippageReserveBps);
    const reservedRiskUsd =
      plannedLossOf(intent) + estimatedEntryFeeUsd + estimatedExitFeeUsd + stopSlippageReserveUsd;
    return { intent, reservedRiskUsd } as TradingPreview;
  });

export const TradingPreviewServiceLive = Layer.effect(
  TradingPreviewService,
  Effect.succeed(TradingPreviewService.of({ preview: previewOrder })),
);
