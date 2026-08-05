/**
 * TradingTradeHistoryService - the mission's own completed orders, read back.
 *
 * The fills have always been persisted; only the workspace could see them. This
 * is the read that lets the harness score a thesis against its outcome instead
 * of starting every turn from the position in front of it.
 *
 * Two things make this more than a SELECT. Fills are aggregated into orders,
 * because Hyperliquid reports a market order as a dozen partials and a history
 * of slices is not a history of decisions. And each order carries the strategy
 * version that was current when it filled, so a loss taken under a thesis the
 * mission has since abandoned reads differently from one taken under the thesis
 * it is still running.
 *
 * @module TradingTradeHistoryService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  TRADE_HISTORY_DEFAULT_LIMIT,
  TRADE_HISTORY_MAX_LIMIT,
  type TradingTradeHistory,
  type TradingTradeHistoryEntry,
} from "@t3tools/trading-contracts/history";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export interface TradingTradeHistoryServiceShape {
  readonly read: (input: {
    readonly missionId: string;
    readonly limit?: number | undefined;
  }) => Effect.Effect<TradingTradeHistory, PersistenceSqlError>;
}

export class TradingTradeHistoryService extends Context.Service<
  TradingTradeHistoryService,
  TradingTradeHistoryServiceShape
>()("t3/trading/TradingTradeHistoryService") {}

/** One order: the sum of its own partial fills, newest first. */
interface OrderRow {
  readonly cloid: string | null;
  readonly order_id: number;
  readonly market: string;
  readonly side: string;
  readonly filled_size: number;
  readonly avg_fill_price: number;
  readonly fee_usd: number;
  readonly closed_pnl: number;
  readonly first_fill_at: number;
  readonly last_fill_at: number;
  readonly fill_count: number;
}

interface StrategyVersionRow {
  readonly version: number;
  readonly created_at: number;
  readonly target_profit_usd: number | null;
}

/**
 * The strategy version in force at `tradedAt`.
 *
 * `versions` arrives newest first, so the first one published at or before the
 * fill is the one that was current. A fill from before the first publish — the
 * bootstrap turn's, if it ever traded — has none, and says so by omission
 * rather than by borrowing v1's target.
 */
const versionAt = (
  versions: ReadonlyArray<StrategyVersionRow>,
  tradedAt: number,
): StrategyVersionRow | undefined => versions.find((v) => v.created_at <= tradedAt);

const toEntry = (
  row: OrderRow,
  versions: ReadonlyArray<StrategyVersionRow>,
): TradingTradeHistoryEntry => {
  const version = versionAt(versions, row.last_fill_at);
  return {
    orderId: row.order_id,
    ...(row.cloid === null ? {} : { cloid: row.cloid }),
    market: row.market,
    side: row.side === "buy" ? "buy" : "sell",
    filledSize: row.filled_size,
    avgFillPrice: row.avg_fill_price > 0 ? row.avg_fill_price : 1,
    notionalUsd: row.filled_size * row.avg_fill_price,
    feeUsd: row.fee_usd,
    closedPnlUsd: row.closed_pnl,
    netPnlUsd: row.closed_pnl - row.fee_usd,
    firstFillAt: row.first_fill_at,
    lastFillAt: row.last_fill_at,
    fillCount: row.fill_count,
    ...(version === undefined ? {} : { strategyVersion: version.version }),
    ...(version?.target_profit_usd == null ? {} : { targetProfitUsd: version.target_profit_usd }),
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read: TradingTradeHistoryServiceShape["read"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(input.limit ?? TRADE_HISTORY_DEFAULT_LIMIT, TRADE_HISTORY_MAX_LIMIT);

      // Every order the mission ever placed, not just the page: the summary is
      // a claim about the whole mission, and one built from a page would flatter
      // any mission that traded more times than the page is long. A mission's
      // order count is bounded by its own trading, so this stays small.
      const rows = yield* sql<OrderRow>`
        SELECT
          MIN(cloid) AS cloid,
          order_id,
          market,
          side,
          SUM(filled_size) AS filled_size,
          SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_fill_price,
          SUM(fee_usd) AS fee_usd,
          SUM(closed_pnl) AS closed_pnl,
          MIN(traded_at) AS first_fill_at,
          MAX(traded_at) AS last_fill_at,
          COUNT(*) AS fill_count
        FROM trading_fills
        WHERE mission_id = ${input.missionId}
        GROUP BY order_id, market, side
        ORDER BY MAX(traded_at) DESC
      `.pipe(Effect.mapError(toPersistenceSqlError("TradingTradeHistoryService.orders")));

      const versions = yield* sql<StrategyVersionRow>`
        SELECT version, created_at,
               json_extract(strategy_json, '$.protection.targetProfitUsd') AS target_profit_usd
        FROM momentum_strategy_versions
        WHERE mission_id = ${input.missionId}
        ORDER BY created_at DESC, version DESC
      `.pipe(Effect.mapError(toPersistenceSqlError("TradingTradeHistoryService.versions")));

      const orders = rows.map((row) => toEntry(row, versions));
      // Only an order that closed exposure has a result to be scored: an entry
      // reports `closedPnl` 0 and would otherwise count as a loss the size of
      // its own fee.
      const scored = orders.filter((order) => order.closedPnlUsd !== 0);

      return {
        missionId: input.missionId,
        orders: orders.slice(0, limit),
        summary: {
          realizedPnlUsd: orders.reduce((sum, order) => sum + order.closedPnlUsd, 0),
          feesPaidUsd: orders.reduce((sum, order) => sum + order.feeUsd, 0),
          netPnlUsd: orders.reduce((sum, order) => sum + order.netPnlUsd, 0),
          orderCount: orders.length,
          fillCount: orders.reduce((sum, order) => sum + order.fillCount, 0),
          winningOrders: scored.filter((order) => order.netPnlUsd > 0).length,
          losingOrders: scored.filter((order) => order.netPnlUsd < 0).length,
          ...(orders.length === 0
            ? {}
            : {
                firstFillAt: Math.min(...orders.map((order) => order.firstFillAt)),
                lastFillAt: Math.max(...orders.map((order) => order.lastFillAt)),
              }),
        },
      } satisfies TradingTradeHistory;
    });

  return { read } satisfies TradingTradeHistoryServiceShape;
});

export const TradingTradeHistoryServiceLive = Layer.effect(TradingTradeHistoryService, make);
