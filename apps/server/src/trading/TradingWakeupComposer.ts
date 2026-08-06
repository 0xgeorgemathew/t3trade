/**
 * TradingWakeupComposer - assembles the bounded `TradingHarnessWakeup` snapshot
 * a resumed run starts with, spec §12.2.
 *
 * The composer is the single place that gathers the fresh facts a resumed
 * harness turn needs: a market snapshot, an account snapshot, the active
 * strategy, the authority, the coalesced pending inbox events, the mission
 * instruction, and (when present) the triggering watch. It does not decide
 * whether to run — the `TradingTurnCoordinator` already did that and holds the
 * decision lease — it only collects and serializes the snapshot.
 *
 * The serialized wakeup is what the wake path writes into the resumed turn's
 * `message.text` (§12.4): the harness reads the same bounded payload every
 * time, regardless of which cause woke it. The composer never talks to the
 * provider; that is the wake path's job via `OrchestrationEngineService`.
 *
 * @module TradingWakeupComposer
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { TradingCostEstimate } from "@t3tools/trading-contracts/costs";
import { POC_DEFAULT_TIMEFRAME, type TradingTimeframe } from "@t3tools/trading-contracts/strategy";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import type { ObservedVolatility } from "@t3tools/trading-contracts/volatility";

import { boundStrategyProse } from "./StrategyProse.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";

import type { TradingPlanState } from "./Schemas.ts";
import type { PersistedWatch } from "./Schemas.ts";
import type { TradingMission } from "./Schemas.ts";
import {
  describeArmedWatch,
  TradingDomainEventSummary,
  TradingHarnessWakeup,
  type TradingHarnessRunCause,
} from "./Schemas.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

/** §12.2 bounds the candles a wakeup carries directly. */
const WAKEUP_RECENT_CANDLES = 8;

/**
 * The holding-period horizons the wakeup carries, rather than the default six.
 *
 * A target is checked against a near and a far window; the four middle points
 * the default distribution adds are noise the resumed turn does not read. The
 * `trading_measure_volatility` tool still uses the full default — this trims
 * only what the wakeup embeds.
 */
const WAKEUP_HOLD_HORIZONS: ReadonlyArray<number> = [3, 20] as const;

/**
 * Hard ceiling on the rendered wakeup text. The wakeup is the resumed turn's
 * `message.text`; an unbounded blob would crowd the provider context.
 *
 * Exceeding it never fails the compose — see `renderBoundedWakeup`. A wakeup
 * that does not fit is a wakeup that does not happen, and a mission whose every
 * wake fails is deaf while still holding exposure.
 */
export const MAX_WAKEUP_CHARS = 5_000;

/** Longest any single prose field survives in the wakeup projection. */
const WAKEUP_PROSE_CHARS = 280;

/** Longest any published condition/evidence list survives in the projection. */
const WAKEUP_LIST_ENTRIES = 6;

/** How many inbox events and armed watches the second trim rung keeps. */
const WAKEUP_PENDING_EVENTS = 6;
const WAKEUP_ARMED_WATCHES = 12;

/** Bars `recentCandles` falls back to once the cheaper rungs are exhausted. */
const WAKEUP_TRIMMED_CANDLES = 4;

const HARD_TRUNCATION_MARKER = "\n[truncated: wakeup exceeded budget — call trading_get_mission]";

/**
 * The second timeframe every wakeup measures, given the mission's first.
 *
 * A target has to be checked against a structure longer than the one it was
 * read off, and on 1m the longest horizon the measurement offers is twenty
 * minutes. Rather than instruct the harness to remember a second
 * `trading_measure_volatility` call it is free to skip, the wakeup carries the
 * pair. A mission already running on 1h has nothing higher to pair with.
 */
const HIGHER_TIMEFRAME: Readonly<Record<TradingTimeframe, TradingTimeframe | null>> = {
  "1m": "15m",
  "3m": "15m",
  "5m": "1h",
  "15m": "1h",
  "1h": null,
};

/**
 * The schema is the source of truth for shape: the wakeup struct is decoded
 * through `TradingHarnessWakeup` before rendering, so a malformed snapshot
 * fails compose rather than reaching the resumed turn. The rendered text is a
 * flat key/value form rather than JSON — JSON's quoting and bracing overhead is
 * roughly a third of the payload and the harness reads this as prose, so a
 * compact form pulls the whole message under the context budget without losing
 * a field.
 */
const decodeWakeup = Schema.decodeUnknownSync(TradingHarnessWakeup);

/**
 * Round a number for rendering. Whole numbers stay exact; fractions round to
 * four significant decimals — enough resolution for a ratio or a funding rate,
 * and tighter than the noise floor of the USD figures beside them.
 */
const roundFloat = (value: number): number => {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  return Number(value.toPrecision(4));
};

/**
 * Walk the wakeup and round every float in place.
 *
 * The wakeup is rendered into the resumed turn's context budget, and the
 * exchange feeds carry more decimals than the harness reads. Rounding at compose
 * time is a compactness win only — the schema still validates the rounded value,
 * and nothing downstream treats these numbers as accounting.
 */
const roundWakeupFloats = (value: unknown): unknown => {
  if (typeof value === "number") return roundFloat(value);
  if (Array.isArray(value)) return value.map(roundWakeupFloats);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = roundWakeupFloats(v);
    }
    return out;
  }
  return value;
};

/**
 * Fields that are staleness/observability metadata, not decision inputs. The
 * harness reads "what is the mark" from the snapshot; "when did we last ask" is
 * plumbing, and repeating it eight times adds lines without adding signal.
 */
const RENDER_SKIP_KEYS: ReadonlySet<string> = new Set([
  "freshness",
  "staleAfterMillis",
  "source",
  "feeRateSource",
  "observedAt",
]);

/**
 * Render the (already-rounded) wakeup as sectioned key=value lines.
 *
 * Each top-level field is a section header; nested values flatten under it as
 * `key=value` pairs. Flat records (objects whose values are all primitives)
 * fold onto one line to keep the cost estimate and the strategy belief from
 * dominating the payload. The form is readable as prose and parses back to the
 * same shape, so the schema round-trip stays meaningful.
 */
const isFlatRecord = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value as Record<string, unknown>).every(
    ([k, v]) =>
      !RENDER_SKIP_KEYS.has(k) && (v === null || v === undefined || typeof v !== "object"),
  );

const renderFlatRecord = (value: Record<string, unknown>, indent: number): string => {
  const pad = "  ".repeat(indent);
  const pairs = Object.entries(value)
    .filter(([k, v]) => !RENDER_SKIP_KEYS.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return `${pad}${pairs.join(" ")}`;
};

const renderValue = (value: unknown, indent: number): string[] => {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [`${pad}${String(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}-`];
    const isLeaf = value.every((v) => v === null || typeof v !== "object");
    if (isLeaf) return [`${pad}${value.map(String).join(" ")}`];
    const lines: string[] = [];
    value.forEach((entry, index) => {
      if (isFlatRecord(entry)) {
        lines.push(
          `${pad}[${index}] ${renderFlatRecord(entry as Record<string, unknown>, 0).trimStart()}`,
        );
      } else {
        lines.push(`${pad}[${index}]`);
        lines.push(...renderValue(entry, indent + 1));
      }
    });
    return lines;
  }
  if (typeof value === "object") {
    if (isFlatRecord(value)) return [renderFlatRecord(value as Record<string, unknown>, indent)];
    const lines: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RENDER_SKIP_KEYS.has(k) || v === null || v === undefined) continue;
      if (typeof v === "object") {
        lines.push(`${pad}${k}:`);
        lines.push(...renderValue(v, indent + 1));
      } else {
        lines.push(`${pad}${k}=${String(v)}`);
      }
    }
    return lines;
  }
  return [];
};

/**
 * Render a validated wakeup struct as the resumed turn's wakeup text.
 *
 * Exported so the contract test can assert the rendered length stays under the
 * context budget without re-implementing the renderer.
 */
export const renderWakeup = (wakeup: TradingHarnessWakeup): string => {
  const rounded = roundWakeupFloats(wakeup);
  const lines: string[] = ["trading-harness-wakeup"];
  const top = rounded as Record<string, unknown>;
  for (const [key, value] of Object.entries(top)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}:`);
    lines.push(...renderValue(value, 1));
  }
  // The mandate and authority are no longer embedded on every wake — point the
  // run at the one tool that returns them, so it does not have to discover it.
  lines.push("mandate-and-authority: call trading_get_mission");
  return lines.join("\n");
};

/**
 * Keep the first `WAKEUP_LIST_ENTRIES` entries, and say how many were dropped.
 *
 * The marker entry matters more than it looks: a run that sees five exit
 * conditions where it published nine would work from a plan it never wrote.
 * `(+4 more)` tells it the list is a projection and `trading_get_mission`
 * returns the whole thing.
 */
const capList = <A>(
  entries: ReadonlyArray<A>,
  marker: (dropped: number) => A,
): ReadonlyArray<A> => {
  if (entries.length <= WAKEUP_LIST_ENTRIES) return entries;
  return [...entries.slice(0, WAKEUP_LIST_ENTRIES), marker(entries.length - WAKEUP_LIST_ENTRIES)];
};

const conditionMarker = (dropped: number) => ({ description: `(+${dropped} more)` });

/**
 * The first rung: clip the plan's prose to what a run reads at a glance.
 *
 * The publish path already bounds each field at 600 chars; this is the harder
 * wakeup projection. The persisted strategy is untouched — the full text stays
 * one `trading_get_mission` call away.
 */
const boundWakeupProse = (strategy: TradingPlanState): TradingPlanState => ({
  ...strategy,
  ...boundStrategyProse(strategy, WAKEUP_PROSE_CHARS).strategy,
});

/** The second rung: keep the head of each published list, drop the tail. */
const boundStrategyLists = (strategy: TradingPlanState): TradingPlanState => ({
  ...strategy,
  belief: {
    ...strategy.belief,
    evidence: capList(strategy.belief.evidence, (dropped) => `(+${dropped} more)`),
  },
  entryPlan: {
    ...strategy.entryPlan,
    conditions: capList(strategy.entryPlan.conditions, conditionMarker),
  },
  exitConditions: capList(strategy.exitConditions, conditionMarker),
  abandonmentConditions: capList(strategy.abandonmentConditions, conditionMarker),
  reentryConditions: capList(strategy.reentryConditions, conditionMarker),
});

/**
 * The rungs the renderer climbs, cheapest loss of signal first.
 *
 * Order is deliberate: prose the run can re-read on demand goes before the
 * lists it decides from, and the live market data it cannot re-derive from a
 * tool call goes last.
 */
const TRIM_LADDER: ReadonlyArray<{
  readonly name: string;
  readonly apply: (wakeup: TradingHarnessWakeup) => TradingHarnessWakeup;
}> = [
  {
    name: "strategy_prose",
    apply: (wakeup) => ({ ...wakeup, activeStrategy: boundWakeupProse(wakeup.activeStrategy) }),
  },
  {
    name: "strategy_lists",
    apply: (wakeup) => ({ ...wakeup, activeStrategy: boundStrategyLists(wakeup.activeStrategy) }),
  },
  {
    name: "events_and_watches",
    apply: (wakeup) => ({
      ...wakeup,
      pendingEvents: wakeup.pendingEvents.slice(-WAKEUP_PENDING_EVENTS),
      armedWatches: wakeup.armedWatches.slice(0, WAKEUP_ARMED_WATCHES),
    }),
  },
  {
    name: "recent_candles",
    apply: (wakeup) => ({
      ...wakeup,
      recentCandles: {
        ...wakeup.recentCandles,
        candles: wakeup.recentCandles.candles.slice(-WAKEUP_TRIMMED_CANDLES),
      },
    }),
  },
];

/**
 * Render the wakeup, shrinking the projection until it fits the budget.
 *
 * Compose used to fail when the rendered text blew `MAX_WAKEUP_CHARS`, on the
 * theory that an oversized wakeup is a composer defect. It is not: the size is
 * the harness's own prose coming back at it, so one verbose plan made every
 * subsequent wake for that mission fail identically — the watch was consumed,
 * the run was marked failed, and the mission went permanently deaf. Trimming is
 * always the better answer than not waking, and every rung is logged so an
 * oversized plan stays visible.
 */
export const renderBoundedWakeup = (
  wakeup: TradingHarnessWakeup,
): {
  readonly text: string;
  readonly steps: ReadonlyArray<string>;
  readonly untrimmedChars: number;
} => {
  let current = wakeup;
  let text = renderWakeup(current);
  const untrimmedChars = text.length;
  const steps: string[] = [];

  for (const rung of TRIM_LADDER) {
    if (text.length <= MAX_WAKEUP_CHARS) return { text, steps, untrimmedChars };
    current = rung.apply(current);
    steps.push(rung.name);
    text = renderWakeup(current);
  }
  if (text.length <= MAX_WAKEUP_CHARS) return { text, steps, untrimmedChars };

  // Last resort. The run still gets its market and position facts (they render
  // first) and is told the rest is one tool call away.
  steps.push("hard_truncation");
  return {
    text: `${text.slice(0, MAX_WAKEUP_CHARS - HARD_TRUNCATION_MARKER.length)}${HARD_TRUNCATION_MARKER}`,
    steps,
    untrimmedChars,
  };
};

/**
 * Failure surface for the compose step. A gateway failure (snapshot read) or a
 * missing trading account surface here; the wake path turns either into a
 * `blocked` run so the lease is released and the mission is not left stuck.
 */
export interface ComposeWakeupError {
  readonly _tag: "ComposeWakeupError";
  readonly reason: string;
  readonly cause?: unknown;
}

export interface ComposeWakeupInput {
  readonly mission: TradingMission;
  readonly harnessRunId: string;
  readonly cause: TradingHarnessRunCause;
  readonly occurredAt: number;
  /** The watch id that fired, when the cause is a watch or timer. */
  readonly triggeringWatchId?: string;
  /** The user message text, when the cause is `user_message`. */
  readonly userMessage?: string;
  /**
   * The pending inbox events the coordinator already collected and marked
   * `included_in_run` atomically with the lease. Re-passing them keeps the
   * composer free of a second inbox round-trip and avoids a race where a
   * freshly-persisted event sneaks into the snapshot.
   */
  readonly pendingEvents: ReadonlyArray<TradingDomainEventSummary>;
  /**
   * The active strategy the coordinator already loaded (check 7). Passed in so
   * the composer does not re-fetch and observe a different version than the one
   * the lease was acquired against.
   */
  readonly activeStrategy: TradingPlanState;
}

export interface TradingWakeupComposerShape {
  /**
   * Gather the fresh market/account snapshots, resolve the triggering watch,
   * and assemble the bounded `TradingHarnessWakeup`.
   *
   * Returns the structured wakeup value (for inspection) and its JSON
   * serialization (for the resumed turn's `message.text`).
   */
  readonly compose: (
    input: ComposeWakeupInput,
  ) => Effect.Effect<
    { readonly wakeup: TradingHarnessWakeup; readonly text: string },
    ComposeWakeupError
  >;
}

export class TradingWakeupComposer extends Context.Service<
  TradingWakeupComposer,
  TradingWakeupComposerShape
>()("t3/trading/TradingWakeupComposer") {}

const fail = (reason: string, cause?: unknown): ComposeWakeupError => ({
  _tag: "ComposeWakeupError",
  reason,
  cause,
});

const make = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;
  const missions = yield* TradingMissionService;
  const watches = yield* TradingWatchService;
  const strategies = yield* TradingStrategyService;
  const costs = yield* TradingCostEstimator;

  /**
   * Measure the higher timeframe, or return nothing.
   *
   * Enrichment, not a fact the wakeup is defined by: a mission whose second
   * history read fails still needs to wake, so the failure costs the field and
   * nothing else.
   */
  const measureHigherTimeframe = (
    market: TradingMission["market"],
    primary: TradingTimeframe,
  ): Effect.Effect<ObservedVolatility | null> => {
    const higher = HIGHER_TIMEFRAME[primary];
    if (higher === null) return Effect.succeed(null);
    return gateway
      .getMarketHistory({ market, interval: higher, maxBars: VOLATILITY_LOOKBACK_BARS })
      .pipe(
        Effect.map((history) =>
          measureVolatility({
            market,
            interval: higher,
            candles: history.candles,
            measuredAt: history.freshness.observedAt,
            // Two horizons cover the structure check a target needs; the default
            // six-point distribution is more than a wakeup needs to carry.
            holdHorizons: WAKEUP_HOLD_HORIZONS,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
  };

  /**
   * Cost the round trip on the size actually held.
   *
   * Flat there is nothing to cost, and the hypothetical belongs to
   * `trading_estimate_costs`. On a profit-target wake this is the number that
   * decides whether the unrealised PnL beside it is worth banking, so it is
   * measured at the real size rather than at a round one.
   */
  const costOpenPosition = (
    market: string,
    size: number,
    masterAddress: string,
    fallbackTakerFeeBpsPerSide: number,
  ): Effect.Effect<TradingCostEstimate | null> => {
    if (size === 0) return Effect.succeed(null);
    return costs
      .estimate({
        market,
        masterAddress: masterAddress as `0x${string}`,
        sizeEth: Math.abs(size),
        fallbackTakerFeeBpsPerSide,
      })
      .pipe(
        Effect.provideService(HyperliquidGateway, gateway),
        Effect.catchCause(() => Effect.succeed(null)),
      );
  };

  const resolveTriggeringWatch = (
    watchId: string | undefined,
  ): Effect.Effect<Option.Option<PersistedWatch>, ComposeWakeupError> =>
    Effect.gen(function* () {
      if (watchId === undefined) return Option.none();
      const watch = yield* watches
        .getWatch(watchId)
        .pipe(Effect.mapError((error) => fail("watch_lookup_failed", error)));
      return watch === null ? Option.none() : Option.some(watch);
    });

  const compose: TradingWakeupComposerShape["compose"] = (input) =>
    Effect.gen(function* () {
      const { mission, harnessRunId, cause, occurredAt, pendingEvents, activeStrategy } = input;

      // §10.6: account reads always use the master-wallet address as identity.
      const address = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.mapError((error) => fail("address_resolution_failed", error)));

      // Fresh snapshots — the whole point of the wake path. The gateway enforces
      // its own freshness windows (BBO 2s, asset context 5s, §13); the composer
      // does not second-guess them. The position read and the bounded 20-bar
      // history ride the same batch so a woken run starts already knowing what
      // it holds and what price just did, without boilerplate tool calls. A
      // history-read failure fails compose the same way a snapshot failure does.
      const primaryTimeframe = activeStrategy.timeframes[0] ?? POC_DEFAULT_TIMEFRAME;
      const [marketSnapshot, accountSnapshot, position, history] = yield* Effect.all(
        [
          gateway.getMarketSnapshot(mission.market),
          gateway.getAccountSnapshot(address),
          gateway.getPosition(address, mission.market),
          // One read serves both halves of "what did price just do?": the last
          // 20 bars the harness reads directly, and the longer window the
          // volatility measurement needs to say anything trustworthy.
          gateway.getMarketHistory({
            market: mission.market,
            interval: primaryTimeframe,
            maxBars: VOLATILITY_LOOKBACK_BARS,
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((error) => fail("snapshot_read_failed", error)));

      // §12.2 bounds `recentCandles` at 20 bars; the measurement reads the whole
      // window. A target derived from 20 one-minute bars is a target derived
      // from twenty minutes of noise.
      const recentCandles = {
        ...history,
        candles: history.candles.slice(-WAKEUP_RECENT_CANDLES),
      };
      const observedVolatility = measureVolatility({
        market: mission.market,
        interval: primaryTimeframe,
        candles: history.candles,
        measuredAt: history.freshness.observedAt,
        // Two horizons cover the structure check a target needs; the default
        // six-point distribution is more than a wakeup needs to carry.
        holdHorizons: WAKEUP_HOLD_HORIZONS,
      });

      // What the position was worth at its best, and how far it has come off
      // that. A profit-target wake that has to choose between banking and
      // extending needs both, and the exchange reports neither.
      const peak = yield* missions
        .readPeakUnrealisedPnl({ missionId: mission.id, market: mission.market })
        .pipe(Effect.mapError((error) => fail("peak_pnl_read_failed", error)));
      const positionWithPeak =
        peak === null
          ? position
          : {
              ...position,
              peakUnrealisedPnl: peak,
              drawdownFromPeakUsd: Math.max(0, peak - position.unrealisedPnl),
            };

      // Both enrichments, concurrently, and both optional. Neither can fail the
      // compose: a wakeup that arrives without its second timeframe is worse
      // than one that arrives with it, and far better than one that never
      // arrives at all.
      const [higherTimeframeVolatility, positionCosts] = yield* Effect.all(
        [
          measureHigherTimeframe(mission.market, primaryTimeframe),
          costOpenPosition(
            mission.market,
            position.size,
            address,
            mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
          ),
        ],
        { concurrency: "unbounded" },
      );

      const triggeringWatch = yield* resolveTriggeringWatch(input.triggeringWatchId);

      // What is still armed, and how far the market has to travel to fire each
      // one. Without this a woken run has to call `trading_list_watches` and do
      // the arithmetic itself before it can tell a near miss from a level it
      // armed an hour ago and forgot.
      const armed = yield* strategies
        .listWatches(mission.id)
        .pipe(Effect.mapError((error) => fail("watch_list_failed", error)));
      const armedWatches = armed
        .filter((persisted) => persisted.status === "active")
        .map((persisted) => describeArmedWatch(persisted, marketSnapshot.markPrice));

      const wakeup: TradingHarnessWakeup = {
        kind: "trading-harness-wakeup",
        missionId: mission.id,
        harnessRunId,
        cause,
        occurredAt,
        triggeringWatch: Option.isSome(triggeringWatch) ? triggeringWatch.value : undefined,
        // Only a watch the runtime armed itself carries a reason; a watch the
        // harness registered woke it for the reason the harness already knows.
        wakeReason: Option.isSome(triggeringWatch) ? triggeringWatch.value.armedReason : undefined,
        userMessage: input.userMessage,
        marketSnapshot,
        accountSnapshot,
        position: positionWithPeak,
        recentCandles,
        observedVolatility,
        ...(higherTimeframeVolatility === null ? {} : { higherTimeframeVolatility }),
        ...(positionCosts === null ? {} : { positionCosts }),
        activeStrategy,
        strategyAgeMillis: Math.max(0, occurredAt - activeStrategy.updatedAt),
        armedWatches,
        pendingEvents: [...pendingEvents],
      };

      // The mandate, instruction, and default timeframe are stable for a
      // mission's life and no longer duplicated onto every wake — the rendered
      // text points the run at `trading_get_mission` for them instead.
      const validated = decodeWakeup(wakeup);
      const { text, steps, untrimmedChars } = renderBoundedWakeup(validated);
      if (steps.length > 0) {
        yield* Effect.logWarning("TradingWakeupComposer: wakeup trimmed to fit the budget", {
          missionId: mission.id,
          harnessRunId,
          steps,
          before: untrimmedChars,
          after: text.length,
          limit: MAX_WAKEUP_CHARS,
        });
      }
      return { wakeup: validated, text };
    });

  return { compose } satisfies TradingWakeupComposerShape;
});

export const TradingWakeupComposerLive = Layer.effect(TradingWakeupComposer, make);
