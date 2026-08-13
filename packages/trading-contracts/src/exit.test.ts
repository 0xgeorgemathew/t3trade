/**
 * Canonical exit sizing — step 5 of the viability plan.
 *
 * Every case here is one the old hand-built exit intent could get wrong: the
 * side, the size, and what a partial reduce leaves behind.
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { resolveExitSize, TradingReducePositionInput, type ExitSizingInput } from "./exit.ts";

const base = (overrides: Partial<ExitSizingInput> = {}): ExitSizingInput => ({
  positionSize: 0.5,
  markPrice: 2_000,
  szDecimals: 4,
  minimumNotionalUsd: 10,
  closeWholePosition: false,
  ...overrides,
});

describe("resolveExitSize", () => {
  it("closes a long by selling all of it, and a short by buying all of it", () => {
    const long = resolveExitSize(base({ closeWholePosition: true }));
    assert.deepStrictEqual(long, {
      refusal: null,
      size: 0.5,
      side: "sell",
      remainingSize: 0,
      promotedToClose: false,
      note: null,
    });

    const short = resolveExitSize(base({ positionSize: -0.5, closeWholePosition: true }));
    assert.strictEqual(short.refusal, null);
    assert.strictEqual(short.refusal === null ? short.side : null, "buy");
  });

  it("takes a fraction off and reports what is left, signed", () => {
    const half = resolveExitSize(base({ requestedFraction: 0.5 }));
    assert.strictEqual(half.refusal, null);
    if (half.refusal !== null) return;
    assert.strictEqual(half.size, 0.25);
    assert.strictEqual(half.remainingSize, 0.25);

    const shortHalf = resolveExitSize(base({ positionSize: -0.5, requestedFraction: 0.5 }));
    assert.strictEqual(shortHalf.refusal, null);
    if (shortHalf.refusal !== null) return;
    // A short that is half closed still holds a short.
    assert.strictEqual(shortHalf.remainingSize, -0.25);
    assert.strictEqual(shortHalf.side, "buy");
  });

  it("never reduces by more than is held", () => {
    const oversized = resolveExitSize(base({ requestedSize: 5 }));
    assert.strictEqual(oversized.refusal, null);
    if (oversized.refusal !== null) return;
    assert.strictEqual(oversized.size, 0.5);
    assert.strictEqual(oversized.remainingSize, 0);
    // Reducing by more than exists cannot cross through flat into a reversal.
    assert.include(oversized.note ?? "", "clamped");
  });

  it("closes the rest rather than leaving dust behind", () => {
    // 0.4970 off a 0.5 position leaves 0.003 — $6 at 2,000, under the $10 the
    // exchange will take. Left there it is a position the mission cannot exit
    // in a normal order, so the whole thing goes.
    const promoted = resolveExitSize(base({ requestedSize: 0.497 }));
    assert.strictEqual(promoted.refusal, null);
    if (promoted.refusal !== null) return;
    assert.strictEqual(promoted.size, 0.5);
    assert.strictEqual(promoted.promotedToClose, true);
    assert.strictEqual(promoted.remainingSize, 0);
    assert.include(promoted.note ?? "", "exchange minimum");
  });

  it("leaves a remainder alone when it is worth keeping", () => {
    const kept = resolveExitSize(base({ requestedSize: 0.4 }));
    assert.strictEqual(kept.refusal, null);
    if (kept.refusal !== null) return;
    assert.strictEqual(kept.promotedToClose, false);
    assert.strictEqual(kept.remainingSize, 0.1);
  });

  it("truncates to exchange precision rather than rounding up", () => {
    const truncated = resolveExitSize(base({ szDecimals: 2, requestedSize: 0.12999 }));
    assert.strictEqual(truncated.refusal, null);
    if (truncated.refusal !== null) return;
    assert.strictEqual(truncated.size, 0.12);
  });

  it("refuses when there is nothing held, nothing named, or nothing left after rounding", () => {
    assert.strictEqual(resolveExitSize(base({ positionSize: 0 })).refusal, "no_position");
    assert.strictEqual(
      resolveExitSize(base({ positionSize: 0, closeWholePosition: true })).refusal,
      "no_position",
    );
    assert.strictEqual(resolveExitSize(base()).refusal, "no_size_named");
    assert.strictEqual(
      resolveExitSize(base({ szDecimals: 2, requestedSize: 0.001 })).refusal,
      "size_rounds_to_zero",
    );
  });
});

describe("TradingReducePositionInput", () => {
  it("requires exactly one reduction size", () => {
    const decode = Schema.decodeUnknownSync(TradingReducePositionInput);
    assert.throws(() => decode({}));
    assert.throws(() => decode({ sizeEth: 0.1, fraction: 0.5 }));
    assert.doesNotThrow(() => decode({ fraction: 0.5 }));
  });
});
