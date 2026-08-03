/**
 * TradingProtectionService — §17.2 steps 5–9, §17.3, §17.4.
 *
 * The fake exchange here is a small state machine rather than a canned
 * response, because every property worth proving is about the ORDER of things:
 * that coverage is read back from canonical state instead of from the
 * placement's own response, that the superseded stop is cancelled only after
 * the replacement is confirmed, and that the window closes rather than
 * retrying forever. A stubbed one-shot response cannot distinguish any of
 * those from their broken versions.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import type { TradingOrderResult } from "@t3tools/trading-contracts/execution";

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import {
  makeTradingProtectionService,
  TradingProtectionService,
  type ProtectionInput,
} from "./TradingProtectionService.ts";

const MASTER = "0xmaster";

const INPUT: ProtectionInput = {
  missionId: "mission_protect",
  strategyVersion: 1,
  executionSequence: 0,
  masterAddress: MASTER,
  market: "ETH",
  stopPrice: 2_950,
};

/** A resting reduce-only stop below a long. */
const restingStop = (cloid: string, remainingSize: number): AgentOpenOrder =>
  ({
    market: "ETH",
    orderId: Math.floor(remainingSize * 1_000) + cloid.length,
    cloid,
    side: "sell",
    limitPrice: 2_920,
    size: remainingSize,
    remainingSize,
    status: "open",
    createdAt: 1_000,
    reduceOnly: true,
    isTrigger: true,
    triggerPrice: 2_950,
    orderType: "Stop Market",
  }) as AgentOpenOrder;

/**
 * The exchange, as far as this service can tell: a position, a set of resting
 * orders, and a record of what was asked of it.
 */
interface FakeExchange {
  positionSize: number;
  markPrice: number;
  orders: AgentOpenOrder[];
  placements: Array<{ cloid: string; positionSize: number }>;
  cancels: string[];
  /** When set, placements fail with this message instead of resting. */
  placementFailure: string | undefined;
  /** When true, a placement is accepted but never appears in canonical state. */
  swallowPlacements: boolean;
  /** Every placement and cancel, in the order they happened. */
  log: Array<"place" | "cancel">;
}

const makeFake = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: 0.5,
  markPrice: 3_000,
  orders: [],
  placements: [],
  cancels: [],
  placementFailure: undefined,
  swallowPlacements: false,
  log: [],
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
                  entryPrice: fake.markPrice,
                  // upnl 0 ⇒ mark === entry, which is what the service derives.
                  unrealisedPnl: 0,
                  marginUsed: 100,
                },
              ],
      }),
    getOpenOrders: () => Effect.succeed(fake.orders),
    resolveMarket: () => Effect.die("not used"),
    getOrderBook: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const executionLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitProtectiveStop: (input: {
      cloid: string;
      positionSize: number;
    }): Effect.Effect<ReadonlyArray<TradingOrderResult>, never> =>
      Effect.sync(() => {
        fake.log.push("place");
        fake.placements.push({ cloid: input.cloid, positionSize: input.positionSize });
        if (fake.placementFailure !== undefined) {
          return [
            {
              cloid: input.cloid,
              status: "error",
              reason: fake.placementFailure,
              role: "protection",
            },
          ] satisfies ReadonlyArray<TradingOrderResult>;
        }
        if (!fake.swallowPlacements) {
          fake.orders.push(restingStop(input.cloid, Math.abs(input.positionSize)));
        }
        return [
          { cloid: input.cloid, status: "resting", orderId: 1, role: "protection" },
        ] satisfies ReadonlyArray<TradingOrderResult>;
      }),
    submitCancel: (input: { cloid: string }) =>
      Effect.sync(() => {
        fake.log.push("cancel");
        fake.cancels.push(input.cloid);
        fake.orders = fake.orders.filter((o) => o.cloid !== input.cloid);
      }),
    submitOrder: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

const runWith = <A, E>(
  fake: FakeExchange,
  body: (service: TradingProtectionService["Service"]) => Effect.Effect<A, E, HyperliquidGateway>,
) =>
  Effect.gen(function* () {
    const service = yield* makeTradingProtectionService;
    return yield* body(service);
  }).pipe(Effect.provide(Layer.mergeAll(gatewayLayer(fake), executionLayer(fake))));

/**
 * The service polls inside the reconciliation window. Under TestClock those
 * sleeps never advance on their own, so the body runs forked and the clock is
 * pushed past the whole window.
 */
const runWithClock = <A, E>(
  fake: FakeExchange,
  body: (service: TradingProtectionService["Service"]) => Effect.Effect<A, E, HyperliquidGateway>,
) =>
  Effect.gen(function* () {
    const fiber = yield* runWith(fake, body).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("60 seconds");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped);

const runReconcile = (fake: FakeExchange, input: ProtectionInput = INPUT) =>
  runWithClock(fake, (service) => service.reconcileProtection(input));

it.effect("reports a flat position as nothing to protect", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runReconcile(fake);

    assert.equal(outcome.status, "flat");
    assert.equal(fake.placements.length, 0);
  }),
);

it.effect("places nothing when the canonical position is already covered", () =>
  Effect.gen(function* () {
    const fake = makeFake({ orders: [restingStop("0xexisting", 0.5)] });
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "already_protected");
    assert.equal(outcome.protectedSize, 0.5);
    // Nothing was placed and, crucially, nothing was cancelled: the existing
    // stop is the protection.
    assert.equal(fake.placements.length, 0);
    assert.deepEqual(fake.cancels, []);
  }),
);

it.effect("protects an uncovered position and confirms it from canonical state", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "protected");
    assert.equal(outcome.protectedSize, 0.5);
    assert.equal(fake.placements.length, 1);
    assert.equal(fake.placements[0]!.positionSize, 0.5);
  }),
);

it.effect("sizes protection to the canonical position, not the requested size", () =>
  Effect.gen(function* () {
    // §17.3: the IOC asked for 0.5 and filled 0.12. Protecting 0.5 would be
    // rejected or would over-hedge; protecting 0.12 is the invariant.
    const fake = makeFake({ positionSize: 0.12 });
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "protected");
    assert.equal(fake.placements[0]!.positionSize, 0.12);
    assert.equal(outcome.protectedSize, 0.12);
  }),
);

it.effect("tops up a position whose existing stop covers only part of it", () =>
  Effect.gen(function* () {
    // The §17.4 shape: a scale-in from 0.2 to 0.5 with the old 0.2 stop still
    // resting. A fixed-size trigger does not resize itself.
    const fake = makeFake({ positionSize: 0.5, orders: [restingStop("0xold", 0.2)] });
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "protected");
    // The replacement is sized to the whole canonical position, not to the
    // 0.3 shortfall — two partial stops at different prices would unwind the
    // position in pieces.
    assert.equal(fake.placements[0]!.positionSize, 0.5);
    // And only once the replacement is confirmed is the stale stop dropped.
    assert.deepEqual(outcome.replacedCloids, ["0xold"]);
    assert.deepEqual(fake.cancels, ["0xold"]);
  }),
);

it.effect("confirms the replacement BEFORE cancelling the superseded stop", () =>
  Effect.gen(function* () {
    // §17.4's ordering rule, and the only one that matters here. Cancelling
    // first would leave a moment with no protection at all — precisely the
    // window the invariant forbids. Overlapping reduce-only stops, by
    // contrast, cannot open exposure, so the safe order is place-then-cancel.
    const fake = makeFake({ positionSize: 0.5, orders: [restingStop("0xold", 0.2)] });
    yield* runReconcile(fake);

    assert.deepEqual(fake.log, ["place", "cancel"]);
  }),
);

it.effect("escalates when the window closes with the position still uncovered", () =>
  Effect.gen(function* () {
    // The placement is accepted but never shows up in canonical state — the
    // case where believing the response would report a naked position as safe.
    const fake = makeFake({ swallowPlacements: true });
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "escalate");
    assert.equal(outcome.protectedSize, 0);
    assert.ok(outcome.escalationReason?.includes("confirmed only 0"));
    // Bounded: it stops at the attempt limit rather than retrying forever.
    assert.equal(fake.placements.length, 3);
  }),
);

it.effect("escalates when every placement is rejected, and says why", () =>
  Effect.gen(function* () {
    const fake = makeFake({ placementFailure: "Insufficient margin" });
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "escalate");
    assert.ok(outcome.escalationReason?.includes("Insufficient margin"));
  }),
);

it.effect("does not count a take-profit as protection", () =>
  Effect.gen(function* () {
    // A TP above a long is reduce-only, a trigger, and on the reducing side.
    // Counting it would leave the entire downside uncovered while the position
    // read "protected".
    const takeProfit = { ...restingStop("0xtp", 0.5), triggerPrice: 3_200 } as AgentOpenOrder;
    const fake = makeFake({ orders: [takeProfit] });
    const outcome = yield* runReconcile(fake);
    assert.equal(outcome.status, "protected");
    // A real stop had to be placed despite the TP already resting.
    assert.equal(fake.placements.length, 1);
  }),
);

it.effect("does not count a non-reduce-only trigger as protection", () =>
  Effect.gen(function* () {
    const notReduceOnly = { ...restingStop("0xopen", 0.5), reduceOnly: false } as AgentOpenOrder;
    const fake = makeFake({ orders: [notReduceOnly] });
    const outcome = yield* runReconcile(fake);

    assert.equal(outcome.status, "protected");
    assert.equal(fake.placements.length, 1);
  }),
);

// ---------------------------------------------------------------------------
// §17.3 · Cancelling a partially filled parent
// ---------------------------------------------------------------------------

it.effect("protects the filled slice before it cancels a partially filled parent", () =>
  Effect.gen(function* () {
    // The §17.3 failure this prevents: the parent's linked children are
    // cancelled with it, so cancelling first would strip the filled slice of
    // its only stop and leave it open.
    const fake = makeFake({ positionSize: 0.12 });
    yield* runWithClock(fake, (service) =>
      service.cancelEntriesWithProtection({ ...INPUT, cloids: ["0xparent"] }),
    );

    assert.equal(fake.log[0], "place");
    assert.equal(fake.cancels.includes("0xparent"), true);
    assert.equal(fake.placements[0]!.positionSize, 0.12);
  }),
);

it.effect("replaces protection the parent cancel took with it", () =>
  Effect.gen(function* () {
    // §17.3 step 5. Cancelling a parent cancels its linked children, so the
    // reconcile AFTER the cancel is not belt-and-braces — it is the step that
    // notices the stop is gone and puts a new one back.
    const fake = makeFake({ positionSize: 0.12 });

    yield* runWithClock(fake, (service) =>
      Effect.gen(function* () {
        const first = yield* service.reconcileProtection(INPUT);
        assert.equal(first.status, "protected");
        // The parent cancel takes the linked child with it.
        fake.orders = [];
        return yield* service.reconcileProtection(INPUT);
      }),
    );

    assert.equal(fake.placements.length, 2);
  }),
);

it.effect("does not cancel the parent when the filled slice cannot be protected", () =>
  Effect.gen(function* () {
    // Cancelling here would trade a working entry for an unprotected position
    // with nothing left to cancel.
    const fake = makeFake({ positionSize: 0.12, swallowPlacements: true });
    const outcome = yield* runWithClock(fake, (service) =>
      service.cancelEntriesWithProtection({ ...INPUT, cloids: ["0xparent"] }),
    );

    assert.equal(outcome.status, "escalate");
    assert.deepEqual(fake.cancels, []);
  }),
);

// --- §17.4 stop replacement: moving a stop that is already good -------------
//
// `reconcileProtection` stops at `already_protected` — its job is to close a
// coverage gap, and a covered position has none. Trailing a stop is the case
// where coverage is fine and the price is wrong, which is why it needs its own
// entry point rather than a flag on that one.

it.effect("moves the stop and cancels the old one only after the new one is confirmed", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5, orders: [restingStop("0xold", 0.5)] });
    const outcome = yield* runWithClock(fake, (service) =>
      service.replaceProtection({ ...INPUT, stopPrice: 2_980 }),
    );

    assert.equal(outcome.status, "protected");
    // A fully covered position did not stop it: the new stop went out.
    assert.equal(fake.placements.length, 1);
    // And the order is the whole point — place, then cancel. Never the reverse.
    assert.deepEqual(fake.log, ["place", "cancel"]);
    assert.deepEqual(fake.cancels, ["0xold"]);
    assert.deepEqual(outcome.replacedCloids, ["0xold"]);
  }),
);

it.effect("leaves the old stop in place when the replacement never confirms", () =>
  Effect.gen(function* () {
    // The replacement is accepted but never appears in canonical state. Total
    // coverage still reads "fine" because the OLD stop is resting — which is
    // exactly the trap: a confirm that asks "is anything covering this?" would
    // answer yes and then cancel the only thing that was.
    const fake = makeFake({
      positionSize: 0.5,
      orders: [restingStop("0xold", 0.5)],
      swallowPlacements: true,
    });
    const outcome = yield* runWithClock(fake, (service) =>
      service.replaceProtection({ ...INPUT, stopPrice: 2_980 }),
    );

    assert.deepEqual(fake.cancels, []);
    // Reported as a failed adjustment, not as an uncovered position — the two
    // lead to very different places, one of them a forced close.
    assert.equal(outcome.status, "already_protected");
    assert.equal(outcome.protectedSize, 0.5);
  }),
);

it.effect("escalates when the replacement fails and nothing else covers the position", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5, swallowPlacements: true });
    const outcome = yield* runWithClock(fake, (service) =>
      service.replaceProtection({ ...INPUT, stopPrice: 2_980 }),
    );

    assert.equal(outcome.status, "escalate");
    assert.equal(outcome.protectedSize, 0);
  }),
);

it.effect("has nothing to move on a flat position", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runWithClock(fake, (service) =>
      service.replaceProtection({ ...INPUT, stopPrice: 2_980 }),
    );

    assert.equal(outcome.status, "flat");
    assert.equal(fake.placements.length, 0);
  }),
);
