import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Renames the open-ended authority sentinel from `"revoked"` to
 * `"until_revoked"` in every persisted authority.
 *
 * `validUntil: "revoked"` meant "valid until the user revokes it", but the
 * whole authority is handed to the harness in its mission context, and the
 * harness read the field literally: it reported its mandate as revoked and
 * refused to place any order, on a mission that was live and `analysing`.
 * Nothing enforces the value, so the rename is the entire fix.
 *
 * Both tables that store an authority are rewritten. Rows already carrying the
 * new spelling are untouched, so this is safe to re-run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE trading_authority_versions
    SET authority_json =
      replace(authority_json, '"validUntil":"revoked"', '"validUntil":"until_revoked"')
    WHERE authority_json LIKE '%"validUntil":"revoked"%'
  `;

  yield* sql`
    UPDATE projection_trading_missions
    SET authority_json =
      replace(authority_json, '"validUntil":"revoked"', '"validUntil":"until_revoked"')
    WHERE authority_json LIKE '%"validUntil":"revoked"%'
  `;
});
