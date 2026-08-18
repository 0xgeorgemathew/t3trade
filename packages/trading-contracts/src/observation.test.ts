import { assert, describe, it } from "@effect/vitest";

import {
  echoedBarsForLook,
  TRADING_LOOK_DEFAULT_BARS,
  TRADING_LOOK_FLAT_BAR_CAP,
} from "./observation.ts";

/**
 * Plan 36 item 8. 17 `trading_look` calls came to 293,500 characters — 82% of
 * one mission's entire context, against 35,589 for all 21 of its wake payloads
 * combined. The model asked for 120 bars on essentially every turn and used
 * them to recompute ema(20) and ema(50), which the server had already computed
 * and sent beside them. Thirteen of those turns concluded "no setup".
 *
 * The cap is flat-only on purpose: the shape of the chart is what a trade is
 * contemplated and managed against, and a held position is not the place to
 * economise.
 */
describe("echoedBarsForLook", () => {
  it("caps a flat call at the flat cap", () => {
    assert.equal(echoedBarsForLook({ bars: 120 }), TRADING_LOOK_FLAT_BAR_CAP);
  });

  it("gives a held position the whole window it asked for", () => {
    assert.equal(echoedBarsForLook({ bars: 120, holdingPosition: true }), 120);
  });

  it("leaves a flat call under the cap alone", () => {
    assert.equal(echoedBarsForLook({ bars: 5 }), 5);
  });

  it("still answers indicators-without-bars with no chart at all", () => {
    // The reading is 140 characters where the window it came from is 18,000.
    assert.equal(echoedBarsForLook({ indicators: [{ kind: "ema" }] }), 0);
    assert.equal(echoedBarsForLook({ indicators: [{ kind: "ema" }], holdingPosition: true }), 0);
  });

  it("falls back to the short tail when neither was named", () => {
    assert.equal(echoedBarsForLook({}), TRADING_LOOK_DEFAULT_BARS);
    assert.equal(echoedBarsForLook({ holdingPosition: true }), TRADING_LOOK_DEFAULT_BARS);
  });

  it("takes an explicit zero as the answer, not as absent", () => {
    assert.equal(echoedBarsForLook({ bars: 0 }), 0);
  });
});
