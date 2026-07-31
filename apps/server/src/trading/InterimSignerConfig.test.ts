import { Effect, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { resolveInterimSignerFromEnv } from "./InterimSignerConfig.ts";

const VALID_KEY = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bfce4c2e6e2c2f3a3a3b3a3a";
const VALID_ADDR = "0xAb1234567890aBc1234567890aBc1234567890aB";

describe("resolveInterimSignerFromEnv", () => {
  it.effect("returns none when neither env var is set (fail-closed gate)", () =>
    Effect.gen(function* () {
      const none = yield* resolveInterimSignerFromEnv({});
      const keyOnly = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: VALID_KEY,
      });
      const addrOnly = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_ADDRESS: VALID_ADDR,
      });
      expect(none).toEqual(Option.none());
      expect(keyOnly).toEqual(Option.none());
      expect(addrOnly).toEqual(Option.none());
    }),
  );

  it.effect("loads the signer when both env vars are present and well-formed", () =>
    Effect.gen(function* () {
      const result = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: VALID_KEY,
        T3_TRADES_INTERIM_SIGNER_ADDRESS: VALID_ADDR,
      });
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        // Address is lowercased for consistent comparison.
        expect(result.value.address).toBe(VALID_ADDR.toLowerCase());
        expect(result.value.privateKeyBytes).toBeInstanceOf(Uint8Array);
        expect(result.value.privateKeyBytes.length).toBe(32);
      }
    }),
  );

  it.effect("rejects a malformed private key", () =>
    Effect.gen(function* () {
      const error = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: "0xnotakey",
        T3_TRADES_INTERIM_SIGNER_ADDRESS: VALID_ADDR,
      }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_private_key");
    }),
  );

  it.effect("rejects a malformed address", () =>
    Effect.gen(function* () {
      const error = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: VALID_KEY,
        T3_TRADES_INTERIM_SIGNER_ADDRESS: "0xdeadbeef",
      }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_address");
    }),
  );
});
