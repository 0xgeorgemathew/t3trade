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
  type TakeProfitInput,
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

/** The plan's basis for a long: reference 3000, target move 200 → TP at 3200. */
const TP_INPUT: TakeProfitInput = {
  missionId: "mission_protect",
  strategyVersion: 1,
  executionSequence: 0,
  masterAddress: MASTER,
  market: "ETH",
  targetBasis: { referencePrice: 3_000, measuredMoveUsd: 200 },
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

/** A resting reduce-only limit on the reducing side — the take-profit shape. */
const restingTakeProfit = (
  cloid: string,
  remainingSize: number,
  limitPrice: number,
  side: "sell" | "buy" = "sell",
): AgentOpenOrder =>
  ({
    market: "ETH",
    orderId: Math.floor(remainingSize * 10_000) + cloid.length,
    cloid,
    side,
    limitPrice,
    size: remainingSize,
    remainingSize,
    status: "open",
    createdAt: 1_000,
    reduceOnly: true,
    isTrigger: false,
    orderType: "Limit",
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
  /** Take-profit placements, with the limit price each was asked to rest at. */
  aloPlacements: Array<{ cloid: string; limitPrice: number; positionSize: number }>;
  cancels: string[];
  /** When set, stop placements fail with this message instead of resting. */
  placementFailure: string | undefined;
  /** When set, take-profit placements fail with this message instead of resting. */
  aloFailure: string | undefined;
  /** When true, a stop placement is accepted but never appears in canonical state. */
  swallowPlacements: boolean;
  /** When true, a take-profit placement is accepted but never appears in canonical state. */
  swallowAlo: boolean;
  /** Every placement and cancel, in the order they happened. */
  log: Array<"place" | "cancel">;
}

const makeFake = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: 0.5,
  markPrice: 3_000,
  orders: [],
  placements: [],
  aloPlacements: [],
  cancels: [],
  placementFailure: undefined,
  aloFailure: undefined,
  swallowPlacements: false,
  swallowAlo: false,
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
    submitReduceOnlyAlo: (input: {
      cloid: string;
      positionSize: number;
      limitPrice: number;
    }): Effect.Effect<ReadonlyArray<TradingOrderResult>, never> =>
      Effect.sync(() => {
        fake.log.push("place");
        fake.aloPlacements.push({
          cloid: input.cloid,
          limitPrice: input.limitPrice,
          positionSize: input.positionSize,
        });
        if (fake.aloFailure !== undefined) {
          return [
            {
              cloid: input.cloid,
              status: "error",
              reason: fake.aloFailure,
              role: "protection",
            },
          ] satisfies ReadonlyArray<TradingOrderResult>;
        }
        if (!fake.swallowAlo) {
          fake.orders.push(
            restingTakeProfit(
              input.cloid,
              Math.abs(input.positionSize),
              input.limitPrice,
              input.positionSize > 0 ? "sell" : "buy",
            ),
          );
        }
        return [
          { cloid: input.cloid, status: "resting", orderId: 2, role: "protection" },
        ] satisfies ReadonlyArray<TradingOrderResult>;
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

const runTakeProfit = (fake: FakeExchange, input: TakeProfitInput = TP_INPUT) =>
  runWithClock(fake, (service) => service.reconcileTakeProtection(input));

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

// --- plan 29 step 2.5: the resting reduce-only take-profit -------------------
//
// The stop tests above stay exactly as they were: the take-profit is a new
// reconciliation beside the stop, not a change to it. What these prove is the
// take-profit's own lifecycle — placed from the plan's target, replaced when
// the target moves, withdrawn when the plan or the position removes it — and
// that none of it can touch a stop.

it.effect("places a take-profit at the plan's derived target price", () =>
  Effect.gen(function* () {
    // Long 0.5 at mark 3000, plan basis reference 3000 + move 200 → the
    // profit is taken by selling 0.5 at 3200, resting as maker.
    const fake = makeFake();
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "placed");
    assert.equal(outcome.targetPrice, 3_200);
    assert.equal(fake.aloPlacements.length, 1);
    // Never larger than the position: the placement is sized to the canonical
    // size, which is the only authority on what there is to reduce.
    assert.equal(fake.aloPlacements[0]!.positionSize, 0.5);
    assert.equal(fake.aloPlacements[0]!.limitPrice, 3_200);

    const resting = fake.orders.find((o) => o.cloid === fake.aloPlacements[0]!.cloid);
    assert.ok(resting !== undefined);
    assert.equal(resting.reduceOnly, true);
    // A resting limit, not a trigger — the stop's wire shape stays the stop's.
    assert.equal(resting.isTrigger, false);
  }),
);

it.effect("derives a short take-profit below the plan's reference", () =>
  Effect.gen(function* () {
    // Short 0.5 at mark 3000, same basis: the target move flips to 2800 and
    // the reducing side flips to buy. A sign error here rests a limit on the
    // losing side that fills immediately at a loss.
    const fake = makeFake({ positionSize: -0.5 });
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "placed");
    assert.equal(outcome.targetPrice, 2_800);
    assert.equal(fake.aloPlacements[0]!.limitPrice, 2_800);
    const resting = fake.orders.find((o) => o.cloid === fake.aloPlacements[0]!.cloid);
    assert.ok(resting !== undefined);
    assert.equal(resting.side, "buy");
  }),
);

it.effect("replaces a moved target, confirming the new take-profit before cancelling the old", () =>
  Effect.gen(function* () {
    // The plan republished: 3100 became 3200. Same ordering rule as the stop
    // replacement — place, confirm, and only then cancel — because the gap
    // between a cancel and a placement is a take-profit that does not exist.
    const fake = makeFake({ orders: [restingTakeProfit("0xoldtp", 0.5, 3_100)] });
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "replaced");
    assert.deepEqual(fake.log, ["place", "cancel"]);
    assert.deepEqual(fake.cancels, ["0xoldtp"]);
    assert.deepEqual(outcome.cancelledCloids, ["0xoldtp"]);
    // And the replacement rests where the plan now says.
    assert.equal(fake.aloPlacements[0]!.limitPrice, 3_200);
  }),
);

it.effect("leaves the resting take-profit alone when it already matches the target", () =>
  Effect.gen(function* () {
    const fake = makeFake({ orders: [restingTakeProfit("0xtp", 0.5, 3_200)] });
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "unchanged");
    assert.deepEqual(fake.aloPlacements, []);
    assert.deepEqual(fake.cancels, []);
  }),
);

it.effect("places nothing and cancels nothing without a usable target", () =>
  Effect.gen(function* () {
    // targetBasis null: the plan stood down, published no basis, or flagged
    // insufficient volatility. No target means no order — and no leftover.
    const fake = makeFake();
    const outcome = yield* runTakeProfit(fake, { ...TP_INPUT, targetBasis: null });

    assert.equal(outcome.status, "withdrawn");
    assert.deepEqual(fake.aloPlacements, []);
    assert.deepEqual(fake.cancels, []);
  }),
);

it.effect("withdraws resting take-profits when the plan removes its target", () =>
  Effect.gen(function* () {
    const fake = makeFake({ orders: [restingTakeProfit("0xoldtp", 0.5, 3_100)] });
    const outcome = yield* runTakeProfit(fake, { ...TP_INPUT, targetBasis: null });

    assert.equal(outcome.status, "withdrawn");
    assert.deepEqual(fake.cancels, ["0xoldtp"]);
  }),
);

it.effect("leaves a harness-placed patient exit alone when the plan has no target", () =>
  Effect.gen(function* () {
    // A `patient` exit (plan 29 step 2.3) rests reduce-only on the reducing
    // side — the same shape as a take-profit, and only the execution record
    // says which is which. Cancelling it would undo the model's own decision
    // five seconds after it made it.
    const fake = makeFake({ orders: [restingTakeProfit("0xpatientexit", 0.5, 3_100)] });
    const outcome = yield* runTakeProfit(fake, {
      ...TP_INPUT,
      targetBasis: null,
      preserveCloids: ["0xpatientexit"],
    });

    assert.equal(outcome.status, "withdrawn");
    assert.deepEqual(fake.cancels, []);
  }),
);

it.effect("does not let a patient exit stand in for the plan's take-profit", () =>
  Effect.gen(function* () {
    // Preserved both ways: the harness's order is neither cancelled nor
    // counted as the plan's profit-taking, so the plan's own target still
    // goes on the book beside it. Both are reduce-only, so the pair cannot
    // take more than the position.
    const fake = makeFake({ orders: [restingTakeProfit("0xpatientexit", 0.5, 3_200)] });
    const outcome = yield* runTakeProfit(fake, {
      ...TP_INPUT,
      preserveCloids: ["0xpatientexit"],
    });

    assert.equal(outcome.status, "placed");
    assert.equal(fake.aloPlacements.length, 1);
    assert.equal(fake.aloPlacements[0]!.limitPrice, 3_200);
    assert.deepEqual(fake.cancels, []);
  }),
);

it.effect("withdraws a leftover take-profit when the position is flat", () =>
  Effect.gen(function* () {
    // The orphan case: the take-profit filled (or the position was closed
    // under it), the position is gone, and a reduce-only limit is still
    // resting. §17.2's flat return cancels nothing, so this pass owns the belt.
    const fake = makeFake({
      positionSize: 0,
      orders: [restingTakeProfit("0xorphantp", 0.5, 3_100)],
    });
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "flat");
    assert.deepEqual(fake.cancels, ["0xorphantp"]);
    assert.deepEqual(outcome.cancelledCloids, ["0xorphantp"]);
  }),
);

it.effect("keeps the old take-profit when the replacement never confirms", () =>
  Effect.gen(function* () {
    // The placement is accepted but never shows up in canonical state. The
    // old take-profit at 3100 must survive — cancelling it on the strength of
    // an unconfirmed response is the exact §17.1 assumption this service
    // exists to refuse.
    const fake = makeFake({
      orders: [restingTakeProfit("0xoldtp", 0.5, 3_100)],
      swallowAlo: true,
    });
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "failed");
    assert.deepEqual(fake.cancels, []);
    assert.ok(fake.orders.some((o) => o.cloid === "0xoldtp"));
  }),
);

it.effect("never touches a resting stop while reconciling the take-profit", () =>
  Effect.gen(function* () {
    // The stop is a trigger; the take-profit predicate matches resting limits
    // only. A stop in the book is invisible to this pass — not counted, not
    // cancelled, not replaced.
    const fake = makeFake({ orders: [restingStop("0xstop", 0.5)] });
    const outcome = yield* runTakeProfit(fake);

    assert.equal(outcome.status, "placed");
    assert.deepEqual(fake.cancels, []);
    const stop = fake.orders.find((o) => o.cloid === "0xstop");
    assert.ok(stop !== undefined);
    assert.equal(stop.isTrigger, true);
  }),
);
