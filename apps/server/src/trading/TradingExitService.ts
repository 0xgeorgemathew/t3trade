/**
 * TradingExitService — the server half of getting out.
 *
 * The mirror of `TradingQuoteService`, and for the same reason: an exit is made
 * of a strategy version, an authority version, a lease-owning run, a monotonic
 * sequence, a crossing limit price, a side and a size, and the harness can
 * usefully answer none of them. The side and size in particular have exactly
 * one correct source — the canonical position — and taking them from an intent
 * instead is how a `reduce` becomes an increase wearing a reduce's name.
 *
 * Unlike a quote, an exit is not held for later. It resolves against state read
 * now and is handed straight to the execution path, because the whole point of
 * these three tools is that there is nothing between deciding to get out and
 * getting out.
 *
 * @module TradingExitService
 */
import { resolveExitSize } from "@t3tools/trading-contracts/exit";
import { deriveQuoteLimitPrice } from "@t3tools/trading-contracts/quote";
import type { TradingOrderIntent } from "@t3tools/trading-contracts/execution";
import { urgencyToOrderPreference, type TradingUrgency } from "@t3tools/trading-contracts/strategy";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { retryTransientRead } from "./RetryTransient.ts";
import { IocSlippageConfig } from "./IocSlippageConfig.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { allocateExecutionSequence } from "./TradingExecutionSequence.ts";

/** Which of the three exits was asked for. */
export type ExitKind = "close" | "reduce" | "cancel";

export interface ExitRequest {
  readonly missionId: string;
  readonly kind: ExitKind;
  /** Defaults to the market the mission is mandated to. */
  readonly market?: string | undefined;
  readonly sizeEth?: number | undefined;
  readonly fraction?: number | undefined;
  /** The resting order a `cancel` withdraws. */
  readonly cloid?: string | undefined;
  /**
   * How urgently a `close`/`reduce` should land. Defaults to `now` (crossing
   * IOC); `patient` rests reduce-only at the near side as a maker order.
   * Meaningless to a `cancel`, which places no order.
   */
  readonly urgency?: TradingUrgency | undefined;
}

export type ExitPreparation =
  | {
      readonly outcome: "ready";
      readonly intent: TradingOrderIntent;
      readonly expectedAuthorityVersion: number;
      readonly activeHarnessRunId: string;
      /** What the harness needs told when the exit is not the one it named. */
      readonly note: string | null;
    }
  | {
      readonly outcome: "refused";
      readonly reason: string;
      readonly detail: string;
    };

export class TradingExitService extends Context.Service<
  TradingExitService,
  {
    readonly prepare: (request: ExitRequest) => Effect.Effect<ExitPreparation>;
  }
>()("t3/trading/TradingExitService") {}

const refused = (reason: string, detail: string): ExitPreparation => ({
  outcome: "refused",
  reason,
  detail,
});

export const makeTradingExitService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missions = yield* TradingMissionService;
  const gateway = yield* HyperliquidGateway;
  const iocSlippage = yield* IocSlippageConfig;

  /** The run holding the mission's decision lease, read from the lease's table. */
  const readActiveRun = (missionId: string) =>
    sql<{ readonly run_id: string }>`
      SELECT run_id FROM trading_harness_runs
      WHERE mission_id = ${missionId} AND status NOT IN ('completed', 'failed')
      ORDER BY started_at DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.run_id ?? null));

  const prepare: TradingExitService["Service"]["prepare"] = (request) =>
    Effect.gen(function* () {
      const mission = yield* missions.getMission(request.missionId);
      const market = request.market ?? mission.market;
      if (market !== mission.market) {
        return refused(
          "market_is_eth",
          `mission is mandated to ${mission.market} only; got ${market}`,
        );
      }

      // Before anything about the mission: a cancel that names no order is a
      // malformed call, and reporting it as a lease problem sends the harness
      // to fix the wrong thing.
      if (
        request.kind === "cancel" &&
        (request.cloid === undefined || request.cloid.length === 0)
      ) {
        return refused(
          "no_target_named",
          "name the cloid of the resting order to withdraw; trading_get_open_orders lists them",
        );
      }

      const harnessRunId = yield* readActiveRun(request.missionId);
      if (harnessRunId === null) {
        return refused(
          "harness_run_owns_lease",
          "no harness run currently owns this mission's decision lease; an exit is only executable inside a turn",
        );
      }

      const executionSequence = yield* allocateExecutionSequence(sql, request.missionId);
      const shared = {
        missionId: request.missionId,
        executionSequence,
        market: market as TradingOrderIntent["market"],
        reduceOnly: true,
      } as const;

      // A cancel touches no position: it names one resting order and withdraws
      // it. Size and price are structural filler the intent schema requires and
      // the cancel path never reads.
      if (request.kind === "cancel") {
        // Non-empty by the guard above; narrowed here so the intent is typed.
        const targetCloid = request.cloid ?? "";
        const cancelIntent: TradingOrderIntent = {
          ...shared,
          actionType: "cancel",
          side: "sell",
          size: 1,
          orderPreference: "resting_limit",
          limitPrice: 1,
          targetCloid,
        };
        return {
          outcome: "ready" as const,
          note: null,
          expectedAuthorityVersion: mission.authorityVersion,
          activeHarnessRunId: harnessRunId,
          intent: cancelIntent,
        };
      }

      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      // The exchange is the authority on what is held. Reading the local
      // snapshot instead would size an exit against a position that has since
      // been stopped out, filled further, or liquidated.
      const position = yield* retryTransientRead(
        gateway.getPosition(masterAddress, market),
        "exit.getPosition",
      );
      const orderBook = yield* retryTransientRead(
        gateway.getOrderBook(market),
        "exit.getOrderBook",
      );
      const resolved = yield* retryTransientRead(
        gateway.resolveMarket(market),
        "exit.resolveMarket",
      );
      const bbo = orderBook.bestBidOffer;
      const bestBid = bbo.bidPrice;
      const bestAsk = bbo.askPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        return refused(
          "market_data_unavailable",
          `${market} has no two-sided book right now, so there is no price to exit against`,
        );
      }

      const sizing = resolveExitSize({
        positionSize: position.size,
        markPrice: (bestBid + bestAsk) / 2,
        szDecimals: resolved.szDecimals,
        minimumNotionalUsd: MIN_NOTIONAL_USD,
        requestedSize: request.sizeEth,
        requestedFraction: request.fraction,
        closeWholePosition: request.kind === "close",
      });
      if (sizing.refusal !== null) {
        return refused(sizing.refusal, sizing.detail);
      }

      // An exit defaults to crossing: a reduce-only order that rests is a
      // reduce-only order that does not happen, and the whole reason to have
      // these tools is that the exit lands. A patient exit opts out
      // deliberately — it rests reduce-only at the near side as a maker order,
      // keeping the exit able to never happen in exchange for not paying the
      // spread.
      const orderPreference = urgencyToOrderPreference(request.urgency ?? "now");
      const limitPrice = deriveQuoteLimitPrice({
        side: sizing.side,
        orderPreference,
        bestBid,
        bestAsk,
        slippageBps: (yield* iocSlippage.resolve).entryBps,
      });

      const exitIntent: TradingOrderIntent = {
        ...shared,
        // A reduce promoted past the dust threshold is a close, and calling it
        // one is what makes the guard take the whole canonical position rather
        // than the size that left the dust.
        actionType: sizing.promotedToClose ? "close" : request.kind,
        side: sizing.side,
        size: sizing.size,
        orderPreference,
        limitPrice,
      };
      return {
        outcome: "ready" as const,
        note: sizing.note,
        expectedAuthorityVersion: mission.authorityVersion,
        activeHarnessRunId: harnessRunId,
        intent: exitIntent,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("trading exit could not be prepared", { cause: String(cause) }).pipe(
          Effect.as(
            refused(
              "market_data_unavailable",
              "the position, book, or mission state an exit is sized from could not be read; retry once",
            ),
          ),
        ),
      ),
    );

  return TradingExitService.of({ prepare });
});

export const TradingExitServiceLive = Layer.effect(TradingExitService, makeTradingExitService);
