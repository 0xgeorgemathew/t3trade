/**
 * What actually happened to an execution the harness requested.
 *
 * `trading_enter` raises `trading.execution.requested` and the reactor
 * answers it on its own worker. The tool used to return a synthesized
 * `status: "submitted"` the moment the dispatch landed — before preview, before
 * signing, before the exchange had been asked anything. A refusal downstream
 * was logged server-side and never reached the harness, so a mission whose
 * every entry was being rejected read, to the harness, as a mission that had
 * entered. That is the worst possible failure mode for a trading agent: it
 * believes it holds a position it does not hold.
 *
 * This service closes that gap. It waits, bounded, for the request to reach a
 * durable conclusion and reports it: the persisted execution record when one
 * was written, the recorded refusal when the request was refused before
 * signing, and the real loss budget either way.
 *
 * @module TradingExecutionOutcome
 */
import type {
  TradingOrderResult,
  TradingOrderTimeInForce,
  TradingRequestEntryResult,
} from "@t3tools/trading-contracts";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import { classifyFailureMessage } from "@t3tools/trading-contracts/recovery";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingExecutionReceipts } from "./TradingExecutionReceipts.ts";
import { executionRefusedKey, executionSettledKey } from "./ExecutionRefusal.ts";

/**
 * How long the tool waits for the reactor to conclude.
 *
 * The reactor's work is a reconcile, a preview, one signed submission and a
 * second reconcile — a handful of exchange round-trips. Twenty seconds covers
 * that with room for a slow one; past it the honest answer is "still in
 * flight", not a guess about which way it went.
 */
const OUTCOME_DEADLINE_MS = 20_000;

/**
 * The one poll left, and why there is one.
 *
 * The receipt latch is the normal path: the reactor opens it the moment the
 * request is settled, and the wait ends in microseconds rather than at the next
 * quarter-second tick. What the latch cannot cover is a settle that happened in
 * another process, or before this waiter existed at all — the signal is
 * in-memory, the record is durable, and only the record is truth. So a slow
 * sweep runs underneath: rare enough to cost nothing, frequent enough that a
 * missed signal is a delay rather than a wrong answer.
 */
const FALLBACK_SWEEP_MS = 2_000;

export interface AwaitOutcomeInput {
  readonly missionId: string;
  readonly executionSequence: number;
  /** The intent's action type, which decides where the answer will be found. */
  readonly actionType: string;
  readonly maximumCumulativeLossUsd: number;
  readonly fallbackTakerFeeBpsPerSide: number;
  readonly masterAddress: string;
}

export interface TradingExecutionOutcomeShape {
  readonly awaitOutcome: (input: AwaitOutcomeInput) => Effect.Effect<TradingRequestEntryResult>;
}

export class TradingExecutionOutcome extends Context.Service<
  TradingExecutionOutcome,
  TradingExecutionOutcomeShape
>()("t3/trading/TradingExecutionOutcome") {}

const OrderResultsJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const decodeOrderResultsJson = Schema.decodeUnknownSync(OrderResultsJson);

interface RecordRow {
  readonly execution_id: string;
  readonly cloid: string;
  readonly action_type: string;
  readonly status: string;
  readonly order_results_json: string;
  /** The limit the server placed — for an IOC, derived from BBO, not the intent. */
  readonly limit_price: number;
  /** The TIF the order went out with — the server's answer to the urgency asked. */
  readonly time_in_force: string;
}

/**
 * The record statuses `TradingRequestEntryResult` reports verbatim. Anything
 * else would be a status the wire contract has no word for, and the honest
 * answer for one of those is "still in flight".
 */
const REPORTABLE_STATUSES = new Set(["accepted", "filled", "cancelled", "rejected", "failed"]);

/** The two actions that place no order of their own (see `executionSettledKey`). */
const DETERMINISTIC_ACTIONS = new Set(["cancel", "modify_stop"]);

/** The actions whose ack states what is left of the position. */
const REDUCING_ACTIONS = new Set(["reduce", "close"]);

const make = Effect.gen(function* () {
  const inbox = yield* TradingEventInbox;
  const receipts = yield* TradingExecutionReceipts;
  const budgetReader = yield* TradingBudgetReader;
  const gateway = yield* HyperliquidGateway;
  const sql = yield* SqlClient.SqlClient;

  /** The execution record for this request, once one exists. */
  const findRecord = (missionId: string, executionSequence: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<RecordRow>`
        SELECT execution_id, cloid, action_type, status, order_results_json, limit_price,
               time_in_force
        FROM trading_execution_records
        WHERE mission_id = ${missionId} AND execution_sequence = ${executionSequence}
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      return rows[0] ?? null;
    }).pipe(Effect.orElseSucceed(() => null));

  /** The reactor's recorded reason for refusing this request, if it refused. */
  const findRefusal = (missionId: string, executionSequence: number) =>
    inbox
      .findSummary(missionId, executionRefusedKey(executionSequence))
      .pipe(Effect.orElseSucceed(() => null));

  /** What a deterministic action (cancel, modify_stop) did, once it is done. */
  const findSettlement = (missionId: string, executionSequence: number) =>
    inbox
      .findSummary(missionId, executionSettledKey(executionSequence))
      .pipe(Effect.orElseSucceed(() => null));

  /**
   * What the mission still holds, from the snapshot the post-submit reconcile
   * wrote. Only meaningful for a `reduce`/`close`, which is the only place it
   * is read.
   */
  const readRemainingSize = (missionId: string) =>
    sql<{ readonly size: number }>`
      SELECT size FROM trading_position_snapshots WHERE mission_id = ${missionId}
    `.pipe(
      Effect.map((rows) => rows[0]?.size ?? 0),
      Effect.orElseSucceed(() => 0),
    );

  /**
   * Size-weighted average price of the fills recorded under one cloid.
   *
   * Returns null when nothing filled — which is the honest answer for a
   * rejected order and for an IOC that crossed nothing. The reconcile that runs
   * after submission is what puts the fills in this table, so by the time a
   * record is terminal they are here.
   */
  const readAvgFillPrice = (missionId: string, cloid: string) =>
    sql<{ readonly filled_size: number; readonly avg_fill_price: number }>`
      SELECT filled_size, avg_fill_price FROM trading_fills
      WHERE mission_id = ${missionId} AND cloid = ${cloid}
    `.pipe(
      Effect.map((rows) => {
        const size = rows.reduce((total, row) => total + row.filled_size, 0);
        if (size <= 0) return null;
        const notional = rows.reduce(
          (total, row) => total + row.filled_size * row.avg_fill_price,
          0,
        );
        return notional / size;
      }),
      Effect.orElseSucceed(() => null),
    );

  /**
   * The loss budget, or an admission that it could not be read.
   *
   * `null` is the whole point of the return type. This used to answer a failed
   * read with `{ remaining: 0, exhausted: true }` — "conservative", except that
   * `exhausted` is the word §16.4 uses for a mission that must stop trading,
   * and a harness told its budget is exhausted stops trading. A read that
   * failed says nothing about the budget, and saying nothing is what the caller
   * now reports.
   */
  const readBudget = (input: AwaitOutcomeInput) =>
    Effect.gen(function* () {
      const feeBps = yield* gateway.getTakerFeeRateBps(input.masterAddress as `0x${string}`).pipe(
        Effect.map((rate) => rate.feeBps),
        // The authority's fallback rate exists for exactly this. `catchCause`
        // rather than `orElseSucceed` because a transport defect must not take
        // down the report either — the outcome is the point, the fee is trim.
        Effect.catchCause(() => Effect.succeed(input.fallbackTakerFeeBpsPerSide)),
      );
      const budgetInput = yield* budgetReader.read({
        missionId: input.missionId,
        maximumCumulativeLossUsd: input.maximumCumulativeLossUsd,
        takerFeeRateBps: feeBps,
      });
      const budget = evaluateLossBudget(budgetInput);
      return {
        remainingCumulativeLossUsd: budget.remainingCumulativeLossUsd,
        exhausted: budget.exhausted,
      };
    }).pipe(
      // A budget read that fails must not turn a real outcome into an error,
      // and must not be reported as a verdict about the budget either.
      Effect.catchCause(() => Effect.succeed(null)),
    );

  /**
   * The budget as the wire contract carries it, plus the sentence that says so
   * when it could not be read.
   *
   * The contract's `budget` is not optional, so an unreadable budget has to
   * carry numbers. It carries the ones that assert nothing — a full remainder
   * is not claimed, and `exhausted` is not claimed either — and `detail` says
   * outright that these are unknown, which is the field the harness reads.
   */
  const reportBudget = (
    budget: { remainingCumulativeLossUsd: number; exhausted: boolean } | null,
  ) => budget ?? { remainingCumulativeLossUsd: 0, exhausted: false };

  const BUDGET_UNREADABLE =
    "the loss budget could not be read, so the budget in this result is unknown, not exhausted — " +
    "read trading_look before sizing anything on it";

  const withBudget = (
    detail: string,
    budget: { remainingCumulativeLossUsd: number; exhausted: boolean } | null,
  ): string => (budget === null ? `${detail}; ${BUDGET_UNREADABLE}` : detail);

  const decodeOrderResults = (json: string): ReadonlyArray<TradingOrderResult> =>
    decodeOrderResultsJson(json) as ReadonlyArray<TradingOrderResult>;

  /**
   * The durable answer to "what happened to this request", or null if there is
   * not one yet. Three places to look, because three things can settle a
   * request: a written record, a deterministic action's receipt, and a refusal
   * recorded before anything was signed.
   */
  const readSettledOutcome = (input: AwaitOutcomeInput) =>
    Effect.gen(function* () {
      const record = yield* findRecord(input.missionId, input.executionSequence);
      if (record !== null && REPORTABLE_STATUSES.has(record.status)) {
        const reducing = REDUCING_ACTIONS.has(record.action_type);
        const avgFillPrice = yield* readAvgFillPrice(input.missionId, record.cloid);
        const budget = yield* readBudget(input);
        return {
          executionId: record.execution_id,
          // The record's own word for what happened. Reporting a cancelled
          // or failed execution as `accepted` told the harness it held a
          // resting order it did not have.
          status: record.status as "accepted" | "filled" | "cancelled" | "rejected" | "failed",
          cloid: record.cloid,
          orderResults: decodeOrderResults(record.order_results_json),
          budget: reportBudget(budget),
          detail: withBudget(record.status, budget),
          ...(reducing ? { remainingSize: yield* readRemainingSize(input.missionId) } : {}),
          // The limit the server placed, so the harness can see the crossing
          // bound its IOC was priced with rather than the one it asked for.
          limitPrice: record.limit_price,
          // The TIF the urgency became — the harness never names one, so this
          // is the only place it learns whether the order crossed or rested.
          timeInForce: record.time_in_force as TradingOrderTimeInForce,
          ...(avgFillPrice === null ? {} : { avgFillPrice }),
        } satisfies TradingRequestEntryResult;
      }

      // A `cancel` or a `modify_stop` writes no record; the reactor records
      // what it did in the inbox instead.
      if (DETERMINISTIC_ACTIONS.has(input.actionType)) {
        const settled = yield* findSettlement(input.missionId, input.executionSequence);
        if (settled !== null) {
          const budget = yield* readBudget(input);
          return {
            status: "succeeded" as const,
            cloid: "",
            orderResults: [],
            budget: reportBudget(budget),
            detail: withBudget(settled.summary, budget),
          } satisfies TradingRequestEntryResult;
        }
      }

      const refusal = yield* findRefusal(input.missionId, input.executionSequence);
      if (refusal !== null) {
        // Refused before signing: no record, no nonce spent, no order. The
        // record and cloid fields are left off rather than blanked — there is
        // no execution to name, and a blank id is not a valid `TradingId`.
        const budget = yield* readBudget(input);
        return {
          status: "rejected" as const,
          cloid: "",
          orderResults: [],
          budget: reportBudget(budget),
          detail: withBudget(refusal.summary, budget),
          // No nonce was spent, so this one CAN be retried when the failure
          // says so — the refusal was recorded as a sentence, and the tag and
          // reason inside it are what decide.
          recovery: classifyFailureMessage(refusal.summary),
        } satisfies TradingRequestEntryResult;
      }

      return null;
    });

  const awaitOutcome: TradingExecutionOutcomeShape["awaitOutcome"] = (input) =>
    Effect.gen(function* () {
      // The reactor commonly finishes before this waiter starts, so look once
      // before waiting on a signal that has already been sent.
      const settled = yield* readSettledOutcome(input);
      if (settled !== null) return settled;

      const sweeps = Math.ceil(OUTCOME_DEADLINE_MS / FALLBACK_SWEEP_MS);
      for (let sweep = 0; sweep < sweeps; sweep++) {
        // Block on the reactor's own signal rather than re-asking the database.
        // A `false` here means no signal arrived within the sweep, which is not
        // an answer — the record still is, so it is read either way.
        yield* receipts.awaitSettled({
          missionId: input.missionId,
          executionSequence: input.executionSequence,
          timeoutMillis: FALLBACK_SWEEP_MS,
        });
        const answer = yield* readSettledOutcome(input);
        if (answer !== null) return answer;
      }

      // Still in flight. "submitted" is the one status that says exactly that,
      // and the detail keeps the harness from reading it as a fill.
      const budget = yield* readBudget(input);
      return {
        status: "submitted" as const,
        cloid: "",
        orderResults: [],
        budget: reportBudget(budget),
        detail: withBudget(
          "The request is still being executed. Read the position and open orders before assuming it filled.",
          budget,
        ),
        // The one case that must never be retryable. A submission whose outcome
        // is unknown may already be resting or filled at the exchange; sending
        // it again is how one intended order becomes two real ones. The answer
        // is to read what is actually there.
        recovery: {
          retryable: false,
          action: "read_state" as const,
          retryAfterMillis: 0,
          reason: "outcome_unknown",
        },
      };
    });

  return { awaitOutcome } satisfies TradingExecutionOutcomeShape;
});

export const TradingExecutionOutcomeLive = Layer.effect(TradingExecutionOutcome)(make);
