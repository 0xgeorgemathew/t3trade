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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { type PersistenceSqlError } from "../persistence/Errors.ts";
import type { PersistedWatch } from "./Schemas.ts";
import { TradingMarket, TradingTimeframe } from "./Schemas.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

/** The market assumed for a candle delivery that does not name its coin. */
const DEFAULT_MARKET = "ETH";

/** Every market a mission may be mandated to trade (§10.1). */
const MARKETS = TradingMarket.literals;

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
  /**
   * Forget the last candle seen per subscription, so the next delivery starts a
   * fresh rollover comparison. For tests, which share one long-lived evaluator
   * across cases and would otherwise see one case's candle finalised by the
   * next case's first delivery.
   */
  readonly forgetDeliveredCandles: Effect.Effect<void>;
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

/** One delivered candle, reduced to the three fields finality and matching need. */
interface DeliveredCandle {
  readonly openTime: number;
  readonly closeTime: number;
  readonly close: number;
}

/**
 * The candle payload delivered over the WS `candle` channel is an array whose
 * first element carries `{t, T, s, i, o, c, h, l, v, n}` (per the wire schema).
 */
const candleFromDelivery = (delivery: WsDelivery): DeliveredCandle | undefined => {
  const data = delivery.data;
  const candle = Array.isArray(data) ? data[0] : data;
  const openTime = num(field(candle, "t"));
  const closeTime = num(field(candle, "T"));
  const close = num(field(candle, "c"));
  if (openTime === undefined || closeTime === undefined || close === undefined) return undefined;
  return { openTime, closeTime, close };
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
  const sql = yield* SqlClient.SqlClient;

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
   * The last candle delivered per `coin:interval`, so a rollover is visible.
   *
   * In-memory and per-process on purpose: it holds one small record per
   * subscription and its only job is to compare consecutive deliveries. A
   * restart loses at most the candle in flight, and the next rollover restores
   * it.
   */
  const lastDelivered = new Map<string, DeliveredCandle>();

  /**
   * Which candle, if any, this delivery proves is final.
   *
   * The wall-clock test alone is not enough, and that is what stalled the wake
   * loop. Hyperliquid pushes a candle only when a trade updates it, so the last
   * delivery a candle ever receives lands *before* its close time — measured on
   * testnet ETH 1m, not one candle in a three-minute capture was ever delivered
   * again after its `T`. A watch armed on `1m` therefore waited for a message
   * that only arrives when a trade happens to land in the final milliseconds,
   * which is why runs woke every three to five minutes instead of every minute.
   *
   * A rollover is the proof that was missing: the exchange starting candle N+1
   * means it has stopped updating candle N, whatever the clock says. The
   * wall-clock test is kept as the second path, for a delivery that does land
   * after its own close.
   */
  const finalizedCandle = (
    previous: DeliveredCandle | undefined,
    current: DeliveredCandle,
  ): Effect.Effect<DeliveredCandle | undefined> =>
    Effect.gen(function* () {
      if (previous !== undefined && previous.openTime < current.openTime) return previous;
      const observedAt = yield* nowMs;
      return current.closeTime <= observedAt ? current : undefined;
    });

  /**
   * Evaluate a `candle_close` watch against a candle already known to be final.
   *
   * The predicate is a directional price comparison against the candle's close;
   * the dedupe key is scoped per watch and close so a replay cannot wake the
   * harness twice.
   */
  const evaluateCandleClose = (
    tracked: TrackedWatch,
    market: string,
    interval: string,
    candle: DeliveredCandle,
  ) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "candle_close") return;
      if (market !== watch.market) return;
      if (interval !== watch.interval) return;

      const matched =
        watch.direction === "above" ? candle.close >= watch.price : candle.close <= watch.price;
      if (!matched) return;

      yield* enqueueFire(
        tracked,
        `candle_close:${tracked.watch.id}:${candle.closeTime}`,
        `${watch.interval} candle closed ${candle.close} (${watch.direction} ${watch.price})`,
        { closeTime: candle.closeTime, close: candle.close, watchId: tracked.watch.id },
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

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, reference, observedAt);

    const matched =
      watch.direction === "above" ? reference >= watch.price : reference <= watch.price;
    if (!matched) return;

    yield* enqueueFire(
      tracked,
      `price_cross:${tracked.watch.id}`,
      `${watch.priceSource} ${watch.market} crossed ${watch.direction} ${watch.price} (at ${reference})`,
      { reference, observedAt, watchId: tracked.watch.id },
    );
  });

  /**
   * Fire when the reconciled state a watch names has changed since the last
   * sweep. `signature` is the value being watched, reduced to a string: the
   * position's size and entry for `position_update`, the order's remaining size
   * for `order_update`, and `"gone"` when the row no longer exists.
   *
   * `position_update` and `order_update` are differential — they fire on a
   * *change*, so each needs a baseline. The first sweep that sees a watch
   * records the current value and fires nothing; a later sweep that reads
   * something different fires.
   *
   * The baseline lives on the watch row rather than in a process-local Map,
   * because a restart with a Map baseline swallows exactly the change the
   * harness most needs to hear about: the position that moved, or the order
   * that filled, while the server was down. The row is durable, so the first
   * real change after a restart still fires.
   */
  const fireOnChange = (tracked: TrackedWatch, signature: string, describe: () => string) =>
    Effect.gen(function* () {
      const key = tracked.watch.id;
      const rows = yield* sql<{ readonly baseline_signature: string | null }>`
        SELECT baseline_signature FROM trading_watches WHERE watch_id = ${key}
      `.pipe(Effect.orDie);
      const previous = rows[0]?.baseline_signature ?? null;
      if (previous === signature) return;

      yield* sql`
        UPDATE trading_watches SET baseline_signature = ${signature} WHERE watch_id = ${key}
      `.pipe(Effect.orDie);
      // The first observation is the baseline, not a change.
      if (previous === null) return;

      yield* enqueueFire(tracked, `${tracked.watch.watch.type}:${key}:${signature}`, describe(), {
        watchId: key,
        previous,
        current: signature,
      });
    });

  /**
   * How stale a stored `last_evaluated_at` may be before this sweep refreshes
   * it even when the value is unchanged. The sweep cadence is 2s; 5s keeps a
   * write from landing on every single tick when the number is static, while
   * still telling the checklist the watch is live.
   */
  const OBSERVATION_REFRESH_MILLIS = 5_000;

  /**
   * Carry the value a watch predicate is reading onto the watch row so the
   * workspace's conditions checklist can render the live number next to its
   * threshold, not just a ticked/empty checkbox.
   *
   * Called by the four numeric evaluators (`price_cross`, `pnl_above`,
   * `pnl_below`, `pnl_giveback`) on every sweep that computed a real observed
   * value, BEFORE the match-check / early-return — so a watch that has not
   * crossed still surfaces how close it is.
   *
   * Write-guarded: a write only lands when the value moved beyond an epsilon or
   * the stored timestamp is stale, so a static number does not hit SQLite on
   * every 2s tick. A sweep that could not read a real value (flat position,
   * gateway failure) must NOT call this — there is nothing true to record.
   */
  const recordObservation = (watchId: string, observedValue: number, observedAt: number) =>
    sql`
      UPDATE trading_watches
      SET last_observed_value = ${observedValue}, last_evaluated_at = ${observedAt}
      WHERE watch_id = ${watchId}
        AND (
          last_observed_value IS NULL
          OR ABS(last_observed_value - ${observedValue}) > 1e-9
          OR last_evaluated_at < ${observedAt - OBSERVATION_REFRESH_MILLIS}
        )
    `.pipe(Effect.orDie);

  /**
   * Evaluate a `position_update` watch against the reconciled position snapshot.
   *
   * Reads the reconciler's table rather than the exchange: the reconciler is
   * already converging it on fills, reconnects, and the periodic backstop, and
   * a watch that re-read the exchange every two seconds would multiply that
   * traffic by the number of armed watches.
   */
  const evaluatePositionUpdate = Effect.fn("WatchEvaluator.evaluatePositionUpdate")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "position_update") return;

    const rows = yield* sql<{
      readonly size: number;
      readonly entry_price: number | null;
    }>`
      SELECT size, entry_price FROM trading_position_snapshots
      WHERE mission_id = ${tracked.missionId} AND market = ${watch.market}
    `.pipe(Effect.orDie);

    const row = rows[0];
    const signature = row === undefined ? "flat" : `${row.size}@${row.entry_price ?? ""}`;
    yield* fireOnChange(
      tracked,
      signature,
      () => `${watch.market} position changed to ${signature}`,
    );
  });

  /**
   * Evaluate an `order_update` watch against the reconciled order table.
   *
   * A cloid that has left the table has been filled or cancelled, which is the
   * update the harness most needs to hear about — so a missing row is a change,
   * not a reason to stay silent.
   */
  const evaluateOrderUpdate = Effect.fn("WatchEvaluator.evaluateOrderUpdate")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "order_update") return;

    const rows = yield* sql<{ readonly remaining_size: number }>`
      SELECT remaining_size FROM trading_orders
      WHERE mission_id = ${tracked.missionId} AND cloid = ${watch.cloid}
    `.pipe(Effect.orDie);

    const row = rows[0];
    const signature = row === undefined ? "gone" : `resting:${row.remaining_size}`;
    yield* fireOnChange(tracked, signature, () => `order ${watch.cloid} is now ${signature}`);
  });

  /**
   * The live position a PnL watch is measured against, or `null` when the
   * mission is flat.
   *
   * The PnL comes from the gateway position read, resolved via the
   * master-wallet address — the same identity the composer and §10.6 use. A
   * flat position fires nothing and leaves the watch active, so a strategy
   * publish or a later re-entry still supersedes it like any other watch.
   */
  const readLivePosition = (tracked: TrackedWatch, market: string) =>
    Effect.gen(function* () {
      const mission = yield* missions.getMission(tracked.missionId);
      const address = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      const position = yield* gateway.getPosition(address, market);
      return position.size === 0 ? null : position;
    }).pipe(Effect.orDie);

  /**
   * Evaluate a `pnl_above` watch against the reconciled unrealised PnL.
   *
   * The target lives in the strategy the watch was armed against.
   *
   * `pnl_above` is not differential: it fires once when the threshold is first
   * reached, then `markTriggered` flips it terminal so a subsequent sweep
   * cannot re-fire.
   */
  const evaluatePnlAbove = Effect.fn("WatchEvaluator.evaluatePnlAbove")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "pnl_above") return;

    const position = yield* readLivePosition(tracked, watch.market);
    if (position === null) return;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, position.unrealisedPnl, observedAt);
    if (position.unrealisedPnl < watch.valueUsd) return;

    yield* enqueueFire(
      tracked,
      `pnl_above:${tracked.watch.id}`,
      `unrealised PnL $${position.unrealisedPnl.toFixed(2)} reached target $${watch.valueUsd}`,
      {
        unrealisedPnl: position.unrealisedPnl,
        valueUsd: watch.valueUsd,
        observedAt,
        watchId: tracked.watch.id,
      },
    );
  });

  /**
   * Evaluate a `pnl_below` watch against the reconciled unrealised PnL.
   *
   * The mirror of `pnl_above`, and signed: the level worth watching on the way
   * down is usually a loss. A flat position never fires it, for the same reason
   * — a mission with no position has no PnL to have fallen.
   */
  const evaluatePnlBelow = Effect.fn("WatchEvaluator.evaluatePnlBelow")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "pnl_below") return;

    const position = yield* readLivePosition(tracked, watch.market);
    if (position === null) return;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, position.unrealisedPnl, observedAt);
    if (position.unrealisedPnl > watch.valueUsd) return;

    yield* enqueueFire(
      tracked,
      `pnl_below:${tracked.watch.id}`,
      `unrealised PnL $${position.unrealisedPnl.toFixed(2)} fell to the $${watch.valueUsd} level`,
      {
        unrealisedPnl: position.unrealisedPnl,
        valueUsd: watch.valueUsd,
        observedAt,
        watchId: tracked.watch.id,
      },
    );
  });

  /**
   * Evaluate a `pnl_giveback` watch: how far this position has come off its own
   * best.
   *
   * The high-water mark is the reconciler's durable `peak_unrealised_pnl`, not
   * anything the exchange reports and not a process-local maximum — a restart
   * loses neither the peak nor the give-back that happened while it was down.
   * A position that has never been in profit has no peak, so nothing fires:
   * a losing trade is the stop's problem, not this watch's.
   */
  const evaluatePnlGiveback = Effect.fn("WatchEvaluator.evaluatePnlGiveback")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "pnl_giveback") return;

    const position = yield* readLivePosition(tracked, watch.market);
    if (position === null) return;

    const rows = yield* sql<{ readonly peak_unrealised_pnl: number | null }>`
      SELECT peak_unrealised_pnl FROM trading_position_snapshots
      WHERE mission_id = ${tracked.missionId} AND market = ${watch.market}
    `.pipe(Effect.orDie);
    const peak = rows[0]?.peak_unrealised_pnl ?? 0;
    if (peak <= 0) return;

    const drawdown = peak - position.unrealisedPnl;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, drawdown, observedAt);
    if (drawdown < watch.drawdownUsd) return;

    yield* enqueueFire(
      tracked,
      `pnl_giveback:${tracked.watch.id}`,
      `unrealised PnL gave back $${drawdown.toFixed(2)} from its peak of $${peak.toFixed(2)} (now $${position.unrealisedPnl.toFixed(2)})`,
      {
        unrealisedPnl: position.unrealisedPnl,
        peakUnrealisedPnl: peak,
        drawdownUsd: drawdown,
        thresholdUsd: watch.drawdownUsd,
        observedAt,
        watchId: tracked.watch.id,
      },
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
      const candle = candleFromDelivery(delivery);
      if (candle === undefined) return;

      const market = delivery.subscription.coin ?? DEFAULT_MARKET;
      const key = `${market}:${interval}`;
      const previous = lastDelivered.get(key);
      lastDelivered.set(key, candle);

      const finalized = yield* finalizedCandle(previous, candle);
      if (finalized === undefined) return;

      const tracked = yield* activeTrackedWatches();
      yield* Effect.forEach(tracked, (t) => evaluateCandleClose(t, market, interval, finalized));
    });

  const evaluateOne = (t: TrackedWatch, observedAt: number) => {
    switch (t.watch.watch.type) {
      case "price_cross":
        return evaluatePriceCross(t);
      case "scheduled_reassessment":
        return evaluateScheduled(t, observedAt);
      case "position_update":
        return evaluatePositionUpdate(t);
      case "order_update":
        return evaluateOrderUpdate(t);
      case "pnl_above":
        return evaluatePnlAbove(t);
      case "pnl_below":
        return evaluatePnlBelow(t);
      case "pnl_giveback":
        return evaluatePnlGiveback(t);
      default:
        return Effect.void;
    }
  };

  const sweep: WatchEvaluatorShape["sweep"] = Effect.gen(function* () {
    const tracked = yield* activeTrackedWatches();
    const observedAt = yield* nowMs;
    for (const t of tracked) {
      // Contained per watch: the evaluators read the exchange and the DB
      // through `orDie`, and one watch's transient failure must not starve the
      // rest of this sweep — a silent evaluator is a deaf mission wearing a
      // healthy status.
      yield* evaluateOne(t, observedAt).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WatchEvaluator: one evaluation failed; the sweep continues", {
            watchId: t.watch.id,
            watchType: t.watch.watch.type,
            cause: String(cause),
          }),
        ),
      );
    }
  });

  const start: WatchEvaluatorShape["start"] = () =>
    Effect.gen(function* () {
      // One candle subscription per market per §13 direct interval.
      // Deliveries route to the candle-close watches bound to that interval.
      //
      // The forked consumers read the services the evaluator captured at build,
      // so nothing extra is required in the forked fibers' context.
      // `catchCause`, not `ignore`: `ignore` swallows typed failures only, and
      // the evaluators die (`orDie`) on gateway/DB errors — a defect escaping
      // here would kill the consumer fiber and silence every watch it drives,
      // with nothing on the mission to say it happened.
      for (const market of MARKETS) {
        for (const interval of DIRECT_INTERVALS) {
          const subscription = ws.subscribe({ type: "candle", coin: market, interval });
          yield* Effect.forkScoped(
            Stream.runForEach(subscription, (delivery) =>
              evaluateDelivery(delivery).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("WatchEvaluator: candle evaluation failed", {
                    cause: String(cause),
                  }),
                ),
              ),
            ),
          );
        }
      }

      // The slow sweep for price-cross and scheduled watches.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* sweep.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("WatchEvaluator: sweep failed; retrying next interval", {
                  cause: String(cause),
                }),
              ),
            );
            yield* Effect.sleep(SWEEP_INTERVAL);
          }
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
    evaluateDelivery,
    sweep,
    forgetDeliveredCandles: Effect.sync(() => lastDelivered.clear()),
  } satisfies WatchEvaluatorShape;
});

export const WatchEvaluatorLive = Layer.effect(WatchEvaluator, make);
