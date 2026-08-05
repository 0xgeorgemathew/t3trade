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

import { TradingCostEstimator } from "./TradingCostEstimator.ts";

import type { TradingAuthority } from "./Schemas.ts";
import type { MomentumStrategyState } from "./Schemas.ts";
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
const WAKEUP_RECENT_CANDLES = 20;

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

/** The wakeup serialized as the resumed turn's `message.text`. */
const WakeupJson = Schema.fromJsonString(TradingHarnessWakeup);
const encodeWakeupJson = Schema.encodeUnknownSync(WakeupJson);

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
  readonly activeStrategy: MomentumStrategyState;
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

      const authority: TradingAuthority = mission.authority;

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
        authority,
        pendingEvents: [...pendingEvents],
        instruction: mission.instruction,
        defaultTimeframe: POC_DEFAULT_TIMEFRAME,
      };

      const text = encodeWakeupJson(wakeup);
      return { wakeup, text };
    });

  return { compose } satisfies TradingWakeupComposerShape;
});

export const TradingWakeupComposerLive = Layer.effect(TradingWakeupComposer, make);
