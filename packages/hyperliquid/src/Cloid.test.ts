import { describe, expect, it } from "vite-plus/test";

import { deriveCloid } from "./Cloid.ts";

describe("deriveCloid", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      missionId: "mission_1",
      executionSequence: 0,
      actionType: "open",
    };
    expect(deriveCloid(input)).toBe(deriveCloid(input));
  });

  it("returns a 0x-prefixed 34-char lowercase hex string (the Hyperliquid wire shape)", () => {
    const cloid = deriveCloid({
      missionId: "mission_1",
      executionSequence: 0,
      actionType: "open",
    });
    // 0x + 32 hex chars (16 bytes / 128 bits). The exchange validates this
    // shape; a bare 32-char hex is silently dropped (Task 4 finding).
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(cloid.length).toBe(34);
  });

  it("changes when any input changes", () => {
    const base = {
      missionId: "mission_1",
      executionSequence: 0,
      actionType: "open",
    };
    const original = deriveCloid(base);
    expect(deriveCloid({ ...base, missionId: "mission_2" })).not.toBe(original);
    expect(deriveCloid({ ...base, executionSequence: 1 })).not.toBe(original);
    expect(deriveCloid({ ...base, actionType: "scale_in" })).not.toBe(original);
  });

  it("respects field boundaries (no suffix/prefix confusion)", () => {
    // missionId "ab" + sequence 12 must not collide with "a" + "b" + 12:
    // the field separator distinguishes them.
    const a = deriveCloid({
      missionId: "ab",
      executionSequence: 12,
      actionType: "open",
    });
    const b = deriveCloid({
      missionId: "a",
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
          executionSequence: seq,
          actionType: action,
        });
        expect(seen.has(cloid)).toBe(false);
        seen.add(cloid);
      }
    }
  });
});
