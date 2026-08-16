/**
 * The previous observation's market sample — plan 29 steps 7.3 and 7.4.
 *
 * Two phase-7 readings are deltas, not levels: whether the book is thinning,
 * and whether open interest is moving with price or against it. The exchange
 * serves a history for neither, so the runtime keeps one row per mission and
 * market and the next observation compares against it.
 *
 * Plain functions over `SqlClient`, in the same shape as `TradingLevelHistory`,
 * so the composer can call them without new layer wiring. Neither can fail the
 * caller: a sample that cannot be read costs this turn's deltas, and one that
 * cannot be written costs the next turn's. Never the observation.
 *
 * @module TradingMarketSample
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { MarketSample } from "@t3tools/trading-contracts/microstructure";

interface SampleRow {
  readonly mark_price: number;
  readonly spread_bps: number | null;
  readonly near_depth_usd: number | null;
  readonly open_interest: number | null;
  readonly observed_at: number;
}

/** The sample the previous observation left, or nothing. */
export const readMarketSample = (input: {
  readonly missionId: string;
  readonly market: string;
}): Effect.Effect<MarketSample | null, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<SampleRow>`
      SELECT mark_price, spread_bps, near_depth_usd, open_interest, observed_at
      FROM trading_market_samples
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      markPrice: row.mark_price,
      ...(row.spread_bps === null ? {} : { spreadBps: row.spread_bps }),
      ...(row.near_depth_usd === null ? {} : { nearDepthUsd: row.near_depth_usd }),
      ...(row.open_interest === null ? {} : { openInterest: row.open_interest }),
      observedAt: row.observed_at,
    };
  }).pipe(Effect.orElseSucceed(() => null));

/**
 * Leave this observation's sample for the next one.
 *
 * One row per mission and market, overwritten every time. A series would be
 * data no reader reads: every delta this phase reports spans exactly one gap.
 */
export const writeMarketSample = (input: {
  readonly missionId: string;
  readonly market: string;
  readonly sample: MarketSample;
}): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { sample } = input;
    yield* sql`
      INSERT INTO trading_market_samples
        (mission_id, market, mark_price, spread_bps, near_depth_usd, open_interest, observed_at)
      VALUES (
        ${input.missionId},
        ${input.market},
        ${sample.markPrice},
        ${sample.spreadBps ?? null},
        ${sample.nearDepthUsd ?? null},
        ${sample.openInterest ?? null},
        ${sample.observedAt}
      )
      ON CONFLICT (mission_id, market) DO UPDATE SET
        mark_price = excluded.mark_price,
        spread_bps = excluded.spread_bps,
        near_depth_usd = excluded.near_depth_usd,
        open_interest = excluded.open_interest,
        observed_at = excluded.observed_at
    `;
  }).pipe(Effect.catchCause(() => Effect.void));
