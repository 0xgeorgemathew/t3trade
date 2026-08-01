import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Additive PROMPT-04 columns on the execution tables. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fillCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_fills)`;
  if (!fillCols.some((column) => column.name === "closed_pnl")) {
    yield* sql`ALTER TABLE trading_fills ADD COLUMN closed_pnl REAL NOT NULL DEFAULT 0`;
  }
  const positionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_position_snapshots)`;
  if (!positionCols.some((column) => column.name === "liquidation_price")) {
    yield* sql`ALTER TABLE trading_position_snapshots ADD COLUMN liquidation_price REAL`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_risk_reservations_execution
    ON trading_risk_reservations (execution_id)
  `;
});
