/**
 * Market watches - spec §11.3, §12.1.
 *
 * A watch is a simple, deterministic, typed, inspectable predicate the runtime
 * can evaluate without judgment. Anything that requires weighing evidence is
 * harness responsibility and does not belong here.
 *
 * @module MarketWatch
 */
import { Schema } from "effect";
import { ACTIVE_TRADING_POLICY, type TradingPolicy } from "./policy.ts";
import { PositiveUsdAmount, Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { TradingTimeframe } from "./strategy.ts";

export const WatchPriceSource = Schema.Literals(["mark", "mid"]);
export type WatchPriceSource = typeof WatchPriceSource.Type;

export const WatchCrossDirection = Schema.Literals(["above", "below"]);
export type WatchCrossDirection = typeof WatchCrossDirection.Type;

export const MarketWatch = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("price_cross"),
    market: TradingMarket,
    priceSource: WatchPriceSource,
    direction: WatchCrossDirection,
    price: Price,
  }),
  Schema.Struct({
    type: Schema.Literal("candle_close"),
    market: TradingMarket,
    interval: TradingTimeframe,
    direction: WatchCrossDirection,
    price: Price,
  }),
  Schema.Struct({
    type: Schema.Literal("order_update"),
    cloid: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("position_update"),
    market: TradingMarket,
  }),
  Schema.Struct({
    type: Schema.Literal("scheduled_reassessment"),
    runAt: UnixMillis,
  }),
  Schema.Struct({
    type: Schema.Literal("pnl_above"),
    market: TradingMarket,
    valueUsd: PositiveUsdAmount,
  }),
  /**
   * Fires when unrealised PnL falls to or below `valueUsd`.
   *
   * Signed, unlike `pnl_above`: the level worth watching on the way down is
   * usually a loss (`-6`), and sometimes a give-back floor under a winner
   * (`+3`). Zero is the break-even line.
   */
  Schema.Struct({
    type: Schema.Literal("pnl_below"),
    market: TradingMarket,
    valueUsd: Schema.Number,
  }),
  /**
   * Fires when unrealised PnL has fallen `drawdownUsd` from its own high-water
   * mark on this position.
   *
   * The high-water mark is durable — the reconciler maintains it on the
   * position snapshot — so this survives a restart and resets when the mission
   * goes flat. It is the watch that makes holding past a profit target safe:
   * a target wake that decides to extend can arm a give-back beneath the peak
   * instead of betting the whole open profit on the next leg.
   */
  Schema.Struct({
    type: Schema.Literal("pnl_giveback"),
    market: TradingMarket,
    drawdownUsd: PositiveUsdAmount,
  }),
]);
export type MarketWatch = typeof MarketWatch.Type;

/** Watch lifecycle - spec §11.3. */
export const PersistedWatchStatus = Schema.Literals([
  "active",
  "triggered",
  "consumed",
  "cancelled",
  "expired",
  "superseded",
]);
export type PersistedWatchStatus = typeof PersistedWatchStatus.Type;

/**
 * Who armed a watch.
 *
 * Absent means the harness armed it deliberately. `staleness_floor` means the
 * runtime armed it because the mission would otherwise have had nothing left
 * that could wake it — a wake from one of these is the cue that nothing crossed
 * and the thesis is the thing to reconsider. `profit_target` means the runtime
 * armed a `pnl_above` watch at the strategy's declared profit target while the
 * mission holds a position — a wake from it is a decision point: bank the win
 * (close, or reduce and keep a runner) if momentum is fading, or extend to the
 * ladder's next rung by republishing with a fresh basis if it is not.
 *
 * `stop_proximity` means the runtime armed a `price_cross` one ATR ahead of the
 * resting stop while the mission holds a position. A wake from it is the
 * designed moment to decide the stop deliberately — tighten, hold, or exit —
 * before the exchange decides instead.
 *
 * `stop_decision` means the runtime armed a `pnl_below` watch at ~70% of the
 * planned loss at the resting stop. A wake from it asks one question — thesis
 * broken, or noise? The answers are hold, tighten legally, or exit better
 * than the stop; the exchange stop stays resting as the backstop.
 *
 * `wake_retry` means this watch is a replacement for one that fired and was
 * consumed by a wake that then failed to reach the harness. The condition it
 * carries is the same one the harness armed; the reason records that the
 * original firing was lost, so a wake from it is not a second crossing.
 */
export const WatchArmedReason = Schema.Literals([
  "staleness_floor",
  "profit_target",
  "wake_retry",
  "stop_proximity",
  "stop_decision",
]);
export type WatchArmedReason = typeof WatchArmedReason.Type;

/**
 * A watch as persisted, bound to the strategy version that registered it -
 * spec §12.1.
 *
 * `watch` carries the published `MarketWatch` union verbatim; `strategyVersion`
 * is what makes a watch supersedable when the harness publishes v(n+1).
 *
 * Version 0 means the watch was armed before the first strategy publish. It is
 * not a degenerate case: like any other watch, the publish of v1 supersedes it.
 * Allowing 0 here is what lets `trading_register_watch` succeed for a mission
 * whose bootstrap turn registers coverage before it has published anything.
 */
export const PersistedWatch = Schema.Struct({
  id: TradingId,
  missionId: TradingId,
  strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  watch: MarketWatch,
  status: PersistedWatchStatus,
  armedReason: Schema.optional(WatchArmedReason),
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
  /**
   * The value the predicate is currently reading (mark/mid price for
   * `price_cross`, unrealised PnL for `pnl_above`/`pnl_below`, drawdown from
   * peak for `pnl_giveback`), written back by the evaluator on every sweep it
   * observed a real value.
   *
   * Absent on rows that predate the column or on a sweep where the evaluator
   * could not read a value (flat position, gateway failure). The web renders
   * this alongside the threshold so the conditions checklist can show the live
   * number a watch is measuring against, not just a ticked/empty checkbox.
   */
  lastObservedValue: Schema.optional(Schema.Number),
  /**
   * When the evaluator last swept this watch and wrote `lastObservedValue`.
   * Absent in lockstep with `lastObservedValue`.
   */
  lastEvaluatedAt: Schema.optional(UnixMillis),
});
export type PersistedWatch = typeof PersistedWatch.Type;

// ---------------------------------------------------------------------------
// The armed-coverage floor for a mission holding a position
// ---------------------------------------------------------------------------

/**
 * Bar length, in milliseconds, for each direct timeframe.
 *
 * The floor is expressed in bars of the strategy's primary timeframe so the
 * cadence scales with how fast the market the harness is reasoning about
 * actually prints confirming candles.
 */
const BAR_MILLIS: Readonly<Record<TradingTimeframe, number>> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

const MINUTE = 60_000;

/** One bar of a timeframe, in milliseconds. */
export function timeframeBarMillis(timeframe: TradingTimeframe): number {
  return BAR_MILLIS[timeframe];
}

/**
 * The floor for a flat mission on the 1m default timeframe. Kept as a named
 * constant because the contract's tests assert against it directly. Reads the
 * policy in force so an I2 cadence change lands here without a second edit.
 */
export const WATCH_COVERAGE_FLOOR_MILLIS =
  ACTIVE_TRADING_POLICY.reassessment.flatFloorBars * BAR_MILLIS["1m"];

/**
 * How far ahead a scheduled reassessment may sit and still count as coverage.
 *
 * The floor scales with the strategy's primary timeframe and whether the
 * mission is holding a position:
 * - Holding a position: 3 bars, clamped to [2 min, 15 min]. A 1m holder
 *   reassesses inside 3 minutes, a 5m holder at 15 minutes, a 1h holder at the
 *   15-minute cap.
 * - Flat with a published thesis: the policy's flat floor (plan 27 I2) — as
 *   shipped, 10 bars clamped to [5 min, 30 min]. A 1m flat mission at 10
 *   minutes, a 5m flat mission at 30 minutes, a 1h flat mission at the cap.
 *
 * A flat 1m mission is the original case this floor existed for, and its value
 * is unchanged (10 minutes). The clamp bounds the long timeframes so a 1h
 * mission never waits an hour to notice its thesis has gone stale. The flat
 * branch reads the versioned policy because the quick-trades objective names
 * this cadence as a candidate to shorten — through D2 replay, like every
 * threshold.
 */
export function watchCoverageFloorMillis(input: {
  readonly timeframe: TradingTimeframe;
  readonly holdingPosition: boolean;
  readonly policy?: TradingPolicy;
}): number {
  const bar = BAR_MILLIS[input.timeframe];
  if (input.holdingPosition) {
    return Math.min(Math.max(3 * bar, 2 * MINUTE), 15 * MINUTE);
  }
  const reassessment = (input.policy ?? ACTIVE_TRADING_POLICY).reassessment;
  const [clampMinMinutes, clampMaxMinutes] = reassessment.flatFloorClampMinutes;
  return Math.min(
    Math.max(reassessment.flatFloorBars * bar, clampMinMinutes * MINUTE),
    clampMaxMinutes * MINUTE,
  );
}

/**
 * The slow sanity interval for a position that *is* covered on both sides.
 *
 * The tight holding floor above exists for the deaf case: nothing armed can
 * wake the mission, so it must be woken on time alone. A position with a level
 * or a PnL line armed on each side, or a confirmed exchange stop, is not that
 * case — waking it every three bars spends a full harness turn to conclude
 * "hold". It still deserves a periodic look at whether the thesis itself is
 * still true, so this is 10× the tight floor, clamped to [15 min, 2 h].
 */
export function watchSanityBackstopMillis(timeframe: TradingTimeframe): number {
  const tight = watchCoverageFloorMillis({ timeframe, holdingPosition: true });
  return Math.min(Math.max(10 * tight, 15 * MINUTE), 120 * MINUTE);
}

/** Which directions a mission's armed watches can actually fire in. */
export interface WatchCoverage {
  /** An armed watch that fires if price rises from here. */
  readonly coversUpside: boolean;
  /** An armed watch that fires if price falls from here. */
  readonly coversDownside: boolean;
  /** An armed reassessment due within the floor. */
  readonly coversByReassessment: boolean;
}

/**
 * Read what a mission's watches can actually wake it for.
 *
 * `price_cross` and `candle_close` carry a direction and a level, so they cover
 * a side directly. A level on the wrong side of the mark does not count: a
 * "cross above 1850" armed while price is already 1860 is not upside coverage;
 * it is a condition that was true before it was written.
 *
 * PnL watches cover a side too, when the position's direction is known. A
 * `pnl_above` is a level in dollars on the winning side, `pnl_below` and
 * `pnl_giveback` are levels on the losing side, and the evaluator re-reads
 * reconciled unrealised PnL on every sweep — so a long with a loss line and a
 * target armed hears both ways it can move. Which price direction each maps to
 * comes from the sign of `positionSize`; without it they cover nothing, because
 * "winning" has no meaning.
 *
 * A confirmed exchange-native stop covering the whole position also counts as
 * losing-side coverage: the position cannot run through it without the exchange
 * acting, and the exchange acting produces a `position_update`.
 *
 * `order_update` and `position_update` on their own cover nothing. They fire on
 * a change in size — real events, but a position whose only armed watches are
 * those can watch its own mark run away and never hear about it, which is
 * exactly the session this rule exists because of.
 */
export function readWatchCoverage(input: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly markPrice: number;
  readonly nowMillis: number;
  readonly floorMillis?: number;
  /** Signed position size. Absent or zero means PnL watches cover no side. */
  readonly positionSize?: number;
  /** Absolute size covered by confirmed exchange-native protection. */
  readonly protectedSize?: number;
}): WatchCoverage {
  const active = input.watches.filter((w) => w.status === "active");
  const isLong = (input.positionSize ?? 0) > 0;
  const isShort = (input.positionSize ?? 0) < 0;

  let coversUpside = false;
  let coversDownside = false;

  /** The price direction that a gain, and a loss, would move this position. */
  const coverWinningSide = () => {
    if (isLong) coversUpside = true;
    if (isShort) coversDownside = true;
  };
  const coverLosingSide = () => {
    if (isLong) coversDownside = true;
    if (isShort) coversUpside = true;
  };

  for (const persisted of active) {
    const watch = persisted.watch;
    if (watch.type === "price_cross" || watch.type === "candle_close") {
      if (watch.direction === "above" && watch.price >= input.markPrice) coversUpside = true;
      if (watch.direction === "below" && watch.price <= input.markPrice) coversDownside = true;
      continue;
    }
    if (watch.type === "pnl_above") coverWinningSide();
    if (watch.type === "pnl_below" || watch.type === "pnl_giveback") coverLosingSide();
  }

  const size = Math.abs(input.positionSize ?? 0);
  const fullyProtected = size > 0 && (input.protectedSize ?? 0) >= size - PROTECTION_EPSILON;
  if (fullyProtected) coverLosingSide();

  return { coversUpside, coversDownside, coversByReassessment: hasReassessmentWithin(input) };
}

/**
 * Slack when comparing a protected size against the position size. Exchange
 * rounding leaves the reduce-only order a hair short of the position it covers.
 */
const PROTECTION_EPSILON = 1e-9;

/**
 * Whether an armed reassessment is due inside the floor.
 *
 * Split out of `readWatchCoverage` because a flat mission has no mark to
 * measure levels against, and this is the only part of coverage that still
 * means something without one.
 */
export function hasReassessmentWithin(input: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly nowMillis: number;
  readonly floorMillis?: number;
}): boolean {
  const floor = input.floorMillis ?? WATCH_COVERAGE_FLOOR_MILLIS;
  return input.watches.some(
    (persisted) =>
      persisted.status === "active" &&
      persisted.watch.type === "scheduled_reassessment" &&
      persisted.watch.runAt <= input.nowMillis + floor,
  );
}

/**
 * True when a mission holding a position would hear nothing: no level armed on
 * one of the two sides it could move, and no reassessment due inside the floor.
 */
export function isDeafWhileHoldingPosition(coverage: WatchCoverage): boolean {
  if (coverage.coversByReassessment) return false;
  return !(coverage.coversUpside && coverage.coversDownside);
}

// ---------------------------------------------------------------------------
// Entry conditions a waiting mission named but did not arm
// ---------------------------------------------------------------------------

/**
 * An entry condition whose published price hint has no watch armed at it.
 *
 * A decision to wait is a decision with content: "entry candidate at 1894, come
 * back if price reaches 1899" is a trigger, and a trigger that lives only in
 * prose cannot wake anything. This is the mismatch, surfaced — never acted on.
 * Watch predicates come from `MarketWatch` alone, so nothing here is auto-armed
 * from a description; it is reported to the next wake and to the UI so the gap
 * is visible where the plan is read.
 */
export const UnarmedEntryCondition = Schema.Struct({
  description: Schema.String,
  priceLevel: Price,
  timeframe: Schema.optional(TradingTimeframe),
});
export type UnarmedEntryCondition = typeof UnarmedEntryCondition.Type;

/**
 * How close an armed level has to be to a published hint to count as armed.
 *
 * 10 bps: a hint is the harness's own rounding of a level it also armed, and
 * "1899" against a watch at 1899.2 is the same decision, not an unarmed one.
 */
const ENTRY_HINT_TOLERANCE_BPS = 10;

/**
 * Find the price hints in a waiting plan's entry conditions that no active
 * price-level watch covers.
 *
 * Conditions with no `priceLevel` are skipped: there is nothing to match a
 * watch against, and a non-price trigger ("funding flips") has no watch type to
 * arm today.
 */
export function findUnarmedEntryConditions(input: {
  readonly conditions: ReadonlyArray<{
    readonly description: string;
    readonly priceLevel?: number | undefined;
    readonly timeframe?: TradingTimeframe | undefined;
  }>;
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ReadonlyArray<UnarmedEntryCondition> {
  const armedLevels = input.watches.flatMap((persisted) => {
    if (persisted.status !== "active") return [];
    const watch = persisted.watch;
    if (watch.type !== "price_cross" && watch.type !== "candle_close") return [];
    return [watch.price];
  });

  const unarmed: Array<UnarmedEntryCondition> = [];
  for (const condition of input.conditions) {
    const level = condition.priceLevel;
    if (level === undefined) continue;
    const tolerance = (Math.abs(level) * ENTRY_HINT_TOLERANCE_BPS) / 10_000;
    if (armedLevels.some((armed) => Math.abs(armed - level) <= tolerance)) continue;
    unarmed.push({
      description: condition.description,
      priceLevel: level,
      ...(condition.timeframe === undefined ? {} : { timeframe: condition.timeframe }),
    });
  }
  return unarmed;
}

// ---------------------------------------------------------------------------
// Entry conditions armed with the wrong kind of watch
// ---------------------------------------------------------------------------

/**
 * A trigger whose armed watch cannot evaluate the evidence it declared.
 *
 * The failure this catches is specific and was invisible: a close-confirmed
 * breakout armed as a `price_cross` fires on the wick that trades through the
 * level and closes back inside. The mission is woken, spends a turn, finds the
 * break failed, and re-arms — the "premature wake / stand-down / re-arm cycle"
 * with no evidence at either end that anything was wrong.
 *
 * The mirror is also wrong: a range boundary armed as a `candle_close` waits a
 * whole bar past the touch, which in a range is most of the move.
 */
export const MisarmedEntryCondition = Schema.Struct({
  description: Schema.String,
  priceLevel: Price,
  /** What the condition declared it needs. */
  confirmation: Schema.Literals(["close", "touch"]),
  /** The watch type armed at that level. */
  armedAs: Schema.Literals(["price_cross", "candle_close"]),
  /** The watch type the confirmation calls for. */
  shouldBe: Schema.Literals(["price_cross", "candle_close"]),
  mismatch: Schema.Literals(["watch_type", "timeframe", "direction"]),
});
export type MisarmedEntryCondition = typeof MisarmedEntryCondition.Type;

/**
 * Find entry conditions armed with a watch that cannot evaluate them.
 *
 * A condition with no `confirmation` is skipped: it made no claim about what
 * would confirm it, and guessing on its behalf is how a wick becomes an entry.
 * A condition with no armed watch at all is `findUnarmedEntryConditions`'s
 * finding, not this one's.
 */
export function findMisarmedEntryConditions(input: {
  readonly conditions: ReadonlyArray<{
    readonly description: string;
    readonly priceLevel?: number | undefined;
    readonly confirmation?: "close" | "touch" | undefined;
    readonly timeframe?: string | undefined;
    readonly direction?: "above" | "below" | undefined;
  }>;
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ReadonlyArray<MisarmedEntryCondition> {
  const armed = input.watches.flatMap((persisted) => {
    if (persisted.status !== "active") return [];
    const watch = persisted.watch;
    if (watch.type !== "price_cross" && watch.type !== "candle_close") return [];
    return [
      {
        type: watch.type,
        price: watch.price,
        direction: watch.direction,
        interval: watch.type === "candle_close" ? watch.interval : undefined,
      },
    ];
  });

  const misarmed: Array<MisarmedEntryCondition> = [];
  for (const condition of input.conditions) {
    const level = condition.priceLevel;
    const confirmation = condition.confirmation;
    if (level === undefined || confirmation === undefined) continue;

    const shouldBe = confirmation === "close" ? "candle_close" : "price_cross";
    const tolerance = (Math.abs(level) * ENTRY_HINT_TOLERANCE_BPS) / 10_000;
    const at = armed.filter((watch) => Math.abs(watch.price - level) <= tolerance);
    if (at.length === 0) continue;
    const matching = at.some(
      (watch) =>
        watch.type === shouldBe &&
        (condition.direction === undefined || watch.direction === condition.direction) &&
        (confirmation !== "close" ||
          condition.timeframe === undefined ||
          watch.interval === condition.timeframe),
    );
    if (matching) continue;

    const armedWatch = at[0]!;
    const mismatch =
      armedWatch.type !== shouldBe
        ? ("watch_type" as const)
        : condition.direction !== undefined && armedWatch.direction !== condition.direction
          ? ("direction" as const)
          : ("timeframe" as const);

    misarmed.push({
      description: condition.description,
      priceLevel: level,
      confirmation,
      armedAs: armedWatch.type,
      shouldBe,
      mismatch,
    });
  }
  return misarmed;
}
