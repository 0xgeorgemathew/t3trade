/**
 * The env seam over the testnet authority preset.
 *
 * The numbers themselves are `testnetAuthorityDefaults`' business and are
 * tested there. What matters here is the resolution: an override applies, junk
 * falls back rather than failing, and nothing in the environment can widen a
 * permission.
 */
import { assert, describe, it } from "@effect/vitest";

import { testnetAuthorityDefaults } from "@t3tools/trading-contracts/authority";

import { resolveTestnetAuthority } from "./TestnetAuthority.ts";

const CAPITAL = 100;
const defaults = testnetAuthorityDefaults(CAPITAL);

describe("resolveTestnetAuthority", () => {
  it("uses the preset when nothing is set", () => {
    assert.deepEqual(resolveTestnetAuthority({}, CAPITAL), defaults);
  });

  it("applies each override independently", () => {
    const authority = resolveTestnetAuthority(
      {
        T3_TRADES_AUTHORITY_MAX_LEVERAGE: "25",
        T3_TRADES_AUTHORITY_MAX_GROSS_NOTIONAL_USD: "1200",
        T3_TRADES_AUTHORITY_MAX_CUMULATIVE_LOSS_USD: "50",
        T3_TRADES_AUTHORITY_MAX_PLANNED_RISK_USD: "10",
      },
      CAPITAL,
    );

    assert.equal(authority.maximumLeverage, 25);
    assert.equal(authority.maximumGrossNotionalUsd, 1_200);
    assert.equal(authority.maximumCumulativeLossUsd, 50);
    assert.equal(authority.maximumPlannedRiskPerPositionUsd, 10);
  });

  it("leaves the others at the preset when only one is set", () => {
    const authority = resolveTestnetAuthority(
      { T3_TRADES_AUTHORITY_MAX_PLANNED_RISK_USD: "12" },
      CAPITAL,
    );

    assert.equal(authority.maximumPlannedRiskPerPositionUsd, 12);
    assert.equal(authority.maximumGrossNotionalUsd, defaults.maximumGrossNotionalUsd);
    assert.equal(authority.maximumLeverage, defaults.maximumLeverage);
  });

  it("falls back to the preset for a value that is not a positive number", () => {
    // A typo'd ceiling must not be the thing that stops a mission from being
    // created; the documented default is the safer answer.
    for (const raw of ["", "  ", "nonsense", "0", "-5", "NaN"]) {
      const authority = resolveTestnetAuthority(
        { T3_TRADES_AUTHORITY_MAX_CUMULATIVE_LOSS_USD: raw },
        CAPITAL,
      );
      assert.equal(
        authority.maximumCumulativeLossUsd,
        defaults.maximumCumulativeLossUsd,
        `"${raw}" should not have been accepted`,
      );
    }
  });

  it("cannot widen a permission", () => {
    // Every knob is a size. Reversal, margin mode, and direction are authority
    // the user grants explicitly, not a number in the environment.
    const authority = resolveTestnetAuthority(
      {
        T3_TRADES_AUTHORITY_MAX_LEVERAGE: "25",
        allowDirectionReversal: "true",
        marginModes: "cross",
      },
      CAPITAL,
    );

    assert.equal(authority.allowDirectionReversal, false);
    assert.deepEqual(authority.marginModes, ["isolated"]);
    assert.deepEqual(authority.riskPolicy, defaults.riskPolicy);
  });
});
