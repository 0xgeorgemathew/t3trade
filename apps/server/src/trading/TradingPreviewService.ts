/**
 * trading_preview_order — the §16.3 position-increase checklist, in order.
 *
 * Before any position-increasing action is signed, T3 runs the checklist from
 * risk §16.3 in its listed order — 14 of its 17 rows: the three discipline
 * rows (strategy version, authority version, entry-side market mandate) were
 * retired by plan-29 §3.3. Every item has a rejection reason; a rejection
 * test pins each. Risk is reserved BEFORE signing and reconciled after every
 * state change.
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
  isPositionIncreasing,
} from "@t3tools/trading-contracts/protection";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";

/** One of the 14 §16.3 checklist items the entry list runs, in order, plus the exit-only items. */
export const PREVIEW_CHECKLIST_ITEMS = [
  "mission_active",
  "entries_allowed",
  "harness_run_owns_lease",
  "direction_permitted",
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
  /**
   * Exit-only: there is something to reduce or close.
   *
   * Not a §16.3 row — §16.3 is the position-INCREASE checklist and has no word
   * for "you asked to exit a position you do not hold". The exit path needs one,
   * because the alternative is reporting that refusal under an entry item the
   * harness then tries to satisfy by changing its size.
   */
  "position_exists",
  /**
   * Exit-only since plan-29 §3.3: the entry list no longer polices which
   * market an increase may take, but an exit must still land in the mission's
   * mandated market — it is the one way the exposure is actually removed.
   */
  "market_is_eth",
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

/**
 * An execution record that is mid-submission — written, not yet answered. One
 * of these is what preview item 16 refuses a second submit sequence for.
 */
export interface PendingExecution {
  readonly cloid: string;
  readonly actionType: string;
  readonly status: string;
  /** How long it has sat in a non-terminal status. */
  readonly ageMillis: number;
}

/** State the checklist inspects. All of it is already-reconciled truth. */
export interface PreviewContext {
  readonly mission: TradingMission;
  /**
   * The authority version the mission currently holds. No preview item reads
   * this since plan-29 §3.3 retired `authority_version_current`.
   */
  readonly currentAuthorityVersion: number;
  /**
   * The authority version the requesting harness run observed when it decided
   * (§18 optimistic versioning). Preview stopped comparing it to
   * `currentAuthorityVersion` when `authority_version_current` was retired
   * (plan-29 §3.3); the lease check still ties the decision to a live run.
   */
  readonly expectedAuthorityVersion: number;
  /** The harness run id that owns the decision lease for this mission. */
  readonly activeHarnessRunId: string | null;
  /** The run id attached to the request being previewed. */
  readonly requestingHarnessRunId: string;
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
  /**
   * The mid-submission execution blocking this one, when there is one.
   *
   * A bare boolean made the rejection unactionable: the harness was told
   * something conflicted without being told what, how old it was, or whether it
   * was ever going to resolve. Naming the record is what lets it decide between
   * waiting and asking for the blocker to be settled.
   */
  readonly pendingExecution: PendingExecution | null;
  /** Current loss-budget snapshot inputs (realised, open, pending). */
  readonly budget: PreviewBudgetSnapshot;
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

/** A validated preview — the intent cleared all 14 items. */
export interface TradingPreview {
  readonly intent: TradingOrderIntent;
  /** The USD risk this execution must reserve before signing. */
  readonly reservedRiskUsd: number;
}

/**
 * The loss-budget snapshot the checklist inspects: `LossBudgetInput`, plus
 * the resting-entry notional `TradingBudgetReader` sums alongside it.
 *
 * The extra field is optional so a context assembled without the reader (an
 * older caller, a test fixture) still typechecks — absent means no resting
 * entries, which keeps the arithmetic identical to what it was.
 */
export type PreviewBudgetSnapshot = Parameters<typeof evaluateLossBudget>[0] & {
  /**
   * Notional (`size * limit_price`) of the mission's accepted, unfilled
   * resting entries. Two patient entries resting at once both fill into real
   * gross exposure, so the leverage and gross-notional caps count them; the
   * loss-budget item does not need them (reservations already aggregate).
   */
  readonly pendingEntryNotionalUsd?: number | undefined;
};

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

// --- the 14 checks, in spec order -----------------------------------------

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

const harnessRunOwnsLease: Check = (_intent, ctx) =>
  ctx.activeHarnessRunId !== null && ctx.activeHarnessRunId === ctx.requestingHarnessRunId
    ? Effect.void
    : reject(
        "harness_run_owns_lease",
        ctx.activeHarnessRunId === null
          ? "no harness run currently owns the decision lease"
          : `request run ${ctx.requestingHarnessRunId} does not own the lease held by ${ctx.activeHarnessRunId}`,
      );

/**
 * The mission's open position in this market, from the reconciled budget
 * snapshot. Its `direction` and `size` are what tell a scale-in apart from a
 * reversal.
 */
const openPositionOf = (ctx: PreviewContext) => ctx.budget.openPositions.find((p) => p.size > 0);

/**
 * §16.3 item 6, plus the three authority flags that govern position management.
 *
 * The direction the authority allows is only half of it. `allowScaleIn`,
 * `allowPartialReduction`, and `allowDirectionReversal` are published fields on
 * `TradingAuthority` that nothing read until now, so an authority that said
 * "no reversals" — the POC default — did not actually prevent one.
 *
 * A reversal is specifically a position-INCREASING action whose direction
 * opposes the open position. A reduce or a close in the opposite direction is
 * how you exit, not a reversal, and reduce-only orders cannot flip a position
 * anyway.
 */
const directionPermitted: Check = (intent, ctx) => {
  const authority = ctx.mission.authority;
  const wants = intent.side === "buy" ? "long" : "short";
  if (!authority.allowedDirections.includes(wants as never)) {
    return reject("direction_permitted", `authority does not permit ${wants}`);
  }

  const open = openPositionOf(ctx);
  const increasing = isPositionIncreasing(intent.actionType);

  if (increasing && open !== undefined && open.direction !== wants) {
    return authority.allowDirectionReversal
      ? Effect.void
      : reject(
          "direction_permitted",
          `authority does not permit reversing an open ${open.direction} into a ${wants}`,
        );
  }

  if (intent.actionType === "scale_in" && !authority.allowScaleIn) {
    return reject("direction_permitted", "authority does not permit scaling in");
  }

  // A partial reduction is a reduce that leaves something behind. A full close
  // is always permitted — refusing the exit is never the safe answer.
  if (intent.actionType === "reduce" && !authority.allowPartialReduction) {
    const leavesRemainder = open !== undefined && intent.size < open.size;
    if (leavesRemainder) {
      return reject("direction_permitted", "authority does not permit partial reduction");
    }
  }

  return Effect.void;
};

// The checklist-item key predates the BTC mandate and is kept for spec/log
// continuity: the check is "the intent trades the mission's mandated market".
// Exit-only since plan-29 §3.3 — the entry list stopped policing the market,
// but an exit still has to land in the mandated one.
const marketIsEth: Check = (intent, ctx) =>
  intent.market === ctx.mission.market
    ? Effect.void
    : reject(
        "market_is_eth",
        `mission is mandated to ${ctx.mission.market} only; got ${intent.market}`,
      );

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
 * Existing gross notional the aggregate caps measure against: open-position
 * notional from the budget snapshot, PLUS the notional of accepted, unfilled
 * resting entries. A scale-in onto an existing position must clear the
 * leverage and gross-notional ceilings against `existing + proposed`, not the
 * proposed order alone — and so must a second patient entry resting beside a
 * first: both fill, and the aggregate is what they become together.
 */
const existingNotional = (ctx: PreviewContext): number =>
  ctx.budget.openPositions.reduce((sum, p) => sum + p.size * (p.weightedEntryPrice ?? 0), 0) +
  (ctx.budget.pendingEntryNotionalUsd ?? 0);

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

/**
 * Eq 4 — everything this intent puts at risk, not only what its stop loses.
 *
 * `reservedRisk = plannedLossAtStop + entryFee + exitFee + slippageReserve`.
 * The same number the execution service reserves before signing, and therefore
 * the same number item 15 has to test the budget against: measuring the gate
 * against the planned loss alone admitted intents whose reservation the budget
 * could not actually cover, and the shortfall was exactly the round-trip cost —
 * the one component of risk that is certain rather than conditional.
 */
const proposedReservationUsd = (intent: TradingOrderIntent, ctx: PreviewContext): number => {
  const notional = intent.size * intent.limitPrice;
  const rate = bps(ctx.takerFeeRateBps);
  return plannedLossOf(intent) + notional * rate * 2 + notional * bps(ctx.stopSlippageReserveBps);
};

const reservationsPlusProposedWithinBudget: Check = (intent, ctx) => {
  const budget = evaluateLossBudget(ctx.budget);
  if (budget.exhausted && !isPermittedUnderExhaustion(intent.actionType)) {
    return reject(
      "reservations_plus_proposed_within_budget",
      "budget exhausted; action not permitted under §16.4",
    );
  }
  const proposed = proposedReservationUsd(intent, ctx);
  const afterProposed = budget.remainingCumulativeLossUsd - proposed;
  return afterProposed >= 0
    ? Effect.void
    : reject(
        "reservations_plus_proposed_within_budget",
        `proposed reservation $${proposed.toFixed(2)} (stop loss $${plannedLossOf(intent).toFixed(2)} ` +
          `+ round-trip cost) exceeds the $${budget.remainingCumulativeLossUsd.toFixed(2)} remaining`,
      );
};

const noConflictingExecution: Check = (_intent, ctx) => {
  const blocking = ctx.pendingExecution;
  if (blocking === null) return Effect.void;
  return reject(
    "no_conflicting_execution_pending",
    `execution ${blocking.cloid} (${blocking.actionType}, ${blocking.status}) has been ` +
      `in flight for ${Math.round(blocking.ageMillis / 1000)}s`,
  );
};

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
const ENTRY_CHECKS: ReadonlyArray<{ item: PreviewChecklistItem; run: Check }> = [
  { item: "mission_active", run: isActive },
  { item: "entries_allowed", run: entriesAllowed },
  { item: "harness_run_owns_lease", run: harnessRunOwnsLease },
  { item: "direction_permitted", run: directionPermitted },
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

// --- the exit checklist ----------------------------------------------------
//
// §16.3 is the position-INCREASE checklist, and running it over an exit is what
// made exits unreachable exactly when they mattered most: `entries_allowed`
// refused a close on a mission whose entries the operator had just switched
// off; `mission_active` refused one on a mission `blocked` for cumulative loss;
// `direction_permitted` refused the sell that closes a long under a long-only
// authority; `exchange_minimum_met` refused a dust position that is precisely
// the position you cannot leave sitting there; and the budget item refused the
// action that STOPS the bleeding because the bleeding had used the budget up.
//
// None of those rules is wrong about entries. They are simply about entries.
// The exit list below keeps every check that is about whether this exit can be
// executed correctly, and drops every check that is about whether more exposure
// should be permitted.
//
// Plan-29 §3.3 applied the same reasoning a second time, to the entry list
// itself: `strategy_version_current`, `authority_version_current` and the
// entry half of `market_is_eth` were permission and discipline ceremony — was
// the model obeying its own bookkeeping? — not questions about whether the
// order itself is correct. Every check about the order — size, leverage, loss,
// wallet, freshness, concurrency, the stop — is exactly where it was.

/**
 * A mission that can still act on the exchange.
 *
 * Wider than item 1 on purpose: `blocked` and `paused` are the states an exit
 * is most needed in, and a mission whose loss budget is exhausted still holds a
 * position someone has to be able to flatten. Only the terminal statuses — the
 * mission is over, the authority is gone — refuse.
 */
const EXIT_REFUSING_STATUSES: ReadonlySet<string> = new Set(["revoked", "completed"]);

const missionCanExit: Check = (_intent, ctx) =>
  EXIT_REFUSING_STATUSES.has(ctx.mission.status)
    ? reject("mission_active", `mission is ${ctx.mission.status}; there is nothing left to exit`)
    : Effect.void;

/**
 * Something to reduce, and enough of it.
 *
 * The size on the intent is already the canonical exposure clamped by the
 * guard, so this is not a second opinion about how much to sell — it is the
 * one case the guard cannot express as a size: there is no position at all.
 */
const positionExists: Check = (intent, ctx) => {
  const open = ctx.budget.openPositions.find((position) => position.size > 0);
  if (open === undefined) {
    return reject("position_exists", `no open ${intent.market} position to ${intent.actionType}`);
  }
  return Effect.void;
};

/**
 * Size and price, without the exchange minimum.
 *
 * A position below `MIN_NOTIONAL_USD` is dust, and dust is where the minimum
 * inverts: applied to an exit it refuses the only action that removes the
 * position. Hyperliquid accepts a reduce-only order under the minimum for
 * exactly this reason, so the exit path asks the smaller question — is there a
 * positive size and a positive price to send.
 */
const exitSizeAndPriceValid: Check = sizeAndPriceValid;

/**
 * The one authority flag an exit still answers to.
 *
 * `allowPartialReduction: false` is not a restriction on exiting — a full close
 * clears it — it is the user saying "all or nothing". Keeping it here is what
 * lets everything else about `direction_permitted` be dropped: the allowed
 * direction, the reversal rule and the scale-in rule are all about opening, and
 * the sell that closes a long is not a short.
 */
const partialReductionPermitted: Check = (intent, ctx) => {
  if (intent.actionType !== "reduce" || ctx.mission.authority.allowPartialReduction) {
    return Effect.void;
  }
  const open = openPositionOf(ctx);
  return open !== undefined && intent.size < open.size
    ? reject("direction_permitted", "authority does not permit partial reduction")
    : Effect.void;
};

const EXIT_CHECKS: ReadonlyArray<{ item: PreviewChecklistItem; run: Check }> = [
  { item: "mission_active", run: missionCanExit },
  { item: "harness_run_owns_lease", run: harnessRunOwnsLease },
  { item: "market_is_eth", run: marketIsEth },
  { item: "execution_wallet_approved", run: executionWalletApproved },
  { item: "account_and_bbo_fresh", run: accountAndBboFresh },
  { item: "position_exists", run: positionExists },
  { item: "direction_permitted", run: partialReductionPermitted },
  { item: "size_and_price_valid", run: exitSizeAndPriceValid },
  { item: "no_conflicting_execution_pending", run: noConflictingExecution },
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

/**
 * Pure preview — the checklist this intent's action type actually calls for.
 *
 * An increase runs the 14 §16.3 items in their listed order. An exit runs the
 * nine that are about executing it correctly; see `EXIT_CHECKS` for why the
 * rest do not apply to something that removes exposure.
 */
export const previewOrder = (
  intent: TradingOrderIntent,
  ctx: PreviewContext,
): Effect.Effect<TradingPreview, TradingPreviewRejection> =>
  Effect.gen(function* () {
    const increasing = isPositionIncreasing(intent.actionType);
    for (const { run } of increasing ? ENTRY_CHECKS : EXIT_CHECKS) {
      yield* run(intent, ctx);
    }
    // Eq 4: reservedRisk = plannedLossAtStop + entryFee + exitFee + slippageReserve.
    // Both the entry and the stop-out exit pay the taker rate; the slippage
    // reserve is the authority's bps on the protected notional. The execution
    // service persists this reservation before signing (§16.3: "reserve before
    // signing"). An exit plans no loss, so its reservation is the round trip it
    // still pays — real money, and the only part of Eq 4 that applies to it.
    const reservedRiskUsd = proposedReservationUsd(intent, ctx);
    return { intent, reservedRiskUsd } as TradingPreview;
  }).pipe(
    // A refused intent is a normal outcome, but it is also the most common
    // reason an operator watching the chat sees nothing happen. The failing
    // item and its detail are what turn "the agent tried and stopped" into a
    // sentence, so they are logged once, here, where every refusal passes.
    Effect.tapError((rejection) =>
      Effect.logInfo("trading preview rejected", {
        missionId: intent.missionId,
        actionType: intent.actionType,
        executionSequence: intent.executionSequence,
        item: rejection.item,
        detail: rejection.detail,
      }),
    ),
  );

export const TradingPreviewServiceLive = Layer.effect(
  TradingPreviewService,
  Effect.succeed(TradingPreviewService.of({ preview: previewOrder })),
);
