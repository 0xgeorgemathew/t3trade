import { describe, expect, it } from "vite-plus/test";

import { deriveCloid } from "./Cloid.ts";

describe("deriveCloid", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      missionId: "mission_1",
      strategyVersion: 1,
      executionSequence: 0,
      actionType: "open",
    };
    expect(deriveCloid(input)).toBe(deriveCloid(input));
  });

  it("returns a bare 32-char lowercase hex string", () => {
    const cloid = deriveCloid({
      missionId: "mission_1",
      strategyVersion: 1,
      executionSequence: 0,
      actionType: "open",
    });
    expect(cloid).toMatch(/^[0-9a-f]{32}$/);
    expect(cloid.startsWith("0x")).toBe(false);
  });

  it("changes when any input changes", () => {
    const base = {
      missionId: "mission_1",
      strategyVersion: 1,
      executionSequence: 0,
      actionType: "open",
    };
    const original = deriveCloid(base);
    expect(deriveCloid({ ...base, missionId: "mission_2" })).not.toBe(original);
    expect(deriveCloid({ ...base, strategyVersion: 2 })).not.toBe(original);
    expect(deriveCloid({ ...base, executionSequence: 1 })).not.toBe(original);
    expect(deriveCloid({ ...base, actionType: "scale_in" })).not.toBe(original);
  });

  it("respects field boundaries (no suffix/prefix confusion)", () => {
    // missionId "ab" + sequence 12 must not collide with "a" + "b" + 12:
    // the field separator distinguishes them.
    const a = deriveCloid({
      missionId: "ab",
      strategyVersion: 1,
      executionSequence: 12,
      actionType: "open",
    });
    const b = deriveCloid({
      missionId: "a",
      strategyVersion: 1,
      executionSequence: 12,
      actionType: "open",
    });
    expect(a).not.toBe(b);
  });

  it("does not collide across a large batch of distinct inputs", () => {
    const seen = new Set<string>();
    for (let seq = 0; seq < 5_000; seq++) {
      for (const action of ["open", "scale_in", "reduce", "close", "cancel"]) {
        const cloid = deriveCloid({
          missionId: "mission_1",
          strategyVersion: 1,
          executionSequence: seq,
          actionType: action,
        });
        expect(seen.has(cloid)).toBe(false);
        seen.add(cloid);
      }
    }
  });
});
