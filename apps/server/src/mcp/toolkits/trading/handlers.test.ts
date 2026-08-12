/**
 * Trading toolkit integration tests.
 *
 * These drive the real `/mcp` HTTP endpoint with a credential minted by
 * `McpSessionRegistry.issue`, so what is under test is the whole path an
 * injected `t3-trade` harness takes: bearer auth, MCP session, tool dispatch,
 * capability check, thread-to-mission resolution, and the trading services.
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { runMigrations } from "../../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import type { PublishTradingPlanBody } from "../../../trading/Schemas.ts";
import { TradingLayerLive } from "../../../trading/runtimeLayer.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

/** What `McpServer` returns for anything that is not a declared tool failure. */
const INTERNAL_ERROR_TEXT = "Tool execution failed due to an internal server error.";

const MISSION_ID = "mission_mcp_trading";
const BOUND_THREAD = ThreadId.make("thread-bound-to-mission");
const UNBOUND_THREAD = ThreadId.make("thread-with-no-mission");
const PROVIDER_INSTANCE = ProviderInstanceId.make("claude");

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-trading")),
  getDescriptor: Effect.die("unused"),
});

const strategyBody = (name: string): PublishTradingPlanBody => ({
  name,
  market: "ETH",
  mode: "breakout_continuation",
  direction: "long",
  timeframes: ["5m"],
  belief: {
    summary: "ETH is breaking the overnight range on expanding volume.",
    regime: "trending",
    evidence: ["range high reclaimed", "volume above 20-period average"],
  },
  entryPlan: {
    explanation: "Enter on a 5m close above the range high.",
    orderPreference: "marketable_ioc",
    conditions: [{ description: "5m candle closes above 3,200" }],
  },
  positionManagement: {
    scaleInAllowed: false,
    scaleInConditions: [],
    partialReductionAllowed: true,
  },
  protection: {
    stopMethod: "Structural stop beneath the breakout candle low.",
    targetProfitUsd: 20,
    targetProfitBasis: {
      measurement: "excursion_quantile",
      timeframe: "5m",
      lookbackBars: 120,
      // (32 / 3,200) x 2,000 of notional = the 20 USD published above.
      // Publishing checks that arithmetic, so the two cannot drift apart.
      measuredMoveUsd: 32,
      expectedHoldBars: 10,
      referencePrice: 3_200,
      targetPriceMovePercent: 1,
      positionNotionalUsd: 2_000,
      historicalHitRatePercent: 50,
      rationale: "Median 10-bar upside excursion over the last 120 5m bars is 32 USD of price.",
    },
  },
  exitConditions: [{ description: "Momentum stalls for three consecutive candles." }],
  abandonmentConditions: [{ description: "Range high is lost on a 15m close." }],
  reentryConditions: [],
  currentAction: "waiting",
  explanation: "Momentum continuation on the overnight range break.",
});

/**
 * The MCP HTTP transport answers either `application/json` or an SSE stream
 * depending on the negotiated session, so read the JSON-RPC envelope out of
 * whichever came back.
 */
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

const parseJsonRpc = (body: string): { readonly result?: any; readonly error?: any } => {
  const payload = body.includes("data:")
    ? (body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .at(-1) ?? "{}")
    : body;
  return decodeJson(payload) as { readonly result?: any; readonly error?: any };
};

/**
 * Records what the toolkit raises on the orchestration engine, so a test can
 * assert that an accepted publish reaches the ordered push path instead of
 * stopping at the database.
 */
const dispatchedCommands: Array<OrchestrationCommand> = [];

const recordingEngine = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command) =>
    Effect.sync(() => {
      dispatchedCommands.push(command);
      return { sequence: dispatchedCommands.length };
    }),
  readEvents: () => Stream.empty,
  streamDomainEvents: Stream.empty,
  latestSequence: Effect.succeed(0),
});

const TradingMcpLayer = McpHttpServer.layer.pipe(
  Layer.provideMerge(McpSessionRegistry.layer),
  Layer.provideMerge(TradingLayerLive),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provide(recordingEngine),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-mcp-" })),
  Layer.provide(NodeServices.layer),
);

/**
 * Boot the real endpoint, migrate, seed one mission bound to `BOUND_THREAD`,
 * and hand back a `callTool` bound to a freshly minted credential.
 */
const withMcpServer = <A, E>(
  body: (context: {
    readonly callTool: (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ) => Effect.Effect<{ readonly result?: any; readonly error?: any }, never, never>;
    readonly missions: TradingMissionService["Service"];
    /** Register one active watch against `strategyVersion`, as a watch tool would. */
    readonly seedActiveWatch: (
      watchId: string,
      strategyVersion: number,
    ) => Effect.Effect<void, never, never>;
    /** Record one reconciled fill, as the reconciler would. */
    readonly seedFill: (input: {
      readonly fillId: string;
      readonly orderId: number;
      readonly closedPnl: number;
      readonly feeUsd: number;
    }) => Effect.Effect<void, never, never>;
  }) => Effect.Effect<A, E, HttpServer.HttpServer>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
      const built = yield* Layer.build(
        HttpRouter.serve(TradingMcpLayer, { disableListenLog: true, disableLogger: true }),
      );
      const registry = Context.get(built, McpSessionRegistry.McpSessionRegistry);
      const missions = Context.get(built, TradingMissionService);
      const sql = Context.get(built, SqlClient.SqlClient);
      const seedActiveWatch = (watchId: string, strategyVersion: number) =>
        sql`
          INSERT INTO trading_watches (
            watch_id, mission_id, strategy_version, watch_json, status, version,
            created_at, updated_at
          ) VALUES (
            ${watchId}, ${MISSION_ID}, ${strategyVersion},
            '{"type":"price_cross","market":"ETH","priceSource":"mark","direction":"above","price":3200}',
            'active', 1, 1, 1
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedFill = (input: {
        readonly fillId: string;
        readonly orderId: number;
        readonly closedPnl: number;
        readonly feeUsd: number;
      }) =>
        sql`
          INSERT INTO trading_fills (
            fill_id, mission_id, execution_id, cloid, order_id, market, side,
            filled_size, avg_fill_price, fee_usd, fee_token, closed_pnl,
            traded_at, observed_at
          ) VALUES (
            ${input.fillId}, ${MISSION_ID}, NULL, NULL, ${input.orderId}, 'ETH', 'sell',
            1, 3000, ${input.feeUsd}, 'USDC', ${input.closedPnl}, 1, 1
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const httpClient = yield* HttpClient.HttpClient;

      yield* runMigrations({ toMigrationInclusive: 52 }).pipe(Effect.provide(built), Effect.orDie);
      yield* missions
        .createMission({
          missionId: MISSION_ID,
          userId: "user_mcp_trading",
          tradingAccountId: "acct_mcp_trading",
          instruction: "Trade ETH momentum",
          allocatedCapitalUsd: 1_000,
          harness: {
            provider: "claude",
            providerInstanceId: PROVIDER_INSTANCE,
            threadId: BOUND_THREAD,
            status: "available",
          },
        })
        .pipe(Effect.orDie);

      const callTool = (threadId: ThreadId, name: string, args: unknown) =>
        Effect.gen(function* () {
          const issued = yield* registry.issue({ threadId, providerInstanceId: PROVIDER_INSTANCE });
          const authorization = issued.config.authorizationHeader;
          const accept = "application/json, text/event-stream";

          const initialize = yield* httpClient.post("/mcp", {
            headers: { accept, authorization },
            body: HttpBody.jsonUnsafe({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "trading-test", version: "1.0.0" },
              },
            }),
          });
          const sessionId = initialize.headers["mcp-session-id"];
          expect(initialize.status).toBe(200);

          const response = yield* httpClient.post("/mcp", {
            headers: { accept, authorization, "mcp-session-id": sessionId! },
            body: HttpBody.jsonUnsafe({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
          return parseJsonRpc(yield* response.text);
        }).pipe(Effect.orDie);

      return yield* body({ callTool, missions, seedActiveWatch, seedFill });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

it.effect("serves trading_get_mission and a versioned publish over the real /mcp endpoint", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const initial = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: MISSION_ID,
      });
      assert.equal(initial.result.isError, false);
      const before = initial.result.structuredContent;
      assert.equal(before.mission.id, MISSION_ID);
      assert.equal(before.mission.status, "initializing");
      assert.equal(before.strategyVersion, 0);
      assert.equal(before.strategy, undefined);
      assert.equal(before.authorityVersion, 1);
      assert.equal(before.authority.allocatedCapitalUsd, 1_000);
      assert.equal(before.harness.threadId, BOUND_THREAD);
      assert.deepStrictEqual(before.watches, []);

      const published = yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 0,
        strategy: strategyBody("overnight range break"),
      });
      assert.equal(published.result.isError, false);
      assert.equal(published.result.structuredContent.outcome, "accepted");
      assert.equal(published.result.structuredContent.strategyVersion, 1);
      assert.equal(published.result.structuredContent.strategy.version, 1);
      assert.deepStrictEqual(published.result.structuredContent.supersededWatchIds, []);

      const after = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: MISSION_ID,
      });
      assert.equal(after.result.structuredContent.strategyVersion, 1);
      assert.equal(after.result.structuredContent.strategy.name, "overnight range break");

      // The accepted publish was announced on the orchestration engine, which
      // is what puts it on the server's ordered WS push path — and so was the
      // status the publish settled the mission on (§11.1 `analysing → waiting`
      // happens inside the publish write, so the UI has to hear about it too).
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        ["trading.mission.strategy-published", "trading.mission.status-set"],
      );
    }),
  ),
);

it.effect("rejects a stale expectedVersion over MCP and leaves v(n) intact", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 0,
        strategy: strategyBody("v1"),
      });

      const stale = yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 0,
        strategy: strategyBody("v2 attempt from a stale reader"),
      });
      assert.equal(stale.result.isError, false);
      assert.deepStrictEqual(stale.result.structuredContent, {
        outcome: "rejected",
        reason: "stale_strategy_version",
        currentVersion: 1,
      });

      // v1 survived the rejected publish untouched.
      const current = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: MISSION_ID,
      });
      assert.equal(current.result.structuredContent.strategyVersion, 1);
      assert.equal(current.result.structuredContent.strategy.name, "v1");
    }),
  ),
);

it.effect("supersedes the prior version's active watches on an accepted publish", () =>
  withMcpServer(({ callTool, seedActiveWatch }) =>
    Effect.gen(function* () {
      yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 0,
        strategy: strategyBody("v1"),
      });

      yield* seedActiveWatch("watch_v1_active", 1);

      const republished = yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 1,
        strategy: strategyBody("v2"),
      });
      assert.equal(republished.result.structuredContent.outcome, "accepted");
      assert.deepStrictEqual(republished.result.structuredContent.supersededWatchIds, [
        "watch_v1_active",
      ]);

      const current = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: MISSION_ID,
      });
      const watches = current.result.structuredContent.watches;
      assert.equal(watches.length, 1);
      assert.equal(watches[0].status, "superseded");
    }),
  ),
);

it.effect("answers an unbound thread instead of failing every tool on it", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // A thread with no live mission is not an authorization failure for a
      // read: `trading_get_mission` says so in-band, so the agent can learn
      // that its mission ended rather than seeing every tool error.
      const unbound = yield* callTool(UNBOUND_THREAD, "trading_get_mission", {
        missionId: MISSION_ID,
      });
      assert.notEqual(unbound.result.isError, true);
      assert.equal(unbound.result.structuredContent.bound, false);

      // A bound thread naming someone else's mission is still refused, firmly.
      const wrongMission = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: "mission_belonging_to_someone_else",
      });
      assert.equal(wrongMission.result.isError, true);
      assert.deepStrictEqual(wrongMission.result.content, [
        {
          type: "text",
          text: `TradingToolRejectedError: mission_not_bound_to_thread (thread=${BOUND_THREAD}, mission=mission_belonging_to_someone_else)`,
        },
      ]);
      assert.notEqual(wrongMission.result.content[0].text, INTERNAL_ERROR_TEXT);
    }),
  ),
);

it.effect("keeps write tools closed on an unbound thread", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const published = yield* callTool(UNBOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 0,
        strategy: strategyBody("v1"),
      });
      assert.equal(published.result.isError, true);
      assert.deepStrictEqual(published.result.content, [
        {
          type: "text",
          text: `TradingToolRejectedError: thread_not_bound_to_mission (thread=${UNBOUND_THREAD}, mission=${MISSION_ID})`,
        },
      ]);
    }),
  ),
);

it.effect("still refuses a second active mission for the same user", () =>
  withMcpServer(({ missions }) =>
    Effect.gen(function* () {
      const error = yield* missions
        .createMission({
          missionId: "mission_second",
          userId: "user_mcp_trading",
          tradingAccountId: "acct_mcp_trading",
          instruction: "Trade ETH momentum again",
          allocatedCapitalUsd: 500,
          harness: {
            provider: "claude",
            providerInstanceId: PROVIDER_INSTANCE,
            threadId: ThreadId.make("thread-second"),
            status: "available",
          },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TradingMissionAlreadyActiveError");
      assert.equal((error as { activeMissionId: string }).activeMissionId, MISSION_ID);
    }),
  ),
);

it.effect("registers a watch before the first strategy publish with strategyVersion 0", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // The mission was seeded with no published strategy, so its row still
      // carries strategy_version = 0. A watch registered now must persist,
      // result-encode, and announce — none of those steps may reject on the
      // version being below 1.
      const registered = yield* callTool(BOUND_THREAD, "trading_register_watch", {
        missionId: MISSION_ID,
        watch: {
          type: "price_cross",
          market: "ETH",
          priceSource: "mark",
          direction: "above",
          price: 3200,
        },
      });
      assert.equal(registered.result.isError, false);
      const registeredWatch = registered.result.structuredContent.watch;
      // Nothing was named to replace, so nothing was.
      assert.equal(registered.result.structuredContent.replaced, undefined);
      assert.equal(registeredWatch.strategyVersion, 0);
      assert.equal(registeredWatch.status, "active");
      assert.equal(registeredWatch.watch.type, "price_cross");

      const listed = yield* callTool(BOUND_THREAD, "trading_list_watches", {
        missionId: MISSION_ID,
      });
      assert.equal(listed.result.isError, false);
      const watches = listed.result.structuredContent;
      assert.equal(watches.length, 1);
      assert.equal(watches[0].strategyVersion, 0);
      assert.equal(watches[0].id, registeredWatch.id);

      // The announce path succeeded rather than hitting its
      // "could not announce a registered watch" warning: a watch-registered
      // command reached the recording engine.
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        ["trading.mission.watch-registered"],
      );
    }),
  ),
);

it.effect("moves a level atomically through replacesWatchId", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const level = (price: number) => ({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price,
      });

      const first = yield* callTool(BOUND_THREAD, "trading_register_watch", {
        watch: level(3200),
      });
      const originalId = first.result.structuredContent.watch.id;

      const moved = yield* callTool(BOUND_THREAD, "trading_register_watch", {
        watch: level(3250),
        replacesWatchId: originalId,
      });
      assert.equal(moved.result.isError, false);
      assert.equal(moved.result.structuredContent.replaced.id, originalId);

      const listed = yield* callTool(BOUND_THREAD, "trading_list_watches", {});
      const watches = listed.result.structuredContent;
      const byId = new Map(watches.map((w: { id: string; status: string }) => [w.id, w.status]));
      assert.equal(byId.get(originalId), "cancelled");
      assert.equal(byId.get(moved.result.structuredContent.watch.id), "active");

      // Both halves of the swap reach the workspace: an unannounced cancel
      // leaves a level rendered that is no longer standing.
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "trading.mission.watch-registered",
          "trading.mission.watch-registered",
          "trading.mission.watch-cancelled",
        ],
      );
    }),
  ),
);

it.effect("serves the mission its own completed trades over MCP", () =>
  withMcpServer(({ callTool, seedFill }) =>
    Effect.gen(function* () {
      yield* seedFill({ fillId: "f1", orderId: 100, closedPnl: 12, feeUsd: 1 });
      yield* seedFill({ fillId: "f2", orderId: 200, closedPnl: -4, feeUsd: 1 });

      const read = yield* callTool(BOUND_THREAD, "trading_get_trade_history", {});
      assert.equal(read.result.isError, false);
      const history = read.result.structuredContent;

      assert.equal(history.orders.length, 2);
      assert.equal(history.summary.realizedPnlUsd, 8);
      assert.equal(history.summary.feesPaidUsd, 2);
      assert.equal(history.summary.netPnlUsd, 6);
      assert.equal(history.summary.winningOrders, 1);
      assert.equal(history.summary.losingOrders, 1);
    }),
  ),
);

it.effect("resolves an omitted missionId to the bound mission for a read tool", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // Omitting `missionId` entirely: the call resolves to the one mission the
      // thread is bound to, exactly as naming it would.
      const omitted = yield* callTool(BOUND_THREAD, "trading_get_mission", {});
      assert.equal(omitted.result.isError, false);
      assert.equal(omitted.result.structuredContent.mission.id, MISSION_ID);
    }),
  ),
);

it.effect("resolves an omitted missionId to the bound mission for a write tool", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // A publish with no `missionId` reaches the bound mission and increments
      // its strategy version, just as a publish that named it would.
      const published = yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        expectedVersion: 0,
        strategy: strategyBody("no missionId supplied"),
      });
      assert.equal(published.result.isError, false);
      assert.equal(published.result.structuredContent.outcome, "accepted");
      assert.equal(published.result.structuredContent.strategyVersion, 1);

      // The bound mission now carries the published strategy.
      const after = yield* callTool(BOUND_THREAD, "trading_get_mission", {});
      assert.equal(after.result.structuredContent.strategyVersion, 1);
      assert.equal(after.result.structuredContent.strategy.name, "no missionId supplied");
    }),
  ),
);

it.effect("still rejects a wrong missionId with mission_not_bound_to_thread", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // An explicit `missionId` that does not match the bound mission is still a
      // firm refusal — making the argument optional did not make it trusted.
      const wrong = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: "mission_belonging_to_someone_else",
      });
      assert.equal(wrong.result.isError, true);
      assert.deepStrictEqual(wrong.result.content, [
        {
          type: "text",
          text: `TradingToolRejectedError: mission_not_bound_to_thread (thread=${BOUND_THREAD}, mission=mission_belonging_to_someone_else)`,
        },
      ]);
    }),
  ),
);

it.effect("decodes a prose-string exit condition and round-trips it as the object shape", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // A bare prose string where the schema asked for `{ description }` used to
      // fail the whole publish. The lenient input union decodes it to the object
      // shape, and the persisted strategy carries the object back out.
      const strategyBodyWithProseExit = {
        ...strategyBody("prose exit condition"),
        exitConditions: ["Exit if a finalized 1m candle closes back above 1865.9."],
      };
      const published = yield* callTool(BOUND_THREAD, "trading_publish_plan", {
        missionId: MISSION_ID,
        expectedVersion: 0,
        strategy: strategyBodyWithProseExit,
      });
      assert.equal(published.result.isError, false);
      assert.equal(published.result.structuredContent.outcome, "accepted");

      const after = yield* callTool(BOUND_THREAD, "trading_get_mission", {
        missionId: MISSION_ID,
      });
      const exitConditions = after.result.structuredContent.strategy.exitConditions;
      assert.equal(exitConditions.length, 1);
      // The persisted/encoded form is the object shape, not the bare string.
      assert.deepStrictEqual(exitConditions[0], {
        description: "Exit if a finalized 1m candle closes back above 1865.9.",
      });
    }),
  ),
);

it.effect("refuses to quote an entry outside a turn that owns the decision lease", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // No harness run has been opened for this mission, so nothing owns the
      // lease — the check preview item 5 was named for, made real by reading
      // the table the lease actually lives in rather than trusting an argument.
      const quoted = yield* callTool(BOUND_THREAD, "trading_quote_entry", {
        market: "ETH",
        side: "buy",
        stopPrice: 3_100,
        sizeEth: 0.1,
      });

      assert.equal(quoted.result.isError, false);
      assert.equal(quoted.result.structuredContent.outcome, "refused");
      assert.equal(quoted.result.structuredContent.reason, "harness_run_owns_lease");
    }),
  ),
);

it.effect("tells an execute carrying an unknown quote to go and get one", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const executed = yield* callTool(BOUND_THREAD, "trading_execute", {
        quoteId: "qte_never_issued",
      });

      assert.equal(executed.result.isError, false);
      assert.equal(executed.result.structuredContent.status, "rejected");
      assert.include(executed.result.structuredContent.detail, "quote_not_found");
      assert.include(executed.result.structuredContent.detail, "trading_quote_entry");
    }),
  ),
);

it.effect("refuses an execute that names neither a quote nor a full intent", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const executed = yield* callTool(BOUND_THREAD, "trading_execute", {});

      assert.equal(executed.result.isError, true);
      assert.include(executed.result.content[0]?.text ?? "", "quoteId");
    }),
  ),
);

it.effect("closes a position with a call carrying no arguments at all", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // The whole point of the exit tools: there is nothing to get wrong. This
      // mission has no lease, so the refusal is about the turn — not about a
      // side, a size, a version, or a sequence the caller failed to supply.
      const closed = yield* callTool(BOUND_THREAD, "trading_close_position", {});

      assert.equal(closed.result.isError, false);
      assert.equal(closed.result.structuredContent.status, "rejected");
      assert.include(closed.result.structuredContent.detail, "harness_run_owns_lease");
      // And the harness is told what to do about it rather than left to guess.
      assert.equal(closed.result.structuredContent.recovery.retryable, false);
    }),
  ),
);

it.effect("refuses a reduce that names neither a size nor a fraction", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const reduced = yield* callTool(BOUND_THREAD, "trading_reduce_position", {});

      assert.equal(reduced.result.isError, true);
      assert.include(reduced.result.content[0]?.text ?? "", "exactly one");
    }),
  ),
);

it.effect("refuses a cancel that names no resting order", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const cancelled = yield* callTool(BOUND_THREAD, "trading_cancel_order", { cloid: "" });

      assert.equal(cancelled.result.isError, false);
      assert.equal(cancelled.result.structuredContent.status, "rejected");
      assert.include(cancelled.result.structuredContent.detail, "no_target_named");
    }),
  ),
);
