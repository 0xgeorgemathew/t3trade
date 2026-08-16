import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { InterimSigner, InterimSignerConfig } from "./InterimSignerConfig.ts";
import { ensureLocalTradingAccount, LOCAL_TRADING_ACCOUNT_ID } from "./TradingAccountBootstrap.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";

const ADDRESS = "0xb2b6b516df4b159c0e4eb1d6d7d65a5f2f04c30e";
const OTHER_ADDRESS = "0x00000000000000000000000000000000000000ff";

const signerLayer = (address: string | null) =>
  Layer.succeed(
    InterimSignerConfig,
    InterimSignerConfig.of({
      resolve: Effect.succeed(
        address === null
          ? Option.none()
          : Option.some(
              new InterimSigner({ address, privateKeyBytes: new Uint8Array(32).fill(1) }),
            ),
      ),
    }),
  );

const layer = it.layer(
  TradingMissionServiceLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 63 });
  yield* sql`DELETE FROM trading_accounts`;
});

layer("TradingAccountBootstrap", (it) => {
  it.effect("provisions an account whose master address is the signer's", () =>
    Effect.gen(function* () {
      yield* migrated;

      const address = yield* ensureLocalTradingAccount.pipe(Effect.provide(signerLayer(ADDRESS)));

      assert.deepStrictEqual(address, Option.some(ADDRESS));

      // Read it back the way §10.6 does — through the service that resolves the
      // account state address, not by re-reading the column.
      const missions = yield* TradingMissionService;
      const stored = yield* missions.getMasterWalletAddress(LOCAL_TRADING_ACCOUNT_ID);
      assert.equal(stored, ADDRESS);
    }),
  );

  it.effect("re-running moves the account onto a swapped key rather than duplicating it", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      yield* ensureLocalTradingAccount.pipe(Effect.provide(signerLayer(ADDRESS)));
      yield* ensureLocalTradingAccount.pipe(Effect.provide(signerLayer(OTHER_ADDRESS)));

      const rows = yield* sql<{ account_id: string }>`SELECT account_id FROM trading_accounts`;
      assert.equal(rows.length, 1);

      const missions = yield* TradingMissionService;
      const stored = yield* missions.getMasterWalletAddress(LOCAL_TRADING_ACCOUNT_ID);
      assert.equal(stored, OTHER_ADDRESS);
    }),
  );

  it.effect("provisions nothing while the signer is unarmed", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      const address = yield* ensureLocalTradingAccount.pipe(Effect.provide(signerLayer(null)));

      assert.deepStrictEqual(address, Option.none());
      const rows = yield* sql<{ account_id: string }>`SELECT account_id FROM trading_accounts`;
      assert.equal(rows.length, 0);
    }),
  );

  // An address without the 0x prefix cannot be a master wallet, and writing it
  // would leave a row §10.6 could not decode.
  it.effect("refuses an address that is not an EVM address", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;

      const address = yield* ensureLocalTradingAccount.pipe(
        Effect.provide(signerLayer("b2b6b516df4b159c0e4eb1d6d7d65a5f2f04c30e")),
      );

      assert.deepStrictEqual(address, Option.none());
      const rows = yield* sql<{ account_id: string }>`SELECT account_id FROM trading_accounts`;
      assert.equal(rows.length, 0);
    }),
  );
});
