/**
 * What actually happened to an execution the harness requested.
 *
 * `trading_request_entry` raises `trading.execution.requested` and the reactor
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
import type { TradingOrderResult, TradingRequestEntryResult } from "@t3tools/trading-contracts";
import { evaluateLossBudget } from "@t3tools/trading-contracts/loss-accounting";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { TradingBudgetReader } from "./TradingBudgetReader.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { executionRefusedKey } from "./ExecutionRefusal.ts";

/**
 * How long the tool waits for the reactor to conclude.
 *
 * The reactor's work is a reconcile, a preview, one signed submission and a
 * second reconcile — a handful of exchange round-trips. Twenty seconds covers
 * that with room for a slow one; past it the honest answer is "still in
 * flight", not a guess about which way it went.
 */
const OUTCOME_DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 250;

export interface AwaitOutcomeInput {
  readonly missionId: string;
  readonly executionSequence: number;
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

interface RecordRow {
  readonly execution_id: string;
  readonly cloid: string;
  readonly status: string;
  readonly order_results_json: string;
}

/**
 * Statuses the record passes through on the way to the exchange. A record
 * sitting at one of these has been written but not yet answered, so it is not
 * a conclusion to report.
 */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "previewed",
  "reserved",
  "signed",
  "submitted",
]);

const make = Effect.gen(function* () {
  const inbox = yield* TradingEventInbox;
  const budgetReader = yield* TradingBudgetReader;
  const gateway = yield* HyperliquidGateway;
  const sql = yield* SqlClient.SqlClient;

  /** The execution record for this request, once one exists. */
  const findRecord = (missionId: string, executionSequence: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<RecordRow>`
        SELECT execution_id, cloid, status, order_results_json
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
      // A budget read that fails must not turn a real outcome into an error.
      // Reporting the ceiling as spent is the conservative direction.
      Effect.catchCause(() => Effect.succeed({ remainingCumulativeLossUsd: 0, exhausted: true })),
    );

  const decodeOrderResults = (json: string): ReadonlyArray<TradingOrderResult> =>
    Schema.decodeUnknownSync(OrderResultsJson)(json) as ReadonlyArray<TradingOrderResult>;

  const awaitOutcome: TradingExecutionOutcomeShape["awaitOutcome"] = (input) =>
    Effect.gen(function* () {
      const deadline = OUTCOME_DEADLINE_MS / POLL_INTERVAL_MS;

      for (let attempt = 0; attempt < deadline; attempt++) {
        const record = yield* findRecord(input.missionId, input.executionSequence);
        if (record !== null && !IN_FLIGHT_STATUSES.has(record.status)) {
          return {
            executionId: record.execution_id,
            status: record.status === "rejected" ? ("rejected" as const) : ("accepted" as const),
            cloid: record.cloid,
            orderResults: decodeOrderResults(record.order_results_json),
            budget: yield* readBudget(input),
            detail: record.status,
          };
        }

        const refusal = yield* findRefusal(input.missionId, input.executionSequence);
        if (refusal !== null) {
          // Refused before signing: no record, no nonce spent, no order.
          return {
            executionId: "",
            status: "rejected" as const,
            cloid: "",
            orderResults: [],
            budget: yield* readBudget(input),
            detail: refusal.summary,
          };
        }

        yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
      }

      // Still in flight. "submitted" is the one status that says exactly that,
      // and the detail keeps the harness from reading it as a fill.
      return {
        executionId: "",
        status: "submitted" as const,
        cloid: "",
        orderResults: [],
        budget: yield* readBudget(input),
        detail:
          "The request is still being executed. Read the position and open orders before assuming it filled.",
      };
    });

  return { awaitOutcome } satisfies TradingExecutionOutcomeShape;
});

export const TradingExecutionOutcomeLive = Layer.effect(TradingExecutionOutcome)(make);
