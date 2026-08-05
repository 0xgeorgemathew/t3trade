import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Carry the value each watch predicate is reading onto the watch row itself.
 *
 * The evaluator already computes a value on every sweep — mark/mid for
 * `price_cross`, unrealised PnL for `pnl_above`/`pnl_below`, drawdown from peak
 * for `pnl_giveback` — but only used it to decide whether the watch fired and
 * threw it away on a non-match. The workspace's conditions checklist was
 * therefore limited to a ticked/empty checkbox: it could say a watch had not
 * crossed, but not how close it was.
 *
 * These two columns persist that observed value, plus when it was seen, so the
 * checklist can render the live number next to its threshold. Both are nullable
 * — existing rows have neither, and a sweep that cannot read a real value (flat
 * position, gateway failure) writes nothing rather than a stale zero.
 *
 * Same PRAGMA-guarded `ADD COLUMN` shape as 043 and 048.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_watches)`;
  if (!columns.some((column) => column.name === "last_observed_value")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN last_observed_value REAL`;
  }
  if (!columns.some((column) => column.name === "last_evaluated_at")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN last_evaluated_at INTEGER`;
  }
});
