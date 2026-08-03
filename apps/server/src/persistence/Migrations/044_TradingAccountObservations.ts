import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The last account value reconciliation observed, per mission.
 *
 * A position change can be diffed against the position snapshot the previous
 * reconcile wrote, but an account value has nowhere to be remembered — the
 * gateway reads it fresh every pass and nothing keeps the previous one. Without
 * it a deposit or a withdrawal made in the Hyperliquid UI is invisible: the
 * balance simply is what it is, and the mission never learns that the ground it
 * sizes against moved.
 *
 * One row per mission, overwritten every pass.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_account_observations (
      mission_id    TEXT PRIMARY KEY,
      account_value REAL NOT NULL,
      observed_at   INTEGER NOT NULL
    )
  `;
});
