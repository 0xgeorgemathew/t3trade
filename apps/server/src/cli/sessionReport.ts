/**
 * `t3 session-report` — one trading session's numbers, printed by one command
 * (plan 29 step 0.2).
 *
 * A session is a mission. The command composes the reads that already exist —
 * `readActivityEvidence` and `readDecisionFunnel` — with the trade-economics
 * and wake-count reads added beside them, and prints the result as stable
 * `key: value` lines so a baseline session and a later control session can be
 * diffed verbatim.
 *
 * The database is opened read-only: the shared home database is live while a
 * server owns it, and this command must never be the reason it was written to.
 * Exit-side spread and slippage are structurally unrecorded (no exit quotes
 * exist), so those lines say `n/a` rather than inventing a number. The two
 * fill-sourced cost lines (plan 29 step 2.7) read the session's real fills:
 * maker fill rate by count, and fees as a share of gross notional traded.
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";

import type { ActivityEvidence } from "@t3tools/trading-contracts/policy";

import { resolveBaseDir } from "../os-jank.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  readActivityEvidence,
  readDecisionFunnel,
  readSessionFills,
  readSessionTrades,
  readSessionWakes,
  type SessionFill,
  type SessionTrade,
  type SessionWakeCounts,
} from "../trading/TradingRunTelemetry.ts";
import { baseDirFlag } from "./config.ts";

export class SessionReportDatabaseMissingError extends Schema.TaggedErrorClass<SessionReportDatabaseMissingError>()(
  "SessionReportDatabaseMissingError",
  {
    databasePath: Schema.String,
  },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'. Start T3 once to run migrations.`;
  }
}

export class SessionReportMissionNotFoundError extends Schema.TaggedErrorClass<SessionReportMissionNotFoundError>()(
  "SessionReportMissionNotFoundError",
  {
    databasePath: Schema.String,
    missionId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.missionId === null
      ? `No trading missions recorded in '${this.databasePath}'.`
      : `No mission '${this.missionId}' in '${this.databasePath}'.`;
  }
}

/** The session's headline economics, derived from its closed trades. */
export interface SessionEconomics {
  readonly trades: number;
  /** Closed trades whose net_pnl came out positive. */
  readonly wins: number;
  /** Mean net_pnl in bps of entry notional; null when nothing is priced. */
  readonly netBpsPerTrade: number | null;
  /** fees_paid summed, in bps of entry notional; null when nothing is priced. */
  readonly feesBps: number | null;
  /** Half-spread paid on entry, in bps of entry notional; null with no entry book. */
  readonly entrySpreadBps: number | null;
  /**
   * What entry fills gave up beyond touching the near side of the entry book,
   * in bps of entry notional; negative is price improvement. Null with no
   * entry book.
   */
  readonly entrySlippageBps: number | null;
  /** Trades with a positive entry notional — the bps denominators' sample. */
  readonly pricedTrades: number;
  /** Trades that joined to a recorded open entry — the spread sample. */
  readonly bookedTrades: number;
}

/**
 * All costs are stated against entry notional (|size| x entry_price), the same
 * denominator as net bps per trade, so the lines decompose the headline rather
 * than introducing a second unit. Fees cover the whole round trip; spread and
 * slippage cover the entry side only, because exit quotes are not recorded.
 */
export const deriveSessionEconomics = (trades: ReadonlyArray<SessionTrade>): SessionEconomics => {
  const entryNotional = (trade: SessionTrade): number =>
    trade.entryPrice !== null && trade.entryPrice > 0 ? Math.abs(trade.size) * trade.entryPrice : 0;

  const priced = trades.filter((trade) => entryNotional(trade) > 0);
  const booked = priced.filter((trade) => trade.entryBook !== null);

  const pricedNotional = priced.reduce((sum, trade) => sum + entryNotional(trade), 0);
  const bookedNotional = booked.reduce((sum, trade) => sum + entryNotional(trade), 0);

  const bps = (usd: number, notional: number): number | null =>
    notional > 0 ? (usd / notional) * 10_000 : null;

  // Entry-side split, per trade: what the fill gave up versus the book mid is
  // the half-spread plus whatever the price did beyond the near side. A long
  // pays the ask side of that, a short the bid side.
  const spreadUsd = booked.reduce((sum, trade) => {
    const book = trade.entryBook!;
    return sum + ((book.bestAsk - book.bestBid) / 2) * Math.abs(trade.size);
  }, 0);
  const slippageUsd = booked.reduce((sum, trade) => {
    const book = trade.entryBook!;
    const beyondNearSide =
      trade.direction === "long"
        ? trade.entryPrice! - book.bestAsk
        : book.bestBid - trade.entryPrice!;
    return sum + beyondNearSide * Math.abs(trade.size);
  }, 0);

  return {
    trades: trades.length,
    wins: trades.filter((trade) => trade.netPnlUsd > 0).length,
    netBpsPerTrade:
      priced.length === 0
        ? null
        : priced.reduce((sum, trade) => sum + bps(trade.netPnlUsd, entryNotional(trade))!, 0) /
          priced.length,
    feesBps: bps(
      priced.reduce((sum, trade) => sum + trade.feesPaidUsd, 0),
      pricedNotional,
    ),
    entrySpreadBps: bps(spreadUsd, bookedNotional),
    entrySlippageBps: bps(slippageUsd, bookedNotional),
    pricedTrades: priced.length,
    bookedTrades: booked.length,
  };
};

/**
 * The session's fill-sourced cost measurements — plan 29 step 2.7. Where the
 * economics above are stated against closed trades' entry notional, these come
 * from the session's real fills: fees as the exchange charged them, and the
 * maker/taker flag the exchange put on each fill.
 */
export interface SessionFillCosts {
  /**
   * Share of the session's fills that rested (crossed=false), by count. Null
   * when no fill carries the flag — sessions recorded before it was persisted.
   */
  readonly makerFillRate: number | null;
  /**
   * Total fees paid / gross traded notional (sum of |price x size| per fill),
   * as a fraction. Null when the session traded no notional.
   */
  readonly feeShareOfGross: number | null;
  /** Every reconciled fill of the session — the fee sample. */
  readonly fills: number;
  /** Fills carrying a recorded maker/taker flag — the fill-rate sample. */
  readonly flaggedFills: number;
  /** Flagged fills that rested (crossed=false). */
  readonly makerFills: number;
}

export const deriveSessionFillCosts = (fills: ReadonlyArray<SessionFill>): SessionFillCosts => {
  const flagged = fills.filter((fill) => fill.crossed !== null);
  const makerFills = flagged.filter((fill) => fill.crossed === false).length;
  const grossNotional = fills.reduce((sum, fill) => sum + fill.notionalUsd, 0);
  return {
    makerFillRate: flagged.length === 0 ? null : makerFills / flagged.length,
    feeShareOfGross:
      grossNotional > 0 ? fills.reduce((sum, fill) => sum + fill.feeUsd, 0) / grossNotional : null,
    fills: fills.length,
    flaggedFills: flagged.length,
    makerFills,
  };
};

/** Everything the printer needs for one session. */
export interface SessionReport {
  readonly missionId: string;
  readonly market: string;
  readonly createdAt: number;
  readonly activity: ActivityEvidence;
  readonly economics: SessionEconomics;
  readonly fillCosts: SessionFillCosts;
  readonly wakes: SessionWakeCounts;
  readonly standDownHistogram: ReadonlyArray<{ readonly code: string; readonly runs: number }>;
}

/**
 * Assemble a session's report. Returns null when the mission does not exist,
 * so callers decide how that failure is presented. Everything else is derived
 * from the telemetry reads; nothing here writes.
 */
export const readSessionReport = (
  sql: SqlClient.SqlClient,
  input: { readonly missionId: string },
) =>
  Effect.gen(function* () {
    const missions = yield* sql<{
      readonly mission_id: string;
      readonly market: string;
      readonly created_at: number;
    }>`
      SELECT mission_id, market, created_at FROM trading_missions
      WHERE mission_id = ${input.missionId}
    `;
    const mission = missions[0];
    if (mission === undefined) return null;

    const [activity, funnel, trades, fills, wakes] = yield* Effect.all([
      readActivityEvidence(sql, { missionId: input.missionId }),
      readDecisionFunnel(sql, { missionId: input.missionId }),
      readSessionTrades(sql, { missionId: input.missionId }),
      readSessionFills(sql, { missionId: input.missionId }),
      readSessionWakes(sql, { missionId: input.missionId }),
    ]);

    // Settled runs only — an unsettled run has no stand-down code yet. Totals
    // per code, biggest first, ties by code, so the histogram is stable.
    const byCode = new Map<string, number>();
    for (const row of funnel) {
      if (row.standDownCode === null) continue;
      byCode.set(row.standDownCode, (byCode.get(row.standDownCode) ?? 0) + row.runs);
    }
    const standDownHistogram = [...byCode.entries()]
      .map(([code, runs]) => ({ code, runs }))
      .sort((left, right) => right.runs - left.runs || (left.code < right.code ? -1 : 1));

    return {
      missionId: mission.mission_id,
      market: mission.market,
      createdAt: mission.created_at,
      activity,
      economics: deriveSessionEconomics(trades),
      fillCosts: deriveSessionFillCosts(fills),
      wakes,
      standDownHistogram,
    } satisfies SessionReport;
  });

const round1 = (value: number): number => {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
};

// Two decimals, not round1's one: fee share of gross lives at single-digit
// basis points (0.09% -> 0.06% is the whole move step 2.7 exists to detect),
// which one decimal of percent would blur to identical numbers.
const round2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
};

const bpsLine = (key: string, value: number | null, availability: string): string =>
  value === null
    ? `${key}: n/a (${availability})`
    : `${key}: ${round1(value)} bps of entry notional (${availability})`;

/** Render the report as one stable `key: value` block. */
export const formatSessionReport = (report: SessionReport): string => {
  const { activity, economics, fillCosts, wakes } = report;
  // Ratios print n/a with the reason; otherwise the sample they were computed
  // over rides along, so a partial record cannot read as a complete one.
  const noTrades = economics.trades === 0;
  const pricedNote = `${economics.pricedTrades} of ${economics.trades} trades priced`;
  const bookedNote = `${economics.bookedTrades} of ${economics.trades} trades with an entry book`;

  const lines = [
    `mission: ${report.missionId} (${report.market}, created ${DateTime.formatIso(DateTime.makeUnsafe(report.createdAt))})`,
    `trades: ${economics.trades}`,
    noTrades
      ? `win rate: n/a (no closed trades)`
      : `win rate: ${round1((economics.wins / economics.trades) * 100)}% (${economics.wins} of ${economics.trades})`,
    noTrades || economics.netBpsPerTrade === null
      ? `net bps per trade: n/a (${noTrades ? "no closed trades" : pricedNote})`
      : `net bps per trade: ${round1(economics.netBpsPerTrade)}`,
    noTrades
      ? `cost fees: n/a (no closed trades)`
      : bpsLine("cost fees", economics.feesBps, `round trip; ${pricedNote}`),
    noTrades
      ? `cost spread, entry side: n/a (no closed trades)`
      : bpsLine("cost spread, entry side", economics.entrySpreadBps, bookedNote),
    noTrades
      ? `cost slippage, entry side: n/a (no closed trades)`
      : bpsLine("cost slippage, entry side", economics.entrySlippageBps, bookedNote),
    "cost spread/slippage, exit side: n/a (no exit quotes recorded)",
    fillCosts.makerFillRate === null
      ? `maker fill rate (by fill count): n/a (${fillCosts.fills === 0 ? "no fills recorded" : "no maker flag recorded"})`
      : `maker fill rate (by fill count): ${round1(fillCosts.makerFillRate * 100)}% (${fillCosts.makerFills} of ${fillCosts.flaggedFills} flagged fills)`,
    fillCosts.feeShareOfGross === null
      ? `cost fees, share of gross notional traded: n/a (${fillCosts.fills === 0 ? "no fills recorded" : "no notional recorded"})`
      : `cost fees, share of gross notional traded: ${round2(fillCosts.feeShareOfGross * 100)}% (${fillCosts.fills} fills)`,
    `plan versions published: ${wakes.planVersionsPublished}`,
    `wakes taken: ${wakes.wakes}`,
    `wakes that changed nothing: ${wakes.noOpWakes}`,
    `wakes with no decision: ${wakes.noDecisionWakes}`,
    `time in market: ${activity.timeInMarketPercent}%`,
  ];

  if (report.standDownHistogram.length === 0) {
    lines.push("stand-down codes: none");
  } else {
    lines.push("stand-down codes:");
    for (const entry of report.standDownHistogram) {
      lines.push(`  ${entry.code} ${entry.runs}`);
    }
  }

  return lines.join("\n");
};

/** Resolve the mission to report on: the named one, else the newest by created_at. */
const resolveMissionId = (sql: SqlClient.SqlClient, missionId: string | undefined) =>
  missionId !== undefined
    ? Effect.succeed(missionId)
    : sql<{ readonly mission_id: string }>`
        SELECT mission_id FROM trading_missions
        ORDER BY created_at DESC, mission_id DESC
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.mission_id ?? null));

export const runSessionReport = Effect.fn("sessionReport.run")(function* (input: {
  readonly baseDir?: string | undefined;
  readonly missionId?: string | undefined;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* resolveBaseDir(input.baseDir);
  const databasePath = path.join(baseDir, "userdata", "state.sqlite");

  if (!(yield* fs.exists(databasePath))) {
    return yield* new SessionReportDatabaseMissingError({ databasePath });
  }

  const output = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The live server may hold the database; wait politely for its lock
    // instead of failing. Nothing here writes — the client below is read-only.
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;

    const missionId = yield* resolveMissionId(sql, input.missionId);
    if (missionId === null) {
      return yield* new SessionReportMissionNotFoundError({
        databasePath,
        missionId: input.missionId ?? null,
      });
    }

    const report = yield* readSessionReport(sql, { missionId });
    if (report === null) {
      return yield* new SessionReportMissionNotFoundError({ databasePath, missionId });
    }
    return formatSessionReport(report);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })));

  yield* Console.log(output);
});

const missionFlag = Flag.string("mission").pipe(
  Flag.withDescription("Mission id to report on. Defaults to the newest mission by created_at."),
  Flag.optional,
);

export const sessionReportCommand = Command.make("session-report", {
  baseDir: baseDirFlag,
  mission: missionFlag,
}).pipe(
  Command.withDescription(
    "Print one trading session's numbers: trades, win rate, net bps per trade, cost splits, wakes, time in market, stand-down codes.",
  ),
  Command.withHandler((flags) =>
    runSessionReport({
      baseDir: Option.getOrUndefined(flags.baseDir),
      missionId: Option.getOrUndefined(flags.mission),
    }),
  ),
);
