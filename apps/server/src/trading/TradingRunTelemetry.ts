/**
 * The decision funnel: one typed terminal decision per harness run, plus the
 * observed facts it was derived from.
 *
 * Before this, the only durable evidence a turn left behind was what it
 * changed: a published strategy, an execution record, a refusal in the inbox. A
 * turn that changed nothing left nothing, so the most common outcome in the
 * system — no trade — was also the least measurable one. This module records
 * the rest of the funnel: which tools a run called, which of them failed,
 * whether it published, whether it tried to execute, what the gate said, and
 * what the exchange said.
 *
 * It is a set of functions over `SqlClient` rather than a service, so the three
 * places that observe a run (the MCP tool boundary, the reactor's execution
 * paths, and the coordinator's lease release) can call it with the `sql` they
 * already hold, without another layer to wire through every test.
 *
 * Nothing here stores model reasoning. Tool names are public, and
 * `first_tool_error` is an error message the tool already returned to the
 * agent.
 *
 * @module TradingRunTelemetry
 */
import {
  deriveDecisionOutcome,
  deriveStandDownCode,
  type PublishedStandDownCode,
  type TradingDecisionOutcome,
  type TradingRunFacts,
} from "@t3tools/trading-contracts/decision";
import { assessEnrichment } from "@t3tools/trading-contracts/policy";
import {
  TRADING_ADJUST_STOP_TOOL,
  TRADING_EXECUTE_TOOL,
  TRADING_PUBLISH_PLAN_TOOL,
  TRADING_REQUEST_ENTRY_TOOL,
} from "@t3tools/trading-contracts/tools";
import {
  TRADING_CANCEL_ORDER_TOOL,
  TRADING_CLOSE_POSITION_TOOL,
  TRADING_REDUCE_POSITION_TOOL,
} from "@t3tools/trading-contracts/exit";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Tool names that mean the turn tried to change exchange state. */
const EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  TRADING_EXECUTE_TOOL,
  TRADING_REQUEST_ENTRY_TOOL,
  TRADING_ADJUST_STOP_TOOL,
  TRADING_CLOSE_POSITION_TOOL,
  TRADING_REDUCE_POSITION_TOOL,
  TRADING_CANCEL_ORDER_TOOL,
]);

/** How much of a message is worth keeping: one line, bounded. */
const summarize = (text: string, limit = 300): string =>
  (text.split("\n")[0] ?? "").trim().slice(0, limit);

type Sql = SqlClient.SqlClient;

/**
 * The run a mission currently has open, or `null` when none is.
 *
 * The single-lease invariant (`idx_trading_harness_runs_one_active_per_mission`)
 * means there is at most one, so "the open run" is unambiguous.
 */
const openRunIdForMission = (sql: Sql, missionId: string) =>
  sql<{ readonly run_id: string }>`
    SELECT run_id FROM trading_harness_runs
    WHERE mission_id = ${missionId} AND status NOT IN ('completed', 'failed')
    ORDER BY started_at DESC
    LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.run_id ?? null));

/** The same, resolved from the thread the MCP credential is bound to. */
const openRunIdForThread = (sql: Sql, threadId: string) =>
  sql<{ readonly run_id: string }>`
    SELECT r.run_id FROM trading_harness_runs r
    JOIN trading_missions m ON m.mission_id = r.mission_id
    WHERE json_extract(m.harness_json, '$.threadId') = ${threadId}
      AND r.status NOT IN ('completed', 'failed')
    ORDER BY r.started_at DESC
    LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.run_id ?? null));

/**
 * Record one trading tool call against the thread's open run.
 *
 * Called at the MCP boundary for every trading tool, so the funnel sees the
 * calls a run made even when the run goes on to decide nothing. A call arriving
 * with no open run (an operator poking the tools outside a wake) is dropped
 * rather than invented.
 */
export const recordToolCall = (
  sql: Sql,
  input: {
    readonly threadId: string;
    readonly tool: string;
    /** Transport/schema execution completed without an MCP error. */
    readonly ok: boolean;
    /** In-band operation outcome; false for rejected/refused result variants. */
    readonly accepted?: boolean | undefined;
    readonly errorMessage?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const runId = yield* openRunIdForThread(sql, input.threadId);
    if (runId === null) return;

    const failed = input.ok ? 0 : 1;
    const firstError = input.ok ? null : `${input.tool}: ${summarize(input.errorMessage ?? "")}`;
    const published =
      input.ok && input.accepted !== false && input.tool === TRADING_PUBLISH_PLAN_TOOL ? 1 : 0;
    const executed = EXECUTION_TOOLS.has(input.tool) ? 1 : 0;

    yield* sql`
      UPDATE trading_harness_runs SET
        tools_called_json = json_insert(COALESCE(tools_called_json, '[]'), '$[#]', ${input.tool}),
        tool_error_count = tool_error_count + ${failed},
        first_tool_error = COALESCE(first_tool_error, ${firstError}),
        published_plan = MAX(published_plan, ${published}),
        execute_attempted = MAX(execute_attempted, ${executed})
      WHERE run_id = ${runId}
    `;
  });

/** Record the gate's answer when an execution attempt was refused. */
export const recordExecutionRefusal = (
  sql: Sql,
  input: { readonly missionId: string; readonly reason: string },
) =>
  Effect.gen(function* () {
    const runId = yield* openRunIdForMission(sql, input.missionId);
    if (runId === null) return;
    yield* sql`
      UPDATE trading_harness_runs
      SET first_preview_refusal = COALESCE(first_preview_refusal, ${summarize(input.reason)}),
          execute_attempted = 1
      WHERE run_id = ${runId}
    `;
  });

/** Record that an order actually reached the exchange, and as what. */
export const recordExchangeOutcome = (
  sql: Sql,
  input: { readonly missionId: string; readonly action: string; readonly status: string },
) =>
  Effect.gen(function* () {
    const runId = yield* openRunIdForMission(sql, input.missionId);
    if (runId === null) return;
    yield* sql`
      UPDATE trading_harness_runs
      SET exchange_outcome = COALESCE(
            exchange_outcome,
            ${`${input.action}|${input.status}`}
          ),
          execute_attempted = 1
      WHERE run_id = ${runId}
    `;
  });

interface RunRow {
  readonly mission_id: string;
  readonly started_at: number | null;
  readonly outcome: string | null;
  readonly tools_called_json: string | null;
  readonly tool_error_count: number;
  readonly first_tool_error: string | null;
  readonly published_plan: number;
  readonly execute_attempted: number;
  readonly first_preview_refusal: string | null;
  readonly exchange_outcome: string | null;
}

interface MissionRow {
  readonly market: string;
  readonly harness_json: string;
  readonly strategy_version: number;
  readonly authority_version: number;
}

const parseToolsCalled = (json: string | null): ReadonlyArray<string> => {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
};

/** The harness binding fields the funnel breaks down by. */
const readBinding = (harnessJson: string): { provider: string | null; model: string | null } => {
  try {
    const parsed: unknown = JSON.parse(harnessJson);
    if (typeof parsed !== "object" || parsed === null) return { provider: null, model: null };
    const binding = parsed as Record<string, unknown>;
    return {
      provider: typeof binding["provider"] === "string" ? binding["provider"] : null,
      model: typeof binding["model"] === "string" ? binding["model"] : null,
    };
  } catch {
    return { provider: null, model: null };
  }
};

/** What the published plan says about itself, when there is one. */
const readPlan = (
  strategyJson: string | null,
): {
  mode: string | null;
  standDown: boolean;
  standDownCode: PublishedStandDownCode | undefined;
  armedEntry: boolean;
} => {
  if (strategyJson === null) {
    return { mode: null, standDown: false, standDownCode: undefined, armedEntry: false };
  }
  try {
    const plan = JSON.parse(strategyJson) as {
      readonly mode?: unknown;
      readonly standDownCode?: unknown;
      readonly protection?: {
        readonly targetProfitBasis?: { readonly insufficientVolatility?: unknown };
      };
      readonly entryPlan?: { readonly conditions?: unknown };
    };
    const conditions = plan.entryPlan?.conditions;
    const explicitCode =
      typeof plan.standDownCode === "string" &&
      [
        "insufficient_volatility",
        "costs_exceed_target",
        "regime_unclear",
        "data_unavailable",
        "tool_call_failed",
      ].includes(plan.standDownCode)
        ? (plan.standDownCode as PublishedStandDownCode)
        : undefined;
    return {
      mode: typeof plan.mode === "string" ? plan.mode : null,
      standDown:
        explicitCode !== undefined ||
        plan.protection?.targetProfitBasis?.insufficientVolatility === true,
      standDownCode:
        explicitCode ??
        (plan.protection?.targetProfitBasis?.insufficientVolatility === true
          ? "insufficient_volatility"
          : undefined),
      armedEntry: Array.isArray(conditions) && conditions.length > 0,
    };
  } catch {
    return { mode: null, standDown: false, standDownCode: undefined, armedEntry: false };
  }
};

/**
 * Close the run's decision: derive the one terminal outcome from what was
 * observed, and stamp it with the dimensions a report groups by.
 *
 * Called from the coordinator as the lease is released, so every completed run
 * carries exactly one decision. It is idempotent — a run that already has an
 * outcome is left alone — and it never fails the settlement it runs inside.
 */
export const settleRunDecision = (
  sql: Sql,
  input: { readonly runId: string; readonly completedAt: number },
) =>
  Effect.gen(function* () {
    const runs = yield* sql<RunRow>`
      SELECT mission_id, started_at, outcome, tools_called_json, tool_error_count,
             first_tool_error, published_plan, execute_attempted,
             first_preview_refusal, exchange_outcome
      FROM trading_harness_runs WHERE run_id = ${input.runId}
    `;
    const run = runs[0];
    if (run === undefined || run.outcome !== null) return;

    const missions = yield* sql<MissionRow>`
      SELECT market, harness_json, strategy_version, authority_version
      FROM trading_missions WHERE mission_id = ${run.mission_id}
    `;
    const mission = missions[0];

    const strategies =
      mission === undefined
        ? []
        : yield* sql<{ readonly strategy_json: string }>`
            SELECT strategy_json FROM momentum_strategy_versions
            WHERE mission_id = ${run.mission_id} AND version = ${mission.strategy_version}
          `;

    const plan = readPlan(strategies[0]?.strategy_json ?? null);
    const facts: TradingRunFacts = {
      toolsCalled: parseToolsCalled(run.tools_called_json),
      toolErrorCount: run.tool_error_count,
      ...(run.first_tool_error !== null ? { firstToolError: run.first_tool_error } : {}),
      publishedPlan: run.published_plan === 1,
      publishedStandDown: run.published_plan === 1 && plan.standDown,
      ...(plan.standDownCode === undefined ? {} : { publishedStandDownCode: plan.standDownCode }),
      hasArmedEntry: plan.armedEntry,
      executeAttempted: run.execute_attempted === 1,
      ...(run.first_preview_refusal !== null
        ? { firstPreviewRefusal: run.first_preview_refusal }
        : {}),
      ...(run.exchange_outcome === null
        ? {}
        : (() => {
            const separator = run.exchange_outcome.indexOf("|");
            if (separator > 0) {
              return {
                exchangeAction: run.exchange_outcome.slice(0, separator),
                exchangeStatus: run.exchange_outcome.slice(separator + 1),
              };
            }
            // Migration-051 rows stored only the action name. Treat those as
            // successful mutations; they predate status attribution.
            return { exchangeAction: run.exchange_outcome, exchangeStatus: "succeeded" };
          })()),
    };

    const outcome: TradingDecisionOutcome = deriveDecisionOutcome(facts);
    const standDownCode = deriveStandDownCode(facts, outcome) ?? null;
    const binding =
      mission === undefined ? { provider: null, model: null } : readBinding(mission.harness_json);
    const latency =
      run.started_at === null ? null : Math.max(0, input.completedAt - run.started_at);

    yield* sql`
      UPDATE trading_harness_runs SET
        outcome = ${outcome},
        stand_down_code = ${standDownCode},
        provider = ${binding.provider},
        model = ${binding.model},
        market = ${mission?.market ?? null},
        playbook = ${plan.mode},
        strategy_version = ${mission?.strategy_version ?? null},
        authority_version = ${mission?.authority_version ?? null},
        latency_ms = ${latency}
      WHERE run_id = ${input.runId} AND outcome IS NULL
    `;
  });

/** One row of the funnel report. */
export interface TradingFunnelRow {
  readonly outcome: string;
  readonly standDownCode: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly market: string | null;
  readonly playbook: string | null;
  readonly runs: number;
  readonly executeAttempts: number;
  readonly publishes: number;
  readonly toolErrors: number;
}

/**
 * The funnel, grouped by the dimensions a threshold change would be argued
 * from. Scoped to one mission, or to every mission when none is named.
 */
export const readDecisionFunnel = (sql: Sql, input?: { readonly missionId?: string }) =>
  Effect.gen(function* () {
    const missionId = input?.missionId ?? null;
    const rows = yield* sql<{
      readonly outcome: string;
      readonly stand_down_code: string | null;
      readonly provider: string | null;
      readonly model: string | null;
      readonly market: string | null;
      readonly playbook: string | null;
      readonly runs: number;
      readonly execute_attempts: number;
      readonly publishes: number;
      readonly tool_errors: number;
    }>`
      SELECT outcome, stand_down_code, provider, model, market, playbook,
             COUNT(*) AS runs,
             SUM(execute_attempted) AS execute_attempts,
             SUM(published_plan) AS publishes,
             SUM(CASE WHEN tool_error_count > 0 THEN 1 ELSE 0 END) AS tool_errors
      FROM trading_harness_runs
      WHERE outcome IS NOT NULL
        AND (${missionId} IS NULL OR mission_id = ${missionId})
      GROUP BY outcome, stand_down_code, provider, model, market, playbook
      ORDER BY runs DESC
    `;
    return rows.map(
      (row): TradingFunnelRow => ({
        outcome: row.outcome,
        standDownCode: row.stand_down_code,
        provider: row.provider,
        model: row.model,
        market: row.market,
        playbook: row.playbook,
        runs: row.runs,
        executeAttempts: row.execute_attempts,
        publishes: row.publishes,
        toolErrors: row.tool_errors,
      }),
    );
  });

/**
 * Whether the record supports spending latency on more market data.
 *
 * The plan authorises volume, open interest, and funding features only if the
 * stand-down attribution shows they are what is limiting decisions. This is
 * that question asked of the funnel the runs already write, so the answer comes
 * from the record rather than from an intuition about it.
 */
export const readEnrichmentEvidence = (sql: Sql, input?: { readonly missionId?: string }) =>
  readDecisionFunnel(sql, input).pipe(
    Effect.map((rows) =>
      assessEnrichment(
        rows
          // Waiting, execution refusals, exits, and silent runs are not regime
          // reads and must not dilute the question "did market evidence limit
          // a grounded stand-down?".
          .filter((row) => row.outcome === "no_setup" || row.outcome === "blocked_by_data")
          .map((row) => ({ standDownCode: row.standDownCode, runs: row.runs })),
      ),
    ),
  );
