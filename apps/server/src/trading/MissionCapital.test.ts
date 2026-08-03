/**
 * Where the mandate's size comes from.
 *
 * The three cases the operator cares about: an explicit grant is theirs and is
 * never second-guessed against the balance; no grant means the live account
 * value; an account that cannot be read falls back rather than blocking, so a
 * dead info endpoint never stops a testnet lab from starting.
 */
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";

import { FALLBACK_MISSION_CAPITAL_USD, resolveMissionCapitalUsd } from "./MissionCapital.ts";

const accountValue = (usd: number) => Effect.succeed(usd);
const unreadableAccount = Effect.fail({ _tag: "AccountReadFailed" } as const);
const neverRead = Effect.sync<number>(() => {
  throw new Error("the account must not be read when capital was stated");
});

it.effect("takes an explicit grant verbatim, even above the balance", () =>
  Effect.gen(function* () {
    const capital = yield* resolveMissionCapitalUsd({
      explicitUsd: 5_000,
      readAccountValueUsd: neverRead,
    });
    assert.equal(capital, 5_000);
  }),
);

it.effect("sizes from the live account value when no capital was stated", () =>
  Effect.gen(function* () {
    const capital = yield* resolveMissionCapitalUsd({
      explicitUsd: undefined,
      readAccountValueUsd: accountValue(1_000),
    });
    assert.equal(capital, 1_000);
  }),
);

it.effect("falls back to the default when the account cannot be read", () =>
  Effect.gen(function* () {
    const capital = yield* resolveMissionCapitalUsd({
      explicitUsd: undefined,
      readAccountValueUsd: unreadableAccount,
    });
    assert.equal(capital, FALLBACK_MISSION_CAPITAL_USD);
  }),
);

// A read that succeeds with nothing usable is the same situation as a failed
// one: there is no account value to scale a mandate from.
it.effect("falls back when the account value is zero or nonsense", () =>
  Effect.gen(function* () {
    for (const value of [0, -10, Number.NaN]) {
      const capital = yield* resolveMissionCapitalUsd({
        explicitUsd: undefined,
        readAccountValueUsd: accountValue(value),
      });
      assert.equal(capital, FALLBACK_MISSION_CAPITAL_USD);
    }
  }),
);

// A junk explicit value is not a grant. Falling through to the account is
// better than deriving a $0 or NaN mandate from it.
it.effect("ignores an unusable explicit value and reads the account", () =>
  Effect.gen(function* () {
    for (const value of [0, -100, Number.NaN]) {
      const capital = yield* resolveMissionCapitalUsd({
        explicitUsd: value,
        readAccountValueUsd: accountValue(1_000),
      });
      assert.equal(capital, 1_000);
    }
  }),
);
