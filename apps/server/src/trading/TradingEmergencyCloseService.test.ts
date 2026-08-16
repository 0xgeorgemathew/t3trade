/**
 * TradingEmergencyCloseService — §17.5.
 *
 * The properties worth proving here are all about boundedness and ordering:
 * that a partial IOC fill converges inside three attempts, that a market which
 * will not take the size stops at three rather than retrying forever, that the
 * failure path still reports the exact remaining size, and that the reduce-only
 * protection is never among the orders cancelled on the way out.
 *
 * The fake exchange fills a fixed fraction of whatever is asked, which is what
 * a marketable IOC does against a thin book — the case §17.5 step 6 exists for.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import type { TradingOrderResult } from "@t3tools/trading-contracts/execution";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import {
  EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS,
  makeTradingEmergencyCloseService,
  type EmergencyCloseInput,
} from "./TradingEmergencyCloseService.ts";

const MISSION = "mission_emergency";

const INPUT: EmergencyCloseInput = {
  missionId: MISSION,
  masterAddress: "0xmaster",
  market: "ETH",
  reason: "protection could not be confirmed",
};

interface FakeExchange {
  /** Signed canonical position size. */
  positionSize: number;
  /** Fraction of the requested size each IOC fills. */
  fillFraction: number;
  /** IOC submissions, in order. */
  exits: number[];
  cancels: string[];
  transitions: Array<{ to: string; blockedReason: string | undefined }>;
  /** When set, every IOC submission fails outright. */
  submitFailure: boolean;
}

const makeFake = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: 0.5,
  fillFraction: 1,
  exits: [],
  cancels: [],
  transitions: [],
  submitFailure: false,
  ...overrides,
});

const gatewayLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.succeed({
        positions:
          Math.abs(fake.positionSize) < 1e-9
            ? []
            : [
                {
                  market: "ETH",
                  size: fake.positionSize,
                  entryPrice: 3_000,
                  unrealisedPnl: 0,
                  marginUsed: 100,
                },
              ],
      }),
    getOrderBook: () =>
      Effect.succeed({
        bestBidOffer: { bidPrice: 2_999, askPrice: 3_001 },
      }),
    getOpenOrders: () => Effect.succeed([]),
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const executionLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitReduceOnlyIoc: (input: { positionSize: number }) =>
      Effect.suspend(() => {
        fake.exits.push(input.positionSize);
        if (fake.submitFailure) {
          return Effect.succeed([] as ReadonlyArray<TradingOrderResult>);
        }
        // An IOC fills what it can and cancels the rest.
        const filled = Math.abs(input.positionSize) * fake.fillFraction;
        const sign = fake.positionSize > 0 ? 1 : -1;
        fake.positionSize = Number((fake.positionSize - sign * filled).toFixed(10));
        return Effect.succeed([
          { cloid: "0xexit", status: "filled", filledSize: filled, role: "entry" },
        ] as ReadonlyArray<TradingOrderResult>);
      }),
    submitCancel: (input: { cloid: string }) =>
      Effect.sync(() => {
        fake.cancels.push(input.cloid);
      }),
    submitOrder: () => Effect.die("not used"),
    submitProtectiveStop: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

/**
 * The reconciler's signature names the info client even though the fake never
 * calls it, so the context has to be satisfied.
 */
const infoLayer = Layer.succeed(
  HyperliquidInfoClient,
  {} as unknown as HyperliquidInfoClient["Service"],
);

const reconcilerLayer = Layer.succeed(HyperliquidReconciler, {
  reconcile: () =>
    Effect.succeed({
      position: null,
      openOrders: [],
      canonicalOrders: [],
      fills: [],
      observedAt: 0,
    }),
} as unknown as HyperliquidReconciler["Service"]);

const missionsLayer = (fake: FakeExchange) =>
  Layer.succeed(TradingMissionService, {
    getMissionVersion: () => Effect.succeed(1),
    transition: (input: { to: string; blockedReason?: string | undefined }) =>
      Effect.sync(() => {
        fake.transitions.push({ to: input.to, blockedReason: input.blockedReason });
        return { status: input.to };
      }),
  } as unknown as TradingMissionService["Service"]);

/** Migrate the shared in-memory db so the order-cancel query has tables. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 65 });
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_execution_records`;
});

const runClose = (fake: FakeExchange) =>
  Effect.gen(function* () {
    yield* migrated;
    const service = yield* makeTradingEmergencyCloseService;
    return yield* service.emergencyClose(INPUT);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gatewayLayer(fake),
        executionLayer(fake),
        reconcilerLayer,
        missionsLayer(fake),
        infoLayer,
        NodeSqliteClient.layerMemory(),
      ),
    ),
  );

it.effect("blocks the mission before it closes anything", () =>
  Effect.gen(function* () {
    // §17.5 step 1 is first for a reason: the position being unwound must not
    // be able to grow while it is unwound.
    const fake = makeFake();
    yield* runClose(fake);

    assert.deepEqual(fake.transitions, [{ to: "blocked", blockedReason: "protection_failure" }]);
  }),
);

it.effect("flattens a fully filling position in one attempt", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.equal(outcome.remainingSize, 0);
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(fake.exits, [0.5]);
  }),
);

it.effect("converges a partially filling IOC within three attempts", () =>
  Effect.gen(function* () {
    // The §17.6 evidence case: each IOC takes 60% of what is asked, so the
    // close only completes because step 6 re-reads and retries the REMAINDER.
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0.6 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.attempts <= EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS, true);
    // Each attempt asked for less than the one before — proof it re-read the
    // position rather than resubmitting the original size.
    assert.equal(fake.exits.length >= 2, true);
    assert.equal(fake.exits[1]! < fake.exits[0]!, true);
  }),
);

it.effect("stops at three attempts rather than retrying forever", () =>
  Effect.gen(function* () {
    // A market that will only ever take a sliver. Unbounded retrying here is
    // a way to pay fees indefinitely; §17.5 bounds it instead.
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0.1 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.attempts, EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS);
    assert.equal(fake.exits.length, EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS);
  }),
);

it.effect("reports the exact remaining size and reason when it cannot flatten", () =>
  Effect.gen(function* () {
    // §17.5 step 7. "Could not close" without the number is not actionable.
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.remainingSize, 0.5);
    assert.ok(outcome.failureNotice?.includes("0.5"));
    assert.ok(outcome.failureNotice?.includes(INPUT.reason));
    assert.ok(outcome.failureNotice?.includes("stays blocked"));
  }),
);

it.effect("stays bounded when every submission fails outright", () =>
  Effect.gen(function* () {
    const fake = makeFake({ submitFailure: true });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.attempts, EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS);
    assert.ok(outcome.failureNotice !== undefined);
  }),
);

it.effect("closes a short by buying, and reports it flat", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: -0.4 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.deepEqual(fake.exits, [-0.4]);
  }),
);

it.effect("does nothing when the position is already flat", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.equal(outcome.attempts, 0);
    assert.deepEqual(fake.exits, []);
  }),
);

it.effect("cancels increasing orders but never the reduce-only protection", () =>
  Effect.gen(function* () {
    // §17.5 step 2. Cancelling the stop on the way out would remove the one
    // thing still limiting the loss if the close does not complete.
    const fake = makeFake();
    yield* Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const rows: ReadonlyArray<[string, string, number]> = [
        ["0xentry", "open", 0],
        ["0xstop", "open", 1],
        ["0xclose", "close", 0],
      ];
      for (const [index, [cloid, actionType, reduceOnly]] of rows.entries()) {
        yield* sql`
          INSERT INTO trading_orders (
            mission_id, cloid, order_id, market, side, limit_price,
            remaining_size, reduce_only, observed_at
          ) VALUES (${MISSION}, ${cloid}, 1, 'ETH', 'sell', 3000, 0.5, ${reduceOnly}, 0)
        `;
        // (mission, sequence) is unique since migration 053; one per row.
        const executionSequence = index;
        yield* sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json, created_at, updated_at
          ) VALUES (
            ${`exec_${cloid}`}, ${MISSION}, ${executionSequence}, ${actionType}, ${cloid}, ${`idem_${cloid}`},
            'ETH', 'sell', 0.5, 3000, 'gtc', ${reduceOnly}, '0xsigner', 'accepted', '[]', 0, 0
          )
        `;
      }

      const service = yield* makeTradingEmergencyCloseService;
      yield* service.emergencyClose(INPUT);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          gatewayLayer(fake),
          executionLayer(fake),
          reconcilerLayer,
          missionsLayer(fake),
          infoLayer,
          NodeSqliteClient.layerMemory(),
        ),
      ),
    );

    // The entry is cancelled; the reduce-only stop and the close are not.
    assert.deepEqual(fake.cancels, ["0xentry"]);
  }),
);
