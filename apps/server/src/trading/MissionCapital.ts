/**
 * Where a mission's `allocatedCapitalUsd` comes from.
 *
 * The mandate scales from one number: `testnetAuthorityDefaults` derives gross
 * notional, the cumulative loss budget, and per-position risk from it. That
 * number used to be a constant — 50 — which on a 1,000 USDC testnet account
 * boxed the harness into a $400 notional ceiling and a $17.50 loss budget
 * nobody had chosen. So it is resolved from the account instead.
 *
 * The order, and why:
 *
 *   1. An explicit grant (the env knob, or a number typed into the form) wins
 *      verbatim. It is never clamped against the balance in either direction:
 *      an operator who writes 5,000 against a 1,000 account is stating a
 *      mandate, not asking for advice, and the mandate is theirs to state.
 *   2. Otherwise the live `accountValue` at creation time.
 *   3. Otherwise `FALLBACK_MISSION_CAPITAL_USD`, with a warning.
 *
 * An unreadable snapshot logs and falls through rather than failing the
 * creation. The balance here is information, not a gate — a dead info endpoint
 * must not be the thing that stops a testnet lab from starting, and the warning
 * is the operator's cue that the mandate is smaller than they expect.
 *
 * Resolution happens once, at creation. The mandate does not re-scale when the
 * balance moves: the harness sees the balance every wakeup through
 * `accountSnapshot` and sizes within the rails itself, while the rails are the
 * operator's grant and stay put until the operator changes them.
 *
 * @module MissionCapital
 */
import * as Effect from "effect/Effect";

/**
 * The mandate a mission gets when there is no explicit grant and the account is
 * unreadable. Small on purpose: it is the answer to "we do not know what this
 * account holds", and under-granting is the safe direction to be wrong in.
 */
export const FALLBACK_MISSION_CAPITAL_USD = 50;

const isPositiveFinite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/**
 * Which of the three precedence rules produced the mandate.
 *
 * Reported alongside the number because the number alone does not say whether
 * the operator granted it, the account sized it, or nobody could read the
 * account — and that is the first thing to check when a mission turns out to be
 * trading a mandate nobody expected.
 */
export type MissionCapitalSource = "explicit" | "account" | "fallback";

export interface ResolvedMissionCapital {
  readonly allocatedCapitalUsd: number;
  readonly source: MissionCapitalSource;
}

/**
 * Resolve the capital a new mission is created under.
 *
 * `readAccountValueUsd` is only run when there is no explicit grant, so the
 * common auto-mission path costs one exchange read and the explicit path costs
 * none.
 */
export const resolveMissionCapitalUsd = <E, R>(input: {
  readonly explicitUsd: number | undefined;
  readonly readAccountValueUsd: Effect.Effect<number, E, R>;
}): Effect.Effect<ResolvedMissionCapital, never, R> =>
  Effect.gen(function* () {
    if (isPositiveFinite(input.explicitUsd)) {
      return { allocatedCapitalUsd: input.explicitUsd, source: "explicit" as const };
    }

    const accountValueUsd = yield* input.readAccountValueUsd.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("mission capital: account value unreadable, using the fallback", {
          fallbackUsd: FALLBACK_MISSION_CAPITAL_USD,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

    // The read failed and already warned.
    if (accountValueUsd === null) {
      return { allocatedCapitalUsd: FALLBACK_MISSION_CAPITAL_USD, source: "fallback" as const };
    }

    // A read that succeeded with a zero or nonsense value is its own warning:
    // the account exists and holds nothing usable.
    if (!isPositiveFinite(accountValueUsd)) {
      yield* Effect.logWarning("mission capital: account value is not usable, using the fallback", {
        accountValueUsd,
        fallbackUsd: FALLBACK_MISSION_CAPITAL_USD,
      });
      return { allocatedCapitalUsd: FALLBACK_MISSION_CAPITAL_USD, source: "fallback" as const };
    }

    return { allocatedCapitalUsd: accountValueUsd, source: "account" as const };
  });
