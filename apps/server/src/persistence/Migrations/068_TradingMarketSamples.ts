import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan 29 steps 7.3 and 7.4: the previous observation's market sample.
 *
 * Two of the phase-7 readings are not about the market as it is, but about how
 * it has changed: a book that is thinning and an open interest that is moving
 * against price are both facts about a delta, and a delta needs a previous
 * value. An observation is a point-in-time read of a REST surface that serves
 * neither a depth history nor an open-interest history, so the previous value
 * has to be one the runtime kept.
 *
 * One row per mission and market: the sample is only ever compared against the
 * next one, so keeping a series would be storing data no reader reads. The
 * observation overwrites it on every look and every wake, which is also what
 * makes `observed_at` meaningful — the reader states the age of the comparison
 * beside the comparison, and a mission that has not looked in an hour is told
 * its "change" spans an hour.
 *
 * Nothing here can fail an observation. A sample that cannot be written costs
 * the next turn's deltas and nothing else.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_market_samples (
      mission_id TEXT NOT NULL,
      market TEXT NOT NULL,
      mark_price REAL NOT NULL,
      spread_bps REAL,
      near_depth_usd REAL,
      open_interest REAL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, market)
    )
  `;
});
