/**
 * WatchEvaluator - evaluates persisted watches against live market data, spec §12.1.
 *
 * Subscribes to the Hyperliquid WebSocket client (PROMPT-02) for the channels
 * active watches care about, and runs the simple, deterministic predicate each
 * watch declares. On a match it flips the watch `active → triggered`, persists
 * an inbox event keyed for deduplication, and announces the firing on the
 * orchestration stream so the turn coordinator and the workspace see it.
 *
 * Invariants the evaluator enforces:
 * - A `candle_close` watch fires only on a final close (close time has passed)
 *   and at most once per `(watch, closeTime)` — a replayed closed candle is
 *   dropped by the seen-close set and, redundantly, by the inbox dedupe key.
 * - A `price_cross` watch evaluates against fresh BBO/mark only (§13: BBO 2s).
 *
 * The evaluator never starts a run itself; the turn coordinator owns the lease
 * and the wake path. A watch firing does not authorize a position (§12.4). The
 * scheduled-reassessment sweep and full per-mission subscription management
 * arrive with the wake path (Step 5); this step proves the candle-close
 * fires-exactly-once invariant end-to-end.
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
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { type PersistenceSqlError } from "../persistence/Errors.ts";
import type { PersistedWatch } from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

export interface WatchEvaluatorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when all in-flight evaluations have settled. For tests. */
  readonly drain: Effect.Effect<void>;
  /**
   * Direct evaluation entry point. `evaluateDelivery` is what the forked stream
   * consumer calls per WS delivery; exposing it lets tests drive evaluation
   * synchronously (the fires-exactly-once invariant) without racing a forked
   * fiber.
   */
  readonly evaluateDelivery: (delivery: WsDelivery) => Effect.Effect<void, PersistenceSqlError>;
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
  const watches = yield* TradingWatchService;
  const strategies = yield* TradingStrategyService;
  const missions = yield* TradingMissionService;
  const inbox = yield* TradingEventInbox;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  /**
   * Close times already seen per watch, so the same finalised candle can never
   * fire twice even if the exchange replays it before the watch flips to
   * `triggered`. This is the primary "fires exactly once" guard; the inbox
   * dedupe key is the secondary, durable guard.
   */
  const seenCloses = yield* Ref.make(new Map<string, Set<number>>());

  const markSeenClose = (watchId: string, closeTime: number) =>
    Ref.update(seenCloses, (map) => {
      const set = map.get(watchId) ?? new Set<number>();
      set.add(closeTime);
      map.set(watchId, set);
      return map;
    });

  const hasSeenClose = (watchId: string, closeTime: number) =>
    Ref.modify(seenCloses, (map) => {
      const seen = map.get(watchId)?.has(closeTime) ?? false;
      return [seen, map] as const;
    });

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
        category: "market",
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
   * Evaluate a `candle_close` watch against a delivered candle.
   *
   * Fires only on a final close (close time has passed) and exactly once per
   * `(watch, closeTime)`. The predicate is a directional price comparison
   * against the candle's close.
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

      const alreadySeen = yield* hasSeenClose(tracked.watch.id, parsed.closeTime);
      if (alreadySeen) return;
      yield* markSeenClose(tracked.watch.id, parsed.closeTime);

      const matched =
        watch.direction === "above" ? parsed.close >= watch.price : parsed.close <= watch.price;
      if (!matched) return;

      yield* enqueueFire(
        tracked,
        `candle_close:${watch.interval}:${parsed.closeTime}`,
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

    const gateway = yield* HyperliquidGateway;
    const snapshot = yield* gateway.getMarketSnapshot(watch.market).pipe(Effect.orDie);
    const reference = watch.priceSource === "mark" ? snapshot.markPrice : snapshot.midPrice;

    const matched =
      watch.direction === "above" ? reference >= watch.price : reference <= watch.price;
    if (!matched) return;

    const observedAt = yield* nowMs;
    yield* enqueueFire(
      tracked,
      `price_cross:${watch.market}:${watch.direction}:${watch.price}`,
      `${watch.priceSource} ${watch.market} crossed ${watch.direction} ${watch.price} (at ${reference})`,
      { reference, observedAt, watchId: tracked.watch.id },
    );
  });

  /** Resolve which active candle-close watches a delivery could match. */
  const watchesForDelivery = Effect.fn("WatchEvaluator.watchesForDelivery")(function* (
    delivery: WsDelivery,
  ) {
    const interval = delivery.subscription.interval;
    if (interval === undefined) return [] as ReadonlyArray<TrackedWatch>;
    // The POC has one active mission; the wake path (Step 5) generalizes this.
    const mission = yield* missions.findActiveMission("local");
    if (mission._tag === "None") return [] as ReadonlyArray<TrackedWatch>;
    const all = yield* strategies.listWatches(mission.value.id);
    const threadId = mission.value.harness.threadId as ThreadId;
    return all
      .filter(
        (w) =>
          w.status === "active" && w.watch.type === "candle_close" && w.watch.interval === interval,
      )
      .map((watch) => ({ watch, missionId: mission.value.id as TradingMissionId, threadId }));
  });

  const start: WatchEvaluatorShape["start"] = () =>
    Effect.gen(function* () {
      // Subscribe to the candle channel for the POC market and route deliveries
      // to the candle-close watches bound to each interval. (Full per-mission
      // subscription management arrives with the wake path in Step 5; this proves
      // the evaluate-once invariant end-to-end.)
      //
      // The forked stream consumer reads the same HyperliquidWebSocketClient the
      // evaluator captured at build, so the service does not need to be in the
      // forked fiber's context — `ws` is a closed-over local.
      const subscription = ws.subscribe({ type: "candle", coin: "ETH", interval: "5m" });
      yield* Effect.forkScoped(
        Stream.runForEach(subscription, (delivery) =>
          Effect.gen(function* () {
            const tracked = yield* watchesForDelivery(delivery);
            yield* Effect.forEach(tracked, (t) => evaluateCandleClose(t, delivery));
          }).pipe(Effect.ignore),
        ),
      );
    });

  /**
   * Evaluate a single WS delivery against the active watches it could match,
   * enqueueing any fires. This is what the forked stream consumer in `start`
   * calls per delivery; exposing it lets tests drive evaluation synchronously
   * (the fires-exactly-once invariant) without racing a forked fiber.
   */
  const evaluateDelivery = (delivery: WsDelivery) =>
    Effect.gen(function* () {
      const tracked = yield* watchesForDelivery(delivery);
      yield* Effect.forEach(tracked, (t) => evaluateCandleClose(t, delivery));
    });

  // `evaluatePriceCross` is kept for the wake path (Step 5) to trigger a
  // price-cross re-evaluation on a BBO delivery; it is not part of the public
  // shape yet.
  void evaluatePriceCross;

  return { start, drain: worker.drain, evaluateDelivery } satisfies WatchEvaluatorShape;
});

export const WatchEvaluatorLive = Layer.effect(WatchEvaluator, make);
