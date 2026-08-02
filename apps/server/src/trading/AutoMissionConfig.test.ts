import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { POC_DEFAULT_INSTRUCTION } from "@t3tools/trading-contracts/strategy";

import {
  AUTO_MISSION_DEFAULT_ACCOUNT_ID,
  AUTO_MISSION_DEFAULT_CAPITAL_USD,
  resolveAutoMissionFromEnv,
} from "./AutoMissionConfig.ts";

describe("resolveAutoMissionFromEnv", () => {
  // The shortcut creates missions without anyone asking. Every server that has
  // not opted in must see it stay off, whatever else is in the environment.
  it("is off unless a workspace root is named", () => {
    expect(Option.isNone(resolveAutoMissionFromEnv({}))).toBe(true);
    expect(
      Option.isNone(
        resolveAutoMissionFromEnv({
          T3_TRADES_AUTO_MISSION_CAPITAL_USD: "500",
          T3_TRADES_AUTO_MISSION_INSTRUCTION: "Trade something",
        }),
      ),
    ).toBe(true);
  });

  it("is off for a workspace root that is only whitespace", () => {
    expect(
      Option.isNone(resolveAutoMissionFromEnv({ T3_TRADES_AUTO_MISSION_WORKSPACE: "   " })),
    ).toBe(true);
  });

  it("defaults the mandate, the account, and the 1m instruction", () => {
    const settings = resolveAutoMissionFromEnv({
      T3_TRADES_AUTO_MISSION_WORKSPACE: "/lab/t3-trade-test",
    });

    expect(Option.getOrThrow(settings)).toEqual({
      workspaceRoot: "/lab/t3-trade-test",
      instruction: POC_DEFAULT_INSTRUCTION,
      allocatedCapitalUsd: AUTO_MISSION_DEFAULT_CAPITAL_USD,
      tradingAccountId: AUTO_MISSION_DEFAULT_ACCOUNT_ID,
    });
  });

  it("takes the overrides when they are given", () => {
    const settings = resolveAutoMissionFromEnv({
      T3_TRADES_AUTO_MISSION_WORKSPACE: "/lab/t3-trade-test",
      T3_TRADES_AUTO_MISSION_CAPITAL_USD: "250",
      T3_TRADES_AUTO_MISSION_INSTRUCTION: "Trade ETH momentum on 5m candles.",
      T3_TRADES_AUTO_MISSION_ACCOUNT: "acct_2",
    });

    expect(Option.getOrThrow(settings)).toEqual({
      workspaceRoot: "/lab/t3-trade-test",
      instruction: "Trade ETH momentum on 5m candles.",
      allocatedCapitalUsd: 250,
      tradingAccountId: "acct_2",
    });
  });

  // A capital value that is not a positive number would create a mission whose
  // whole mandate is derived from it — a $0 or NaN mandate. The documented
  // default is a better answer than either.
  it("falls back to the default mandate for an unusable capital value", () => {
    for (const raw of ["", "0", "-100", "abc"]) {
      const settings = resolveAutoMissionFromEnv({
        T3_TRADES_AUTO_MISSION_WORKSPACE: "/lab/t3-trade-test",
        T3_TRADES_AUTO_MISSION_CAPITAL_USD: raw,
      });
      expect(Option.getOrThrow(settings).allocatedCapitalUsd).toBe(
        AUTO_MISSION_DEFAULT_CAPITAL_USD,
      );
    }
  });
});
