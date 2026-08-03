import type { MarketWatch, PersistedWatch, TradingMissionStatus } from "@t3tools/trading-contracts";

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

/**
 * A signed dollar figure, so a P&L reads as a direction and not just a number.
 * Cents are kept: a result of "+$0" for eighty cents would be a lie.
 */
export const formatSignedUsd = (value: number): string => {
  const magnitude = Math.abs(value).toFixed(2);
  if (value > 0) return `+$${magnitude}`;
  if (value < 0) return `-$${magnitude}`;
  return "$0.00";
};

/**
 * A market price as the exchange quotes it.
 *
 * Precision varies by market — ETH trades to the cent, BTC to the dollar — so
 * this keeps whatever the projection carried up to two decimals rather than
 * padding every price to a fixed width it does not have.
 */
export const formatPrice = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });

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
  /** The market the mission trades, as the exchange names it. */
  readonly marketLabel: string;
  /**
   * What the mission is holding, or what it is waiting for. Exposure reads back
   * the fill; a flat mission reads back its armed watch, because the watch is
   * the only thing that can move it — a flat mission with no active watch is
   * saying something worth reading.
   */
  readonly detailPrimary: string;
  /** Live P&L and protection while exposed; null when there is nothing held. */
  readonly detailSecondary: string | null;
  /** The immutable §10.2 harness binding: which provider owns this mission. */
  readonly harnessLabel: string;
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

/**
 * What a flat mission is waiting on.
 *
 * Only `active` watches can still fire; a triggered or superseded one is
 * history. With none of them the mission is deaf — it holds authority but
 * nothing will wake it — and the strip says so rather than leaving the slot
 * blank, because a blank slot reads as "fine".
 */
function describeArmedWatch(watches: ReadonlyArray<PersistedWatch>): string {
  const active = watches.find((watch) => watch.status === "active");
  return active === undefined ? "No active watch" : `Waiting on ${describeWatch(active.watch)}`;
}

/** "Entry 1,833.90 · Mark 1,859.50", dropping whichever price is absent. */
function describeExposure(position: {
  readonly entryPrice?: number | undefined;
  readonly markPrice?: number | undefined;
}): string {
  const parts: string[] = [];
  if (position.entryPrice !== undefined) parts.push(`Entry ${formatPrice(position.entryPrice)}`);
  if (position.markPrice !== undefined) parts.push(`Mark ${formatPrice(position.markPrice)}`);
  return parts.length === 0 ? "Position open" : parts.join(" · ");
}

/**
 * How much of the position a stop actually covers (§16.1).
 *
 * The difference between a bounded loss and an open-ended one, so the strip
 * names it rather than leaving "there is a stop somewhere" to be assumed.
 */
function describeProtection(position: {
  readonly size: number;
  readonly protectedSize: number;
}): string {
  const covered = Math.abs(position.protectedSize);
  if (covered === 0) return "Unprotected";
  return covered >= Math.abs(position.size) ? "Protected" : "Partially protected";
}

export function deriveMissionStrip(mission: {
  readonly status: TradingMissionStatus;
  readonly market: string;
  readonly blockedReason: string | null;
  readonly harness: { readonly provider: string; readonly status: string };
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly markPrice?: number | undefined;
    readonly unrealisedPnl: number;
    readonly protectedSize: number;
  } | null;
  readonly authority: { readonly maximumCumulativeLossUsd: number };
}): MissionStrip {
  const position = mission.position;
  const exposure = position?.size ?? 0;
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

  // A blocked mission's reason outranks everything else the slot could say:
  // it is the one fact that explains why nothing is happening.
  const detailPrimary =
    mission.blockedReason !== null
      ? humanizeLiteral(mission.blockedReason)
      : exposed && position !== null
        ? describeExposure(position)
        : describeArmedWatch(mission.watches);

  const detailSecondary =
    exposed && position !== null
      ? `Unrealised ${formatSignedUsd(position.unrealisedPnl)} · ${describeProtection(position)}`
      : null;

  return {
    tone,
    stateLabel: MISSION_STATUS_LABELS[mission.status],
    marketLabel: mission.market,
    detailPrimary,
    detailSecondary,
    harnessLabel: `${mission.harness.provider} · ${humanizeLiteral(mission.harness.status)}`,
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

// ---------------------------------------------------------------------------
// composer controls
// ---------------------------------------------------------------------------
//
// The three pills the composer carries in a mission-bound thread. Each is read
// back from the mission, never chosen here: the mandate is the authority the
// user granted (§10.4) and entries are governed by the mission's control block
// (§11.1), so a pill that let either be edited from the composer would be
// showing a value the server would not honour.

/**
 * The venue and network a mission trades on.
 *
 * Read from the account id, which is the only network signal the projection
 * carries. An id that does not name its network is shown verbatim rather than
 * assumed to be mainnet — guessing wrong here is the expensive direction.
 */
export function describeTradingAccount(tradingAccountId: string): string {
  const normalized = tradingAccountId.toLowerCase();
  if (normalized.includes("testnet")) return "Hyperliquid · Testnet";
  if (normalized.includes("mainnet")) return "Hyperliquid · Mainnet";
  return tradingAccountId;
}

/** The mandate pill: the grant, and the most it is allowed to lose. */
export function describeMandate(authority: {
  readonly allocatedCapitalUsd: number;
  readonly maximumCumulativeLossUsd: number;
}): string {
  return `${formatUsd(authority.allocatedCapitalUsd)} · max loss ${formatUsd(
    authority.maximumCumulativeLossUsd,
  )}`;
}

/**
 * The entry-permission pill.
 *
 * The POC has no ask-before-orders mode — a mission executes within its mandate
 * or it does not execute — so this reports the control block rather than
 * offering a permission model that does not exist.
 */
export function describeEntryPermission(control: {
  readonly entriesAllowed: boolean;
  readonly reentryAllowed: boolean;
}): string {
  if (!control.entriesAllowed) return "Entries paused";
  return control.reentryAllowed ? "Entries allowed" : "Entries allowed · no re-entry";
}

/**
 * Whether order placement is suspended because the position read is stale
 * (§13's 5s account window).
 *
 * The banner is driven by the same freshness rule the execution path enforces,
 * so the user is told placement is suspended for the same reason it actually
 * is — not by a separate UI-side timer that could disagree.
 *
 * Two conditions have to hold before that claim is true, and checking only the
 * timestamp made it false in the common case. `observed_at` is refreshed by the
 * §18.2 #8 periodic reconcile, which runs *only while a position is open*: a
 * flat mission's last snapshot ages out after five seconds and never comes
 * back, so the banner latched on and stayed on. And a revoked mission keeps its
 * final position row forever, so yesterday's mission still showed a live
 * suspension warning today. Neither had anything suspended — a flat mission has
 * nothing to go stale about, and a revoked one is blocked by being revoked.
 */
export const ACCOUNT_STALE_AFTER_MILLIS = 5_000;

export function isPositionDataStale(
  mission: {
    readonly status: TradingMissionStatus;
    readonly position: { readonly size: number; readonly observedAt: string } | null;
  },
  nowMs: number,
): boolean {
  if (isMissionComplete(mission.status)) return false;

  const position = mission.position;
  if (position === null || position.size === 0) return false;

  return nowMs - Date.parse(position.observedAt) > ACCOUNT_STALE_AFTER_MILLIS;
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

/**
 * The missions worth a card in the workspace.
 *
 * Every mission ever created stays in the projection, and since a thread now
 * opens one and settling it revokes one, that is a growing wall of Revoked
 * cards — each with no controls, because a mission with no authority has
 * nothing left to press. The live missions are the work. The most recent
 * finished one is kept because it is where a mission that just ended reports
 * its result, and losing it the instant it ends would be worse than the wall.
 *
 * Input order is the projection's: newest first.
 */
export function visibleMissions<T extends { readonly status: TradingMissionStatus }>(
  missions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const live = missions.filter((mission) => !isMissionComplete(mission.status));
  const lastFinished = missions.find((mission) => isMissionComplete(mission.status));
  return lastFinished === undefined ? live : [...live, lastFinished];
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

// -- new-mission form (development only) -------------------------------------
//
// The POC has no mission-creation surface: Privy owns account onboarding and
// arrives in PROMPT-06, and nothing before it dispatches `trading.mission.create`.
// Until then the workspace offers a seeding form so the protection and control
// paths can be exercised end-to-end by hand. The two derivations below are here
// rather than in the component so they can be tested without rendering.

/**
 * Whether a mission still holds its thread and the user's one active slot.
 *
 * `revoked` and `completed` are terminal: the server's create guard looks only
 * for a mission outside those two, so a thread whose only mission is terminal
 * is free again. Treating a revoked mission as still binding its thread would
 * burn a thread permanently on every run — and since a mission thread is
 * usually archived afterwards, the picker would empty out entirely.
 */
export function isLiveMission(status: string): boolean {
  return status !== "revoked" && status !== "completed";
}

/** A thread a new mission could bind to. */
export interface MissionThreadOption {
  readonly threadId: string;
  readonly title: string;
}

/**
 * The threads that can take a new mission.
 *
 * §10.2 freezes one active mission onto one thread, so a thread that already
 * carries a live mission is not offered — picking it would only produce a
 * `TradingMissionAlreadyActiveError` at the reactor.
 */
export function selectableMissionThreads(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly archivedAt: string | null;
  }>,
  boundThreadIds: ReadonlySet<string>,
): ReadonlyArray<MissionThreadOption> {
  const free = threads.filter(
    (thread) => thread.archivedAt === null && !boundThreadIds.has(thread.id),
  );

  // Providers title threads themselves, so several can read "Greeting". Binding
  // a mission to the wrong one of those is silent — the panel simply appears on
  // a thread you are not looking at — so repeated titles carry an id suffix.
  const timesSeen = new Map<string, number>();
  for (const thread of free) {
    timesSeen.set(thread.title, (timesSeen.get(thread.title) ?? 0) + 1);
  }

  return free.map((thread) => ({
    threadId: thread.id,
    title:
      (timesSeen.get(thread.title) ?? 0) > 1
        ? `${thread.title} (${thread.id.slice(0, 8)})`
        : thread.title,
  }));
}

/** Why a new-mission form cannot be submitted yet, or null when it can. */
export function newMissionBlocker(input: {
  readonly threadId: string | null;
  readonly instruction: string;
  /**
   * The typed grant, or `null` for "resolve it from the account balance at
   * creation" — an empty field is a valid submission, not a missing one.
   */
  readonly allocatedCapitalUsd: number | null;
  readonly tradingAccountId: string;
  /** A mission already exists in a status other than revoked/completed. */
  readonly hasActiveMission: boolean;
}): string | null {
  // The domain holds one active mission per user, so a second create fails on a
  // uniqueness constraint. Saying so beats surfacing the raw SQL error.
  if (input.hasActiveMission)
    return "A mission is already active. Revoke it before starting another.";
  if (input.threadId === null) return "Pick a thread to bind the mission to.";
  if (input.instruction.trim().length === 0)
    return "Write the instruction the harness will act on.";
  if (input.allocatedCapitalUsd !== null && !(input.allocatedCapitalUsd > 0))
    return "Allocated capital must be greater than zero, or empty to use the account balance.";
  if (input.tradingAccountId.trim().length === 0) return "Name the trading account.";
  return null;
}
