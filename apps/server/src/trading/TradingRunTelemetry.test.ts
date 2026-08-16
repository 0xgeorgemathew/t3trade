// @effect-diagnostics preferSchemaOverJson:off - fixture rows are raw JSON columns, read and written as text.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  readActivityEvidence,
  readDecisionFunnel,
  readEnrichmentEvidence,
  recordExchangeOutcome,
  recordExecutionRefusal,
  recordToolCall,
  settleRunDecision,
} from "./TradingRunTelemetry.ts";

const layer = it.layer(Layer.provideMerge(NodeSqliteClient.layerMemory(), NodeServices.layer));

const THREAD = "thread_1";
const MISSION = "mission_1";

const harnessJson = JSON.stringify({
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: THREAD,
  model: "claude-opus-5",
  status: "available",
});

/**
 * A mission with one open run, and optionally the plan it published. The rest
 * of the trading tables are irrelevant to the funnel, so nothing else is seeded.
 */
const seed = (input?: { readonly plan?: Record<string, unknown> }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 65 });
    yield* sql`DELETE FROM trading_missions`;
    yield* sql`DELETE FROM trading_harness_runs`;
    yield* sql`DELETE FROM trading_plan_history`;

    yield* sql`
      INSERT INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json, authority_version, version,
        created_at, updated_at
      ) VALUES (
        ${MISSION}, 'local', 'acct_1', 'Trade ETH', 'ETH',
        ${harnessJson}, 'analysing', '{}', 3, 1, 1000, 1000
      )
    `;
    if (input?.plan !== undefined) {
      yield* sql`
        INSERT INTO trading_plan_history (mission_id, version, strategy_json, created_at)
        VALUES (${MISSION}, 1, ${JSON.stringify(input.plan)}, 1000)
      `;
    }
    yield* sql`
      INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
      VALUES ('run_1', ${MISSION}, 'scheduled_reassessment', 'starting', 1000, 1000)
    `;
  });

const readRun = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Record<string, unknown>>`
    SELECT * FROM trading_harness_runs WHERE run_id = 'run_1'
  `;
  return rows[0]!;
});

/** A stand-aside plan: the explicit no-position intent (plan 29 step 4.1). */
const standAsidePlan = {
  market: "ETH",
  intent: "stand_aside",
  entry: { triggers: [], urgency: "now" },
  stop: { method: "no position to protect" },
  target: {},
  invalidation: [],
  reassess: { afterMinutes: 90 },
  because: "costs exceed the move on offer",
};

/** A waiting plan with an armed entry level. */
const waitingPlan = {
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [{ description: "reclaim of 2,000 on rising volume", priceLevel: 2_000 }],
    urgency: "now",
  },
  stop: { method: "under the prior swing low" },
  target: { profitUsd: 10 },
  invalidation: [],
  reassess: { afterMinutes: 90 },
  because: "long the reclaim",
};

layer("TradingRunTelemetry", (it) => {
  it.effect("records the tools a run called, and the first one that failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();

      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_look", ok: true });
      yield* recordToolCall(sql, {
        threadId: THREAD,
        tool: "trading_look",
        ok: false,
        errorMessage: "market data unavailable\nstack",
      });
      yield* recordToolCall(sql, {
        threadId: THREAD,
        tool: "trading_look",
        ok: false,
        errorMessage: "no book",
      });

      const run = yield* readRun;
      assert.deepStrictEqual(JSON.parse(String(run["tools_called_json"])), [
        "trading_look",
        "trading_look",
        "trading_look",
      ]);
      assert.strictEqual(run["tool_error_count"], 2);
      assert.strictEqual(run["first_tool_error"], "trading_look: market data unavailable");
      assert.strictEqual(run["published_plan"], 0);
      assert.strictEqual(run["execute_attempted"], 0);
    }),
  );

  it.effect("drops a tool call that belongs to no open run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* sql`UPDATE trading_harness_runs SET status = 'completed' WHERE run_id = 'run_1'`;

      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_look", ok: true });

      const run = yield* readRun;
      assert.strictEqual(run["tools_called_json"], null);
    }),
  );

  it.effect("does not count an in-band rejected publish as published or as a transport error", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* recordToolCall(sql, {
        threadId: THREAD,
        tool: "trading_plan",
        ok: true,
        accepted: false,
      });

      const run = yield* readRun;
      assert.strictEqual(run["published_plan"], 0);
      assert.strictEqual(run["tool_error_count"], 0);
    }),
  );

  it.effect("settles a published stand-aside as no_setup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({ plan: standAsidePlan });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_plan", ok: true });

      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 4_000 });

      const run = yield* readRun;
      assert.strictEqual(run["outcome"], "no_setup");
      // The plan carries no reason code any more, so the attribution is the
      // derived default, not a code the document stated.
      assert.strictEqual(run["stand_down_code"], "insufficient_volatility");
      assert.strictEqual(run["provider"], "claude");
      assert.strictEqual(run["model"], "claude-opus-5");
      assert.strictEqual(run["market"], "ETH");
      // The playbook column is null now: the plan stopped naming a mode.
      assert.strictEqual(run["playbook"], null);
      assert.strictEqual(run["authority_version"], 3);
      assert.strictEqual(run["latency_ms"], 3_000);
    }),
  );

  it.effect("settles a published thesis without armed levels as no_setup too", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({
        plan: { ...waitingPlan, entry: { triggers: [], urgency: "now" }, intent: "long" },
      });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_plan", ok: true });

      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 4_000 });
      const run = yield* readRun;
      assert.strictEqual(run["outcome"], "no_setup");
      // Not a stand-aside: the flatter refusal, where the read resolved.
      assert.strictEqual(run["stand_down_code"], "regime_unclear");
    }),
  );

  it.effect("settles a published thesis with armed levels as waiting_with_setup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({ plan: waitingPlan });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_plan", ok: true });

      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });

      const run = yield* readRun;
      assert.strictEqual(run["outcome"], "waiting_with_setup");
      assert.strictEqual(run["stand_down_code"], "awaiting_trigger");
    }),
  );

  it.effect("separates a failed read from a turn that simply published nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* recordToolCall(sql, {
        threadId: THREAD,
        tool: "trading_look",
        ok: false,
        errorMessage: "internal server error",
      });

      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });
      assert.strictEqual((yield* readRun)["outcome"], "blocked_by_data");

      yield* seed();
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });
      const silent = yield* readRun;
      assert.strictEqual(silent["outcome"], "no_decision");
      assert.strictEqual(silent["stand_down_code"], "not_published");
    }),
  );

  it.effect("settles a refused attempt as execution_refused, and a filled one as entered", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({ plan: waitingPlan });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_execute", ok: true });
      yield* recordExecutionRefusal(sql, {
        missionId: MISSION,
        reason: "planned_loss_within_per_position_ceiling refused",
      });

      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });
      const refused = yield* readRun;
      assert.strictEqual(refused["outcome"], "execution_refused");
      assert.strictEqual(refused["stand_down_code"], "preview_refused");
      assert.strictEqual(refused["execute_attempted"], 1);

      yield* seed({ plan: waitingPlan });
      yield* recordExchangeOutcome(sql, { missionId: MISSION, action: "open", status: "filled" });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });
      assert.strictEqual((yield* readRun)["outcome"], "entered");

      yield* seed({ plan: waitingPlan });
      yield* recordExchangeOutcome(sql, {
        missionId: MISSION,
        action: "close",
        status: "succeeded",
      });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });
      assert.strictEqual((yield* readRun)["outcome"], "managed_position");

      yield* seed({ plan: waitingPlan });
      yield* recordExchangeOutcome(sql, {
        missionId: MISSION,
        action: "open",
        status: "rejected",
      });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });
      const exchangeRejected = yield* readRun;
      assert.strictEqual(exchangeRejected["outcome"], "execution_refused");
      assert.strictEqual(exchangeRejected["stand_down_code"], "exchange_rejected");
    }),
  );

  it.effect("settles exactly once per run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({ plan: standAsidePlan });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_plan", ok: true });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });

      // A second release must not rewrite the decision the first one recorded.
      yield* recordExchangeOutcome(sql, { missionId: MISSION, action: "open", status: "filled" });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 9_000 });

      const run = yield* readRun;
      assert.strictEqual(run["outcome"], "no_setup");
      assert.strictEqual(run["latency_ms"], 1_000);
    }),
  );

  it.effect("reports the funnel grouped by outcome and provider", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({ plan: standAsidePlan });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_plan", ok: true });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });

      const funnel = yield* readDecisionFunnel(sql, { missionId: MISSION });
      assert.strictEqual(funnel.length, 1);
      assert.strictEqual(funnel[0]?.outcome, "no_setup");
      assert.strictEqual(funnel[0]?.provider, "claude");
      assert.strictEqual(funnel[0]?.runs, 1);
      assert.strictEqual(funnel[0]?.publishes, 1);
      assert.strictEqual(funnel[0]?.executeAttempts, 0);
    }),
  );

  // Step 7 authorises volume, open interest, and funding features only if the
  // stand-down record shows they are what is limiting decisions. One run is not
  // that record, and the answer has to say so rather than reading as a no.
  it.effect("answers the enrichment question from the record, not from a hunch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed({ plan: standAsidePlan });
      yield* recordToolCall(sql, { threadId: THREAD, tool: "trading_plan", ok: true });
      yield* settleRunDecision(sql, { runId: "run_1", completedAt: 2_000 });

      const evidence = yield* readEnrichmentEvidence(sql, { missionId: MISSION });
      assert.strictEqual(evidence.warranted, false);
      assert.strictEqual(evidence.sampleRuns, 1);
      assert.include(evidence.reason, "anecdote");
    }),
  );

  // Plan 27 I3: "sat out all day" as a measurement. The count that matters is
  // the stand-down that happened AFTER the structure read had already put a
  // candidate through its cost gate — that flag is written by the read and
  // survives on the run row for the activity evidence to find.
  it.effect("measures activity, and the stand-downs that had a viable candidate", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed();

      // The mission lived 100 minutes and held a position for 30 of them.
      yield* sql`UPDATE trading_missions SET created_at = 0, updated_at = ${100 * 60_000}`;
      yield* sql`
        INSERT INTO trading_closed_trades (
          mission_id, market, opened_at, closed_at, hold_millis, direction, size,
          entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
          peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak, fill_count
        ) VALUES (
          ${MISSION}, 'ETH', 0, ${30 * 60_000}, ${30 * 60_000}, 'long', 1,
          3000, 3010, 10, 1, 9, 12, -2, 3, 2
        )
      `;

      // Run 1 stood down; run 2 stood down on an empty field — discipline, not
      // a failure. (The viable-candidate split died with the cost gate,
      // plan 29 step 3.1; both count the same way now.)
      yield* sql`
        UPDATE trading_harness_runs SET outcome = 'no_setup', status = 'completed'
        WHERE run_id = 'run_1'
      `;
      yield* sql`
        INSERT INTO trading_harness_runs (
          run_id, mission_id, cause, status, started_at, created_at, outcome
        ) VALUES ('run_2', ${MISSION}, 'scheduled_reassessment', 'completed', 2000, 2000, 'no_setup')
      `;

      const activity = yield* readActivityEvidence(sql, { missionId: MISSION });
      assert.strictEqual(activity.sessions, 1);
      assert.strictEqual(activity.trades, 1);
      assert.strictEqual(activity.tradesPerSession, 1);
      assert.strictEqual(activity.timeInMarketPercent, 30);
      assert.strictEqual(activity.standDownRuns, 2);
      assert.include(activity.reason, "2 grounded stand-down");
    }),
  );
});
