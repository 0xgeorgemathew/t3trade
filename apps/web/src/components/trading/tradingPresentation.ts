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

/**
 * A position or fill size in base units.
 *
 * Sizes reach the UI as sums of partial fills, so a clean 3 ETH order arrives as
 * 2.9999999999999996 and rendered raw it reads as a broken feed. Four decimals
 * is the finest lot size the POC's markets quote, so nothing real is lost.
 */
export const formatSize = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 4 });

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
    case "pnl_above":
      return `${watch.market} unrealised PnL reaches $${watch.valueUsd}`;
  }
}

// ---------------------------------------------------------------------------
// harness wakeup messages
// ---------------------------------------------------------------------------
//
// A resumed run's turn begins with the wakeup snapshot injected as the user
// message text (§12.4). Nothing rendered it, so a mission thread read as a wall
// of JSON blobs — one per wake, several a minute at times — with the operator's
// own messages lost between them. The card below is the one-line rendering; the
// payload stays available behind an expander, because the JSON is still the
// authoritative thing the harness was handed.

/** The one line a wakeup message is rendered as. */
export interface WakeupCard {
  /** The §11.2 run cause, humanized. */
  readonly causeLabel: string;
  /** True for the `mission_created` bootstrap, which carries no snapshot. */
  readonly bootstrap: boolean;
  /** "ETH · 3,142.50" while a snapshot is present; null on the bootstrap. */
  readonly marketLabel: string | null;
  /** "Strategy v3" once a strategy exists; null on the bootstrap. */
  readonly strategyLabel: string | null;
  /** How many coalesced inbox events the run was started with. */
  readonly pendingEventCount: number;
  /** The raw payload, pretty-printed for the expander. */
  readonly rawJson: string;
}

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Read a wakeup card out of a message's text, or `null` when the text is not a
 * wakeup at all.
 *
 * Deliberately a hand-parse rather than a schema decode: the timeline renders
 * whatever the server sent, and a wakeup that gained a field the web build does
 * not know about must still render as a card rather than falling back to raw
 * JSON. Every field is optional here; only `kind` decides.
 */
export function deriveWakeupCard(text: string): WakeupCard | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("trading-harness-wakeup")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const payload = parsed as Record<string, unknown>;
  if (payload["kind"] !== "trading-harness-wakeup") return null;

  const market = payload["marketSnapshot"];
  const marketFields =
    typeof market === "object" && market !== null ? (market as Record<string, unknown>) : null;
  const marketName = marketFields === null ? null : readString(marketFields["market"]);
  const markPrice = marketFields === null ? null : readNumber(marketFields["markPrice"]);

  const strategy = payload["activeStrategy"];
  const strategyVersion =
    typeof strategy === "object" && strategy !== null
      ? readNumber((strategy as Record<string, unknown>)["version"])
      : null;

  const pendingEvents = payload["pendingEvents"];

  return {
    causeLabel: humanizeLiteral(readString(payload["cause"]) ?? "wakeup"),
    bootstrap: payload["bootstrap"] === true,
    marketLabel:
      marketName === null
        ? null
        : markPrice === null
          ? marketName
          : `${marketName} · ${formatPrice(markPrice)}`,
    strategyLabel: strategyVersion === null ? null : `Strategy v${strategyVersion}`,
    pendingEventCount: Array.isArray(pendingEvents) ? pendingEvents.length : 0,
    rawJson: JSON.stringify(parsed, null, 2),
  };
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
   * What the market is doing right now, whether or not anything is held.
   *
   * The strip used to name a level the mission was waiting for with no way to
   * tell how far away it was — "waiting for a close below 1868" reads very
   * differently at 1869 than at 1890. Null when the exchange read failed; the
   * slot then disappears rather than showing a price nothing confirmed.
   */
  readonly markLabel: string | null;
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

/**
 * "Entry 1,833.90" — where the exposure was taken.
 *
 * The mark is not repeated here: the strip carries the live one in its own
 * slot, and two marks a few seconds apart on the same line is a contradiction
 * the operator has to stop and resolve.
 */
function describeExposure(position: { readonly entryPrice?: number | undefined }): string {
  return position.entryPrice === undefined
    ? "Position open"
    : `Entry ${formatPrice(position.entryPrice)}`;
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
  readonly marketPrice?: number | undefined;
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
  const markPrice = mission.marketPrice ?? position?.markPrice ?? null;

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
    // The live read is preferred over the position's mark: a flat mission has
    // no position mark at all, and an exposed one's is as old as its last
    // reconcile.
    markLabel: markPrice === null ? null : formatPrice(markPrice),
    detailPrimary,
    detailSecondary,
    harnessLabel: `${mission.harness.provider} · ${humanizeLiteral(mission.harness.status)}`,
    exposure,
    exposureLabel: exposed
      ? `${exposure > 0 ? "Long" : "Short"} ${formatSize(Math.abs(exposure))}`
      : "Flat",
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
// small derivations ported from the execution prototype
// ---------------------------------------------------------------------------

/**
 * How far the fill landed from the limit the order was placed at, in percent.
 *
 * Signed so that positive always means "worse than the limit": a buy that
 * filled above it, a sell that filled below it. For a `marketable_ioc` the
 * server prices the limit from BBO as a slippage bound, so this is the number
 * that says how much of that bound the fill actually spent.
 *
 * Null when the fill cannot be attributed to a known intent — a fill whose
 * cloid does not match the execution on screen has no limit to compare against,
 * and inventing one would put a fabricated figure on a receipt.
 */
export function deriveFillSlippagePercent(
  fill: {
    readonly side: "buy" | "sell";
    readonly avgFillPrice: number;
    readonly cloid?: string | undefined;
  },
  intent: { readonly cloid: string; readonly limitPrice: number } | null,
): number | null {
  if (intent === null || fill.cloid === undefined || fill.cloid !== intent.cloid) return null;
  if (!(intent.limitPrice > 0)) return null;

  const delta =
    fill.side === "buy"
      ? fill.avgFillPrice - intent.limitPrice
      : intent.limitPrice - fill.avgFillPrice;
  return (delta / intent.limitPrice) * 100;
}

/**
 * The leverage a position is actually running at: notional over margin.
 *
 * Derived rather than read back, because the projection carries no leverage
 * field — the exchange's own position row does, but nothing decodes it. Notional
 * ÷ margin is the figure the exchange itself charges margin on, so it matches
 * what Hyperliquid shows next to the market for an isolated position.
 *
 * Null when there is nothing to divide: a flat position, or a snapshot that
 * arrived with no margin or no price to value the size at. A fabricated "1x"
 * would read as a real, deliberately conservative setting.
 */
export function deriveEffectiveLeverage(position: {
  readonly size: number;
  readonly entryPrice?: number | undefined;
  readonly markPrice?: number | undefined;
  readonly marginUsed: number;
}): number | null {
  const price = position.markPrice ?? position.entryPrice ?? null;
  if (price === null || !(price > 0)) return null;
  if (!(position.marginUsed > 0)) return null;
  if (position.size === 0) return null;

  return (Math.abs(position.size) * price) / position.marginUsed;
}

/**
 * "20x" / "3.5x".
 *
 * Whole numbers stay whole — leverage is usually set as one — and anything else
 * keeps a single decimal, which is as fine as the figure is meaningful.
 */
export function formatLeverage(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}x` : `${rounded.toFixed(1)}x`;
}

/** "+0.12%" / "-0.04%". Two decimals: basis points are the scale that matters. */
export function formatSignedPercent(value: number): string {
  const magnitude = Math.abs(value).toFixed(2);
  if (value > 0) return `+${magnitude}%`;
  if (value < 0) return `-${magnitude}%`;
  return "0.00%";
}

/** The figures a paused mission still has at risk while it is not trading. */
export interface PausedExposure {
  readonly exposureLabel: string;
  readonly unrealisedUsd: number;
  readonly liquidationLabel: string;
}

/**
 * What pausing did not stop.
 *
 * The paused card explains that the stop stays live; the numbers underneath it
 * are what that stop is protecting. Null when the mission holds nothing, which
 * is the case where the sentence alone is the whole story.
 */
export function derivePausedExposure(
  position: {
    readonly size: number;
    readonly unrealisedPnl: number;
    readonly liquidationPrice?: number | undefined;
  } | null,
): PausedExposure | null {
  if (position === null || position.size === 0) return null;

  return {
    exposureLabel: `${position.size > 0 ? "Long" : "Short"} ${formatSize(Math.abs(position.size))}`,
    unrealisedUsd: position.unrealisedPnl,
    liquidationLabel:
      position.liquidationPrice === undefined ? "—" : formatPrice(position.liquidationPrice),
  };
}

/**
 * Where to see this mission on the exchange itself.
 *
 * The network comes from the account id, the same signal `describeTradingAccount`
 * reads, so a testnet mission never links at the mainnet book. An account id
 * that names neither gets no link at all — a wrong venue is worse than none.
 */
export function hyperliquidTradeUrl(market: string, tradingAccountId: string): string | null {
  const normalized = tradingAccountId.toLowerCase();
  const host = normalized.includes("testnet")
    ? "https://app.hyperliquid-testnet.xyz"
    : normalized.includes("mainnet")
      ? "https://app.hyperliquid.xyz"
      : null;
  return host === null ? null : `${host}/trade/${market}`;
}

/** One step of the mission-phase breadcrumb. */
export interface MissionPhase {
  readonly label: string;
  readonly state: "done" | "current" | "pending";
}

/** The §11.1 active loop, in the order a mission walks it. */
const LOOP_PHASES: ReadonlyArray<{
  readonly label: string;
  readonly status: TradingMissionStatus;
}> = [
  { label: "Analyse", status: "analysing" },
  { label: "Wait", status: "waiting" },
  { label: "Execute", status: "executing" },
  { label: "Position", status: "position_open" },
];

/**
 * The mission's progress through the §11.1 loop.
 *
 * Empty for every status outside the loop. A paused, blocked, or revoked
 * mission is not somewhere on this path — it has stepped off it — and a
 * breadcrumb that guessed at a position would be the surface contradicting the
 * status the strip is showing right next to it.
 */
export function deriveMissionPhases(status: TradingMissionStatus): ReadonlyArray<MissionPhase> {
  if (status === "completed") {
    return LOOP_PHASES.map((phase) => ({ label: phase.label, state: "done" as const }));
  }

  // `initializing` is before the first step rather than on it: the mission
  // exists and has walked nothing yet.
  if (status === "initializing") {
    return LOOP_PHASES.map((phase) => ({ label: phase.label, state: "pending" as const }));
  }

  const current = LOOP_PHASES.findIndex((phase) => phase.status === status);
  if (current === -1) return [];

  return LOOP_PHASES.map((phase, index) => ({
    label: phase.label,
    state: index < current ? ("done" as const) : index === current ? "current" : "pending",
  }));
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

/**
 * The staleness banner's own text, or null when nothing is stale.
 *
 * "Position data is stale" alone left the operator with no way to tell a read
 * that is a second late from one that stopped four minutes ago — and those are
 * very different situations to be holding a position through. The age is the
 * whole point of the banner, so it goes in the sentence.
 */
export function describeStaleness(
  mission: {
    readonly status: TradingMissionStatus;
    readonly position: { readonly size: number; readonly observedAt: string } | null;
  },
  nowMs: number,
): string | null {
  if (!isPositionDataStale(mission, nowMs)) return null;

  const observedAt =
    mission.position === null ? Number.NaN : Date.parse(mission.position.observedAt);
  const age = Number.isNaN(observedAt) ? null : formatDuration(nowMs - observedAt);
  const lastUpdate = age === null ? "" : ` Last update ${age} ago.`;
  return `Position data is stale. Order placement is suspended until a fresh read lands.${lastUpdate}`;
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
