/**
 * TradingPlanProtectionService — plan 29 step 4.5: the plan writes protection.
 *
 * The two properties worth proving are the step's own statements:
 * - a revision that tightens the stop MOVES the exchange stop at publish time
 *   (through `replaceProtection`, confirm-before-cancel);
 * - a revision that would widen the planned loss past the approved envelope is
 *   REFUSED — the exchange stop is left exactly where it is, and the refusal
 *   says the envelope in the words the publish response will carry.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { TradingPlanState } from "./Schemas.ts";
import {
  TradingPlanProtectionService,
  TradingPlanProtectionServiceLive,
} from "./TradingPlanProtectionService.ts";
import { TradingProtectionService } from "./TradingProtectionService.ts";

const MASTER = "0xmaster";
const MISSION = "mission_plan_protect";

/** A long of 0.5 ETH entered at 3,000 — the canonical read the fakes report. */
const LONG_SIZE = 0.5;
const ENTRY = 3_000;

/** A plan whose stop sits where the test wants it. */
const plan = (stopPrice: number, overrides: Partial<TradingPlanState> = {}): TradingPlanState =>
  ({
    market: "ETH",
    intent: "long",
    entry: { triggers: [], urgency: "now" },
    stop: { method: "fixed", price: stopPrice },
    target: { profitUsd: 25 },
    invalidation: [],
    reassess: { afterMinutes: 90 },
    because: "test plan",
    updatedAt: 1_000,
    ...overrides,
  }) as TradingPlanState;

/** A resting reduce-only stop trigger for the long, at `price`. */
const restingStop = (price: number, remainingSize = LONG_SIZE): AgentOpenOrder =>
  ({
    market: "ETH",
    orderId: 1,
    cloid: "0xstop",
    side: "sell",
    limitPrice: price - 10,
    size: remainingSize,
    remainingSize,
    status: "open",
    createdAt: 1_000,
    reduceOnly: true,
    isTrigger: true,
    triggerPrice: price,
    orderType: "Stop Market",
  }) as AgentOpenOrder;

/** What the fake exchange holds, plus what the protection service was asked. */
interface FakeExchange {
  positionSize: number;
  orders: AgentOpenOrder[];
  /** replaceProtection calls, with the stop price each was asked to rest at. */
  replacements: Array<{ readonly stopPrice: number }>;
  /** reconcileTakeProtection calls, with the target each was handed. */
  takeTargets: Array<{
    readonly takeProfitPrice: number | null;
    readonly targetProfitUsd: number | null;
  }>;
}

const makeFake = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: LONG_SIZE,
  orders: [restingStop(2_950)],
  replacements: [],
  takeTargets: [],
  ...overrides,
});

const gatewayLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.succeed({
        positions:
          fake.positionSize === 0
            ? []
            : [
                {
                  market: "ETH",
                  size: fake.positionSize,
                  entryPrice: ENTRY,
                  // upnl 0 ⇒ mark === entry, the price the coverage read derives.
                  unrealisedPnl: 0,
                  marginUsed: 100,
                },
              ],
      }),
    getOpenOrders: () => Effect.succeed(fake.orders),
  } as unknown as HyperliquidGateway["Service"]);

const protectionLayer = (fake: FakeExchange) =>
  Layer.succeed(TradingProtectionService, {
    // The stop leg. The fake records the ask; whether the exchange confirms
    // is the protection service's own contract, tested in its own file.
    replaceProtection: (input: { readonly stopPrice: number }) =>
      Effect.sync(() => {
        fake.replacements.push({ stopPrice: input.stopPrice });
        return {
          status: "protected",
          positionSize: fake.positionSize,
          protectedSize: Math.abs(fake.positionSize),
          replacedCloids: ["0xstop"],
        };
      }),
    reconcileProtection: (input: { readonly stopPrice: number }) =>
      Effect.sync(() => {
        fake.replacements.push({ stopPrice: input.stopPrice });
        return {
          status: "protected",
          positionSize: fake.positionSize,
          protectedSize: Math.abs(fake.positionSize),
          replacedCloids: [],
        };
      }),
    // The target leg. The fake records the plan-derived target it was handed.
    reconcileTakeProtection: (input: {
      readonly target: {
        readonly takeProfitPrice: number | null;
        readonly targetProfitUsd: number | null;
      } | null;
    }) =>
      Effect.sync(() => {
        fake.takeTargets.push({
          takeProfitPrice: input.target?.takeProfitPrice ?? null,
          targetProfitUsd: input.target?.targetProfitUsd ?? null,
        });
        return {
          status: "unchanged",
          positionSize: fake.positionSize,
          targetPrice: null,
          cancelledCloids: [],
        };
      }),
  } as unknown as TradingProtectionService["Service"]);

/** Migrate and seed the position row plus the entry's approved envelope. */
const seed = (input?: { readonly envelopeUsd?: number | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 65 });
    yield* sql`DELETE FROM trading_position_snapshots`;
    yield* sql`DELETE FROM trading_execution_records`;
    yield* sql`
      INSERT INTO trading_position_snapshots (
        mission_id, market, size, unrealised_pnl, margin_used, protected_size,
        entry_price, opened_at, observed_at
      ) VALUES (
        ${MISSION}, 'ETH', ${LONG_SIZE}, 0, 100, ${LONG_SIZE}, ${ENTRY}, 500, 1000
      )
    `;
    if (input?.envelopeUsd !== null) {
      yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, execution_sequence, action_type, cloid,
          idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json,
          created_at, updated_at, stop_price, planned_loss_at_stop_usd
        ) VALUES (
          'exec_entry', ${MISSION}, 0, 'open', '0xentry', 'idem_entry',
          'ETH', 'buy', ${LONG_SIZE}, ${ENTRY}, 'ioc', 0, '0xsigner', 'filled', '[]',
          600, 600, 2950, ${input?.envelopeUsd ?? 25}
        )
      `;
    }
  });

/** Run one reconcile against its own fake exchange and memory database. */
const reconcile = (
  fake: FakeExchange,
  planState: TradingPlanState,
  seedOptions?: Parameters<typeof seed>[0],
) =>
  Effect.gen(function* () {
    yield* seed(seedOptions);
    const service = yield* TradingPlanProtectionService;
    return yield* service.reconcilePlan({
      missionId: MISSION,
      masterAddress: MASTER,
      plan: planState,
    });
  }).pipe(
    Effect.provide(
      TradingPlanProtectionServiceLive.pipe(
        Layer.provide(gatewayLayer(fake)),
        Layer.provide(protectionLayer(fake)),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
      ),
    ),
  );

describe("TradingPlanProtectionService (plan 29 step 4.5)", () => {
  it.effect("moves the exchange stop when a revision tightens it", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      // Resting at 2,950 (a $25 planned loss on 0.5 ETH); the plan tightens
      // to 2,970 — a $15 loss, comfortably inside the $25 envelope.
      const outcome = yield* reconcile(fake, plan(2_970));

      assert.equal(outcome.stopStatus, "moved");
      assert.equal(outcome.refusal, undefined);
      assert.deepEqual(
        fake.replacements.map((r) => r.stopPrice),
        [2_970],
      );
    }),
  );

  it.effect("refuses to widen past the approved envelope and says so", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const outcome = yield* reconcile(fake, plan(2_800));

      // 2,800 on 0.5 ETH from 3,000 plans a $100 loss — four times the $25
      // the entry was approved with. The stop must not move.
      assert.equal(outcome.stopStatus, "refused");
      assert.deepEqual(fake.replacements, []);
      assert.include(outcome.refusal ?? "", "beyond the $25.00 approved");
      assert.include(outcome.refusal ?? "", "left where it is");
    }),
  );

  it.effect("refuses a stop on the winning side of the mark", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      // 3,050 above the 3,000 mark for a long is not a stop at all: it would
      // trigger the moment it rested and close the position at market. It
      // also plans no loss, so the envelope check alone would wave it through.
      const outcome = yield* reconcile(fake, plan(3_050));

      assert.equal(outcome.stopStatus, "refused");
      assert.deepEqual(fake.replacements, []);
      assert.include(outcome.refusal ?? "", "not on the losing side");
    }),
  );

  it.effect("moves the stop within the envelope even when that widens the loss", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      // 2,960 plans a $20 loss versus the $15 currently resting — a widening
      // move, but inside the $25 envelope, so it goes through. The constraint
      // is the envelope, not the current stop.
      const outcome = yield* reconcile(fake, plan(2_960));

      assert.equal(outcome.stopStatus, "moved");
      assert.deepEqual(
        fake.replacements.map((r) => r.stopPrice),
        [2_960],
      );
    }),
  );

  it.effect("hands the take-profit leg the plan's own target fields", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* reconcile(fake, plan(2_970, { target: { price: 3_100, profitUsd: 40 } }));

      assert.deepEqual(fake.takeTargets, [{ takeProfitPrice: 3_100, targetProfitUsd: 40 }]);
    }),
  );

  it.effect("a stand-aside plan withdraws the resting target", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      yield* reconcile(fake, plan(2_970, { intent: "stand_aside", target: {} }));

      assert.deepEqual(fake.takeTargets, [{ takeProfitPrice: null, targetProfitUsd: null }]);
    }),
  );

  it.effect("leaves the stop alone when the plan states no price", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const outcome = yield* reconcile(fake, {
        ...plan(0),
        stop: { method: "volatility room" },
      } as TradingPlanState);

      assert.equal(outcome.stopStatus, "no_stop_stated");
      assert.deepEqual(fake.replacements, []);
    }),
  );
});
