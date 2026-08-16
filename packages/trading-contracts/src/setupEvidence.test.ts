/**
 * Setup evidence and watch timing — step 4 of the viability plan.
 *
 * Two questions the harness previously had to answer from prose: can this
 * entry's declared evidence actually be evaluated by the watch armed for it,
 * and does the structure read support a setup at all. Both are arithmetic here,
 * so a fixture market classifies the same way every time.
 */
import { assert, describe, it } from "@effect/vitest";

import type { MarketCandle } from "./market.ts";
import {
  analyseMarketStructure,
  analyseTimeframe,
  findCandidateSetups,
} from "./marketStructure.ts";
import { findMisarmedEntryConditions, type PersistedWatch } from "./watch.ts";

const bar = (input: {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly index: number;
}): MarketCandle => ({
  openTime: input.index * 60_000,
  closeTime: (input.index + 1) * 60_000 - 1,
  open: input.open,
  high: input.high,
  low: input.low,
  close: input.close,
  volume: 100,
  trades: 10,
});

/**
 * A market oscillating between 1,990 and 2,010, touching each boundary many
 * times and holding its height across the window. This is what "ranging"
 * looks like when it is measured rather than asserted.
 */
const rangingCandles = (): ReadonlyArray<MarketCandle> => {
  const candles: Array<MarketCandle> = [];
  for (let index = 0; index < 80; index++) {
    // A 10-bar cycle from floor to ceiling and back.
    const phase = index % 10;
    const level = phase < 5 ? 1_990 + phase * 5 : 2_010 - (phase - 5) * 5;
    candles.push(bar({ index, open: level, high: level + 0.4, low: level - 0.4, close: level }));
  }
  return candles;
};

/** The same range, then one bar that closes clear above the ceiling. */
const breakoutCandles = (options?: { readonly wickOnly?: boolean }) => {
  const candles = [...rangingCandles()];
  // Three bars of expansion so the ATR ratio and the direction score both move.
  for (let step = 1; step <= 6; step++) {
    const level = 2_005 + step * 6;
    candles.push(
      bar({ index: 80 + step, open: level - 5, high: level + 1, low: level - 6, close: level }),
    );
  }
  const last = candles[candles.length - 1]!;
  if (options?.wickOnly === true) {
    // The wick goes through; the close comes back inside.
    candles[candles.length - 1] = bar({
      index: 90,
      open: 2_000,
      high: last.high + 20,
      low: 1_998,
      close: 2_000,
    });
  }
  return candles;
};

describe("structure evidence", () => {
  it("counts boundary touches and reports the range as stable", () => {
    const frame = analyseTimeframe({ interval: "1m", candles: rangingCandles() });

    assert.isAtLeast(frame.swingHighTouches ?? 0, 2);
    assert.isAtLeast(frame.swingLowTouches ?? 0, 2);
    assert.isDefined(frame.rangeStabilityPercent);
    assert.isBelow(frame.rangeStabilityPercent!, 30);
    assert.isDefined(frame.positionInRangePercent);
  });

  it("separates a close through a level from a wick through it", () => {
    const broke = analyseTimeframe({ interval: "1m", candles: breakoutCandles() });
    assert.strictEqual(broke.breakout?.closedBeyond, true);
    assert.strictEqual(broke.breakout?.wickOnly, false);

    const wicked = analyseTimeframe({
      interval: "1m",
      candles: breakoutCandles({ wickOnly: true }),
    });
    assert.strictEqual(wicked.breakout?.closedBeyond, false);
    assert.strictEqual(wicked.breakout?.wickOnly, true);
  });

  it("scores no breakout setup from a wick alone", () => {
    const wicked = analyseTimeframe({
      interval: "1m",
      candles: breakoutCandles({ wickOnly: true }),
    });

    const setups = findCandidateSetups([wicked]);

    // This is the whole point: an executable close-confirmed setup cannot come
    // from a bar that closed back inside the range. Near-misses (plan 29
    // step 3.4) may appear, but never as scored setups.
    assert.isEmpty(
      setups.filter((setup) => setup.closeConfirmed && setup.rejectedBy === undefined),
    );
  });

  it("proposes a close-confirmed breakout, and a touch-triggered range boundary", () => {
    const broke = findCandidateSetups([
      analyseTimeframe({ interval: "1m", candles: breakoutCandles() }),
    ]);
    // Found by kind, not by rank: the field now holds the indicator
    // strategies too, and which of several up-candidates scores highest is a
    // tournament question, not this test's claim.
    const breakout = broke.find((setup) =>
      ["momentum_breakout", "opening_range_break"].includes(setup.kind),
    );
    assert.isDefined(breakout);
    assert.strictEqual(breakout!.direction, "up");
    assert.strictEqual(breakout!.closeConfirmed, true);

    // A ranging window with the mark parked on the floor is the range entry.
    const ranging = rangingCandles();
    const atTheFloor = [
      ...ranging,
      bar({ index: 80, open: 1_990, high: 1_990.4, low: 1_989.6, close: 1_990 }),
    ];
    const range = findCandidateSetups([
      analyseTimeframe({ interval: "1m", candles: atTheFloor }),
    ]).filter((setup) => setup.kind === "range_reversion");

    assert.isNotEmpty(range);
    assert.strictEqual(range[0]?.direction, "up");
    assert.strictEqual(range[0]?.closeConfirmed, false);
  });

  it("offers the EMA cross as its own candidate on a fresh cross", () => {
    // A slow drift down, then a clean leg up: the fast EMA crosses the slow
    // one from below and price closes above both.
    const candles: Array<MarketCandle> = [];
    for (let index = 0; index < 60; index++) {
      const level = 2_030 - index * 0.5;
      candles.push(
        bar({ index, open: level + 0.5, high: level + 0.7, low: level - 0.3, close: level }),
      );
    }
    for (let step = 1; step <= 5; step++) {
      const level = 2_000.5 + step * 3;
      candles.push(
        bar({
          index: 59 + step,
          open: level - 3,
          high: level + 0.5,
          low: level - 3.5,
          close: level,
        }),
      );
    }

    const frame = analyseTimeframe({ interval: "1m", candles });
    assert.isDefined(frame.ema);
    assert.isAbove(frame.ema!.spreadUsd, 0);

    // Plan 29 step 7.6: the cross is a reading, not a scored candidate. The
    // frame carries the bias, how separated the averages are in ATRs, and how
    // old the flip is; nothing turns those three into a verdict any more.
    assert.strictEqual(frame.ema!.direction, "up");
    assert.isAbove(frame.ema!.separationAtr, 0);
    assert.isDefined(frame.ema!.barsSinceCross);
    assert.isUndefined(
      findCandidateSetups([frame]).find((setup) => setup.rationale.includes("EMA")),
    );
  });

  it("does not fade an RSI extreme the market is still driving into", () => {
    // The breakout window is overbought by construction, and its recent
    // direction score points straight into the band.
    const frame = analyseTimeframe({ interval: "1m", candles: breakoutCandles() });
    assert.strictEqual(frame.rsi?.condition, "overbought");

    const setups = findCandidateSetups([frame]);
    // The veto still holds: no SCORED reversion. What the frame contributes
    // instead is the near-miss that names the veto and its conviction (plan
    // 29 step 3.4) — context, never a candidate.
    assert.isEmpty(
      setups.filter((setup) => setup.kind === "rsi_reversion" && setup.rejectedBy === undefined),
    );
    const nearMiss = setups.find((setup) => setup.kind === "rsi_reversion");
    assert.isDefined(nearMiss?.rejectedBy);
    assert.include(
      nearMiss!.rejectedBy!.map(({ gate }) => gate),
      "trending_into_band",
    );
  });

  it("says nothing at all about a window too short to measure", () => {
    const structure = analyseMarketStructure({
      market: "ETH",
      measuredAt: 1_000,
      frames: [{ interval: "1m", candles: rangingCandles().slice(0, 10) }],
    });

    assert.strictEqual(structure.timeframes[0]?.sufficientData, false);
    assert.isEmpty(structure.setups);
  });
});

const watchAt = (input: {
  readonly type: "price_cross" | "candle_close";
  readonly price: number;
}): PersistedWatch => ({
  id: `watch_${input.type}_${input.price}`,
  missionId: "mission_1",
  status: "active",
  createdAt: 1_000,
  updatedAt: 1_000,
  watch:
    input.type === "price_cross"
      ? {
          type: "price_cross",
          market: "ETH",
          priceSource: "mark",
          direction: "above",
          price: input.price,
        }
      : {
          type: "candle_close",
          market: "ETH",
          interval: "1m",
          direction: "above",
          price: input.price,
        },
});

describe("findMisarmedEntryConditions", () => {
  it("flags a close-confirmed break armed as a price cross", () => {
    const misarmed = findMisarmedEntryConditions({
      conditions: [
        { description: "1m close above 2,011", priceLevel: 2_011, confirmation: "close" },
      ],
      watches: [watchAt({ type: "price_cross", price: 2_011 })],
    });

    assert.strictEqual(misarmed.length, 1);
    assert.strictEqual(misarmed[0]?.armedAs, "price_cross");
    assert.strictEqual(misarmed[0]?.shouldBe, "candle_close");
    assert.strictEqual(misarmed[0]?.mismatch, "watch_type");
  });

  it("flags a close watch on the wrong timeframe or crossing direction", () => {
    const wrongTimeframe = findMisarmedEntryConditions({
      conditions: [
        {
          description: "5m close above 2,011",
          priceLevel: 2_011,
          confirmation: "close",
          timeframe: "5m",
          direction: "above",
        },
      ],
      watches: [watchAt({ type: "candle_close", price: 2_011 })],
    });
    assert.strictEqual(wrongTimeframe[0]?.mismatch, "timeframe");

    const belowWatch = {
      ...watchAt({ type: "candle_close", price: 2_011 }),
      watch: {
        type: "candle_close" as const,
        market: "ETH" as const,
        interval: "5m" as const,
        direction: "below" as const,
        price: 2_011,
      },
    };
    const wrongDirection = findMisarmedEntryConditions({
      conditions: [
        {
          description: "5m close above 2,011",
          priceLevel: 2_011,
          confirmation: "close",
          timeframe: "5m",
          direction: "above",
        },
      ],
      watches: [belowWatch],
    });
    assert.strictEqual(wrongDirection[0]?.mismatch, "direction");
  });

  it("flags a range touch armed as a candle close", () => {
    const misarmed = findMisarmedEntryConditions({
      conditions: [
        { description: "touch of the range floor", priceLevel: 1_990, confirmation: "touch" },
      ],
      watches: [watchAt({ type: "candle_close", price: 1_990 })],
    });

    assert.strictEqual(misarmed[0]?.shouldBe, "price_cross");
  });

  it("says nothing when the armed watch matches, or when nothing was declared", () => {
    const matched = findMisarmedEntryConditions({
      conditions: [
        { description: "1m close above 2,011", priceLevel: 2_011, confirmation: "close" },
      ],
      watches: [watchAt({ type: "candle_close", price: 2_011 })],
    });
    assert.isEmpty(matched);

    const undeclared = findMisarmedEntryConditions({
      conditions: [{ description: "price reaches 2,011", priceLevel: 2_011 }],
      watches: [watchAt({ type: "price_cross", price: 2_011 })],
    });
    assert.isEmpty(undeclared);
  });

  it("leaves an entirely unarmed condition to findUnarmedEntryConditions", () => {
    const misarmed = findMisarmedEntryConditions({
      conditions: [
        { description: "1m close above 2,011", priceLevel: 2_011, confirmation: "close" },
      ],
      watches: [],
    });

    // Nothing is armed at the level, so this is not a mismatch — it is a gap,
    // and reporting it twice would have the next turn move a watch that does
    // not exist.
    assert.isEmpty(misarmed);
  });
});
