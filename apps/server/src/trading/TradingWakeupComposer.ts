/**
 * TradingWakeupComposer - assembles the bounded `TradingHarnessWakeup` snapshot
 * a resumed run starts with, spec §12.2.
 *
 * The composer is the single place that assembles what a resumed harness turn
 * is told: what woke it (the fired watch or the operator's message), the mark,
 * the position, one cost line, the plan's numbers, the armed set, and pointers
 * at `trading_look` for everything else. It does not decide whether to run —
 * the `TradingTurnCoordinator` already did that and holds the decision lease.
 * The full market gather (`observe`) lives here too, but it belongs to
 * `trading_look`: the model pulls fresh data when a decision needs it, rather
 * than every wake pushing a snapshot it may not read.
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
import type {
  AgentMarketSnapshot,
  MarketHistory,
  OrderBook,
} from "@t3tools/trading-contracts/market";
import {
  MARKET_SAMPLE_MIN_SPAN_MILLIS,
  readMicrostructure,
  sampleFromObservation,
  type MarketMicrostructure,
} from "@t3tools/trading-contracts/microstructure";
import type { LevelHistoryEntry, PreviousStructureRead } from "@t3tools/trading-contracts/wakeup";
import {
  roundCostContext,
  roundCostEstimate,
  roundMicrostructure,
  roundObservedVolatility,
} from "@t3tools/trading-contracts/precision";
import {
  costContextFromEstimate,
  type TradingCostContext,
  type TradingCostEstimate,
} from "@t3tools/trading-contracts/costs";
import {
  describeProjection,
  planPhase,
  runtimeTimeframe,
  type TradingTimeframe,
} from "@t3tools/trading-contracts/strategy";
import { measureVolatility, VOLATILITY_LOOKBACK_BARS } from "@t3tools/trading-contracts/volatility";
import type { ObservedVolatility } from "@t3tools/trading-contracts/volatility";

import { readAccountMarginCapacityUsd } from "./AccountMarginCapacity.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import {
  LEVEL_GROUP_TOLERANCE_ATR,
  readLevelHistory,
  readPreviousStructureRead,
} from "./TradingLevelHistory.ts";
import { readMarketSample, writeMarketSample } from "./TradingMarketSample.ts";

import type { TradingPlanState } from "./Schemas.ts";
import type { PersistedWatch } from "./Schemas.ts";
import type { TradingMission } from "./Schemas.ts";
import type { WakeupArmedWatch, WakeupArmedWatchLine } from "./Schemas.ts";
import {
  describeArmedWatch,
  describeArmedWatchLine,
  describePositionCostLine,
  describeTriggeringWatchLine,
  findMisarmedEntryConditions,
  findUnarmedEntryConditions,
  TradingDomainEventSummary,
  TradingHarnessWakeup,
  type TradingHarnessRunCause,
} from "./Schemas.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

/**
 * §12.2 bounds the candles a wakeup carries directly.
 *
 * Five, down from eight: the wakeup rides a conversation that grows by one
 * wake per turn, and each embedded bar is a line repeated for the life of the
 * thread. Five 1m bars still answer "what did price just do?"; anything
 * deeper is one `trading_look` away.
 */
const WAKEUP_RECENT_CANDLES = 5;

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
 * Exceeding it never fails the compose — see `renderBoundedLeanWakeup`. A
 * wakeup that does not fit is a wakeup that does not happen, and a mission
 * whose every wake fails is deaf while still holding exposure.
 *
 * The ceiling is the backstop, not the diet: every wake renders lean (the
 * alert, the position, the plan's numbers, pointers), so a real wake sits far
 * under it.
 */
export const MAX_WAKEUP_CHARS = 5_000;

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
  return lines.join("\n");
};

/**
 * The armed set as the wake renders it: one line per watch.
 *
 * Every render path goes through here, so the schema keeps the whole
 * `WakeupArmedWatch` (the persisted wake and the UI still read it) and only
 * what the model is handed is compacted. See `describeArmedWatchLine`.
 */
const renderArmedWatches = (
  armed: ReadonlyArray<WakeupArmedWatch>,
): ReadonlyArray<WakeupArmedWatchLine> => armed.map(describeArmedWatchLine);

/**
 * The floor under every render path: what fired, what is held, and a pointer.
 *
 * Shared by the assessment ladder above and the lean ceiling below, so the two
 * cannot disagree about what the last resort keeps.
 */
const renderMinimalWakeup = (wakeup: TradingHarnessWakeup): string =>
  renderWakeupProjection({
    kind: wakeup.kind,
    missionId: wakeup.missionId,
    harnessRunId: wakeup.harnessRunId,
    cause: wakeup.cause,
    occurredAt: wakeup.occurredAt,
    market: wakeup.marketSnapshot.market,
    markPrice: wakeup.marketSnapshot.markPrice,
    position: wakeup.position,
    triggeringWatch:
      wakeup.triggeringWatch === undefined
        ? undefined
        : describeTriggeringWatchLine(wakeup.triggeringWatch),
    pendingEvents: wakeup.pendingEvents.slice(-1),
    readFirst:
      "wakeup exceeded the context budget; call trading_look and fresh market tools before deciding",
  });

/** What a lean wake keeps of the two lists that can grow, and its fallback. */
const LEAN_WAKE_CAPS = { armedWatches: 8, pendingEvents: 3 } as const;
const LEAN_WAKE_TRIMMED_CAPS = { armedWatches: 4, pendingEvents: 1 } as const;

/**
 * Render a wake: what fired (or what the operator said), what the mission
 * holds, the plan's numbers on one line, the one review line, and pointers.
 * No candles, no volatility, no book — the model reads those with
 * `trading_look` when the wake warrants acting.
 *
 * This is THE render path. Every cause used to split between this and a full
 * market-snapshot assessment; the split is gone because the model called
 * `trading_look` on assessment turns anyway, so the snapshot rode the context
 * twice per turn.
 */
const renderLeanWakeup = (
  wakeup: TradingHarnessWakeup,
  caps: { readonly armedWatches: number; readonly pendingEvents: number },
): string =>
  renderWakeupProjection({
    kind: wakeup.kind,
    missionId: wakeup.missionId,
    harnessRunId: wakeup.harnessRunId,
    cause: wakeup.cause,
    occurredAt: wakeup.occurredAt,
    triggeringWatch:
      wakeup.triggeringWatch === undefined
        ? undefined
        : describeTriggeringWatchLine(wakeup.triggeringWatch),
    wakeReason: wakeup.wakeReason,
    userMessage: wakeup.userMessage,
    market: wakeup.marketSnapshot.market,
    markPrice: wakeup.marketSnapshot.markPrice,
    position: wakeup.position,
    // One line, in the shape `costContext` already uses on the flat wakes.
    // The full estimate is a `trading_look` away and was a thousand
    // characters of every holding wake.
    ...(wakeup.positionCosts === undefined
      ? {}
      : { positionCosts: describePositionCostLine(wakeup.positionCosts) }),
    ...(wakeup.costContext === undefined ? {} : { costContext: wakeup.costContext }),
    // The prediction the fired trigger belongs to, as one line. The trigger
    // itself carries `predictionVersion`; without this the run would have to
    // fetch the plan to learn what that number refers to, which is the round
    // trip the lean wake exists to avoid.
    ...(wakeup.prediction === undefined ? {} : { prediction: wakeup.prediction }),
    // The plan's numbers, flat so they fold onto one line: intent, phase, and
    // the stop/target levels. These are what let a reassessment conclude
    // "price is between my stop and my target and nothing fired — keep
    // waiting" without a look. The prose stays behind `trading_look`.
    ...(wakeup.activeStrategy === undefined
      ? {}
      : {
          plan: {
            intent: wakeup.activeStrategy.intent,
            phase: planPhase(wakeup.position.size),
            ...(wakeup.activeStrategy.stop.price === undefined
              ? {}
              : { stopPrice: wakeup.activeStrategy.stop.price }),
            ...(wakeup.activeStrategy.stop.maximumPlannedLossUsd === undefined
              ? {}
              : { maxPlannedLossUsd: wakeup.activeStrategy.stop.maximumPlannedLossUsd }),
            ...(wakeup.activeStrategy.target.price === undefined
              ? {}
              : { targetPrice: wakeup.activeStrategy.target.price }),
            ...(wakeup.activeStrategy.target.profitUsd === undefined
              ? {}
              : { targetProfitUsd: wakeup.activeStrategy.target.profitUsd }),
          },
        }),
    ...(wakeup.strategyReview === undefined ? {} : { strategyReview: wakeup.strategyReview }),
    ...(wakeup.positionReview === undefined ? {} : { positionReview: wakeup.positionReview }),
    armedWatches: renderArmedWatches(wakeup.armedWatches.slice(0, caps.armedWatches)),
    // The gaps between the plan and the armed set — a published entry level
    // with no watch on it, or a watch that cannot evaluate its confirmation.
    // Usually absent; when present they are exactly what the turn is for.
    ...(wakeup.unarmedEntryConditions === undefined
      ? {}
      : { unarmedEntryConditions: wakeup.unarmedEntryConditions }),
    // An advisory about how the ENTRY watches are armed, once the entry has
    // happened, describes a condition that no longer decides anything — and it
    // rode every holding wake of the mission that found it (plan 34 F8).
    ...(wakeup.misarmedEntryConditions === undefined || wakeup.position.size !== 0
      ? {}
      : { misarmedEntryConditions: wakeup.misarmedEntryConditions }),
    // Nothing pending is the ordinary case, and `pendingEvents: -` said so on
    // most wakes of the mission this was measured from. An absent list is the
    // same fact in no characters (plan 35 phase 3).
    ...(wakeup.pendingEvents.length === 0
      ? {}
      : { pendingEvents: wakeup.pendingEvents.slice(-caps.pendingEvents) }),
    // One pointer line, not two blocks. The `omitted` paragraph and the
    // `mandate-and-authority` line under it were 208 identical characters on
    // every wake, saying the same thing twice: read before you act.
    readFirst:
      "no candles, book, structure, account or mandate here — call trading_look before acting",
  });

/**
 * The lean path's own ceiling.
 *
 * This was the one render path that never went through `renderBoundedWakeup`,
 * so a pathological review line or event tail had no cap at all — the lean
 * wake was structurally the unbounded one. The trim is the same doctrine as
 * the ladder above: cut whole fields, never a string mid-value.
 *
 * With the armed set now one line per watch it should never fire. It exists so
 * that "the lean wake is small" is a guarantee rather than an expectation.
 */
const renderBoundedLeanWakeup = (
  wakeup: TradingHarnessWakeup,
): {
  readonly text: string;
  readonly steps: ReadonlyArray<string>;
  readonly untrimmedChars: number;
} => {
  const text = renderLeanWakeup(wakeup, LEAN_WAKE_CAPS);
  const untrimmedChars = text.length;
  if (text.length <= MAX_WAKEUP_CHARS) return { text, steps: [], untrimmedChars };

  const trimmed = renderLeanWakeup(wakeup, LEAN_WAKE_TRIMMED_CAPS);
  const steps = ["lean_events_and_watches"];
  if (trimmed.length <= MAX_WAKEUP_CHARS) return { text: trimmed, steps, untrimmedChars };

  return {
    text: renderMinimalWakeup(wakeup),
    steps: [...steps, "minimal_projection"],
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
  /**
   * The book, when it could be read.
   *
   * Read here rather than beside each caller so the look and the wake cannot
   * quote different books: `trading_look` used to take its own `getOrderBook`
   * while the wake took none, which is exactly the drift `observe` exists to
   * prevent.
   */
  readonly orderBook: OrderBook | null;
  /** What the book says, as readings. Null when nothing could be measured. */
  readonly microstructure: MarketMicrostructure | null;
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
   * The plan-history version in force — the id of the prediction the mission
   * is running, and what a fired watch's `predictionVersion` is compared
   * against.
   *
   * Falls back to 0 rather than failing the wake: a wake that cannot name its
   * prediction's version is still a wake, and 0 matches no watch, which reads
   * as "unknown" rather than as a false match.
   */
  const currentPlanVersion = (missionId: string) =>
    sql<{ readonly version: number | null }>`
      SELECT MAX(version) AS version FROM trading_plan_history WHERE mission_id = ${missionId}
    `.pipe(
      Effect.map((rows) => rows[0]?.version ?? 0),
      Effect.orElseSucceed(() => 0),
    );

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
   * Priced at what the ACCOUNT can fund, because that is what the entry will
   * actually take. It used to price at the plan's declared entry notional, and
   * nothing enforces that number: one mission declared $500 on every entry and
   * took ~$900 on every one of them, bound by `account_margin`. The round trip
   * on the line was therefore half the round trip it paid, the rung derived
   * from it was half as high, and all six of its entry plans cleared a bar that
   * did not exist. The declared notional and the allocated capital remain as
   * fallbacks, in that order, for a mission with no account observation yet —
   * and the line always names the notional it was priced at.
   *
   * Context for the entry question, never a gate; a failed read costs the
   * field, never the wake. Holding wakes carry `positionCosts` instead.
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

      // What the entry would actually be sized against, so the cost line it
      // reasons from is priced at the notional it will really take. Null when
      // the account has not been observed yet; the plan's own declared number
      // is the fallback, and the allocated capital is the fallback under that.
      const fundableNotionalUsd = yield* readAccountMarginCapacityUsd(sql, {
        missionId: mission.id,
        market,
      });
      const declaredEntryNotionalUsd =
        activeStrategy?.entry.initialNotionalUsd !== undefined &&
        activeStrategy.entry.initialNotionalUsd > 0
          ? activeStrategy.entry.initialNotionalUsd
          : null;

      // Both enrichments, concurrently, and both optional. Neither can fail the
      // compose: a wakeup that arrives without its second timeframe is worse
      // than one that arrives with it, and far better than one that never
      // arrives at all. A flat wake gets its one cost line here too — the
      // plan's intended entry notional when the plan names one, else the
      // allocated capital.
      const [higherTimeframeVolatility, positionCosts, costContext, orderBook] = yield* Effect.all(
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
                fundableNotionalUsd ?? declaredEntryNotionalUsd,
                mission.authority.allocatedCapitalUsd,
                address,
                mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide,
              )
            : Effect.succeed<TradingCostContext | null>(null),
          // The book rides the same rule as the two above it: an enrichment,
          // not a fact the observation is defined by. A mission whose book read
          // fails still needs to wake holding a position it can read.
          //
          // `suspend` + `catchCause`, not `orElseSucceed`: a gateway that
          // throws while BUILDING the effect throws inside this generator, and
          // a gateway that dies mid-read produces a defect. Neither is a
          // typed failure, so neither would be caught by recovering from the
          // error channel alone — and either would have cost the whole wake.
          Effect.suspend(() => gateway.getOrderBook(market)).pipe(
            Effect.catchCause(() => Effect.succeed<OrderBook | null>(null)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      // What the previous observation left behind, for the readings that are
      // deltas. A missing sample costs those two change fields and nothing
      // else — the current spread and depth are still reported beside them.
      const previousSample = yield* readMarketSample({
        missionId: mission.id,
        market,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      const microstructure = readMicrostructure({
        orderBook,
        candles: history.candles,
        observedAt: occurredAt,
        markPrice: marketSnapshot.markPrice,
        openInterest: marketSnapshot.openInterest,
        previousSample,
      });

      // ...and what this one leaves for the next. Fire-and-forget by
      // construction: `writeMarketSample` swallows its own failures, because a
      // mission that cannot write bookkeeping still has to wake.
      //
      // A sample younger than the delta floor is NOT replaced. `observe` runs
      // on every `trading_look` as well as every wake, and overwriting on each
      // one would keep resetting the clock: a model that looks three times in a
      // turn would leave the next wake comparing against a sample seconds old
      // and reporting nothing. Letting the stored sample age instead means the
      // comparison spans the gap that actually matters.
      const sampleIsStale =
        previousSample === null ||
        occurredAt - previousSample.observedAt >= MARKET_SAMPLE_MIN_SPAN_MILLIS;
      if (sampleIsStale) {
        yield* writeMarketSample({
          missionId: mission.id,
          market,
          sample: sampleFromObservation({
            markPrice: marketSnapshot.markPrice,
            observedAt: occurredAt,
            microstructure,
            openInterest: marketSnapshot.openInterest,
          }),
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      }

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

      // Plan 33 fix A. The measurements above are IEEE arithmetic and are
      // written here at the precision they are worth reading at — the one seam
      // both a wake and the look's market half come through, so neither can
      // publish a seventeen-figure ratio the other rounded. Prices, sizes and
      // timestamps are not touched; see `roundMarketStructure` and friends for
      // which field each read model derives.
      return {
        address,
        market,
        primaryTimeframe,
        marketSnapshot,
        accountSnapshot,
        position: positionWithPeak,
        history,
        recentCandles,
        observedVolatility: roundObservedVolatility(observedVolatility),
        higherTimeframeVolatility:
          higherTimeframeVolatility === null
            ? null
            : roundObservedVolatility(higherTimeframeVolatility),
        orderBook,
        microstructure: microstructure === null ? null : roundMicrostructure(microstructure),
        positionCosts: positionCosts === null ? null : roundCostEstimate(positionCosts),
        costContext: costContext === null ? null : roundCostContext(costContext),
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

      // The lean gather — what a wake actually carries: the mark, the
      // position, one cost line, and the armed set. The full `observe`
      // (candles, both volatility reads, the book, structure memory) belongs
      // to `trading_look`; running it here paid five exchange reads per wake
      // for measurements the render then dropped, and the model re-read them
      // with a look anyway.
      const market = mission.market;
      const address = yield* missions
        .getMasterWalletAddress(mission.tradingAccountId)
        .pipe(Effect.mapError((error) => fail("address_resolution_failed", error)));

      const [marketSnapshot, exchangePosition] = yield* Effect.all(
        [gateway.getMarketSnapshot(market), gateway.getPosition(address, market)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((error) => fail("snapshot_read_failed", error)));

      // What the position was worth at its best, and how far it has come off
      // that — T3's own bookkeeping, which the exchange does not report.
      const peak = yield* missions
        .readPeakUnrealisedPnl({ missionId: mission.id, market })
        .pipe(Effect.mapError((error) => fail("peak_pnl_read_failed", error)));
      const position =
        peak === null
          ? exchangePosition
          : {
              ...exchangePosition,
              peakUnrealisedPnl: peak,
              drawdownFromPeakUsd: Math.max(0, peak - exchangePosition.unrealisedPnl),
            };

      // The one cost figure a wake carries: the held position's round trip, or
      // the flat reference line. Enrichments — either failing costs the field,
      // never the wake.
      const [rawPositionCosts, rawCostContext] = yield* Effect.all(
        [
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
      const positionCosts = rawPositionCosts === null ? null : roundCostEstimate(rawPositionCosts);
      const costContext = rawCostContext === null ? null : roundCostContext(rawCostContext);

      const armed = yield* strategies
        .listWatches(mission.id)
        .pipe(Effect.mapError((error) => fail("watch_list_failed", error)));

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
      // These two briefs repeat on EVERY wake for the life of the mission, so
      // they are kept terse: the doctrine they compress lives in the playbooks
      // and the first-turn contract, both one call away.
      const flatReview =
        activeStrategy === undefined
          ? "FLAT, NO PLAN ACTIVE — decide this turn: read the market, publish via trading_plan (standing aside counts; a directional plan states a projection), and arm conditions around it on both sides."
          : "FLAT — every playbook is a candidate again (momentum, range_reversion, opening_range, rsi_reversion; ema_cross unscored — read `ema`). Take the one whose expected move beats the round trip (`costContext`), or none.";
      // The projection is the one thing a DIRECTIONAL plan must never be
      // without: an informed estimate of where price is heading. A stand-aside
      // is exempt — the contract says it states none, because an invented
      // prediction would be armed and drawn as if it were believed.
      const projectionNote =
        activeStrategy !== undefined &&
        activeStrategy.projection === undefined &&
        activeStrategy.intent !== "stand_aside"
          ? "NO PROJECTION ON FILE — republish with projection {direction, price, byMinutes, invalidationPrice}; every directional plan states one, and it is what arms the horizon and invalidation wakes. "
          : "";

      // The prediction the mission is running, as one line and a version.
      // A lean wake is a fired trigger and little else; the trigger's own
      // `predictionVersion` means nothing unless the wake also says which
      // prediction is current.
      const prediction =
        activeStrategy?.projection === undefined
          ? undefined
          : {
              version: yield* currentPlanVersion(mission.id),
              summary: describeProjection(activeStrategy.projection),
            };
      const strategyReview =
        position.size === 0 ? `${projectionNote}${staleNote}${flatReview}` : undefined;

      // Holding: the turn belongs to the position, not to the thesis. See
      // `positionReview` on the wakeup schema. A stale plan still says so —
      // holding does not make an expired thesis fresh.
      const positionReview =
        position.size === 0
          ? undefined
          : `${projectionNote}${staleNote}HOLDING — spend this turn on the position: bank-or-extend against positionCosts, check drawdownFromPeakUsd, trail the stop off the entry, keep a \`giveback\` armed while in profit.`;

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
        position,
        ...(positionCosts === null ? {} : { positionCosts }),
        ...(costContext === null ? {} : { costContext }),
        ...(activeStrategy === undefined ? {} : { activeStrategy }),
        ...(activeStrategy === undefined
          ? {}
          : { strategyAgeMillis: Math.max(0, occurredAt - activeStrategy.updatedAt) }),
        ...(prediction === undefined ? {} : { prediction }),
        armedWatches,
        ...(unarmedEntryConditions.length === 0 ? {} : { unarmedEntryConditions }),
        ...(misarmedEntryConditions.length === 0 ? {} : { misarmedEntryConditions }),
        ...(strategyReview === undefined ? {} : { strategyReview }),
        ...(positionReview === undefined ? {} : { positionReview }),
        pendingEvents: [...pendingEvents],
      };

      // The mandate, instruction, and default timeframe are stable for a
      // mission's life and no longer duplicated onto every wake — the rendered
      // text points the run at `trading_look` for them instead.
      const validated = decodeWakeup(wakeup);
      // Every wake is an alert: what fired, what is held, the plan's numbers,
      // and a pointer at trading_look. The path is bounded and reports when it
      // trims.
      const { text, steps, untrimmedChars } = renderBoundedLeanWakeup(validated);
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
