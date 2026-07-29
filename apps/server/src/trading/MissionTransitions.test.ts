import { assert, describe, it } from "@effect/vitest";

import {
  ALL_MISSION_STATUSES,
  allowedTransitions,
  canTransition,
  isActiveMissionStatus,
  LOOP_STATUSES,
  PERMANENT_TERMINAL_STATUSES,
  SUSPENDED_STATUSES,
  validateTransition,
} from "./MissionTransitions.ts";
import type { TradingMissionStatus } from "./Schemas.ts";

/**
 * The complete legal edge set. Every pair not listed here must be rejected, so
 * this table is the assertion rather than a restatement of the implementation:
 * the tests below derive the illegal set by subtracting it from the full
 * cartesian product of §11.1 statuses.
 */
const LEGAL_EDGES: ReadonlyArray<readonly [TradingMissionStatus, TradingMissionStatus]> = [
  // Active loop
  ["initializing", "analysing"],
  ["analysing", "waiting"],
  ["waiting", "analysing"],
  ["waiting", "executing"],
  ["executing", "position_open"],
  ["executing", "waiting"],
  ["position_open", "waiting"],
  ["position_open", "analysing"],
  ["position_open", "executing"],

  // Resume out of a suspended status into a fresh harness turn
  ["paused", "analysing"],
  ["agent_unavailable", "analysing"],
  ["blocked", "analysing"],

  // Any non-permanent status may exit to a suspended status or a terminal
  ...([...LOOP_STATUSES, ...SUSPENDED_STATUSES] as readonly TradingMissionStatus[]).flatMap(
    (from) =>
      ([...SUSPENDED_STATUSES, ...PERMANENT_TERMINAL_STATUSES] as readonly TradingMissionStatus[])
        .filter((to) => to !== from)
        .map((to) => [from, to] as const),
  ),
];

const legalKeys = new Set(LEGAL_EDGES.map(([from, to]) => `${from}->${to}`));

describe("mission state machine (§11.1)", () => {
  it("covers all ten published statuses", () => {
    assert.equal(ALL_MISSION_STATUSES.length, 10);
    assert.deepStrictEqual([...ALL_MISSION_STATUSES].sort(), [
      "agent_unavailable",
      "analysing",
      "blocked",
      "completed",
      "executing",
      "initializing",
      "paused",
      "position_open",
      "revoked",
      "waiting",
    ]);
  });

  it("allows every legal transition", () => {
    for (const [from, to] of LEGAL_EDGES) {
      assert.ok(canTransition(from, to), `expected ${from} -> ${to} to be legal`);
    }
  });

  it("rejects every transition outside the legal set", () => {
    for (const from of ALL_MISSION_STATUSES) {
      for (const to of ALL_MISSION_STATUSES) {
        const expected = legalKeys.has(`${from}->${to}`);
        assert.equal(
          canTransition(from, to),
          expected,
          `${from} -> ${to} should be ${expected ? "legal" : "illegal"}`,
        );
      }
    }
  });

  it("never allows a self-transition", () => {
    for (const status of ALL_MISSION_STATUSES) {
      assert.equal(canTransition(status, status), false, `${status} -> ${status}`);
    }
  });

  it("makes revoked and completed permanent", () => {
    for (const terminal of PERMANENT_TERMINAL_STATUSES) {
      assert.deepStrictEqual(allowedTransitions(terminal), []);
    }
  });

  it("lets every non-permanent status reach a terminal", () => {
    for (const from of [...LOOP_STATUSES, ...SUSPENDED_STATUSES]) {
      assert.ok(canTransition(from, "revoked"), `${from} -> revoked`);
      assert.ok(canTransition(from, "completed"), `${from} -> completed`);
    }
  });

  it("treats everything but the permanent terminals as holding the mission slot", () => {
    for (const status of [...LOOP_STATUSES, ...SUSPENDED_STATUSES]) {
      assert.ok(isActiveMissionStatus(status), `${status} should occupy the slot`);
    }
    for (const status of PERMANENT_TERMINAL_STATUSES) {
      assert.equal(isActiveMissionStatus(status), false, `${status} should free the slot`);
    }
  });
});

describe("blockedReason validation", () => {
  it("requires a reason when moving to blocked", () => {
    assert.deepStrictEqual(validateTransition({ from: "waiting", to: "blocked" }), {
      reason: "blocked_reason_required",
    });
  });

  it("accepts each of the four published reasons", () => {
    for (const blockedReason of [
      "cumulative_loss_limit",
      "protection_failure",
      "account_unavailable",
      "reconciliation_failure",
    ] as const) {
      assert.equal(
        validateTransition({ from: "position_open", to: "blocked", blockedReason }),
        undefined,
      );
    }
  });

  it("refuses a reason on any status other than blocked", () => {
    assert.deepStrictEqual(
      validateTransition({
        from: "waiting",
        to: "paused",
        blockedReason: "cumulative_loss_limit",
      }),
      { reason: "blocked_reason_not_allowed" },
    );
  });

  it("reports an illegal transition before checking the reason", () => {
    assert.deepStrictEqual(validateTransition({ from: "completed", to: "analysing" }), {
      reason: "illegal_transition",
    });
  });
});
