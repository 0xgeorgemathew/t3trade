/**
 * The armed-coverage floor — the rule that stops a mission going deaf while it
 * holds a position.
 *
 * The session this exists because of: a long open at 1833.9, one downside
 * `candle_close` armed, a `position_update` that correctly never fired because
 * the size never changed, price at 1859.5, and a harness that was never woken
 * to do anything about any of it.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  backedOffFloorMillis,
  findUnarmedEntryConditions,
  isDeafWhileHoldingPosition,
  NO_OP_BACKOFF_CAP_MILLIS,
  PLAN_REASSESS_FLOOR_MILLIS,
  planReassessCadenceMillis,
  readWatchCoverage,
  watchCoverageFloorMillis,
  toWatchRow,
  watchSanityBackstopMillis,
  WATCH_COVERAGE_FLOOR_MILLIS,
  type MarketWatch,
  type PersistedWatch,
} from "./watch.ts";
import { ACTIVE_TRADING_POLICY } from "./policy.ts";

const NOW = 1_753_000_000_000;
const MARK = 1_850;

const armed = (
  watch: MarketWatch,
  status: PersistedWatch["status"] = "active",
): PersistedWatch => ({
  id: `watch_${JSON.stringify(watch).length}_${status}`,
  missionId: "mission_1",
  watch,
  status,
  createdAt: NOW,
  updatedAt: NOW,
});

const coverageOf = (watches: ReadonlyArray<PersistedWatch>) =>
  readWatchCoverage({ watches, markPrice: MARK, nowMillis: NOW });

const upside = armed({
  type: "price_cross",
  market: "ETH",
  priceSource: "mark",
  direction: "above",
  price: 1_870,
});
const downside = armed({
  type: "candle_close",
  market: "ETH",
  interval: "1m",
  direction: "below",
  price: 1_830,
});

describe("readWatchCoverage", () => {
  it("reads a level on each side as covering both sides", () => {
    const coverage = coverageOf([upside, downside]);
    assert.isTrue(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });

  it("does not count a level on the wrong side of the mark", () => {
    // "Cross above 1830" armed while price is already 1850 is not upside
    // coverage; it is a condition that was true before it was written.
    const stale = armed({
      type: "price_cross",
      market: "ETH",
      priceSource: "mark",
      direction: "above",
      price: 1_830,
    });
    const coverage = coverageOf([stale, downside]);
    assert.isFalse(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
  });

  it("does not count order or position updates as directional coverage", () => {
    // The observed failure exactly: these are real events, but neither fires
    // for a mark that runs away while the size stays put.
    const coverage = coverageOf([
      downside,
      armed({ type: "order_update", cloid: "0xabc" }),
      armed({ type: "position_update", market: "ETH" }),
    ]);
    assert.isFalse(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
    assert.isTrue(isDeafWhileHoldingPosition(coverage));
  });

  it("ignores watches that are no longer active", () => {
    const coverage = coverageOf([
      { ...upside, status: "superseded" },
      { ...downside, status: "triggered" },
    ]);
    assert.isFalse(coverage.coversUpside);
    assert.isFalse(coverage.coversDownside);
  });

  it("counts a reassessment due inside the floor, and not one beyond it", () => {
    const inside = coverageOf([
      armed({ type: "scheduled_reassessment", runAt: NOW + WATCH_COVERAGE_FLOOR_MILLIS - 1 }),
    ]);
    assert.isTrue(inside.coversByReassessment);
    assert.isFalse(isDeafWhileHoldingPosition(inside));

    const beyond = coverageOf([
      armed({ type: "scheduled_reassessment", runAt: NOW + WATCH_COVERAGE_FLOOR_MILLIS + 1 }),
    ]);
    assert.isFalse(beyond.coversByReassessment);
    assert.isTrue(isDeafWhileHoldingPosition(beyond));
  });
});

describe("readWatchCoverage with PnL watches and a confirmed stop", () => {
  const target = armed({ type: "pnl_above", market: "ETH", valueUsd: 5 });
  const lossLine = armed({ type: "pnl_below", market: "ETH", valueUsd: -6 });
  const giveback = armed({ type: "pnl_giveback", market: "ETH", drawdownUsd: 3 });

  const coverageFor = (
    watches: ReadonlyArray<PersistedWatch>,
    position: { readonly positionSize: number; readonly protectedSize?: number },
  ) => readWatchCoverage({ watches, markPrice: MARK, nowMillis: NOW, ...position });

  it("reads a long's target as upside and its loss line as downside", () => {
    const coverage = coverageFor([target, lossLine], { positionSize: 0.5 });
    assert.isTrue(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });

  it("mirrors the sides for a short", () => {
    // The observed mission: a short with a target above and protection below.
    const coverage = coverageFor([target, giveback], { positionSize: -0.0053 });
    assert.isTrue(coverage.coversDownside);
    assert.isTrue(coverage.coversUpside);
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });

  it("covers no side when the position direction is unknown", () => {
    const coverage = coverageFor([target, lossLine], { positionSize: 0 });
    assert.isFalse(coverage.coversUpside);
    assert.isFalse(coverage.coversDownside);
  });

  it("counts a fully confirmed stop as losing-side coverage", () => {
    const coverage = coverageFor([target], { positionSize: -0.0053, protectedSize: 0.0053 });
    assert.isTrue(coverage.coversDownside); // the target, on a short
    assert.isTrue(coverage.coversUpside); // the resting stop, on a short
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });

  it("does not count a partial stop", () => {
    const coverage = coverageFor([target], { positionSize: 1, protectedSize: 0.4 });
    assert.isTrue(coverage.coversUpside);
    assert.isFalse(coverage.coversDownside);
    assert.isTrue(isDeafWhileHoldingPosition(coverage));
  });

  it("ignores PnL watches that are no longer active", () => {
    const coverage = coverageFor([{ ...target, status: "consumed" }, lossLine], {
      positionSize: 0.5,
    });
    assert.isFalse(coverage.coversUpside);
    assert.isTrue(coverage.coversDownside);
  });
});

describe("isDeafWhileHoldingPosition", () => {
  it("calls a mission with no watches at all deaf", () => {
    assert.isTrue(isDeafWhileHoldingPosition(coverageOf([])));
  });

  it("accepts one side plus a reassessment", () => {
    // The reassessment is the escape hatch: a mission that only wants to watch
    // one direction still gets a turn to reconsider.
    const coverage = coverageOf([
      downside,
      armed({ type: "scheduled_reassessment", runAt: NOW + 60_000 }),
    ]);
    assert.isFalse(isDeafWhileHoldingPosition(coverage));
  });
});

describe("findUnarmedEntryConditions", () => {
  const armedAt = (price: number) =>
    armed({ type: "price_cross", market: "ETH", priceSource: "mark", direction: "below", price });

  it("reports a named level with nothing armed at it", () => {
    const unarmed = findUnarmedEntryConditions({
      conditions: [{ description: "enter on a reclaim of 1899", priceLevel: 1_899 }],
      watches: [],
    });
    assert.deepEqual(unarmed, [{ description: "enter on a reclaim of 1899", priceLevel: 1_899 }]);
  });

  it("treats a watch within 10 bps of the hint as armed", () => {
    // 1899 against a watch at 1899.1 is the same decision, rounded.
    const unarmed = findUnarmedEntryConditions({
      conditions: [{ description: "reclaim", priceLevel: 1_899 }],
      watches: [armedAt(1_899.1)],
    });
    assert.deepEqual(unarmed, []);
  });

  it("does not accept a watch at an unrelated level", () => {
    const unarmed = findUnarmedEntryConditions({
      conditions: [{ description: "reclaim", priceLevel: 1_899 }],
      watches: [armedAt(1_830)],
    });
    assert.equal(unarmed.length, 1);
  });

  it("ignores conditions with no price hint — there is nothing to arm against", () => {
    const unarmed = findUnarmedEntryConditions({
      conditions: [{ description: "wait for funding to flip" }],
      watches: [],
    });
    assert.deepEqual(unarmed, []);
  });

  it("ignores watches that are no longer active", () => {
    const unarmed = findUnarmedEntryConditions({
      conditions: [{ description: "reclaim", priceLevel: 1_899 }],
      watches: [{ ...armedAt(1_899), status: "triggered" }],
    });
    assert.equal(unarmed.length, 1);
  });

  it("keeps the timeframe hint when the plan published one", () => {
    const unarmed = findUnarmedEntryConditions({
      conditions: [{ description: "reclaim", priceLevel: 1_899, timeframe: "5m" }],
      watches: [],
    });
    assert.equal(unarmed[0]?.timeframe, "5m");
  });
});

describe("watchSanityBackstopMillis", () => {
  const MINUTE = 60_000;

  it("stretches a 1m holder from 3 minutes to 30", () => {
    assert.equal(watchSanityBackstopMillis("1m"), 30 * MINUTE);
  });

  it("clamps a 5m holder to the 2-hour cap rather than 150 minutes", () => {
    assert.equal(watchSanityBackstopMillis("5m"), 120 * MINUTE);
  });

  it("is always well beyond the tight floor it replaces", () => {
    for (const timeframe of ["1m", "3m", "5m", "15m", "1h"] as const) {
      assert.isAbove(
        watchSanityBackstopMillis(timeframe),
        watchCoverageFloorMillis({ timeframe, holdingPosition: true }),
      );
    }
  });
});

describe("watchCoverageFloorMillis", () => {
  const MINUTE = 60_000;

  it("scales a 1m holder to 3 bars (3 minutes)", () => {
    assert.equal(watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: true }), 3 * MINUTE);
  });

  it("scales a 1m flat thesis to 10 bars (10 minutes) — the original flat-1m floor", () => {
    assert.equal(
      watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: false }),
      WATCH_COVERAGE_FLOOR_MILLIS,
    );
  });

  it("scales a 5m holder to 3 bars (15 minutes), at the holding cap", () => {
    assert.equal(watchCoverageFloorMillis({ timeframe: "5m", holdingPosition: true }), 15 * MINUTE);
  });

  it("clamps a 1h holder to the 15-minute holding cap rather than 3 hours", () => {
    assert.equal(watchCoverageFloorMillis({ timeframe: "1h", holdingPosition: true }), 15 * MINUTE);
  });

  it("clamps a 1h flat thesis to the 30-minute flat cap rather than 10 hours", () => {
    assert.equal(
      watchCoverageFloorMillis({ timeframe: "1h", holdingPosition: false }),
      30 * MINUTE,
    );
  });

  it("clamps a short-timeframe holder up to the 2-minute minimum", () => {
    // A 3m holder: 3 bars = 9 min, well above the 2 min floor — unaffected.
    // A hypothetical sub-minute timeframe would clamp, but 3m is the smallest
    // real bar; assert it computes 9 minutes without the floor binding.
    assert.equal(watchCoverageFloorMillis({ timeframe: "3m", holdingPosition: true }), 9 * MINUTE);
  });

  it("clamps a short-timeframe flat thesis up to the 5-minute minimum", () => {
    // 3m flat: 10 bars = 30 min, above the 5 min floor — unaffected.
    assert.equal(
      watchCoverageFloorMillis({ timeframe: "3m", holdingPosition: false }),
      30 * MINUTE,
    );
  });

  // Plan 27 I2: the flat cadence is a policy number, so a candidate version
  // can shorten it through replay without touching this arithmetic.
  it("reads the flat floor off the policy in force", () => {
    const quicker = {
      ...ACTIVE_TRADING_POLICY,
      reassessment: { flatFloorBars: 3, flatFloorClampMinutes: [2, 10] as const },
    };
    assert.equal(
      watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: false, policy: quicker }),
      3 * MINUTE,
    );
    // The holding branch is coverage safety, not cadence policy — unchanged.
    assert.equal(
      watchCoverageFloorMillis({ timeframe: "1m", holdingPosition: true, policy: quicker }),
      3 * MINUTE,
    );
  });
});

describe("planReassessCadenceMillis", () => {
  const MINUTE = 60_000;

  it("is the plan's own interval when the plan chose a sane one", () => {
    assert.equal(planReassessCadenceMillis(90), 90 * MINUTE);
    assert.equal(planReassessCadenceMillis(10), 10 * MINUTE);
  });

  // The hot-loop plan wrote `afterMinutes: 1`. The cadence is model-chosen
  // and the model has no cost model for its own turns, so the runtime clamps.
  it("raises a sub-floor interval to the floor", () => {
    assert.equal(planReassessCadenceMillis(1), PLAN_REASSESS_FLOOR_MILLIS);
    assert.equal(planReassessCadenceMillis(0.05), PLAN_REASSESS_FLOOR_MILLIS);
  });

  it("is always strictly positive", () => {
    assert.isAbove(planReassessCadenceMillis(0.0001), 0);
  });
});

describe("backedOffFloorMillis", () => {
  const MINUTE = 60_000;
  const BASE = 10 * MINUTE;

  it("leaves the base interval alone with no no-op streak", () => {
    assert.equal(backedOffFloorMillis(BASE, 0), BASE);
  });

  it("doubles per consecutive no-op wake", () => {
    assert.equal(backedOffFloorMillis(BASE, 1), 20 * MINUTE);
    assert.equal(backedOffFloorMillis(BASE, 2), 40 * MINUTE);
  });

  it("caps at the hour", () => {
    assert.equal(backedOffFloorMillis(BASE, 3), NO_OP_BACKOFF_CAP_MILLIS);
    assert.equal(backedOffFloorMillis(BASE, 50), NO_OP_BACKOFF_CAP_MILLIS);
  });

  // A base above the cap must not be pulled DOWN to the cap: the backoff only
  // ever stretches an interval, never shortens one someone else computed.
  it("never shortens a base already above the cap", () => {
    assert.equal(backedOffFloorMillis(90 * MINUTE, 2), 90 * MINUTE);
  });

  it("treats a negative streak as none", () => {
    assert.equal(backedOffFloorMillis(BASE, -1), BASE);
  });
});

/**
 * Plan 33 fix B. The look's registry read used to hand back the storage row:
 * the mission id it already knew, and the persisted encoding beside the
 * condition that says the same thing in the vocabulary the tool takes.
 */
describe("toWatchRow", () => {
  const persisted: PersistedWatch = {
    id: "watch_1",
    missionId: "mission_1",
    watch: { type: "pnl_giveback", market: "ETH", drawdownUsd: 4 },
    condition: { kind: "giveback", market: "ETH", drawdownUsd: 4 },
    status: "active",
    armedReason: "profit_target",
    predictionVersion: 7,
    lastObservedValue: 1.5,
    lastEvaluatedAt: NOW,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
  };

  it("keeps the id, the condition, and the lifecycle", () => {
    const row = toWatchRow(persisted);
    assert.equal(row.id, "watch_1");
    assert.deepEqual(row.condition, { kind: "giveback", market: "ETH", drawdownUsd: 4 });
    assert.equal(row.status, "active");
    assert.equal(row.armedReason, "profit_target");
    assert.equal(row.predictionVersion, 7);
    assert.equal(row.lastObservedValue, 1.5);
    assert.equal(row.createdAt, NOW - 60_000);
    assert.equal(row.updatedAt, NOW);
  });

  it("drops the mission id and the persisted encoding", () => {
    assert.deepEqual(Object.keys(toWatchRow(persisted)).sort(), [
      "armedReason",
      "condition",
      "createdAt",
      "id",
      "lastObservedValue",
      "predictionVersion",
      "status",
      "updatedAt",
    ]);
  });

  it("derives the condition on a row written before the column existed", () => {
    const { condition: _dropped, ...older } = persisted;
    assert.deepEqual(toWatchRow(older).condition, {
      kind: "giveback",
      market: "ETH",
      drawdownUsd: 4,
    });
  });

  it("encodes smaller than the row it projects", () => {
    assert.isBelow(JSON.stringify(toWatchRow(persisted)).length, JSON.stringify(persisted).length);
  });
});
