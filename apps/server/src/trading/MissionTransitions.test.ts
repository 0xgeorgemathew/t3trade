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
  // Active loop. `analysing → waiting` has two actors since plan 29 step 4.4
  // (publishing a plan, and arming a watch while one exists) — one edge.
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

/**
 * The §11.1 table transcribed exactly as published, including the spec's own
 * `suspend` / `end` shorthand. This is a transcription, not a derivation: it
 * must be edited only when the published table changes.
 */
const SUSPEND = ["paused", "agent_unavailable", "blocked"] as const;
const END = ["revoked", "completed"] as const;

const PUBLISHED_TABLE: Readonly<Record<TradingMissionStatus, readonly TradingMissionStatus[]>> = {
  initializing: ["analysing", ...SUSPEND, ...END],
  analysing: ["waiting", ...SUSPEND, ...END],
  waiting: ["analysing", "executing", ...SUSPEND, ...END],
  executing: ["position_open", "waiting", ...SUSPEND, ...END],
  position_open: ["waiting", "analysing", "executing", ...SUSPEND, ...END],
  paused: ["analysing", ...SUSPEND, ...END],
  agent_unavailable: ["analysing", ...SUSPEND, ...END],
  blocked: ["analysing", ...SUSPEND, ...END],
  revoked: [],
  completed: [],
};

const sorted = (statuses: readonly TradingMissionStatus[]): readonly TradingMissionStatus[] =>
  [...statuses].sort();

describe("published §11.1 transition table", () => {
  it("lists exactly the ten published statuses", () => {
    assert.deepStrictEqual(
      sorted(ALL_MISSION_STATUSES),
      sorted(Object.keys(PUBLISHED_TABLE) as TradingMissionStatus[]),
    );
  });

  it("implements the published table verbatim", () => {
    for (const from of ALL_MISSION_STATUSES) {
      // "No self-transitions" applies to the shorthand too: a suspended status
      // is not among its own `suspend` targets.
      const published = PUBLISHED_TABLE[from].filter((to) => to !== from);
      assert.deepStrictEqual(
        sorted(allowedTransitions(from)),
        sorted(published),
        `allowed transitions out of ${from}`,
      );
    }
  });

  it("requires blockedReason exactly when entering blocked", () => {
    for (const from of ALL_MISSION_STATUSES) {
      for (const to of allowedTransitions(from)) {
        const withoutReason = validateTransition({ from, to });
        const withReason = validateTransition({
          from,
          to,
          blockedReason: "protection_failure",
        });
        if (to === "blocked") {
          assert.deepStrictEqual(
            withoutReason,
            { reason: "blocked_reason_required" },
            `${from} -> blocked`,
          );
          assert.equal(withReason, undefined, `${from} -> blocked with reason`);
        } else {
          assert.equal(withoutReason, undefined, `${from} -> ${to}`);
          assert.deepStrictEqual(
            withReason,
            { reason: "blocked_reason_not_allowed" },
            `${from} -> ${to} with reason`,
          );
        }
      }
    }
  });
});

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
