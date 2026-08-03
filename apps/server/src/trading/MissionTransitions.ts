/**
 * Mission state machine - spec §11.1.
 *
 * §11.1 publishes the complete transition table: ten statuses, no
 * self-transitions, and `blockedReason` required exactly when entering
 * `blocked`. This module is a direct encoding of that table — a harness run may
 * not invent transitions, and the deterministic authority and execution
 * services may only move a mission to `blocked` for one of the four persisted
 * reasons.
 *
 * @module MissionTransitions
 */
import type { TradingMissionBlockedReason, TradingMissionStatus } from "./Schemas.ts";

/**
 * `revoked` permanently ends mission authority; `completed` means the harness
 * declared the objective done. Neither has any outgoing transition.
 */
export const PERMANENT_TERMINAL_STATUSES = ["revoked", "completed"] as const;

/**
 * Statuses that block new discretionary exposure but still hold mission
 * authority, so they continue to occupy the user's single active-mission slot.
 * Each is left only by an explicit user, provider, or harness action.
 */
export const SUSPENDED_STATUSES = ["paused", "agent_unavailable", "blocked"] as const;

/** The active loop from §11.1. */
export const LOOP_STATUSES = [
  "initializing",
  "analysing",
  "waiting",
  "executing",
  "position_open",
] as const;

/**
 * The active loop's edges, verbatim from the §11.1 transition table.
 *
 * `MissionTransitions.test.ts` asserts this table equals the published one edge
 * for edge, so the meaning of each edge stays with the spec rather than here.
 */
const LOOP_TRANSITIONS: Readonly<
  Record<(typeof LOOP_STATUSES)[number], readonly TradingMissionStatus[]>
> = {
  initializing: ["analysing"],
  analysing: ["waiting"],
  waiting: ["analysing", "executing"],
  executing: ["position_open", "waiting"],
  position_open: ["waiting", "analysing", "executing"],
};

const isPermanentTerminal = (status: TradingMissionStatus): boolean =>
  (PERMANENT_TERMINAL_STATUSES as readonly TradingMissionStatus[]).includes(status);

const isLoop = (status: TradingMissionStatus): boolean =>
  (LOOP_STATUSES as readonly TradingMissionStatus[]).includes(status);

/**
 * A mission occupying its owner's single active-mission slot. Everything except
 * the two permanent terminals still holds authority — a paused or blocked
 * mission may still hold a position and its protective orders.
 */
export const isActiveMissionStatus = (status: TradingMissionStatus): boolean =>
  !isPermanentTerminal(status);

/**
 * A mission that is running its own loop right now — not terminal, and not
 * suspended waiting on a user, a provider, or a risk decision.
 *
 * This is the set the runtime may wake of its own accord. A paused or blocked
 * mission still holds authority and still occupies the slot, but waking it
 * would ask the harness to reassess something it has been explicitly told to
 * stop reassessing.
 */
export const isOperativeMissionStatus = (status: TradingMissionStatus): boolean => isLoop(status);

/** The statuses reachable from `from`, per §11.1. */
export const allowedTransitions = (from: TradingMissionStatus): readonly TradingMissionStatus[] => {
  if (isPermanentTerminal(from)) return [];

  // "Any active state may exit to a terminal when the user, the provider, or a
  // deterministic safety condition requires it."
  const exits: readonly TradingMissionStatus[] = [
    ...SUSPENDED_STATUSES.filter((status) => status !== from),
    ...PERMANENT_TERMINAL_STATUSES,
  ];

  if (isLoop(from)) {
    return [...LOOP_TRANSITIONS[from as (typeof LOOP_STATUSES)[number]], ...exits];
  }

  // A suspended mission resumes into a fresh harness turn: §14.6 resume
  // revalidates account, protection, authority, and provider availability
  // before the harness reassesses.
  return ["analysing", ...exits];
};

export const canTransition = (from: TradingMissionStatus, to: TradingMissionStatus): boolean =>
  allowedTransitions(from).includes(to);

export type MissionTransitionRejection =
  | { readonly reason: "illegal_transition" }
  | { readonly reason: "blocked_reason_required" }
  | { readonly reason: "blocked_reason_not_allowed" };

/**
 * Validate a transition together with its `blockedReason`.
 *
 * §11.1 requires the reason to be persisted and visible whenever a mission is
 * blocked, and it is meaningless on any other status.
 */
export const validateTransition = (input: {
  readonly from: TradingMissionStatus;
  readonly to: TradingMissionStatus;
  readonly blockedReason?: TradingMissionBlockedReason | undefined;
}): MissionTransitionRejection | undefined => {
  if (!canTransition(input.from, input.to)) return { reason: "illegal_transition" };
  if (input.to === "blocked" && input.blockedReason === undefined) {
    return { reason: "blocked_reason_required" };
  }
  if (input.to !== "blocked" && input.blockedReason !== undefined) {
    return { reason: "blocked_reason_not_allowed" };
  }
  return undefined;
};

export const ALL_MISSION_STATUSES: readonly TradingMissionStatus[] = [
  ...LOOP_STATUSES,
  ...SUSPENDED_STATUSES,
  ...PERMANENT_TERMINAL_STATUSES,
];

export { isPermanentTerminal };
