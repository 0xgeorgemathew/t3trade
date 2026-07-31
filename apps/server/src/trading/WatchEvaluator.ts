/**
 * WatchEvaluator - evaluates persisted watches against live market data, spec §12.1.
 *
 * Two entry points feed it:
 *  - WS candle deliveries (one subscription per direct interval, §13) drive the
 *    `candle_close` watches.
 *  - A slow periodic sweep drives the `price_cross` watches (fresh BBO/mark via
 *    the gateway, whose §13 freshness windows apply) and fires
 *    `scheduled_reassessment` watches whose `runAt` has passed.
 *
 * On a match it flips the watch `active → triggered`, persists an inbox event
 * keyed for deduplication, and announces the firing on the orchestration stream
 * — the `TradingMissionReactor` turns that announcement into a
 * `TradingTurnCoordinator.requestRun`.
 *
 * "Fires exactly once" rests on two guards, both durable:
 *  - `markTriggered` only flips an `active` watch (atomic UPDATE), so a
 *    concurrent replay, supersede, or cancel drops the firing.
 *  - The inbox deduplication key is scoped per watch (`type:watchId:...`), so a
 *    replay after a restart cannot generate a second wake-up.
 *
 * The evaluator never starts a run itself; the turn coordinator owns the lease
 * and the wake path. A watch firing does not authorize a position (§12.4).
 *
 * @module WatchEvaluator
 */
import type { ThreadId, TradingMissionId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { HyperliquidWebSocketClient, type WsDelivery } from "@t3tools/hyperliquid/WebSocketClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { type PersistenceSqlError } from "../persistence/Errors.ts";
import type { PersistedWatch } from "./Schemas.ts";
import { TradingTimeframe } from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

/** The POC market every mission trades (§10.1). */
const POC_MARKET = "ETH";

/**
 * The five §13 direct candle intervals. Subscribing to all of them keeps the
 * evaluator free of per-watch subscription management: a candle-close watch on
 * any direct interval is evaluated the moment its candle arrives.
 */
const DIRECT_INTERVALS = TradingTimeframe.literals;

/**
 * How often the sweep re-reads price-cross and scheduled watches. Matches the
 * §13 BBO freshness window so a price-cross is evaluated against data no older
 * than the gateway would serve anyway.
 */
const SWEEP_INTERVAL = "2 seconds";

export interface WatchEvaluatorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when all in-flight evaluations have settled. For tests. */
  readonly drain: Effect.Effect<void>;
  /**
   * Evaluate a single WS delivery against the candle-close watches it could
   * match. This is what the forked stream consumers call per delivery;
   * exposing it lets tests drive evaluation synchronously (the
   * fires-exactly-once invariant) without racing a forked fiber.
   */
  readonly evaluateDelivery: (delivery: WsDelivery) => Effect.Effect<void, PersistenceSqlError>;
  /**
   * One pass of the periodic sweep: evaluate active price-cross watches against
   * a fresh gateway snapshot and fire due scheduled reassessments. The forked
   * sweep loop calls this on `SWEEP_INTERVAL`; exposed for tests.
   */
  readonly sweep: Effect.Effect<void, PersistenceSqlError>;
}

export class WatchEvaluator extends Context.Service<WatchEvaluator, WatchEvaluatorShape>()(
  "t3/trading/WatchEvaluator",
) {}

/**
 * A watch the evaluator is tracking, with its bound mission and thread so a
 * firing can announce on the right orchestration stream.
 */
export interface TrackedWatch {
  readonly watch: PersistedWatch;
  readonly missionId: TradingMissionId;
  readonly threadId: ThreadId;
}

/** A firing the evaluator queued for processing. */
interface PendingFire {
  readonly tracked: TrackedWatch;
  readonly deduplicationKey: string;
  readonly summary: string;
  readonly payload: unknown;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const nowMs = Clock.currentTimeMillis;

/** Read a numeric field off an unknown payload, tolerating string-encoded numbers. */
const num = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** Read a field off an unknown object payload. */
const field = (data: unknown, key: string): unknown => {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
};

/**
 * The candle payload delivered over the WS `candle` channel is an array whose
 * first element carries `{t, T, s, i, o, c, h, l, v, n}` (per the wire schema).
 */
const candleFromDelivery = (delivery: WsDelivery) => {
  const data = delivery.data;
  const candle = Array.isArray(data) ? data[0] : data;
  const closeTime = num(field(candle, "T"));
  const close = num(field(candle, "c"));
  if (closeTime === undefined || close === undefined) return undefined;
  return { closeTime, close };
};

const make = Effect.gen(function* () {
  const ws = yield* HyperliquidWebSocketClient;
  const gateway = yield* HyperliquidGateway;
  const watches = yield* TradingWatchService;
  const strategies = yield* TradingStrategyService;
  const missions = yield* TradingMissionService;
  const inbox = yield* TradingEventInbox;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const announceFired = Effect.fn("WatchEvaluator.announceFired")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly watchId: string;
    readonly deduplicationKey: string;
  }) {
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine.dispatch({
      type: "trading.mission.watch-fired",
      commandId: CommandId.make(commandId),
      threadId: input.threadId,
      missionId: input.missionId,
      watchId: input.watchId,
      deduplicationKey: input.deduplicationKey,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Process a queued firing: flip the watch to `triggered`, persist the inbox
   * event, and announce on the orchestration stream.
   *
   * `markTriggered` is the authoritative single-fire guard — if a concurrent
   * supersede or cancel already moved the watch off `active`, this returns
   * `null` and the firing is dropped (the inbox event is never persisted).
   */
  const processFire = (fire: PendingFire) =>
    Effect.gen(function* () {
      const triggered = yield* watches.markTriggered(fire.tracked.watch.id);
      if (triggered === null) return;

      const occurredAt = yield* nowMs;
      yield* inbox.persist({
        missionId: fire.tracked.missionId,
        category: fire.tracked.watch.watch.type === "scheduled_reassessment" ? "timer" : "market",
        deduplicationKey: fire.deduplicationKey,
        payload: fire.payload,
        occurredAt,
        summary: fire.summary,
      });

      yield* announceFired({
        missionId: fire.tracked.missionId,
        threadId: fire.tracked.threadId,
        watchId: fire.tracked.watch.id,
        deduplicationKey: fire.deduplicationKey,
      });
    });

  const worker = yield* makeDrainableWorker((fire: PendingFire) =>
    processFire(fire).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("WatchEvaluator could not process a firing", {
          watchId: fire.tracked.watch.id,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const enqueueFire = (
    tracked: TrackedWatch,
    dedupeKey: string,
    summary: string,
    payload: unknown,
  ) => worker.enqueue({ tracked, deduplicationKey: dedupeKey, summary, payload });

  /**
   * The active watches of the active mission, with mission and thread binding.
   * The POC has one active mission; a multi-mission fork generalizes this read.
   */
  const activeTrackedWatches = Effect.fn("WatchEvaluator.activeTrackedWatches")(function* () {
    const mission = yield* missions.findActiveMission("local");
    if (mission._tag === "None") return [] as ReadonlyArray<TrackedWatch>;
    const all = yield* strategies.listWatches(mission.value.id);
    const threadId = mission.value.harness.threadId as ThreadId;
    return all
      .filter((watch) => watch.status === "active")
      .map((watch) => ({ watch, missionId: mission.value.id as TradingMissionId, threadId }));
  });

  /**
   * Evaluate a `candle_close` watch against a delivered candle.
   *
   * Fires only on a final close (close time has passed). The predicate is a
   * directional price comparison against the candle's close; the dedupe key is
   * scoped per watch and close so a replay cannot wake the harness twice.
   */
  const evaluateCandleClose = (tracked: TrackedWatch, delivery: WsDelivery) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "candle_close") return;
      if (delivery.subscription.interval !== watch.interval) return;

      const parsed = candleFromDelivery(delivery);
      if (parsed === undefined) return;

      const observedAt = yield* nowMs;
      // §13: a candle is finalised only after its close time has passed.
      if (parsed.closeTime > observedAt) return;

      const matched =
        watch.direction === "above" ? parsed.close >= watch.price : parsed.close <= watch.price;
      if (!matched) return;

      yield* enqueueFire(
        tracked,
        `candle_close:${tracked.watch.id}:${parsed.closeTime}`,
        `${watch.interval} candle closed ${parsed.close} (${watch.direction} ${watch.price})`,
        { closeTime: parsed.closeTime, close: parsed.close, watchId: tracked.watch.id },
      );
    });

  /**
   * Evaluate a `price_cross` watch against a fresh BBO/mark snapshot.
   *
   * Freshness is enforced by reading through the gateway (§13: BBO stale after
   * 2s, asset context 5s) rather than trusting a single WS tick.
   */
  const evaluatePriceCross = Effect.fn("WatchEvaluator.evaluatePriceCross")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "price_cross") return;

    const snapshot = yield* gateway.getMarketSnapshot(watch.market).pipe(Effect.orDie);
    const reference = watch.priceSource === "mark" ? snapshot.markPrice : snapshot.midPrice;

    const matched =
      watch.direction === "above" ? reference >= watch.price : reference <= watch.price;
    if (!matched) return;

    const observedAt = yield* nowMs;
    yield* enqueueFire(
      tracked,
      `price_cross:${tracked.watch.id}`,
      `${watch.priceSource} ${watch.market} crossed ${watch.direction} ${watch.price} (at ${reference})`,
      { reference, observedAt, watchId: tracked.watch.id },
    );
  });

  /** Fire a `scheduled_reassessment` watch whose `runAt` has passed. */
  const evaluateScheduled = (tracked: TrackedWatch, observedAt: number) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "scheduled_reassessment") return;
      if (watch.runAt > observedAt) return;

      yield* enqueueFire(
        tracked,
        `scheduled_reassessment:${tracked.watch.id}`,
        `scheduled reassessment due at ${DateTime.formatIso(DateTime.makeUnsafe(watch.runAt))}`,
        { runAt: watch.runAt, observedAt, watchId: tracked.watch.id },
      );
    });

  const evaluateDelivery: WatchEvaluatorShape["evaluateDelivery"] = (delivery) =>
    Effect.gen(function* () {
      const interval = delivery.subscription.interval;
      if (interval === undefined) return;
      const tracked = yield* activeTrackedWatches();
      yield* Effect.forEach(tracked, (t) => evaluateCandleClose(t, delivery));
    });

  const sweep: WatchEvaluatorShape["sweep"] = Effect.gen(function* () {
    const tracked = yield* activeTrackedWatches();
    const observedAt = yield* nowMs;
    for (const t of tracked) {
      switch (t.watch.watch.type) {
        case "price_cross":
          yield* evaluatePriceCross(t);
          break;
        case "scheduled_reassessment":
          yield* evaluateScheduled(t, observedAt);
          break;
        default:
          break;
      }
    }
  });

  const start: WatchEvaluatorShape["start"] = () =>
    Effect.gen(function* () {
      // One candle subscription per §13 direct interval for the POC market.
      // Deliveries route to the candle-close watches bound to that interval.
      //
      // The forked consumers read the services the evaluator captured at build,
      // so nothing extra is required in the forked fibers' context.
      for (const interval of DIRECT_INTERVALS) {
        const subscription = ws.subscribe({ type: "candle", coin: POC_MARKET, interval });
        yield* Effect.forkScoped(
          Stream.runForEach(subscription, (delivery) =>
            evaluateDelivery(delivery).pipe(Effect.ignore),
          ),
        );
      }

      // The slow sweep for price-cross and scheduled watches.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* sweep.pipe(Effect.ignore);
            yield* Effect.sleep(SWEEP_INTERVAL);
          }
        }),
      );
    });

  return { start, drain: worker.drain, evaluateDelivery, sweep } satisfies WatchEvaluatorShape;
});

export const WatchEvaluatorLive = Layer.effect(WatchEvaluator, make);
