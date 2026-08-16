/**
 * TradingWorkingOrderService — plan 29 step 2.4, the order working loop.
 *
 * A patient entry is a post-only ALO the wake placed at the near side, and a
 * post-only order only fills when the market comes to it. Unowned, it does one
 * of two bad things: rests at a price the market has moved away from until the
 * wake's approval is stale, or fills exactly when the market runs through it —
 * the adverse-selection failure the plan's risk note names. This service is
 * the owner. On every watchdog pass it gives a resting unfilled entry one of
 * four answers:
 *
 *   - nothing, while it is young and still at the near side;
 *   - a re-price: cancel and re-place at the CURRENT near side, still post-only,
 *     same size, same side, same stop;
 *   - a cross, once the stated max wait is up: cancel and take the urgency-
 *     "now" path (a marketable IOC) — the moment the wake already approved;
 *   - an abandon, when none of those is possible: the order left the book, the
 *     mission stopped wanting new exposure, or the replacement failed. What
 *     rests is cancelled and the model is told in one line.
 *
 * The exit lane (the audited risk fix this half adds): a model-initiated
 * `patient` exit — a `close`/`reduce` the exit tool rested as a reduce-only
 * ALO — had the mirror problem with no owner at all: no re-price, no cross
 * after a wait, no withdrawal, bounded only by the resting stop. The same
 * pass now owns it with the semantics inverted, because exits are about
 * LEAVING:
 *
 *   - a position is what an exit NEEDS — position gone means it filled (the
 *     fill channel reports that) or it should be withdrawn;
 *   - a suspended mission keeps working its exit: an exit resting is exposure
 *     coming off, and withdrawing it would put exposure back on. Only the
 *     terminal statuses withdraw (the reactor's retirement path owns that);
 *   - a plan revision does not retract an exit. The publish aftermath
 *     retracts resting ENTRIES; an exit is the model's deliberate choice to
 *     leave patiently (the same reasoning that made the take-profit loop
 *     preserve these orders, commit 580c788b6), and the model has the cancel
 *     tool when it changes its mind.
 *
 * The take-profit loop must not be double-managed from here, and is not: see
 * `readNewestAcceptedExit` for how the two lanes of resting reduce-only ALOs
 * are told apart.
 *
 * It is a stateless reconcile in the same sense `TradingProtectionService` is:
 * state is read from canonical exchange state (position + open orders via the
 * master wallet) and from the execution records the submit path already
 * writes. No new tables, no loop-local memory, no migration. Age comes from
 * the records' own timestamps, so a server restart cannot reset a wait.
 *
 * The ordering rule is the stop reconcile's mirror image, and the difference
 * is load-bearing. Overlapping reduce-only STOPS are harmless (they cannot
 * open exposure), so the stop path places the replacement first and cancels
 * the stale one after. Overlapping ENTRIES are double exposure, so this
 * service cancels first, confirms the cancel from canonical state, and only
 * then places. The gap in between holds no position — the entry was unfilled —
 * so the one invariant that must never break ("the moment of fill must never
 * find itself without its stop child") is kept by never placing an entry
 * without its grouped reduce-only stop child beside it. The exit lane keeps
 * the same cancel-first-then-place ordering even though two resting
 * reduce-only exits are only queue contention, never double exposure: keeping
 * records and book one-to-one is what the lineage walk assumes, and the
 * transient co-existence of the exit with the resting stop or the plan's
 * take-profit is tolerated for the same reason the stop reconcile tolerates
 * it — reduce-only orders cannot open exposure.
 *
 * Cancelling a grouped entry parent takes its linked stop child with it (the
 * `normalTpsl` semantics §17.1 documents and §17.3 relies on), which is why
 * every replacement re-places the pair together rather than only the parent.
 * A reduce-only exit carries no stop child — there is nothing to protect
 * against an order that only ever shrinks the position.
 *
 * Exhaustion is not re-evaluated here: §16.4's block already cancels every
 * mission-owned increasing order the moment the budget exhausts, and this
 * loop's vanish branch is what reports the loss of the entry afterwards.
 *
 * Hyperliquid's Chase order type is deliberately not used: it is a browser-tab
 * feature capped at five active orders and is not reachable server-side.
 *
 * @module TradingWorkingOrderService
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import type { TradingOrderIntent, TradingStopInfo } from "@t3tools/trading-contracts/execution";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";
import {
  isPositionIncreasing,
  PROTECTION_RECONCILIATION,
  samePrice,
} from "@t3tools/trading-contracts/protection";
import { ENTRY_PRICING_VALIDITY_MILLIS } from "@t3tools/trading-contracts/entry";
import type { TradingMissionStatus } from "@t3tools/trading-contracts";

import { PERMANENT_TERMINAL_STATUSES, SUSPENDED_STATUSES } from "./MissionTransitions.ts";
import {
  HyperliquidExecutionService,
  TradingExecutionError,
} from "./HyperliquidExecutionService.ts";
import { allocateExecutionSequence } from "./TradingExecutionSequence.ts";

/** The working loop could not complete a pass. */
export class TradingWorkingOrderError extends Schema.TaggedErrorClass<TradingWorkingOrderError>()(
  "TradingWorkingOrderError",
  {
    reason: Schema.Literals(["canonical_read_failed", "book_read_failed", "sequence_alloc_failed"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingWorkingOrderError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** What a pass can fail with: its own refusals, or the exchange's. */
export type WorkingOrderFailure = TradingWorkingOrderError | TradingExecutionError;

/**
 * How long a working entry rests at one price before it is re-priced to the
 * current near side.
 *
 * Policy-shaped knob: a plan may state its own cadence (plan 29 phase 4).
 * Three guard passes (the watchdog runs every 5s) is the same order of
 * magnitude as the protection poll without churning the book every pass —
 * each re-price costs a cancel and a placement, and an entry already at the
 * near side is never re-priced at all.
 */
export const WORKING_ORDER_REPRICE_CADENCE_MILLIS = 15_000;

/**
 * How long a working entry may rest in total before the loop crosses.
 *
 * Policy-shaped knob: a plan may state its own wait (plan 29 phase 4). The
 * default is deliberately the entry pricing validity — the wake's approval was
 * priced against a book that lives 90 seconds, so beyond that the approval's
 * market context is dead and the choice is cross (take the liquidity the
 * wake's urgency-"now" fallback implied) or abandon. Crossing first matches the
 * moment the wake approved; abandoning is what a failed cross falls back to.
 */
export const WORKING_ORDER_MAX_WAIT_MILLIS = ENTRY_PRICING_VALIDITY_MILLIS;

/** What one pass needs to know about the mission whose entry it works. */
export interface WorkingOrderInput {
  readonly missionId: string;
  /** The master-wallet address (§10.6) — canonical reads use it. */
  readonly masterAddress: string;
  readonly market: string;
  /**
   * The mission's current status. The loop's own policy reads it: a suspended
   * or terminal mission must not keep working a new entry, and an execution in
   * progress owns the book for the duration of its turn.
   */
  readonly missionStatus: TradingMissionStatus;
  /**
   * The current plan's publication time and whether it stood aside, when a
   * plan exists. The backstop half of plan 29's audited risk fix: a resting
   * patient entry is retracted when the plan stood aside or was revised after
   * the entry was accepted — the publish aftermath cancels it directly, and
   * this catches whatever that path missed. The exit lane deliberately does
   * NOT read this: retracting an exit would put exposure back on, and the
   * model has the cancel tool for changing its mind about leaving.
   */
  readonly plan?: {
    readonly publishedAt: number;
    readonly standAside: boolean;
  } | null;
  /** The pass decides ages against this, never the wall clock. */
  readonly nowMs: number;
  /** Allowed slippage for the crossing IOC — the same config the wake uses. */
  readonly allowedSlippageBps: number;
}

/** How one pass ended. */
export type WorkingOrderOutcomeStatus =
  /** No resting post-only order is owed anything. Nothing was done. */
  | "no_working_order"
  /** An order rests and is young enough, or its turn owns the book. */
  | "resting"
  /** The order was cancelled and re-placed at the current near side. */
  | "repriced"
  /** The max wait was reached; the order crossed via a marketable IOC. */
  | "crossed"
  /** Terminal: the order was withdrawn and the model must be told. */
  | "abandoned"
  /** A position exists — the stop machinery owns the world now. */
  | "position_open"
  /** The pass could not act; nothing was cancelled. The next pass retries. */
  | "failed";

/** The result of one working-order pass. */
export interface WorkingOrderOutcome {
  readonly status: WorkingOrderOutcomeStatus;
  /**
   * The intent this pass placed, when it placed one. A cross hands this back
   * so the caller can run the same post-fill protection reconciliation the
   * wake's own execution path runs. The entry lane only: an exit cross
   * removes exposure and needs no post-fill protection, so the exit lane's
   * crosses deliberately leave this undefined.
   */
  readonly placedIntent?: TradingOrderIntent | undefined;
  /** Cloids this pass cancelled. */
  readonly cancelledCloids: ReadonlyArray<string>;
  /** The cloid of the record the decision was about, when there was one. */
  readonly cloid?: string | undefined;
  /** One plain-language line for the harness, on terminal outcomes. */
  readonly summary?: string | undefined;
  /** Why the pass failed or abandoned, when it did. */
  readonly detail?: string | undefined;
  /** How long the entry had been waiting, when a working order existed. */
  readonly waitMillis?: number | undefined;
  /** How many times the lineage had been re-priced before this pass. */
  readonly repriceCount?: number | undefined;
}

/**
 * How much of the mission's resting book a direct withdrawal takes.
 *
 * `all` is a mission ending: nothing it owns may outlive it, so entries,
 * patient exits and the plan's resting take-profit all go. `entries` is a
 * plan revision: the model changed its mind about getting IN, which says
 * nothing about the exit it asked for or the target the plan is still
 * declaring — cancelling those would undo a decision nobody revised and would
 * fight the take-profit reconcile that runs on the same publish.
 */
export type AbandonScope = "all" | "entries";

/** What the direct-withdraw path needs. */
export interface AbandonInput {
  readonly missionId: string;
  readonly masterAddress: string;
  readonly market: string;
  readonly nowMs: number;
  /** Defaults to `all` — the mission-ended case this path was written for. */
  readonly scope?: AbandonScope | undefined;
}

/** The result of a direct withdrawal. */
export interface AbandonOutcome {
  /** True when a resting order in scope was found. */
  readonly found: boolean;
  readonly cancelledCloids: ReadonlyArray<string>;
  readonly cloid?: string | undefined;
}

/**
 * The working-order service. `reconcile` is the watchdog's per-pass entry
 * point — it owns both lanes, the resting patient entry and the resting
 * patient exit; `abandon` is the direct withdrawal the reactor calls when a
 * mission ends with a resting order still on its book. Reasons for a
 * withdrawal live with the caller — it knows why the mission ended; this
 * service knows how to cancel.
 */
export class TradingWorkingOrderService extends Context.Service<
  TradingWorkingOrderService,
  {
    readonly reconcile: (
      input: WorkingOrderInput,
    ) => Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure>;

    readonly abandon: (input: AbandonInput) => Effect.Effect<AbandonOutcome, WorkingOrderFailure>;
  }
>()("t3/trading/TradingWorkingOrderService") {}

/** A canonical read of the position and everything resting against it. */
interface CanonicalView {
  readonly positionSize: number;
  readonly openOrders: ReadonlyArray<AgentOpenOrder>;
}

/**
 * The execution-record columns the loop reads. The entry queries filter on a
 * non-null stop; the exit queries read records that carry none — `stop_price`
 * is nullable because a reduce-only exit never has one, and each lane treats
 * it accordingly. `market`, `side` and `action_type` are read back from
 * columns the submit path wrote from a `TradingOrderIntent`, which is the
 * only writer.
 */
interface WorkingRecordRow {
  readonly execution_id: string;
  readonly mission_id: string;
  readonly execution_sequence: number;
  readonly action_type: string;
  readonly cloid: string;
  readonly market: string;
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly stop_price: number | null;
  readonly planned_loss_at_stop_usd: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** The lineage of one working entry: the original approval and its re-prices. */
interface WorkingLineage {
  /** The newest accepted record — the one whose order should be resting. */
  readonly resting: WorkingRecordRow;
  /** The record the wake originally approved; the wait is measured from it. */
  readonly original: WorkingRecordRow;
  /** Re-prices the lineage had before this pass. */
  readonly repriceCount: number;
}

/** Sizes below this are rounding, not exposure (see PROTECTION_SIZE_EPSILON). */
const SIZE_EPSILON = 1e-9;

/**
 * The envelope facts that make a replacement the same trade the wake approved.
 * Everything else — limit price, time in force — is exactly what this loop owns.
 * The stop is entry-lane only: an exit carries none, and `stopPrice` is
 * undefined exactly when the record it came from had no stop.
 */
interface Envelope {
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly stopPrice?: number | undefined;
}

/**
 * Why a replacement intent does not match the approval it claims to extend.
 * Null means it matches; a string is the refusal the outcome reports.
 */
const envelopeDefect = (approved: Envelope, candidate: Envelope): string | null => {
  if (candidate.side !== approved.side) {
    return `side ${candidate.side} does not match the approved ${approved.side}`;
  }
  if (Math.abs(candidate.size - approved.size) > SIZE_EPSILON) {
    return `size ${candidate.size} does not match the approved ${approved.size}`;
  }
  // Entries must keep the approved stop; exits must keep having none. A
  // candidate that swaps one for the other is a mutated envelope, whichever
  // lane it arrived on.
  if (approved.stopPrice === undefined || candidate.stopPrice === undefined) {
    if (approved.stopPrice !== candidate.stopPrice) {
      return "one envelope carries a stop and the other does not";
    }
    return null;
  }
  if (!samePrice(candidate.stopPrice, approved.stopPrice)) {
    return `stop ${candidate.stopPrice} does not match the approved ${approved.stopPrice}`;
  }
  return null;
};

/**
 * The three facts every outcome carries: which order, how long it has been
 * working, and how many times it has been re-priced. The wait is measured
 * from the ORIGINAL record, so a re-price does not reset the cross horizon.
 */
const outcomeFacts = (
  nowMs: number,
  lineage: WorkingLineage,
): {
  readonly cloid: string;
  readonly waitMillis: number;
  readonly repriceCount: number;
} => ({
  cloid: lineage.resting.cloid,
  waitMillis: nowMs - lineage.original.created_at,
  repriceCount: lineage.repriceCount,
});

/** The envelope half of the hard constraint every placement asserts. */
const envelopeOf = (record: WorkingRecordRow): Envelope => ({
  side: record.side,
  size: record.size,
  stopPrice: record.stop_price ?? undefined,
});

export const makeTradingWorkingOrderService = Effect.gen(function* () {
  const execution = yield* HyperliquidExecutionService;
  const gateway = yield* HyperliquidGateway;
  // Captured at layer build rather than demanded per call, so the service's
  // methods carry no SQL requirement — the same shape the control service
  // takes. The working loop is invoked from the watchdog pass, which must not
  // have to thread a database handle into every call site.
  const sql = yield* SqlClient.SqlClient;

  const readCanonical = (input: {
    readonly masterAddress: string;
    readonly market: string;
  }): Effect.Effect<CanonicalView, TradingWorkingOrderError> =>
    Effect.gen(function* () {
      const mapError = (cause: unknown) =>
        new TradingWorkingOrderError({
          reason: "canonical_read_failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      const snapshot = yield* gateway
        .getAccountSnapshot(input.masterAddress as `0x${string}`)
        .pipe(Effect.mapError(mapError));
      const openOrders = yield* gateway
        .getOpenOrders(input.masterAddress as `0x${string}`)
        .pipe(Effect.mapError(mapError));
      const position = snapshot.positions.find((p) => p.market === input.market);
      return { positionSize: position === undefined ? 0 : position.size, openOrders };
    });

  /**
   * Poll canonical state until `accept` says so or the confirmation window
   * runs out, returning the last view either way. Same window and cadence the
   * protection reconcile confirms inside: an order takes a moment to appear or
   * disappear, and "not visible yet" is not "not there".
   */
  const confirmWithin = (
    accept: (view: CanonicalView) => boolean,
    reread: () => Effect.Effect<CanonicalView, TradingWorkingOrderError>,
  ): Effect.Effect<CanonicalView, TradingWorkingOrderError> =>
    Effect.gen(function* () {
      let current = yield* reread();
      const polls = Math.max(
        1,
        Math.floor(
          PROTECTION_RECONCILIATION.windowMillis / PROTECTION_RECONCILIATION.confirmPollMillis,
        ),
      );
      for (let poll = 1; poll < polls && !accept(current); poll++) {
        yield* Effect.sleep(`${PROTECTION_RECONCILIATION.confirmPollMillis} millis`);
        current = yield* reread();
      }
      return current;
    });

  /** True when one resting order is this mission's working entry. */
  const isWorkingEntryOrder = (
    order: AgentOpenOrder,
    market: string,
    side: "buy" | "sell",
  ): boolean =>
    order.market === market &&
    order.side === side &&
    !order.reduceOnly &&
    !order.isTrigger &&
    order.remainingSize > SIZE_EPSILON;

  /**
   * True when one resting order is this mission's working exit. The mirror
   * of `isWorkingEntryOrder`: reduce-only is the exit's shape, and matching
   * is by cloid on top of it so the resting stop (a trigger) and the plan's
   * take-profit (a different cloid) are never mistaken for the exit.
   */
  const isWorkingExitOrder = (
    order: AgentOpenOrder,
    market: string,
    side: "buy" | "sell",
  ): boolean =>
    order.market === market &&
    order.side === side &&
    order.reduceOnly &&
    !order.isTrigger &&
    order.remainingSize > SIZE_EPSILON;

  /** Best-effort cancels; a failed one is retried by the next pass. */
  const cancelBestEffort = (
    market: string,
    cloids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const cancelled: string[] = [];
      for (const cloid of cloids) {
        yield* execution.submitCancel({ market, cloid }).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.sync(() => cancelled.push(cloid)),
            onFailure: (cause) =>
              Effect.logWarning(
                "working order: could not cancel a resting order; the next pass " +
                  `retries (cloid=${cloid}): ${cause.message}`,
              ),
          }),
        );
      }
      return cancelled;
    });

  /**
   * Cancel one cloid and confirm from canonical state that it is gone.
   *
   * A placement against a cancel that never landed would rest TWO entries —
   * the double exposure this loop exists to prevent — so the cancel is proven
   * before anything is placed. A cancel that will not confirm inside the
   * window fails the pass; nothing else moved, so the next pass retries.
   */
  const cancelAndConfirmGone = (
    input: { readonly market: string; readonly cloid: string },
    reread: () => Effect.Effect<CanonicalView, TradingWorkingOrderError>,
  ): Effect.Effect<boolean, WorkingOrderFailure> =>
    Effect.gen(function* () {
      yield* execution.submitCancel({ market: input.market, cloid: input.cloid });
      const view = yield* confirmWithin(
        (v) => !v.openOrders.some((o) => o.cloid === input.cloid),
        reread,
      );
      return !view.openOrders.some((o) => o.cloid === input.cloid);
    });

  /** A fresh execution sequence, or a refusal that fails the pass. */
  const freshSequence = (missionId: string) =>
    allocateExecutionSequence(sql, missionId).pipe(
      Effect.mapError(
        (cause) =>
          new TradingWorkingOrderError({
            reason: "sequence_alloc_failed",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

  /** The newest accepted post-only entry record, or null when none rests. */
  const readNewestAcceptedEntry = (input: {
    readonly missionId: string;
    readonly market: string;
  }): Effect.Effect<WorkingRecordRow | null> =>
    Effect.gen(function* () {
      // An entry record without a stop is not this loop's to work: the
      // mandatory-stop gate owns that defect, and re-placing it preview-free
      // would launder it into a fresh approval.
      const rows = yield* sql<WorkingRecordRow>`
        SELECT execution_id, mission_id, execution_sequence,
               action_type, cloid, market, side, size, stop_price,
               planned_loss_at_stop_usd, created_at, updated_at
        FROM trading_execution_records
        WHERE mission_id = ${input.missionId}
          AND market = ${input.market}
          AND time_in_force = 'alo'
          AND reduce_only = 0
          AND status = 'accepted'
          AND stop_price IS NOT NULL
        ORDER BY created_at DESC, execution_sequence DESC
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as WorkingRecordRow[]));
      const row = rows[0];
      if (row === undefined) return null;
      if (!isPositionIncreasing(row.action_type)) return null;
      return row;
    });

  /**
   * The action types the exit tool writes for an order it places: `close`,
   * and `reduce` (a reduce promoted past the dust threshold is recorded as
   * the close it becomes — see `TradingExitService`).
   */
  const EXIT_ACTION_TYPES = ["close", "reduce"] as const;

  /**
   * The newest accepted resting patient EXIT, or null when none rests.
   *
   * Telling this lane's records from the take-profit's is the whole
   * double-management risk, and the discrimination is by action type:
   *
   *  - the exit tool records exactly `close` or `reduce` through the full
   *    preview → submit path, so those two action types ARE the
   *    model-initiated exits;
   *  - the take-profit's resting reduce-only ALOs are placed through
   *    `submitReduceOnlyAlo`, which never writes an execution record — its
   *    cloid embeds `take_profit_<price>` but that exists only in the
   *    exchange's order list, not in this table — so they cannot reach this
   *    reader at all;
   *  - the `IN ('close','reduce')` filter is the belt for the day that
   *    changes: a `take_profit_<price>`-shaped record can never be picked up
   *    as a patient exit. The take-profit reconcile owns its own orders and
   *    explicitly preserves ours (its `preserveCloids`, commit 580c788b6);
   *    this lane returns the courtesy by scope rather than by cloid list.
   */
  const readNewestAcceptedExit = (input: {
    readonly missionId: string;
    readonly market: string;
  }): Effect.Effect<WorkingRecordRow | null> =>
    Effect.gen(function* () {
      // `size` is matched with exact floating-point equality, which is safe
      // only because every replacement copies `original.size` byte for byte
      // (see the reprice path below). The day anything rounds a replacement's
      // size the lineage breaks silently: the walk finds no ancestor, the wait
      // clock resets, and an order that has been working for a minute reads as
      // new.
      const rows = yield* sql<WorkingRecordRow>`
        SELECT execution_id, mission_id, execution_sequence,
               action_type, cloid, market, side, size, stop_price,
               planned_loss_at_stop_usd, created_at, updated_at
        FROM trading_execution_records
        WHERE mission_id = ${input.missionId}
          AND market = ${input.market}
          AND time_in_force = 'alo'
          AND reduce_only = 1
          AND status = 'accepted'
          AND ${sql.in("action_type", EXIT_ACTION_TYPES)}
        ORDER BY created_at DESC, execution_sequence DESC
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as WorkingRecordRow[]));
      return rows[0] ?? null;
    });

  /**
   * Read the working order's lineage from the execution records.
   *
   * The lineage is the chain of records that share the resting record's
   * envelope (action, side, size, stop) and touch in time: each member was
   * placed within one max-wait of the member after it. The walk stops at a
   * gap of a max-wait or more — earlier records belonged to an earlier cycle
   * that had already ended — and the status filter admits the attempts the
   * loop itself leaves behind (a rejected or failed placement) but never a
   * fill, which ends a cycle outright.
   *
   * The stop comparison is the null-safe `IS`: entries match their recorded
   * stop, exits match its absence, and neither can bleed into the other's
   * lineage.
   */
  const readLineage = (
    input: { readonly missionId: string; readonly market: string },
    resting: WorkingRecordRow,
  ): Effect.Effect<WorkingLineage> =>
    Effect.gen(function* () {
      // `size` is matched with exact floating-point equality, which is safe
      // only because every replacement copies `original.size` byte for byte
      // (see the reprice path below). The day anything rounds a replacement's
      // size the lineage breaks silently: the walk finds no ancestor, the wait
      // clock resets, and an order that has been working for a minute reads as
      // new.
      const rows = yield* sql<WorkingRecordRow>`
        SELECT execution_id, mission_id, execution_sequence,
               action_type, cloid, market, side, size, stop_price,
               planned_loss_at_stop_usd, created_at, updated_at
        FROM trading_execution_records
        WHERE mission_id = ${input.missionId}
          AND market = ${input.market}
          AND action_type = ${resting.action_type}
          AND time_in_force = 'alo'
          AND side = ${resting.side}
          AND size = ${resting.size}
          AND stop_price IS ${resting.stop_price}
          AND status IN ('accepted', 'cancelled', 'rejected', 'failed')
        ORDER BY created_at DESC, execution_sequence DESC
      `.pipe(Effect.orElseSucceed(() => [] as WorkingRecordRow[]));

      const startIndex = rows.findIndex((row) => row.execution_id === resting.execution_id);
      if (startIndex < 0) return { resting, original: resting, repriceCount: 0 };

      // Newest-first rows: walking the index upward walks back in time.
      const chain: WorkingRecordRow[] = [];
      for (let i = startIndex; i < rows.length; i++) {
        const row = rows[i]!;
        const connects =
          chain.length === 0 ||
          row.created_at >= chain[chain.length - 1]!.created_at - WORKING_ORDER_MAX_WAIT_MILLIS;
        if (!connects) break;
        chain.push(row);
      }
      if (chain.length === 0) return { resting, original: resting, repriceCount: 0 };
      return {
        resting,
        original: chain[chain.length - 1]!,
        repriceCount: Math.max(0, chain.length - 1),
      } satisfies WorkingLineage;
    });

  /** Whether any fill was ever recorded under one of these cloids. */
  const hasFillUnderAny = (
    missionId: string,
    cloids: ReadonlyArray<string>,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (cloids.length === 0) return false;
      const rows = yield* sql<{ readonly fill_id: string }>`
        SELECT fill_id FROM trading_fills
        WHERE mission_id = ${missionId} AND ${sql.in("cloid", cloids)}
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as Array<{ readonly fill_id: string }>));
      return rows.length > 0;
    });

  /**
   * The risk the approval reserved, carried over to a replacement rather than
   * recomputed: the same size at the same stop reserves the same loss, and a
   * recomputation would invite a fee estimate to resize an envelope nobody
   * re-approved. Falls back to the record's own planned loss when no
   * reservation row survives (a released reservation keeps its amount).
   */
  const carriedReservationUsd = (lineage: WorkingLineage): Effect.Effect<number> =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly reserved_risk_usd: number }>`
        SELECT reserved_risk_usd FROM trading_risk_reservations
        WHERE mission_id = ${lineage.resting.mission_id} AND cloid = ${lineage.resting.cloid}
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as Array<{ readonly reserved_risk_usd: number }>));
      const reserved = rows[0]?.reserved_risk_usd;
      if (reserved !== undefined) return reserved;
      return (
        lineage.resting.planned_loss_at_stop_usd ?? lineage.original.planned_loss_at_stop_usd ?? 0
      );
    });

  /**
   * Build a replacement intent for a lineage: the ORIGINAL approval's
   * envelope, a fresh execution sequence, and the order shape the caller
   * states. A fresh sequence is not optional — reusing the old one would
   * derive the old cloid and the old idempotency key, and the resubmission
   * guard would return the old record without submitting.
   *
   * `reduceOnly` selects the lane: false for entries (whose grouped stop
   * child is re-armed from the recorded stop), true for exits (whose records
   * carry no stop, so the intent carries none either).
   */
  const buildReplacementIntent = (
    lineage: WorkingLineage,
    input: { readonly limitPrice: number; readonly freshSequence: number },
    orderPreference: "post_only" | "marketable_ioc",
    reduceOnly: boolean,
  ): { readonly intent: TradingOrderIntent; readonly stop: TradingStopInfo | undefined } => {
    const original = lineage.original;
    const stop: TradingStopInfo | undefined =
      original.stop_price === null
        ? undefined
        : {
            stopPrice: original.stop_price,
            plannedLossAtStopUsd: original.planned_loss_at_stop_usd ?? 0,
          };
    const intent: TradingOrderIntent = {
      missionId: original.mission_id,
      executionSequence: input.freshSequence,
      // Read back from a column only the intent writer ever fills; the cast
      // re-narrows the SQL text to the literal it was written from.
      actionType: original.action_type as TradingOrderIntent["actionType"],
      market: original.market as TradingMarket,
      side: original.side,
      size: original.size,
      orderPreference,
      limitPrice: input.limitPrice,
      stop,
      reduceOnly,
    };
    return { intent, stop };
  };

  /**
   * Place a replacement through the constrained preview-free path, after
   * asserting the envelope. The assert is the hard constraint that stands in
   * for the §16.3 checklist this path cannot run: the intent may differ from
   * the approval in limit price and time in force ONLY. It is checked against
   * the ORIGINAL record (what the wake approved) and the RESTING record (what
   * the book claims to be working), so a mutated resting row cannot vouch
   * for itself.
   */
  const placeReplacement = (
    input: WorkingOrderInput,
    lineage: WorkingLineage,
    intent: TradingOrderIntent,
    stop: TradingStopInfo | undefined,
  ): Effect.Effect<
    | { readonly ok: true; readonly recordCloid: string }
    | { readonly ok: false; readonly detail: string },
    WorkingOrderFailure
  > =>
    Effect.gen(function* () {
      const candidate = { side: intent.side, size: intent.size, stopPrice: stop?.stopPrice };
      // Against the ORIGINAL (what the wake approved) and against the RESTING
      // record (what the book claims to be working): the second check is what
      // keeps a mutated resting row from vouching for itself.
      const defect =
        envelopeDefect(envelopeOf(lineage.original), candidate) ??
        envelopeDefect(envelopeOf(lineage.resting), candidate);
      if (defect !== null) {
        return { ok: false, detail: `refusing a mutated envelope: ${defect}` };
      }
      const reservedRiskUsd = yield* carriedReservationUsd(lineage);
      const record = yield* execution
        .submitWorkingEntry({
          intent,
          reservedRiskUsd,
          allowedSlippageBps: input.allowedSlippageBps,
        })
        .pipe(Effect.provideService(SqlClient.SqlClient, sql));
      return { ok: true, recordCloid: record.cloid };
    });

  const reconcile = (
    input: WorkingOrderInput,
  ): Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      // --- is there a working exit first? ------------------------------------
      //
      // The exit lane runs before the entry lane's `position_open` early
      // return: an exit needs a position, so a resting exit beside an open
      // position is exactly the state this lane exists to work, and the
      // entry lane would have returned without ever reaching it.
      const restingExit = yield* readNewestAcceptedExit(input);
      if (restingExit !== null) {
        return yield* reconcileExit(input, restingExit);
      }

      // --- is there a working entry at all? ----------------------------------
      //
      // Read first and read locally: on the common pass — no entry resting —
      // this is one SQL query and no exchange round-trip.
      const restingRecord = yield* readNewestAcceptedEntry(input);
      if (restingRecord === null) {
        return { status: "no_working_order", cancelledCloids: [] } satisfies WorkingOrderOutcome;
      }
      const lineage = yield* readLineage(input, restingRecord);
      const facts = outcomeFacts(input.nowMs, lineage);

      // --- a filled entry is no longer this loop's ---------------------------
      const reread = () => readCanonical(input);
      const view = yield* reread();
      if (Math.abs(view.positionSize) > SIZE_EPSILON) {
        return {
          status: "position_open",
          cancelledCloids: [],
          ...facts,
        } satisfies WorkingOrderOutcome;
      }

      const restingOrder = view.openOrders.find(
        (order) =>
          order.cloid === lineage.resting.cloid &&
          isWorkingEntryOrder(order, input.market, lineage.resting.side),
      );

      // --- the entry left the book without filling ---------------------------
      if (restingOrder === undefined) {
        if (
          yield* hasFillUnderAny(input.missionId, [lineage.resting.cloid, lineage.original.cloid])
        ) {
          // It filled and the position has since closed; the fill channel is
          // how the model hears about that, not this loop.
          return {
            status: "no_working_order",
            cancelledCloids: [],
            ...facts,
          } satisfies WorkingOrderOutcome;
        }
        // Nobody is working this entry anymore: cancelled by hand, expired, or
        // a replacement of ours that never confirmed. It is not resurrected —
        // the wake that wanted in must place a new entry against the market
        // it sees now. Nothing should rest; the cancel below is the belt for
        // a stop child the parent's removal may have orphaned.
        const cancelled = yield* cancelBestEffort(input.market, [lineage.resting.cloid]);
        return {
          status: "abandoned",
          cancelledCloids: cancelled,
          ...facts,
          summary:
            `patient entry abandoned: it left the book unfilled after ` +
            `${Math.round(facts.waitMillis / 1000)}s and was not replaced`,
        } satisfies WorkingOrderOutcome;
      }

      // --- the mission (and its plan) must still want the entry ---------------
      const suspendedOrTerminal =
        (SUSPENDED_STATUSES as readonly TradingMissionStatus[]).includes(input.missionStatus) ||
        (PERMANENT_TERMINAL_STATUSES as readonly TradingMissionStatus[]).includes(
          input.missionStatus,
        );
      const planRetractedIt =
        input.plan !== undefined &&
        input.plan !== null &&
        (input.plan.standAside || input.plan.publishedAt > lineage.resting.created_at);
      if (suspendedOrTerminal || planRetractedIt) {
        const cancelled = yield* cancelBestEffort(input.market, [lineage.resting.cloid]);
        return {
          status: "abandoned",
          cancelledCloids: cancelled,
          ...facts,
          ...(suspendedOrTerminal
            ? { summary: `patient entry withdrawn: the mission is ${input.missionStatus}` }
            : input.plan?.standAside === true
              ? {
                  summary:
                    "patient entry withdrawn: the plan stood aside — the model changed its mind",
                }
              : {
                  summary:
                    "patient entry withdrawn: the plan was revised after this entry was accepted",
                }),
        } satisfies WorkingOrderOutcome;
      }
      if (input.missionStatus === "executing" || input.missionStatus === "initializing") {
        // The wake's own turn owns the book while it runs.
        return { status: "resting", cancelledCloids: [], ...facts } satisfies WorkingOrderOutcome;
      }

      // --- the order on the book must be the approval -------------------------
      //
      // A size that no longer matches the record means the intent this loop
      // would re-place is not the intent the wake approved — and the
      // preview-free path has no checklist to catch it. Refuse and leave
      // everything as it rests; the wake that owns the mission decides.
      if (Math.abs(restingOrder.size - lineage.resting.size) > SIZE_EPSILON) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail:
            `the resting order's size ${restingOrder.size} does not match the ` +
            `approved ${lineage.resting.size}; refusing to work it`,
        } satisfies WorkingOrderOutcome;
      }

      // --- the wait is up: cross ----------------------------------------------
      if (facts.waitMillis >= WORKING_ORDER_MAX_WAIT_MILLIS) {
        return yield* crossWorkingEntry(input, lineage, restingOrder.limitPrice, reread);
      }

      // --- re-price on cadence -------------------------------------------------
      if (input.nowMs - lineage.resting.updated_at >= WORKING_ORDER_REPRICE_CADENCE_MILLIS) {
        return yield* repriceWorkingEntry(input, lineage, restingOrder, reread);
      }

      return { status: "resting", cancelledCloids: [], ...facts } satisfies WorkingOrderOutcome;
    });

  // --- the cross: cancel, then take the urgency-"now" path -------------------

  const crossWorkingEntry = (
    input: WorkingOrderInput,
    lineage: WorkingLineage,
    restingLimitPrice: number,
    reread: () => Effect.Effect<CanonicalView, TradingWorkingOrderError>,
  ): Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      const facts = outcomeFacts(input.nowMs, lineage);

      const gone = yield* cancelAndConfirmGone(
        { market: input.market, cloid: lineage.resting.cloid },
        reread,
      );
      if (!gone) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail: "the resting entry would not cancel; nothing was crossed",
        } satisfies WorkingOrderOutcome;
      }

      const sequence = yield* freshSequence(input.missionId);
      // The mapper derives a crossing limit from its own fresh book read for
      // `marketable_ioc`; the intent's price is the envelope-neutral resting
      // price, carried only because the intent shape requires one.
      const { intent, stop } = buildReplacementIntent(
        lineage,
        { limitPrice: restingLimitPrice, freshSequence: sequence },
        "marketable_ioc",
        false,
      );
      const placed = yield* placeReplacement(input, lineage, intent, stop);
      if (!placed.ok) {
        return {
          status: "failed",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          detail: placed.detail,
        } satisfies WorkingOrderOutcome;
      }

      // Confirm the cross from canonical state, never from the response: the
      // proof of a cross is a position. The grouped stop child went out with
      // the entry, but §17.1 says a submission proves nothing — the caller
      // runs the post-fill protection reconcile on the returned intent.
      const afterCross = yield* confirmWithin(
        (v) => Math.abs(v.positionSize) > SIZE_EPSILON,
        reread,
      );
      if (Math.abs(afterCross.positionSize) > SIZE_EPSILON) {
        return {
          status: "crossed",
          placedIntent: intent,
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          summary:
            `patient entry crossed after ${Math.round(facts.waitMillis / 1000)}s: ` +
            `${intent.side} ${intent.size} ${intent.market} at market ` +
            `(stop ${stop?.stopPrice} went out with it)`,
        } satisfies WorkingOrderOutcome;
      }

      // The cross did not fill — the mandatory-stop gate may have refused a
      // stop the market has run through, or the book had nothing to take.
      // Cancel whatever it left (an unfilled IOC should leave nothing) and
      // tell the model the entry is over.
      const leftovers = afterCross.openOrders
        .map((o) => o.cloid)
        .filter((c): c is string => c !== undefined && c === placed.recordCloid);
      const cancelled = yield* cancelBestEffort(input.market, leftovers);
      return {
        status: "abandoned",
        cancelledCloids: cancelled,
        ...facts,
        summary:
          `patient entry abandoned: the crossing order did not fill after the ` +
          `${WORKING_ORDER_MAX_WAIT_MILLIS / 1000}s wait`,
      } satisfies WorkingOrderOutcome;
    });

  // --- the re-price: cancel, then rest at the CURRENT near side --------------

  const repriceWorkingEntry = (
    input: WorkingOrderInput,
    lineage: WorkingLineage,
    restingOrder: AgentOpenOrder,
    reread: () => Effect.Effect<CanonicalView, TradingWorkingOrderError>,
  ): Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      const facts = outcomeFacts(input.nowMs, lineage);

      const book = yield* gateway.getOrderBook(input.market).pipe(
        Effect.mapError(
          (cause) =>
            new TradingWorkingOrderError({
              reason: "book_read_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const { bidPrice, askPrice } = book.bestBidOffer;
      const nearSide = lineage.resting.side === "buy" ? bidPrice : askPrice;
      if (nearSide === undefined) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail: `no ${lineage.resting.side === "buy" ? "bid" : "ask"} to re-price against`,
        } satisfies WorkingOrderOutcome;
      }

      // Already at the near side: re-placing would be churn, not ownership.
      // The entry keeps resting; the max wait is what ends it.
      if (samePrice(nearSide, restingOrder.limitPrice)) {
        return { status: "resting", cancelledCloids: [], ...facts } satisfies WorkingOrderOutcome;
      }

      // Cancel first, confirm, then place — two resting entries are double
      // exposure, exactly what the stop reconcile's opposite ordering
      // tolerates and this one must not.
      const gone = yield* cancelAndConfirmGone(
        { market: input.market, cloid: lineage.resting.cloid },
        reread,
      );
      if (!gone) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail: "the resting entry would not cancel; nothing was re-priced",
        } satisfies WorkingOrderOutcome;
      }

      const sequence = yield* freshSequence(input.missionId);
      const { intent, stop } = buildReplacementIntent(
        lineage,
        { limitPrice: nearSide, freshSequence: sequence },
        "post_only",
        false,
      );
      const placed = yield* placeReplacement(input, lineage, intent, stop);
      if (!placed.ok) {
        return {
          status: "failed",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          detail: placed.detail,
        } satisfies WorkingOrderOutcome;
      }

      // Confirm the replacement rests, from canonical state — the response
      // proves nothing (§17.1). A post-only at the near side can still be
      // refused when the book moves through it between the read and the
      // place; that failure leaves the entry cancelled, which is the abandon
      // the model has to hear about.
      const afterPlace = yield* confirmWithin(
        (v) => v.openOrders.some((o) => o.cloid === placed.recordCloid),
        reread,
      );
      if (!afterPlace.openOrders.some((o) => o.cloid === placed.recordCloid)) {
        return {
          status: "abandoned",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          summary:
            `patient entry abandoned: re-pricing to ${nearSide} did not confirm ` +
            "— the exchange refused the replacement or it never rested",
        } satisfies WorkingOrderOutcome;
      }

      return {
        status: "repriced",
        placedIntent: intent,
        cancelledCloids: [lineage.resting.cloid],
        ...facts,
      } satisfies WorkingOrderOutcome;
    });

  // --- the exit lane: the same ownership, semantics inverted -------------------

  /**
   * Work one resting patient exit. Mirrors the entry half of `reconcile`
   * with the polarity the audited gap identified: a position is what an
   * exit needs, so the entry lane's `position_open` early return becomes
   * "the position is gone — verify a fill, else withdraw", and the
   * stillWantsIt check keeps working through every non-terminal status
   * because an exit resting is exposure coming off.
   */
  const reconcileExit = (
    input: WorkingOrderInput,
    restingRecord: WorkingRecordRow,
  ): Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      const lineage = yield* readLineage(input, restingRecord);
      const facts = outcomeFacts(input.nowMs, lineage);

      const reread = () => readCanonical(input);
      const view = yield* reread();

      // --- the position is gone: filled elsewhere, or nothing to exit -------
      if (Math.abs(view.positionSize) <= SIZE_EPSILON) {
        if (
          yield* hasFillUnderAny(input.missionId, [lineage.resting.cloid, lineage.original.cloid])
        ) {
          // It filled and the position has since closed — or the position
          // was closed by the stop/take-profit and the exchange retired the
          // reduce-only order with it. Either way the fill channel is how
          // the model hears about it, not this loop.
          return {
            status: "no_working_order",
            cancelledCloids: [],
            ...facts,
          } satisfies WorkingOrderOutcome;
        }
        // Nothing is left to exit and the order never filled: a leftover
        // resting on a flat position. Withdraw it and say so — leaving it
        // would make the record work a position that does not exist forever.
        const cancelled = yield* cancelBestEffort(input.market, [lineage.resting.cloid]);
        return {
          status: "abandoned",
          cancelledCloids: cancelled,
          ...facts,
          summary:
            "patient exit withdrawn: the position is gone (stopped out, closed, or " +
            "taken by the take-profit) and the order never filled",
        } satisfies WorkingOrderOutcome;
      }

      const restingOrder = view.openOrders.find(
        (order) =>
          order.cloid === lineage.resting.cloid &&
          isWorkingExitOrder(order, input.market, lineage.resting.side),
      );

      // --- the exit left the book --------------------------------------------
      if (restingOrder === undefined) {
        if (
          yield* hasFillUnderAny(input.missionId, [lineage.resting.cloid, lineage.original.cloid])
        ) {
          // A partial fill took some of the position; the reconciler settles
          // the record and the fill channel reports the reduction.
          return {
            status: "no_working_order",
            cancelledCloids: [],
            ...facts,
          } satisfies WorkingOrderOutcome;
        }
        // Cancelled by hand, retired with the position's last reduction, or a
        // replacement of ours that never confirmed. Not resurrected: the
        // model that wanted out must place a new exit against the market it
        // sees now.
        const cancelled = yield* cancelBestEffort(input.market, [lineage.resting.cloid]);
        return {
          status: "abandoned",
          cancelledCloids: cancelled,
          ...facts,
          summary:
            `patient exit abandoned: it left the book unfilled after ` +
            `${Math.round(facts.waitMillis / 1000)}s and was not replaced`,
        } satisfies WorkingOrderOutcome;
      }

      // --- the mission's say-so, inverted -------------------------------------
      //
      // Suspended is deliberately NOT a withdrawal here: the entry lane
      // abandons on `paused`/`blocked` because it must not open exposure
      // into a stopped mission; an exit does the opposite of opening. Only
      // the permanent terminals withdraw — and the reactor's retirement path
      // (`retireWorkingOrdersQuietly` → `abandon`) owns those in practice;
      // this branch is the defensive backstop for a pass that raced one.
      const terminal = (PERMANENT_TERMINAL_STATUSES as readonly TradingMissionStatus[]).includes(
        input.missionStatus,
      );
      if (terminal) {
        const cancelled = yield* cancelBestEffort(input.market, [lineage.resting.cloid]);
        return {
          status: "abandoned",
          cancelledCloids: cancelled,
          ...facts,
          summary: `patient exit withdrawn: the mission is ${input.missionStatus}`,
        } satisfies WorkingOrderOutcome;
      }
      if (input.missionStatus === "executing" || input.missionStatus === "initializing") {
        // The wake's own turn owns the book while it runs.
        return { status: "resting", cancelledCloids: [], ...facts } satisfies WorkingOrderOutcome;
      }

      // --- the order on the book must be the approval --------------------------
      if (Math.abs(restingOrder.size - lineage.resting.size) > SIZE_EPSILON) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail:
            `the resting exit's size ${restingOrder.size} does not match the ` +
            `approved ${lineage.resting.size}; refusing to work it`,
        } satisfies WorkingOrderOutcome;
      }

      // --- the wait is up: cross -----------------------------------------------
      if (facts.waitMillis >= WORKING_ORDER_MAX_WAIT_MILLIS) {
        return yield* crossWorkingExit(
          input,
          lineage,
          restingOrder.limitPrice,
          reread,
          view.positionSize,
        );
      }

      // --- re-price on cadence ---------------------------------------------------
      if (input.nowMs - lineage.resting.updated_at >= WORKING_ORDER_REPRICE_CADENCE_MILLIS) {
        return yield* repriceWorkingExit(input, lineage, restingOrder, reread);
      }

      return { status: "resting", cancelledCloids: [], ...facts } satisfies WorkingOrderOutcome;
    });

  const crossWorkingExit = (
    input: WorkingOrderInput,
    lineage: WorkingLineage,
    restingLimitPrice: number,
    reread: () => Effect.Effect<CanonicalView, TradingWorkingOrderError>,
    positionSizeBefore: number,
  ): Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      const facts = outcomeFacts(input.nowMs, lineage);

      const gone = yield* cancelAndConfirmGone(
        { market: input.market, cloid: lineage.resting.cloid },
        reread,
      );
      if (!gone) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail: "the resting exit would not cancel; nothing was crossed",
        } satisfies WorkingOrderOutcome;
      }

      const sequence = yield* freshSequence(input.missionId);
      const { intent } = buildReplacementIntent(
        lineage,
        { limitPrice: restingLimitPrice, freshSequence: sequence },
        "marketable_ioc",
        true,
      );
      const placed = yield* placeReplacement(input, lineage, intent, undefined);
      if (!placed.ok) {
        return {
          status: "failed",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          detail: placed.detail,
        } satisfies WorkingOrderOutcome;
      }

      // Confirm the cross from canonical state: the proof of an exit cross
      // is the position shrinking (a reduce may leave a remainder). No
      // placedIntent is handed back — the entry lane's cross returns one so
      // the reactor can protect the position it opened; a cross that only
      // ever removes exposure has no such follow-up to run.
      const afterCross = yield* confirmWithin(
        (v) => Math.abs(v.positionSize) < Math.abs(positionSizeBefore) - SIZE_EPSILON,
        reread,
      );
      if (Math.abs(afterCross.positionSize) < Math.abs(positionSizeBefore) - SIZE_EPSILON) {
        return {
          status: "crossed",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          summary:
            `patient exit crossed after ${Math.round(facts.waitMillis / 1000)}s: ` +
            `${intent.side} ${intent.size} ${intent.market} at market — the ` +
            `position is ${Math.abs(afterCross.positionSize) <= SIZE_EPSILON ? "closed" : "reduced"}`,
        } satisfies WorkingOrderOutcome;
      }

      // The cross did not fill — the book had nothing to take at the price
      // the mapper allowed. Cancel whatever it left (an unfilled IOC should
      // leave nothing) and tell the model the exit is over.
      const leftovers = afterCross.openOrders
        .map((o) => o.cloid)
        .filter((c): c is string => c !== undefined && c === placed.recordCloid);
      const cancelled = yield* cancelBestEffort(input.market, leftovers);
      return {
        status: "abandoned",
        cancelledCloids: cancelled,
        ...facts,
        summary:
          `patient exit abandoned: the crossing order did not fill after the ` +
          `${WORKING_ORDER_MAX_WAIT_MILLIS / 1000}s wait`,
      } satisfies WorkingOrderOutcome;
    });

  const repriceWorkingExit = (
    input: WorkingOrderInput,
    lineage: WorkingLineage,
    restingOrder: AgentOpenOrder,
    reread: () => Effect.Effect<CanonicalView, TradingWorkingOrderError>,
  ): Effect.Effect<WorkingOrderOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      const facts = outcomeFacts(input.nowMs, lineage);

      const book = yield* gateway.getOrderBook(input.market).pipe(
        Effect.mapError(
          (cause) =>
            new TradingWorkingOrderError({
              reason: "book_read_failed",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const { bidPrice, askPrice } = book.bestBidOffer;
      const nearSide = lineage.resting.side === "buy" ? bidPrice : askPrice;
      if (nearSide === undefined) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail: `no ${lineage.resting.side === "buy" ? "bid" : "ask"} to re-price against`,
        } satisfies WorkingOrderOutcome;
      }

      // Already at the near side: the model's patient price stands until the
      // book moves away from it, exactly as the entry lane leaves an entry
      // that still sits at the near side. Re-placing would be churn.
      if (samePrice(nearSide, restingOrder.limitPrice)) {
        return { status: "resting", cancelledCloids: [], ...facts } satisfies WorkingOrderOutcome;
      }

      // Cancel first, confirm, then place — same ordering as the entry lane.
      // Two resting reduce-only exits are queue contention, never double
      // exposure, but the records-to-book correspondence the lineage walk
      // assumes is worth one confirmation window, and the transient overlap
      // with the resting stop or the take-profit is tolerated for the same
      // reason the stop reconcile tolerates it: reduce-only cannot open.
      const gone = yield* cancelAndConfirmGone(
        { market: input.market, cloid: lineage.resting.cloid },
        reread,
      );
      if (!gone) {
        return {
          status: "failed",
          cancelledCloids: [],
          ...facts,
          detail: "the resting exit would not cancel; nothing was re-priced",
        } satisfies WorkingOrderOutcome;
      }

      const sequence = yield* freshSequence(input.missionId);
      const { intent } = buildReplacementIntent(
        lineage,
        { limitPrice: nearSide, freshSequence: sequence },
        "post_only",
        true,
      );
      const placed = yield* placeReplacement(input, lineage, intent, undefined);
      if (!placed.ok) {
        return {
          status: "failed",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          detail: placed.detail,
        } satisfies WorkingOrderOutcome;
      }

      const afterPlace = yield* confirmWithin(
        (v) => v.openOrders.some((o) => o.cloid === placed.recordCloid),
        reread,
      );
      if (!afterPlace.openOrders.some((o) => o.cloid === placed.recordCloid)) {
        return {
          status: "abandoned",
          cancelledCloids: [lineage.resting.cloid],
          ...facts,
          summary:
            `patient exit abandoned: re-pricing to ${nearSide} did not confirm ` +
            "— the exchange refused the replacement or it never rested",
        } satisfies WorkingOrderOutcome;
      }

      return {
        status: "repriced",
        placedIntent: intent,
        cancelledCloids: [lineage.resting.cloid],
        ...facts,
      } satisfies WorkingOrderOutcome;
    });

  /**
   * Direct withdrawal: cancel what rests, no replacement, no cross. The
   * caller owns the reason and the telling; this owns the cancelling.
   *
   * Shape first, records second: a terminal mission's records may already be
   * settling, but a cloid'd, non-trigger limit in this mission's market is
   * ours and nobody is working it — an entry, a patient exit, or the plan's
   * take-profit (all three are mission-owned; none may outlive the mission,
   * and the exchange retiring reduce-only orders with the position is
   * relied upon, not assumed). `scope: "entries"` narrows that to the
   * position-increasing half for the caller that only revised its way IN.
   * Stops are triggers and stay: they are the flat-protection the emergency
   * close coordinates with, and the exchange retires them with the position.
   * An order placed in the exchange UI carries no cloid and is not ours to
   * cancel.
   */
  const abandon = (input: AbandonInput): Effect.Effect<AbandonOutcome, WorkingOrderFailure> =>
    Effect.gen(function* () {
      const view = yield* readCanonical(input);
      const entriesOnly = input.scope === "entries";
      const resting = view.openOrders.filter(
        (order) =>
          order.market === input.market &&
          order.cloid !== undefined &&
          !order.isTrigger &&
          order.remainingSize > SIZE_EPSILON &&
          !(entriesOnly && order.reduceOnly),
      );
      if (resting.length === 0) {
        return { found: false, cancelledCloids: [] } satisfies AbandonOutcome;
      }
      const cancelled = yield* cancelBestEffort(
        input.market,
        resting.flatMap((o) => (o.cloid === undefined ? [] : [o.cloid])),
      );
      return {
        found: true,
        cancelledCloids: cancelled,
        cloid: resting[0]?.cloid,
      } satisfies AbandonOutcome;
    });

  return TradingWorkingOrderService.of({ reconcile, abandon });
});

export const TradingWorkingOrderServiceLive = Layer.effect(
  TradingWorkingOrderService,
  makeTradingWorkingOrderService,
);
