import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The human-readable summary an inbox event was persisted with (§18.1).
 *
 * Migration 035 created `trading_event_inbox` without a summary column, so the
 * wakeup had to fabricate `category:deduplication_key` labels. The evaluator
 * composes a real summary at observation time ("5m candle closed 3010 (above
 * 3000)"); storing it is what lets a resumed run read it back.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE trading_event_inbox ADD COLUMN summary TEXT NOT NULL DEFAULT ''
  `;
});
