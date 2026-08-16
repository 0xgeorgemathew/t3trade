/**
 * TradingControlService — the §14.7 deterministic user-control API.
 *
 * The defining property is negative, so it is tested negatively: NO service
 * this suite provides can serve a harness turn. There is no turn coordinator,
 * no wakeup composer, no provider session, no harness binding, and the preview
 * service is absent rather than stubbed green — if any control reached for one
 * of them, the layer would fail to build and every test here would fail.
 *
 * That is the closest a unit test can get to "verified with the provider
 * process stopped", and it is stronger than a stub: a stub proves the call
 * was made and answered, while an absent service proves the call is never
 * made at all.
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
import { TradingProtectionService } from "./TradingProtectionService.ts";
import {
  makeTradingControlService,
  type ExchangeControlInput,
  type TradingControlService,
} from "./TradingControlService.ts";

const MISSION = "mission_control";

const TARGET: ExchangeControlInput = {
  missionId: MISSION,
  masterAddress: "0xmaster",
  market: "ETH",
};

interface Fake {
  positionSize: number;
  exits: number[];
  cancels: string[];
  transitions: string[];
  protectedCancels: Array<ReadonlyArray<string>>;
  protectionEscalates: boolean;
}

const makeFake = (overrides: Partial<Fake> = {}): Fake => ({
  positionSize: 0.5,
  exits: [],
  cancels: [],
  transitions: [],
  protectedCancels: [],
  protectionEscalates: false,
  ...overrides,
});

const gatewayLayer = (fake: Fake) =>
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
    getOrderBook: () => Effect.succeed({ bestBidOffer: { bidPrice: 2_999, askPrice: 3_001 } }),
    getOpenOrders: () => Effect.succeed([]),
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const executionLayer = (fake: Fake) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitReduceOnlyIoc: (input: { positionSize: number }) =>
      Effect.sync(() => {
        fake.exits.push(input.positionSize);
        const sign = fake.positionSize > 0 ? 1 : -1;
        fake.positionSize = Number(
          (fake.positionSize - sign * Math.abs(input.positionSize)).toFixed(10),
        );
        return [
          { cloid: "0xexit", status: "filled", role: "entry" },
        ] as ReadonlyArray<TradingOrderResult>;
      }),
    submitCancel: (input: { cloid: string }) =>
      Effect.sync(() => {
        fake.cancels.push(input.cloid);
      }),
    // Present so the layer builds, but a control that reached the full submit
    // path would need a preview context — which is exactly what these must not
    // require, so it dies rather than returning something plausible.
    submitOrder: () => Effect.die("a deterministic control must not use the preview path"),
    submitProtectiveStop: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

const protectionLayer = (fake: Fake) =>
  Layer.succeed(TradingProtectionService, {
    reconcileProtection: () => Effect.die("not used directly by the control service"),
    cancelEntriesWithProtection: (input: { cloids: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        fake.protectedCancels.push(input.cloids);
        return {
          status: fake.protectionEscalates ? "escalate" : "protected",
          positionSize: fake.positionSize,
          protectedSize: fake.protectionEscalates ? 0 : Math.abs(fake.positionSize),
          replacedCloids: [],
        };
      }),
  } as unknown as TradingProtectionService["Service"]);

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

const missionsLayer = (fake: Fake) =>
  Layer.succeed(TradingMissionService, {
    getMissionVersion: () => Effect.succeed(1),
    transition: (input: { to: string }) =>
      Effect.sync(() => {
        fake.transitions.push(input.to);
        return { status: input.to };
      }),
  } as unknown as TradingMissionService["Service"]);

const infoLayer = Layer.succeed(
  HyperliquidInfoClient,
  {} as unknown as HyperliquidInfoClient["Service"],
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 65 });
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_execution_records`;
});

/**
 * Build the control service over a deliberately harness-free context.
 *
 * Absent here, and absent on purpose: TradingTurnCoordinator,
 * TradingWakeupComposer, TradingPreviewService, TradingEventInbox,
 * ProviderService, and the orchestration engine. If a control needed any of
 * them, this would not compile or would not build.
 */
const runControl = <A, E>(
  fake: Fake,
  body: (service: TradingControlService["Service"]) => Effect.Effect<A, E>,
  seed: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    yield* migrated;
    yield* seed;
    const service = yield* makeTradingControlService;
    return yield* body(service);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gatewayLayer(fake),
        executionLayer(fake),
        protectionLayer(fake),
        reconcilerLayer,
        missionsLayer(fake),
        infoLayer,
        NodeSqliteClient.layerMemory(),
      ),
    ),
  );

/** Insert a resting order plus the execution record that names its action. */
let seededSequence = 0;
const seedOrder = (
  cloid: string,
  actionType: string,
  reduceOnly: number,
  stopPrice: number | null,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_orders (
        mission_id, cloid, order_id, market, side, limit_price,
        remaining_size, reduce_only, observed_at
      ) VALUES (${MISSION}, ${cloid}, 1, 'ETH', 'buy', 3000, 0.5, ${reduceOnly}, 0)
    `;
    // One sequence per row: (mission, sequence) is unique since migration 053.
    const executionSequence = seededSequence++;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at,
        stop_price
      ) VALUES (
        ${`exec_${cloid}`}, ${MISSION}, ${executionSequence}, ${actionType}, ${cloid}, ${`idem_${cloid}`},
        'ETH', 'buy', 0.5, 3000, 'gtc', ${reduceOnly}, '0xsigner', 'accepted', '[]', 0, 0,
        ${stopPrice}
      )
    `;
  }).pipe(Effect.orDie);

// ---------------------------------------------------------------------------
// Lifecycle controls
// ---------------------------------------------------------------------------

it.effect("pause blocks entries without standing down the stop", () =>
  Effect.gen(function* () {
    // §14.7's paused card promises the stop stays live on-exchange. A pause
    // that cancelled protection would make that card a lie.
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.pause({ missionId: MISSION }));

    assert.equal(outcome.status, "paused");
    assert.deepEqual(fake.transitions, ["paused"]);
    assert.deepEqual(fake.cancels, []);
    assert.deepEqual(fake.exits, []);
    assert.ok(outcome.summary.includes("protection stays live"));
  }),
);

it.effect("resume returns the mission to analysing", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.resume({ missionId: MISSION }));
    assert.equal(outcome.status, "analysing");
  }),
);

it.effect("revoke ends authority and preserves protection", () =>
  Effect.gen(function* () {
    // Revocation ends what the harness may do. Cancelling the stop at the same
    // time would end the safety net along with the authority.
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.revoke({ missionId: MISSION }));

    assert.equal(outcome.status, "revoked");
    assert.deepEqual(fake.cancels, []);
    assert.ok(outcome.summary.includes("protection stays live"));
  }),
);

// ---------------------------------------------------------------------------
// Exchange-touching controls
// ---------------------------------------------------------------------------

it.effect("cancel_entries protects the filled slice before cancelling", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    // It routed through the §17.3 protected-cancel path, not a bare cancel.
    assert.deepEqual(fake.protectedCancels, [["0xentry"]]);
    assert.deepEqual(fake.cancels, []);
    assert.ok(outcome.summary.includes("stays protected"));
  }),
);

it.effect("cancel_entries leaves reduce-only protection alone", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      Effect.gen(function* () {
        yield* seedOrder("0xentry", "open", 0, 2_950);
        yield* seedOrder("0xstop", "open", 1, 2_950);
      }),
    );

    // Only the non-reduce-only entry is a candidate. Cancelling the stop would
    // strip the position of the thing limiting its loss.
    assert.deepEqual(fake.protectedCancels, [["0xentry"]]);
  }),
);

it.effect("cancel_entries does not cancel when protection could not be established", () =>
  Effect.gen(function* () {
    const fake = makeFake({ protectionEscalates: true });
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    assert.ok(outcome.summary.includes("could not be protected"));
  }),
);

it.effect("cancel_entries reports plainly when nothing is resting", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.cancelEntries(TARGET));

    assert.deepEqual(fake.protectedCancels, []);
    assert.ok(outcome.summary.includes("No resting entry orders"));
  }),
);

it.effect("reduce_position takes the requested fraction of the canonical position", () =>
  Effect.gen(function* () {
    for (const [percent, expected] of [
      [25, 0.125],
      [50, 0.25],
      [75, 0.375],
      [100, 0.5],
    ] as const) {
      const fake = makeFake({ positionSize: 0.5 });
      yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent }));
      assert.equal(fake.exits[0], expected, `${percent}%`);
    }
  }),
);

it.effect("reduce_position sizes off the canonical position, not a remembered one", () =>
  Effect.gen(function* () {
    // The position moved since the button was rendered. 50% means 50% of what
    // exists now.
    const fake = makeFake({ positionSize: 0.2 });
    yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));
    assert.equal(fake.exits[0], 0.1);
  }),
);

it.effect("reduce_position reduces a short by buying", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: -0.4 });
    yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));
    assert.equal(fake.exits[0], -0.2);
  }),
);

it.effect("close_position closes the whole canonical position", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5 });
    const outcome = yield* runControl(fake, (s) => s.closePosition(TARGET));

    assert.deepEqual(fake.exits, [0.5]);
    assert.equal(outcome.positionSize, 0);
    assert.ok(outcome.summary.includes("closed"));
  }),
);

it.effect("close_position on a flat position does nothing", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runControl(fake, (s) => s.closePosition(TARGET));

    assert.deepEqual(fake.exits, []);
    assert.ok(outcome.summary.includes("Already flat"));
  }),
);

it.effect("close_and_revoke closes first, then revokes", () =>
  Effect.gen(function* () {
    // The order matters: revoking first would end the authority the close
    // itself runs under.
    const fake = makeFake({ positionSize: 0.5 });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevoke(TARGET));

    assert.deepEqual(fake.exits, [0.5]);
    assert.deepEqual(fake.transitions, ["revoked"]);
    assert.equal(outcome.status, "revoked");
  }),
);

it.effect("every control runs with no harness service in context", () =>
  Effect.gen(function* () {
    // The negative property §14.7 turns on, exercised across all seven in one
    // context that contains no coordinator, no preview service, no provider
    // session, and no harness binding. Reaching for any of them would fail to
    // build rather than fall back.
    const fake = makeFake({ positionSize: 0.5 });
    const summaries = yield* runControl(
      fake,
      (s) =>
        Effect.gen(function* () {
          const pause = yield* s.pause({ missionId: MISSION });
          const resume = yield* s.resume({ missionId: MISSION });
          const cancel = yield* s.cancelEntries(TARGET);
          const reduce = yield* s.reducePosition({ ...TARGET, percent: 25 });
          const close = yield* s.closePosition(TARGET);
          const revoke = yield* s.revoke({ missionId: MISSION });
          const closeRevoke = yield* s.closeAndRevoke(TARGET);
          return [pause, resume, cancel, reduce, close, revoke, closeRevoke].map((o) => o.summary);
        }),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    assert.equal(summaries.length, 7);
    assert.equal(
      summaries.every((s) => s.length > 0),
      true,
    );
  }),
);
