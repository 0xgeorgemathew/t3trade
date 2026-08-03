import { Effect, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  readFileText,
  resolveInterimSignerFromEnv,
  resolveInterimSignerFromFile,
} from "./InterimSignerConfig.ts";

/**
 * Canonical Ethereum test vector: private key = 32 bytes of 0x01 derives to
 * 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf. Used so the address-derivation
 * inside the config is pinned without the owner's real key.
 */
const VALID_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const DERIVED_ADDR = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

describe("resolveInterimSignerFromEnv", () => {
  it.effect("returns none when the key env var is unset (fail-closed gate)", () =>
    Effect.gen(function* () {
      const none = yield* resolveInterimSignerFromEnv({});
      const addrOnly = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_ADDRESS: DERIVED_ADDR,
      });
      expect(none).toEqual(Option.none());
      expect(addrOnly).toEqual(Option.none());
    }),
  );

  it.effect("derives the address from the key alone", () =>
    Effect.gen(function* () {
      const result = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: VALID_KEY,
      });
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.address).toBe(DERIVED_ADDR);
        expect(result.value.privateKeyBytes).toBeInstanceOf(Uint8Array);
        expect(result.value.privateKeyBytes.length).toBe(32);
      }
    }),
  );

  it.effect("accepts an explicit address that matches the derived one", () =>
    Effect.gen(function* () {
      const result = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: VALID_KEY,
        T3_TRADES_INTERIM_SIGNER_ADDRESS: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      });
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        // Address is lowercased for consistent comparison.
        expect(result.value.address).toBe(DERIVED_ADDR);
      }
    }),
  );

  it.effect("rejects an explicit address that does not match the key", () =>
    Effect.gen(function* () {
      const error = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: VALID_KEY,
        T3_TRADES_INTERIM_SIGNER_ADDRESS: "0x1111111111111111111111111111111111111111",
      }).pipe(Effect.flip);
      expect(error.reason).toBe("address_mismatch");
    }),
  );

  it.effect("rejects a malformed private key", () =>
    Effect.gen(function* () {
      const error = yield* resolveInterimSignerFromEnv({
        T3_TRADES_INTERIM_SIGNER_KEY: "0xnotakey",
      }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_private_key");
    }),
  );
});

describe("resolveInterimSignerFromFile with the real reader", () => {
  // Regression: the reader used `Effect.promise`, whose rejection is a DEFECT.
  // Defects skip `orElseSucceed`, so an absent key file killed the caller
  // instead of leaving the gate unarmed — which is what a fresh checkout, with
  // no key written yet, always hits.
  it.effect("leaves the gate unarmed when the key file is absent", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveInterimSignerFromFile(
        readFileText,
        "/nonexistent/t3-trades-secrets",
      );
      expect(resolved).toEqual(Option.none());
    }),
  );
});
