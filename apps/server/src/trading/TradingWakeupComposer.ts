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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type {
  AgentAccountSnapshot,
  AgentNetPosition,
} from "@t3tools/trading-contracts/account-snapshot";
import type { AgentMarketSnapshot, MarketHistory } from "@t3tools/trading-contracts/market";
import type { LevelHistoryEntry, PreviousStructureRead } from "@t3tools/trading-contracts/wakeup";
import {
  costContextFromEstimate,
  type TradingCostContext,
  type TradingCostEstimate,
} from "@t3tools/trading-contracts/costs";
import {
  planPhase,
  runtimeTimeframe,
  type TradingTimeframe,
} from "@t3tools/trading-contracts/strategy";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import type { ObservedVolatility } from "@t3tools/trading-contracts/volatility";

import { boundStrategyProse } from "./StrategyProse.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import {
  LEVEL_GROUP_TOLERANCE_ATR,
  readLevelHistory,
  readPreviousStructureRead,
} from "./TradingLevelHistory.ts";

import type { TradingPlanState } from "./Schemas.ts";
import type { PersistedWatch } from "./Schemas.ts";
import type { TradingMission } from "./Schemas.ts";
import {
  describeArmedWatch,
  findMisarmedEntryConditions,
  findUnarmedEntryConditions,
  TradingDomainEventSummary,
  TradingHarnessWakeup,
  type TradingHarnessRunCause,
} from "./Schemas.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

/** §12.2 bounds the candles a wakeup carries directly. */
const WAKEUP_RECENT_CANDLES = 8;

/** Whether a stored structure-read interval is a timeframe the wakeup can echo. */
const isTradingTimeframe = (value: string): value is TradingTimeframe =>
  value === "1m" || value === "3m" || value === "5m" || value === "15m" || value === "1h";

/**
 * The holding-period horizons the wakeup carries, rather than the default six.
 *
 * A target is checked against a near and a far window; the four middle points
 * the default distribution adds are noise the resumed turn does not read. The
 * `trading_look` tool still uses the full default — this trims
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

/** The harder per-field clip the `strategy_digest` trim rung applies. */
const WAKEUP_DIGEST_PROSE_CHARS = 120;

/** Longest any published condition/evidence list survives in the projection. */
const WAKEUP_LIST_ENTRIES = 6;

/** How many inbox events and armed watches the second trim rung keeps. */
const WAKEUP_PENDING_EVENTS = 6;
const WAKEUP_ARMED_WATCHES = 12;

/** Bars `recentCandles` falls back to once the cheaper rungs are exhausted. */
const WAKEUP_TRIMMED_CANDLES = 4;

/**
 * The second timeframe every wakeup measures, given the mission's first.
 *
 * A target has to be checked against a structure longer than the one it was
 * read off, and on 1m the longest horizon the measurement offers is twenty
 * minutes. Rather than instruct the harness to remember a second
 * `trading_look` call it is free to skip, the wakeup carries the
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
 * Which second timeframe this wakeup measures.
 *
 * A target has to be checked against a structure longer than the one it was
 * read off, and on 1m the longest horizon the measurement offers is twenty
 * minutes. Rather than instruct the harness to remember a second
 * `trading_look` call it is free to skip, the wakeup carries the
 * pair. A mission already running on 1h has nothing higher to pair with.
 *
 * This used to prefer the plan's published `timeframes[0]` when it sat above
 * the runtime interval; the plan no longer names timeframes (plan 29 step
 * 4.1), so the fixed pairing is the whole rule — a plan that reasons on a
 * longer interval says so in `because`, and the runtime still feeds it the
 * fastest bars plus this one higher read.
 */
const pairedTimeframe = (primary: TradingTimeframe): TradingTimeframe | null =>
  HIGHER_TIMEFRAME[primary];

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
const isPrimitiveRecord = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value as Record<string, unknown>).every(
    ([k, v]) =>
      !RENDER_SKIP_KEYS.has(k) && (v === null || v === undefined || typeof v !== "object"),
  );

// A record still folds onto one line when its values nest one level of
// primitive-only records — a quantile block like `favourableUpUsd={p25=7 p50=20
// p75=33}` reads fine inline, and the multi-line form was a third of the
// volatility section's bulk.
const isFlatRecord = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value as Record<string, unknown>).every(
    ([k, v]) =>
      !RENDER_SKIP_KEYS.has(k) &&
      (v === null || v === undefined || typeof v !== "object" || isPrimitiveRecord(v)),
  );

const renderFlatRecord = (value: Record<string, unknown>, indent: number): string => {
  const pad = "  ".repeat(indent);
  const renderPrimitiveRecord = (record: Record<string, unknown>): string =>
    Object.entries(record)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  const pairs = Object.entries(value)
    .filter(([k, v]) => !RENDER_SKIP_KEYS.has(k) && v !== null && v !== undefined)
    .map(([k, v]) =>
      typeof v === "object"
        ? `${k}={${renderPrimitiveRecord(v as Record<string, unknown>)}}`
        : `${k}=${String(v)}`,
    );
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
const renderWakeupProjection = (projection: Record<string, unknown>): string => {
  const rounded = roundWakeupFloats(projection);
  const lines: string[] = ["trading-harness-wakeup"];
  const top = rounded as Record<string, unknown>;
  for (const [key, value] of Object.entries(top)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}:`);
    lines.push(...renderValue(value, 1));
  }
  // The mandate and authority are no longer embedded on every wake — point the
  // run at the one tool that returns them, so it does not have to discover it.
  lines.push("mandate-and-authority: call trading_look");
  return lines.join("\n");
};

export const renderWakeup = (wakeup: TradingHarnessWakeup): string =>
  renderWakeupProjection(wakeup as unknown as Record<string, unknown>);

/**
 * Keep the first `WAKEUP_LIST_ENTRIES` entries, and say how many were dropped.
 *
 * The marker entry matters more than it looks: a run that sees five exit
 * conditions where it published nine would work from a plan it never wrote.
 * `(+4 more)` tells it the list is a projection and `trading_look`
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
 * one `trading_look` call away.
 */
const boundWakeupProse = (strategy: TradingPlanState): TradingPlanState => ({
  ...strategy,
  ...boundStrategyProse(strategy, WAKEUP_PROSE_CHARS).strategy,
});

/** The second rung: keep the head of each published list, drop the tail. */
const boundStrategyLists = (strategy: TradingPlanState): TradingPlanState => ({
  ...strategy,
  entry: {
    ...strategy.entry,
    triggers: capList(strategy.entry.triggers, conditionMarker),
  },
  invalidation: capList(strategy.invalidation, (dropped) => `(+${dropped} more)`),
});

/**
 * The rungs the renderer climbs, cheapest loss of signal first.
 *
 * Order is deliberate: prose the run can re-read on demand goes before the
 * lists it decides from, and the live market data it cannot re-derive from a
 * tool call goes last.
 */
/**
 * The hardest strategy projection: prose clipped to a line each and the
 * trigger list replaced by a pointer. The persisted plan is untouched and one
 * `trading_look` call away.
 */
const digestStrategy = (strategy: TradingPlanState): TradingPlanState => ({
  ...strategy,
  ...boundStrategyProse(strategy, WAKEUP_DIGEST_PROSE_CHARS).strategy,
  entry: {
    ...strategy.entry,
    triggers: [{ description: "(clipped — call trading_look for the full plan)" }],
  },
});

const TRIM_LADDER: ReadonlyArray<{
  readonly name: string;
  readonly apply: (wakeup: TradingHarnessWakeup) => TradingHarnessWakeup;
}> = [
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
  {
    // The two review reminders go here too (only ever one is present): by this
    // rung the plan's own prose is being cut to a line, and doctrine the run
    // can read with one `trading_get_playbook` call does not outrank the market
    // data beside it.
    name: "strategy_digest",
    apply: (wakeup) => {
      const { strategyReview: _dropped, positionReview: _alsoDropped, ...rest } = wakeup;
      // A plan-less wakeup has nothing to digest; the rung still drops the
      // review reminders, which is the point of arriving here.
      return wakeup.activeStrategy === undefined
        ? rest
        : { ...rest, activeStrategy: digestStrategy(wakeup.activeStrategy) };
    },
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
  // Prose and list bounding used to be the first two trim rungs, but in
  // practice every real plan tripped them: the "full" rendering never survived
  // to a provider anyway, so it is now the baseline projection rather than a
  // logged trim step. The full text stays one trading_look call away.
  let current: TradingHarnessWakeup =
    wakeup.activeStrategy === undefined
      ? wakeup
      : {
          ...wakeup,
          activeStrategy: boundStrategyLists(boundWakeupProse(wakeup.activeStrategy)),
        };
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

  // Last resort is still structural: keep complete decision-critical fields
  // and replace re-readable sections with pointers. Never cut the final string
  // mid-field — a truncated price, condition, or JSON-shaped record is worse
  // than an explicit omission.
  steps.push("essential_projection");
  const essential = renderWakeupProjection({
    kind: current.kind,
    missionId: current.missionId,
    harnessRunId: current.harnessRunId,
    cause: current.cause,
    occurredAt: current.occurredAt,
    triggeringWatch: current.triggeringWatch,
    wakeReason: current.wakeReason,
    userMessage: current.userMessage,
    marketSnapshot: current.marketSnapshot,
    accountSnapshot: current.accountSnapshot,
    position: current.position,
    recentCandles: {
      ...current.recentCandles,
      candles: current.recentCandles.candles.slice(-2),
    },
    observedVolatility: current.observedVolatility,
    positionCosts: current.positionCosts,
    costContext: current.costContext,
    ...(current.activeStrategy === undefined
      ? {}
      : {
          strategy: {
            market: current.activeStrategy.market,
            intent: current.activeStrategy.intent,
            // The phase the old `currentAction` used to carry, derived from
            // what the mission holds: flat is waiting, a position is holding.
            planPhase: planPhase(current.position.size),
            entryTriggers: current.activeStrategy.entry.triggers.slice(0, 3),
            stop: current.activeStrategy.stop,
            target: current.activeStrategy.target,
          },
        }),
    armedWatches: current.armedWatches.slice(0, 6),
    unarmedEntryConditions: current.unarmedEntryConditions,
    misarmedEntryConditions: current.misarmedEntryConditions,
    pendingEvents: current.pendingEvents.slice(-3),
    omitted: "call trading_look for the full plan, authority, watches, and pending state",
  });
  if (essential.length <= MAX_WAKEUP_CHARS) {
    return { text: essential, steps, untrimmedChars };
  }

  steps.push("minimal_projection");
  const minimal = renderWakeupProjection({
    kind: current.kind,
    missionId: current.missionId,
    harnessRunId: current.harnessRunId,
    cause: current.cause,
    occurredAt: current.occurredAt,
    market: current.marketSnapshot.market,
    markPrice: current.marketSnapshot.markPrice,
    position: current.position,
    triggeringWatch: current.triggeringWatch,
    pendingEvents: current.pendingEvents.slice(-1),
    omitted:
      "wakeup exceeded the context budget; call trading_look and fresh market tools before deciding",
  });
  return { text: minimal, steps, untrimmedChars };
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
   * The active plan the coordinator already loaded. Optional since plan 29
   * step 4.3: a plan-less mission wakes on the same snapshot, with
   * `strategyReview` saying there is no plan and the turn is there to decide.
   */
  readonly activeStrategy?: TradingPlanState | undefined;
}

/** What one observation of a mission's market and state is made of. */
export interface ObserveInput {
  readonly mission: TradingMission;
  readonly occurredAt: number;
  /** The market to read. Defaults to the mission's own. */
  readonly market?: TradingMission["market"] | undefined;
  /** The plan in force, when there is one — it sizes the cost context. */
  readonly activeStrategy?: TradingPlanState | undefined;
}

/**
 * The facts a wake and a `trading_look` are both made of — plan 29 step 6.1.
 *
 * The twelve read tools and this composer were two implementations of "what
 * does the model need to know". This is the single gather both now run; the
 * wakeup adds its framing (cause, triggering watch, the reviews) and renders,
 * and `trading_look` returns it as a structure.
 */
export interface ObservedFacts {
  readonly address: string;
  readonly market: TradingMission["market"];
  readonly primaryTimeframe: TradingTimeframe;
  readonly marketSnapshot: AgentMarketSnapshot;
  readonly accountSnapshot: AgentAccountSnapshot;
  /** The position, carrying T3's own high-water mark when one is recorded. */
  readonly position: AgentNetPosition;
  /** The full lookback window the measurements were taken over. */
  readonly history: MarketHistory;
  /** The bounded tail of `history` a wakeup carries. */
  readonly recentCandles: MarketHistory;
  readonly observedVolatility: ObservedVolatility;
  readonly higherTimeframeVolatility: ObservedVolatility | null;
  readonly positionCosts: TradingCostEstimate | null;
  readonly costContext: TradingCostContext | null;
  readonly levelHistory: ReadonlyArray<LevelHistoryEntry>;
  readonly previousStructureRead: PreviousStructureRead | undefined;
  readonly enteredWithoutScoredSetup: boolean | undefined;
  /** Every watch this mission has registered, in whatever status. */
  readonly watches: ReadonlyArray<PersistedWatch>;
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

  /**
   * The gather half of `compose`, on its own — what `trading_look` returns.
   *
   * Same reads, same failure surface, same enrichment-never-fails rule: a
   * higher timeframe, a cost line, or a memory read that fails costs its field
   * and nothing else.
   */
  readonly observe: (input: ObserveInput) => Effect.Effect<ObservedFacts, ComposeWakeupError>;
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
  // Level memory + prior-read echo (plan 27 B1/B2) are local table reads.
  const sql = yield* SqlClient.SqlClient;

  /**
   * Measure the higher timeframe, or return nothing.
   *
   * Enrichment, not a fact the wakeup is defined by: a mission whose second
   * history read fails still needs to wake, so the failure costs the field and
   * nothing else.
   */
  const measureHigherTimeframe = (
    market: TradingMission["market"],
    higher: TradingTimeframe | null,
  ): Effect.Effect<ObservedVolatility | null> => {
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
   * `trading_look`. On a profit-target wake this is the number that
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

  /**
   * The one cost line a flat wake carries — plan 29 step 3.1.
   *
   * Priced at the plan's intended entry notional when the plan names one, else
   * at the mission's allocated capital: a notional the mission could actually
   * trade, stated in the line itself. Context for the entry question, never a
   * gate; a failed read costs the field, never the wake. Holding wakes carry
   * `positionCosts` instead.
   */
  const costFlatWakeup = (
    market: string,
    intendedNotionalUsd: number | null,
    defaultNotionalUsd: number,
    masterAddress: string,
    fallbackTakerFeeBpsPerSide: number,
  ): Effect.Effect<TradingCostContext | null> =>
    costs
      .estimate({
        market,
        masterAddress: masterAddress as `0x${string}`,
        notionalUsd: intendedNotionalUsd ?? defaultNotionalUsd,
        fallbackTakerFeeBpsPerSide,
      })
      .pipe(
        Effect.map(costContextFromEstimate),
        Effect.provideService(HyperliquidGateway, gateway),
        Effect.catchCause(() => Effect.succeed(null)),
      );

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

  const observe: TradingWakeupComposerShape["observe"] = (input) =>
    Effect.gen(function* () {
      const { mission, occurredAt } = input;
      const activeStrategy = input.activeStrategy;
      const market = input.market ?? mission.market;

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
      // The mandate's interval, or 1m — see `runtimeTimeframe`. The plan no
      // longer names a timeframe of its own (plan 29 step 4.1).
      const primaryTimeframe = runtimeTimeframe(mission.instruction);
      const [marketSnapshot, accountSnapshot, position, history] = yield* Effect.all(
        [
          gateway.getMarketSnapshot(market),
          gateway.getAccountSnapshot(address),
          gateway.getPosition(address, market),
          // One read serves both halves of "what did price just do?": the last
          // 20 bars the harness reads directly, and the longer window the
          // volatility measurement needs to say anything trustworthy.
          gateway.getMarketHistory({
            market,
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
        market,
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
        .readPeakUnrealisedPnl({ missionId: mission.id, market })
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
      // arrives at all. A flat wake gets its one cost line here too — the
      // plan's intended entry notional when the plan names one, else the
      // allocated capital.
      const [higherTimeframeVolatility, positionCosts, costContext] = yield* Effect.all(
        [
          measureHigherTimeframe(market, pairedTimeframe(primaryTimeframe)),
          costOpenPosition(
            market,
            position.size,
            address,
            mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
          ),
          position.size === 0
            ? costFlatWakeup(
                market,
                activeStrategy !== undefined &&
                  activeStrategy.entry.initialNotionalUsd !== undefined &&
                  activeStrategy.entry.initialNotionalUsd > 0
                  ? activeStrategy.entry.initialNotionalUsd
                  : null,
                mission.authority.allocatedCapitalUsd,
                address,
                mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
              )
            : Effect.succeed<TradingCostContext | null>(null),
        ],
        { concurrency: "unbounded" },
      );

      // What the levels near the mark have already done to this mission, and
      // what the previous structure read believed (plan 27 B1/B2). Both are
      // memory, not fresh market data: either failing costs the field, never
      // the wake.
      const levelHistory = yield* readLevelHistory({
        missionId: mission.id,
        market,
        markPrice: marketSnapshot.markPrice,
        toleranceUsd: LEVEL_GROUP_TOLERANCE_ATR * observedVolatility.atrUsd,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const previousRead = yield* readPreviousStructureRead({
        missionId: mission.id,
        market,
        preferredInterval: primaryTimeframe,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      // Plan 27 C2: whether the open position's entry had a scored setup
      // behind it, read off the entry the server committed to. Absent while
      // flat, and absent (not asserted) when the row cannot be read.
      const enteredWithoutScoredSetup =
        position.size === 0
          ? undefined
          : yield* sql<{ readonly setup_kind: string | null }>`
              SELECT setup_kind FROM trading_entry_context
              WHERE mission_id = ${mission.id} AND action_type = 'open'
              ORDER BY recorded_at DESC
              LIMIT 1
            `.pipe(
              Effect.map((rows) => (rows.length === 0 ? true : rows[0]?.setup_kind == null)),
              Effect.orElseSucceed(() => undefined),
            );
      const previousStructureRead =
        previousRead === null || !isTradingTimeframe(previousRead.interval)
          ? undefined
          : {
              interval: previousRead.interval,
              classification: previousRead.classification,
              ...(previousRead.swing_high === null
                ? {}
                : { swingHighUsd: previousRead.swing_high }),
              ...(previousRead.swing_low === null ? {} : { swingLowUsd: previousRead.swing_low }),
              readAgeMillis: Math.max(0, occurredAt - previousRead.measured_at),
            };

      // Every watch this mission has registered. A wake describes the active
      // ones with their distance from the mark; a `look` reports the whole
      // list, including what already fired.
      const watches = yield* strategies
        .listWatches(mission.id)
        .pipe(Effect.mapError((error) => fail("watch_list_failed", error)));

      return {
        address,
        market,
        primaryTimeframe,
        marketSnapshot,
        accountSnapshot,
        position: positionWithPeak,
        history,
        recentCandles,
        observedVolatility,
        higherTimeframeVolatility,
        positionCosts,
        costContext,
        levelHistory,
        previousStructureRead,
        enteredWithoutScoredSetup,
        watches,
      } satisfies ObservedFacts;
    });

  const compose: TradingWakeupComposerShape["compose"] = (input) =>
    Effect.gen(function* () {
      const { mission, harnessRunId, cause, occurredAt, pendingEvents } = input;
      const activeStrategy = input.activeStrategy;

      const facts = yield* observe({
        mission,
        occurredAt,
        ...(activeStrategy === undefined ? {} : { activeStrategy }),
      });
      const {
        marketSnapshot,
        accountSnapshot,
        recentCandles,
        observedVolatility,
        higherTimeframeVolatility,
        positionCosts,
        costContext,
        levelHistory,
        previousStructureRead,
        enteredWithoutScoredSetup,
      } = facts;
      const position = facts.position;
      const armed = facts.watches;

      const triggeringWatch = yield* resolveTriggeringWatch(input.triggeringWatchId);

      // What is still armed, and how far the market has to travel to fire each
      // one. Without this a woken run has to read the watch list and do the
      // arithmetic itself before it can tell a near miss from a level it armed
      // an hour ago and forgot.
      const armedWatches = armed
        .filter((persisted) => persisted.status === "active")
        .map((persisted) => describeArmedWatch(persisted, marketSnapshot.markPrice));

      // Flat and waiting: the entry levels the plan names, that nothing is armed
      // at. The runtime reports the gap and never closes it — a watch predicate
      // comes from `MarketWatch`, never from a condition's prose. Flat is the
      // waiting phase (`planPhase`); the old gate read the nine-value
      // `currentAction`, and "flat" is the whole of what it meant.
      const unarmedEntryConditions =
        activeStrategy !== undefined && planPhase(position.size) === "waiting"
          ? findUnarmedEntryConditions({
              conditions: activeStrategy.entry.triggers,
              watches: armed,
            })
          : [];

      // Plan 29 step 4.6: an untriggered plan goes stale on its own. When the
      // wake is past `reassess.afterMinutes` since the plan was written, the
      // review says so ahead of anything else — the plan is no longer the
      // incumbent view, it is the thing to reconsider.
      const staleNote =
        activeStrategy !== undefined &&
        occurredAt > activeStrategy.updatedAt + activeStrategy.reassess.afterMinutes * 60_000
          ? `STALE PLAN — this plan has gone stale (published ${Math.round(
              (occurredAt - activeStrategy.updatedAt) / 60_000,
            )} min ago against a ${activeStrategy.reassess.afterMinutes} min reassess window); reassess before acting on it. `
          : "";

      // Flat: every playbook is a candidate again this turn. See
      // `strategyReview` on the wakeup schema for why this rides the payload
      // rather than living only in the playbook the run may not call. A
      // plan-less flat mission gets the decision prompt instead — the turn is
      // the mission's read on the market, not an apology for a missing plan
      // (plan 29 step 4.3).
      const flatReview =
        activeStrategy === undefined
          ? "FLAT, NO PLAN ACTIVE — nothing is armed for this mission and no thesis is on file. Decide this turn: weigh the market against one question — is the expected move over the intended hold bigger than the round trip is worth? (`costContext` prices it) — and either publish a plan (`trading_publish_plan`; standing aside is a plan too) or arm what you are waiting for."
          : "FLAT — the field is open: momentum, range_reversion, opening_range, ema_cross, and rsi_reversion are all candidates again, and `candidates[]` carries each setup with its own cost arithmetic. Weigh each against one question — is the expected move over the intended hold bigger than the round trip is worth? (`costContext` prices it) — and take the one that answers it best, or none of them if none do.";
      const strategyReview = position.size === 0 ? `${staleNote}${flatReview}` : undefined;

      // Holding: the turn belongs to the position, not to the thesis. See
      // `positionReview` on the wakeup schema. A stale plan still says so —
      // holding does not make an expired thesis fresh.
      const positionReview =
        position.size === 0
          ? undefined
          : `${staleNote}HOLDING — spend this turn on the position. Bank-or-extend against positionCosts (unrealisedPnl minus the remaining exit cost is what banking is worth) and preferredTargetUsd; check drawdownFromPeakUsd against peakUnrealisedPnl; trail the stop (trail_peak / breakeven, or volatility_room if ATR expanded) rather than leaving it where entry put it; keep a \`giveback\` condition armed under the peak whenever you are in profit.`;

      // The other half of the same read: a level that IS armed, with a watch
      // that cannot evaluate the confirmation the trigger declared.
      const misarmedEntryConditions =
        activeStrategy === undefined
          ? []
          : findMisarmedEntryConditions({
              conditions: activeStrategy.entry.triggers,
              watches: armed,
            });

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
        position,
        recentCandles,
        observedVolatility,
        ...(higherTimeframeVolatility === null ? {} : { higherTimeframeVolatility }),
        ...(positionCosts === null ? {} : { positionCosts }),
        ...(costContext === null ? {} : { costContext }),
        ...(activeStrategy === undefined ? {} : { activeStrategy }),
        ...(activeStrategy === undefined
          ? {}
          : { strategyAgeMillis: Math.max(0, occurredAt - activeStrategy.updatedAt) }),
        armedWatches,
        ...(unarmedEntryConditions.length === 0 ? {} : { unarmedEntryConditions }),
        ...(misarmedEntryConditions.length === 0 ? {} : { misarmedEntryConditions }),
        ...(strategyReview === undefined ? {} : { strategyReview }),
        ...(positionReview === undefined ? {} : { positionReview }),
        ...(levelHistory.length === 0 ? {} : { levelHistory }),
        ...(enteredWithoutScoredSetup === undefined ? {} : { enteredWithoutScoredSetup }),
        ...(previousStructureRead === undefined ? {} : { previousStructureRead }),
        pendingEvents: [...pendingEvents],
      };

      // The mandate, instruction, and default timeframe are stable for a
      // mission's life and no longer duplicated onto every wake — the rendered
      // text points the run at `trading_look` for them instead.
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

  return { compose, observe } satisfies TradingWakeupComposerShape;
});

export const TradingWakeupComposerLive = Layer.effect(TradingWakeupComposer, make);
