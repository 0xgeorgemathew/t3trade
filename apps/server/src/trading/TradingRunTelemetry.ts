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
  type TradingDecisionOutcome,
  type TradingRunFacts,
} from "@t3tools/trading-contracts/decision";
import {
  assessActivity,
  assessEnrichment,
  assessEntryGovernance,
} from "@t3tools/trading-contracts/policy";
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
  standAside: boolean;
  armedEntry: boolean;
} => {
  if (strategyJson === null) {
    return { standAside: false, armedEntry: false };
  }
  try {
    const plan = JSON.parse(strategyJson) as {
      readonly intent?: unknown;
      readonly entry?: { readonly triggers?: unknown };
    };
    const triggers = plan.entry?.triggers;
    return {
      // The old schema keyed this on a published `standDownCode`; the plan
      // document no longer carries one (plan 29 step 4.1). Standing aside is
      // the explicit no-position intent, and it is the whole signal.
      standAside: plan.intent === "stand_aside",
      armedEntry: Array.isArray(triggers) && triggers.length > 0,
    };
  } catch {
    return { standAside: false, armedEntry: false };
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
      SELECT market, harness_json, authority_version
      FROM trading_missions WHERE mission_id = ${run.mission_id}
    `;
    const mission = missions[0];

    const strategies =
      mission === undefined
        ? []
        : yield* sql<{ readonly strategy_json: string }>`
            SELECT strategy_json FROM trading_plan_history
            WHERE mission_id = ${run.mission_id}
            ORDER BY version DESC LIMIT 1
          `;

    const plan = readPlan(strategies[0]?.strategy_json ?? null);
    const facts: TradingRunFacts = {
      toolsCalled: parseToolsCalled(run.tools_called_json),
      toolErrorCount: run.tool_error_count,
      ...(run.first_tool_error !== null ? { firstToolError: run.first_tool_error } : {}),
      publishedPlan: run.published_plan === 1,
      publishedStandDown: run.published_plan === 1 && plan.standAside,
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

    // `playbook` is null now: the plan document stopped naming a mode (plan 29
    // step 4.1 — the strategy name lives in `because` as prose), and a run
    // settles exactly once, so this only stamps runs settling from here on.
    yield* sql`
      UPDATE trading_harness_runs SET
        outcome = ${outcome},
        stand_down_code = ${standDownCode},
        provider = ${binding.provider},
        model = ${binding.model},
        market = ${mission?.market ?? null},
        playbook = null,
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
/**
 * Wins and losses split by whether a scored setup was behind the entry, and
 * losses attributed to the regime read in force at entry — plan 27 C2/C3.
 *
 * Each closed trade is joined to the newest consumed `open` quote at or
 * before the moment the position opened; the quote row carries the C1
 * snapshot (`setup_kind_at_entry`, `regime_at_entry`). A trade with no
 * joinable quote counts as unscored with an unrecorded regime — an entry the
 * governance record cannot explain is exactly what the split exists to count.
 */
export const readEntryGovernance = (sql: Sql, input?: { readonly missionId?: string }) =>
  Effect.gen(function* () {
    const missionId = input?.missionId ?? null;
    const rows = yield* sql<{
      readonly net_pnl: number;
      readonly setup_kind_at_entry: string | null;
      readonly regime_at_entry: string | null;
    }>`
      SELECT t.net_pnl,
             q.setup_kind_at_entry,
             q.regime_at_entry
      FROM trading_closed_trades t
      LEFT JOIN trading_entry_quotes q ON q.quote_id = (
        SELECT q2.quote_id FROM trading_entry_quotes q2
        WHERE q2.mission_id = t.mission_id
          AND q2.action_type = 'open'
          AND q2.consumed_at IS NOT NULL
          AND q2.consumed_at <= t.opened_at + 60000
        ORDER BY q2.consumed_at DESC
        LIMIT 1
      )
      WHERE (${missionId} IS NULL OR t.mission_id = ${missionId})
    `;
    return assessEntryGovernance(
      rows.map((row) => ({
        scoredSetupBehindIt: row.setup_kind_at_entry !== null,
        setupKindAtEntry: row.setup_kind_at_entry,
        regimeAtEntry: row.regime_at_entry,
        netPnlUsd: row.net_pnl,
      })),
    );
  });

/**
 * Activity as a measurement — plan 27 I3: how often the loop trades, how much
 * of its life it spends holding, and how often it grounds a stand-down. A
 * session is a mission; with settled missions kept (H1), the read spans the
 * whole record.
 */
export const readActivityEvidence = (sql: Sql, input?: { readonly missionId?: string }) =>
  Effect.gen(function* () {
    const missionId = input?.missionId ?? null;

    const sessions = yield* sql<{
      readonly active_millis: number;
      readonly trades: number;
      readonly held_millis: number;
    }>`
      SELECT
        MAX(m.updated_at - m.created_at, 0) AS active_millis,
        COUNT(t.mission_id) AS trades,
        COALESCE(SUM(t.hold_millis), 0) AS held_millis
      FROM trading_missions m
      LEFT JOIN trading_closed_trades t ON t.mission_id = m.mission_id
      WHERE (${missionId} IS NULL OR m.mission_id = ${missionId})
      GROUP BY m.mission_id
    `;

    const standDowns = yield* sql<{ readonly stand_downs: number }>`
      SELECT COUNT(*) AS stand_downs
      FROM trading_harness_runs
      WHERE outcome IN ('no_setup', 'blocked_by_data')
        AND (${missionId} IS NULL OR mission_id = ${missionId})
    `;

    return assessActivity({
      sessions: sessions.map((row) => ({
        activeMillis: row.active_millis,
        trades: row.trades,
        heldMillis: row.held_millis,
      })),
      standDownRuns: standDowns[0]?.stand_downs ?? 0,
    });
  });

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

/**
 * One closed trade with the entry quote it joins to — the raw material for a
 * session's economics (plan 29 step 0.2). Same quote join `readEntryGovernance`
 * uses: the newest consumed `open` quote at or shortly before the position
 * opened. A trade with no joinable quote still counts, it just cannot
 * contribute to the entry-side spread and slippage splits.
 */
export interface SessionTrade {
  readonly netPnlUsd: number;
  readonly feesPaidUsd: number;
  readonly size: number;
  readonly entryPrice: number | null;
  readonly direction: string;
  readonly entryQuote: { readonly bestBid: number; readonly bestAsk: number } | null;
}

/** The mission's closed trades, newest close first, with their entry quotes. */
export const readSessionTrades = (sql: Sql, input: { readonly missionId: string }) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly net_pnl: number;
      readonly fees_paid: number;
      readonly size: number;
      readonly entry_price: number | null;
      readonly direction: string;
      readonly best_bid: number | null;
      readonly best_ask: number | null;
    }>`
      SELECT t.net_pnl, t.fees_paid, t.size, t.entry_price, t.direction,
             q.best_bid, q.best_ask
      FROM trading_closed_trades t
      LEFT JOIN trading_entry_quotes q ON q.quote_id = (
        SELECT q2.quote_id FROM trading_entry_quotes q2
        WHERE q2.mission_id = t.mission_id
          AND q2.action_type = 'open'
          AND q2.consumed_at IS NOT NULL
          AND q2.consumed_at <= t.opened_at + 60000
        ORDER BY q2.consumed_at DESC
        LIMIT 1
      )
      WHERE t.mission_id = ${input.missionId}
      ORDER BY t.closed_at DESC
    `;
    return rows.map(
      (row): SessionTrade => ({
        netPnlUsd: row.net_pnl,
        feesPaidUsd: row.fees_paid,
        size: row.size,
        entryPrice: row.entry_price,
        direction: row.direction,
        entryQuote:
          row.best_bid !== null && row.best_ask !== null
            ? { bestBid: row.best_bid, bestAsk: row.best_ask }
            : null,
      }),
    );
  });

/**
 * One reconciled fill of a session — the money columns the fill-sourced cost
 * measurements read (plan 29 step 2.7). Unlike the closed-trade economics,
 * these come from the real fills: fees as the exchange actually charged them,
 * against the notional actually traded.
 */
export interface SessionFill {
  readonly feeUsd: number;
  /** |price x size| — this fill's share of the session's gross traded notional. */
  readonly notionalUsd: number;
  /**
   * The exchange's maker/taker flag: false = maker (rested, paid no spread),
   * true = taker (crossed, paid it). Null on fills recorded before the flag
   * was carried — those cannot contribute to a maker fill rate.
   */
  readonly crossed: boolean | null;
}

/** The session's fills, oldest first — the real-fill basis for step 2.7. */
export const readSessionFills = (sql: Sql, input: { readonly missionId: string }) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly fee_usd: number;
      readonly notional_usd: number;
      readonly crossed: number | null;
    }>`
      SELECT fee_usd, ABS(avg_fill_price * filled_size) AS notional_usd, crossed
      FROM trading_fills
      WHERE mission_id = ${input.missionId}
      ORDER BY traded_at
    `;
    return rows.map(
      (row): SessionFill => ({
        feeUsd: row.fee_usd,
        notionalUsd: row.notional_usd,
        crossed: row.crossed === null ? null : row.crossed === 1,
      }),
    );
  });

/** A session's wake counts — plan 29 step 0.2's activity half. */
export interface SessionWakeCounts {
  /** Every harness run the mission ever started, settled or not. */
  readonly wakes: number;
  /** Runs that neither published a plan nor attempted an execution. */
  readonly noOpWakes: number;
  /** The stricter count: settled runs whose outcome was `no_decision`. */
  readonly noDecisionWakes: number;
  /**
   * Plan versions published. Counted from `trading_plan_history` rather
   * than SUM(published_plan) over runs: every accepted publish appends a
   * history row, so the table is the authoritative count.
   */
  readonly planVersionsPublished: number;
}

export const readSessionWakes = (sql: Sql, input: { readonly missionId: string }) =>
  Effect.gen(function* () {
    const runs = yield* sql<{
      readonly wakes: number;
      readonly no_op_wakes: number;
      readonly no_decision_wakes: number;
    }>`
      SELECT COUNT(*) AS wakes,
             SUM(CASE WHEN published_plan = 0 AND execute_attempted = 0 THEN 1 ELSE 0 END)
               AS no_op_wakes,
             SUM(CASE WHEN outcome = 'no_decision' THEN 1 ELSE 0 END) AS no_decision_wakes
      FROM trading_harness_runs
      WHERE mission_id = ${input.missionId}
    `;
    const versions = yield* sql<{ readonly plan_versions: number }>`
      SELECT COUNT(*) AS plan_versions FROM trading_plan_history
      WHERE mission_id = ${input.missionId}
    `;
    return {
      wakes: runs[0]?.wakes ?? 0,
      noOpWakes: runs[0]?.no_op_wakes ?? 0,
      noDecisionWakes: runs[0]?.no_decision_wakes ?? 0,
      planVersionsPublished: versions[0]?.plan_versions ?? 0,
    } satisfies SessionWakeCounts;
  });
