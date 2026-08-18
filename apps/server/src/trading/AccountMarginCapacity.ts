/**
 * What the exchange account can actually fund, in gross notional.
 *
 * `account_value * leverage`, both from the reconciler's own snapshots. The
 * mandate's ceilings say what the mission MAY take; this says what the account
 * CAN settle, and when they disagree the account wins — an entry sized off an
 * 8x mandate against a 1x account fills an eighth of the request and reports
 * `filled`.
 *
 * Shared because two callers need the same number for opposite reasons: the
 * entry service bounds the order by it, and the wake's cost line prices by it.
 * They were not shared before, and the cost line quoted the plan's declared
 * $500 while every entry actually took ~$900 — so the round trip the model
 * reasoned against was half the one it paid, and every target it set cleared a
 * rung that was half as high as the real one.
 *
 * @module AccountMarginCapacity
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The account's fundable notional, or null when there is no account value to
 * read. Null is "unknown", never "zero": an unreadable row must not bound an
 * entry, and must not price a cost line either.
 */
export const readAccountMarginCapacityUsd = (
  sql: SqlClient.SqlClient,
  input: {
    readonly missionId: string;
    readonly market: string;
  },
): Effect.Effect<number | null> =>
  Effect.gen(function* () {
    const accounts = yield* sql<{ readonly account_value: number }>`
      SELECT account_value FROM trading_account_observations
      WHERE mission_id = ${input.missionId}
    `;
    const positions = yield* sql<{ readonly leverage: number | null }>`
      SELECT leverage FROM trading_position_snapshots
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
    `;
    const accountValue = accounts[0]?.account_value;
    if (accountValue == null || !(accountValue > 0)) return null;

    // No snapshot row exists until the mission has held a position, so the
    // FIRST entry of a mission read a null leverage — and a null capacity
    // removed the ceiling entirely rather than lowering it. That is how one
    // mission's opening order asked for $6,809 against a 1x account holding
    // $900: every later entry was bound by `account_margin`, and only the
    // first had nothing to bind it. Unlevered is the floor no account can be
    // below, so it is the honest stand-in for a leverage nobody has reported.
    const leverage = positions[0]?.leverage ?? 1;
    if (!(leverage > 0)) return null;
    return accountValue * leverage;
  }).pipe(
    // A sizing bound and a cost reference are both enrichments. An unreadable
    // row leaves each exactly as it was before this existed.
    //
    // `catchCause`, not `orElseSucceed`: a missing table is a DEFECT, not a
    // typed failure, and recovering only the error channel let one take a
    // whole `trading_look` down with "internal server error".
    Effect.catchCause(() => Effect.succeed(null)),
  );
