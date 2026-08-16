import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan 29 step 6.2: the quote table goes.
 *
 * It held the server's half of an order between the turn that asked for it and
 * the call that executed it. Entering is one call now, so there is no between
 * — nothing writes a quote and, since migration 064 moved the four readers,
 * nothing reads one.
 *
 * `trading_execution_sequences` is deliberately NOT dropped with it. It is not
 * part of the two-step: the exit service, the stop-adjustment path and both
 * lanes of the working-order loop allocate from it, its counter is what derives
 * every cloid, and the working-order lineage walk orders on it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_trading_entry_quotes_mission_quoted`;
  yield* sql`DROP INDEX IF EXISTS idx_trading_entry_quotes_mission_sequence`;
  yield* sql`DROP TABLE IF EXISTS trading_entry_quotes`;
});
