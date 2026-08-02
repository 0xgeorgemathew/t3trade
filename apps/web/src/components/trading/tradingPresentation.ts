import type { MarketWatch, TradingMissionStatus } from "@t3tools/trading-contracts";

/** The ten §11.1 statuses, as the workspace names them. */
export const MISSION_STATUS_LABELS: Record<TradingMissionStatus, string> = {
  initializing: "Initializing",
  analysing: "Analysing",
  waiting: "Waiting",
  executing: "Executing",
  position_open: "Position open",
  paused: "Paused",
  agent_unavailable: "Agent unavailable",
  blocked: "Blocked",
  revoked: "Revoked",
  completed: "Completed",
};

export const formatUsd = (value: number): string =>
  value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

/** Turn an underscored domain literal into prose without inventing wording. */
export const humanizeLiteral = (value: string): string => value.replaceAll("_", " ");

/**
 * One line describing what a watch is waiting for.
 *
 * Watches are deterministic predicates (§11.3), so this reads the predicate
 * back rather than summarizing or interpreting it.
 */
export function describeWatch(watch: MarketWatch): string {
  switch (watch.type) {
    case "price_cross":
      return `${watch.market} ${watch.priceSource} crosses ${watch.direction} ${watch.price}`;
    case "candle_close":
      return `${watch.market} ${watch.interval} candle closes ${watch.direction} ${watch.price}`;
    case "order_update":
      return `Order ${watch.cloid} updates`;
    case "position_update":
      return `${watch.market} position updates`;
    case "scheduled_reassessment":
      return `Scheduled reassessment at ${new Date(watch.runAt).toISOString()}`;
  }
}

// ---------------------------------------------------------------------------
// §14.7 risk chrome
// ---------------------------------------------------------------------------
//
// Every surface below is DERIVED from the mission projection. None of them
// hold state of their own, and none of them can show something the projection
// does not say — which is what makes "renders from projections in its driving
// state" checkable rather than aspirational.

/** Statuses in which a mission is armed or exposed and the strip must show. */
const ARMED_OR_EXPOSED: ReadonlySet<TradingMissionStatus> = new Set<TradingMissionStatus>([
  "executing",
  "position_open",
  "waiting",
  "analysing",
  "paused",
  "blocked",
]);

/** The strip's state dot, matched to how urgent the mission's state is. */
export type MissionStripTone = "exposed" | "armed" | "paused" | "blocked";

/** The persistent mission strip (§14.7 risk chrome). */
export interface MissionStrip {
  readonly tone: MissionStripTone;
  readonly stateLabel: string;
  /** Signed exposure in base units; zero when flat. */
  readonly exposure: number;
  readonly exposureLabel: string;
  /**
   * The most the mission can still lose: the authority's cumulative-loss
   * ceiling. The strip shows the ceiling rather than a live remaining figure
   * because the projection carries the ceiling, and a number the projection
   * cannot back would be a guess.
   */
  readonly maximumLossLabel: string;
  /**
   * The one primary action. Close-and-stop is always one click while exposed
   * (§14.7); with no exposure there is nothing to close, so the primary action
   * becomes the one that stops new exposure.
   */
  readonly primaryAction: "close_and_revoke" | "pause" | "resume";
  readonly primaryActionLabel: string;
}

/** True when the strip must be on screen at all (§14.7: armed or exposed). */
export function shouldShowMissionStrip(mission: {
  readonly status: TradingMissionStatus;
  readonly position: { readonly size: number } | null;
}): boolean {
  const exposed = (mission.position?.size ?? 0) !== 0;
  return exposed || ARMED_OR_EXPOSED.has(mission.status);
}

export function deriveMissionStrip(mission: {
  readonly status: TradingMissionStatus;
  readonly position: { readonly size: number } | null;
  readonly authority: { readonly maximumCumulativeLossUsd: number };
}): MissionStrip {
  const exposure = mission.position?.size ?? 0;
  const exposed = exposure !== 0;

  const tone: MissionStripTone =
    mission.status === "blocked"
      ? "blocked"
      : mission.status === "paused"
        ? "paused"
        : exposed
          ? "exposed"
          : "armed";

  // While exposed, the primary action is always the way out — one click, no
  // menu. It stays primary even when the mission is blocked or paused: those
  // states stop new exposure, they do not remove the exposure already taken.
  const primaryAction = exposed
    ? ("close_and_revoke" as const)
    : mission.status === "paused"
      ? ("resume" as const)
      : ("pause" as const);

  return {
    tone,
    stateLabel: MISSION_STATUS_LABELS[mission.status],
    exposure,
    exposureLabel: exposed ? `${exposure > 0 ? "Long" : "Short"} ${Math.abs(exposure)}` : "Flat",
    maximumLossLabel: formatUsd(mission.authority.maximumCumulativeLossUsd),
    primaryAction,
    primaryActionLabel:
      primaryAction === "close_and_revoke"
        ? "Close and stop"
        : primaryAction === "resume"
          ? "Resume"
          : "Pause",
  };
}

/**
 * Whether order placement is suspended because the position read is stale
 * (§13's 5s account window).
 *
 * The banner is driven by the same freshness rule the execution path enforces,
 * so the user is told placement is suspended for the same reason it actually
 * is — not by a separate UI-side timer that could disagree.
 */
export const ACCOUNT_STALE_AFTER_MILLIS = 5_000;

export function isPositionDataStale(
  mission: { readonly position: { readonly observedAt: string } | null },
  nowMs: number,
): boolean {
  const observedAt = mission.position?.observedAt;
  if (observedAt === undefined) return false;
  return nowMs - Date.parse(observedAt) > ACCOUNT_STALE_AFTER_MILLIS;
}

/** The order-rejected surface, when the latest execution was refused. */
export interface RejectedOrderNotice {
  readonly actionType: string;
  readonly side: string;
  readonly size: number;
  /** True when re-arming is possible: the mission is not blocked or revoked. */
  readonly canReArm: boolean;
}

export function deriveRejectedOrder(mission: {
  readonly status: TradingMissionStatus;
  readonly inFlightExecution: {
    readonly status: string;
    readonly actionType: string;
    readonly side: string;
    readonly size: number;
  } | null;
}): RejectedOrderNotice | null {
  const execution = mission.inFlightExecution;
  if (execution === null) return null;
  if (execution.status !== "rejected" && execution.status !== "failed") return null;

  return {
    actionType: execution.actionType,
    side: execution.side,
    size: execution.size,
    // Re-arming a blocked mission would route around §16.4's no-auto-resume
    // rule, and a revoked one has no authority left to re-arm.
    canReArm: mission.status !== "blocked" && mission.status !== "revoked",
  };
}

/** The completion summary card (§14.7 risk chrome). */
export interface CompletionSummary {
  readonly realizedPnlUsd: number;
  readonly feesPaidUsd: number;
  /** Realised result net of the fees already paid (§16.2). */
  readonly netResultUsd: number;
  readonly fillCount: number;
  /** Traded duration in millis, first fill to last. Null with fewer than two. */
  readonly tradedDurationMillis: number | null;
  /** The loss the strategy planned to risk, when one was published. */
  readonly plannedLossUsd: number | null;
  /**
   * How the realised result compares to the plan. Null when nothing was
   * planned — an unpublished strategy has no plan to deviate from.
   */
  readonly deviationFromPlanUsd: number | null;
}

/** True when the mission has finished and the summary card should show. */
export function isMissionComplete(status: TradingMissionStatus): boolean {
  return status === "completed" || status === "revoked";
}

export function deriveCompletionSummary(mission: {
  readonly result: {
    readonly realizedPnlUsd: number;
    readonly feesPaidUsd: number;
    readonly fillCount: number;
    readonly firstFillAt: string | null;
    readonly lastFillAt: string | null;
  };
  readonly strategy: {
    readonly protection: { readonly maximumPlannedLossUsd?: number | undefined };
  } | null;
}): CompletionSummary {
  const { result } = mission;
  // §16.2: paid fees live in the realised result and must not be counted
  // twice. They are shown separately AND netted once, never netted twice.
  const netResultUsd = result.realizedPnlUsd - result.feesPaidUsd;

  const tradedDurationMillis =
    result.firstFillAt === null || result.lastFillAt === null || result.fillCount < 2
      ? null
      : Date.parse(result.lastFillAt) - Date.parse(result.firstFillAt);

  const plannedLossUsd = mission.strategy?.protection.maximumPlannedLossUsd ?? null;

  return {
    realizedPnlUsd: result.realizedPnlUsd,
    feesPaidUsd: result.feesPaidUsd,
    netResultUsd,
    fillCount: result.fillCount,
    tradedDurationMillis,
    plannedLossUsd,
    // Positive means the mission did better than the loss it planned to risk.
    deviationFromPlanUsd: plannedLossUsd === null ? null : netResultUsd + plannedLossUsd,
  };
}

/** "2m 30s" from a duration in millis. */
export function formatDuration(millis: number): string {
  const totalSeconds = Math.max(0, Math.round(millis / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
