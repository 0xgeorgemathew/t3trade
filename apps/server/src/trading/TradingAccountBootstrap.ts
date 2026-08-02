/**
 * TradingAccountBootstrap - the local testnet account row.
 *
 * A mission names a `trading_accounts` row, and §10.6 reads Hyperliquid account
 * state with that row's master-wallet address. Nothing in the POC creates the
 * row: Privy owns account provisioning and arrives in PROMPT-06, so until then
 * a mission cannot be created at all without this bootstrap.
 *
 * The stand-in is deliberately thin. On testnet the interim signer IS the
 * master account (no separate agent approval), so both wallets carry the one
 * derived address and the row is keyed on a fixed id rather than a generated
 * one — re-running the server must land on the same account, not a new one.
 *
 * When the signer is unarmed the bootstrap does nothing. The live-submit gate
 * is fail-closed by design, and an account row without a usable key would only
 * move the failure later.
 *
 * @module TradingAccountBootstrap
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { InterimSignerConfig, type InterimSignerError } from "./InterimSignerConfig.ts";
import { TradingExecutionWallet, TradingMasterWallet } from "./Schemas.ts";
import { LOCAL_TRADING_USER_ID } from "./TradingMissionReactor.ts";

// The two wallet columns are JSON text, and the published contract shapes are
// the source of truth for what goes in them — so they are encoded through the
// schemas rather than hand-serialised.
const encodeMasterWallet = Schema.encodeSync(Schema.fromJsonString(TradingMasterWallet));
const encodeExecutionWallet = Schema.encodeSync(Schema.fromJsonString(TradingExecutionWallet));

// The signer derives its address from the key, so this always holds; the guard
// exists to narrow `string` to the contract's template-literal address rather
// than to assert it away.
function isEvmAddress(value: string): value is `0x${string}` {
  return value.startsWith("0x");
}

/**
 * The account id every locally created mission names.
 *
 * Fixed rather than generated so the id can be typed into the workspace's
 * new-mission form and so a restart reuses the same row.
 */
export const LOCAL_TRADING_ACCOUNT_ID = "local-hyperliquid-testnet";

/**
 * Upsert the local account row from the interim signer.
 *
 * The address is refreshed on every start: swapping the key in
 * `.t3/secrets/` should move the account the missions read, not leave a stale
 * address pointing at the previous wallet.
 */
export const ensureLocalTradingAccount: Effect.Effect<
  Option.Option<string>,
  PersistenceSqlError | InterimSignerError,
  SqlClient.SqlClient | InterimSignerConfig
> = Effect.gen(function* () {
  const config = yield* InterimSignerConfig;
  const signer = yield* config.resolve;

  if (Option.isNone(signer)) {
    yield* Effect.logInfo(
      "TradingAccountBootstrap: interim signer unarmed, no local trading account provisioned",
    );
    return Option.none();
  }

  const address = signer.value.address;
  if (!isEvmAddress(address)) {
    yield* Effect.logWarning("TradingAccountBootstrap: signer address is not an EVM address", {
      address,
    });
    return Option.none();
  }

  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;

  const masterWallet = encodeMasterWallet({
    privyWalletId: "interim-master",
    address,
    ownership: "user",
  });
  const executionWallet = encodeExecutionWallet({
    privyWalletId: "interim-signer",
    address,
    hyperliquidAgentName: "interim",
    status: "approved",
    approvedAt: now,
  });

  yield* sql`
    INSERT INTO trading_accounts (
      account_id, user_id, environment,
      master_wallet_json, execution_wallet_json,
      status, created_at, updated_at
    ) VALUES (
      ${LOCAL_TRADING_ACCOUNT_ID}, ${LOCAL_TRADING_USER_ID}, ${"hyperliquid_testnet"},
      ${masterWallet}, ${executionWallet},
      ${"ready"}, ${now}, ${now}
    )
    ON CONFLICT (account_id) DO UPDATE SET
      master_wallet_json = excluded.master_wallet_json,
      execution_wallet_json = excluded.execution_wallet_json,
      status = excluded.status,
      updated_at = excluded.updated_at
  `.pipe(Effect.mapError(toPersistenceSqlError("ensureLocalTradingAccount")));

  yield* Effect.logInfo("TradingAccountBootstrap: local trading account ready", {
    accountId: LOCAL_TRADING_ACCOUNT_ID,
    address,
  });

  return Option.some(address);
});

/**
 * Runs the bootstrap once at layer build.
 *
 * A failure here is logged rather than fatal: an unreadable key or a locked
 * database should degrade trading to unavailable, not stop the server from
 * booting.
 */
export const TradingAccountBootstrapLive: Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | InterimSignerConfig
> = Layer.effectDiscard(
  ensureLocalTradingAccount.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("TradingAccountBootstrap: local trading account not provisioned", {
        cause,
      }),
    ),
  ),
);
