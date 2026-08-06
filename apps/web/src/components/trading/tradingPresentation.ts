import type {
  MarketWatch,
  PersistedWatch,
  PersistedWatchStatus,
  TradingMissionStatus,
} from "@t3tools/trading-contracts";

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
    case "pnl_below":
      return `${watch.market} unrealised PnL falls to $${watch.valueUsd}`;
    case "pnl_giveback":
      return `${watch.market} unrealised PnL gives back $${watch.drawdownUsd} from its peak`;
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
 * Where a fill or an order sits in the life of a position.
 *
 * The mission's whole activity is this cycle — open, hold, close — and a
 * receipt that says only "sell 0.67" hides which half of it just happened. The
 * two facts that matter are the side the exposure was on and whether this took
 * it on or gave it back, and they are independent: a sell opens a short and
 * closes a long.
 */
export interface PositionLifecycle {
  /** The side of the exposure, not the side of the order. */
  readonly direction: "long" | "short";
  readonly action: "open" | "close" | "reverse";
  /** The action as a card labels it. */
  readonly actionLabel: string;
}

const exposureSide = (text: string): "long" | "short" | null => {
  if (text.includes("long")) return "long";
  if (text.includes("short")) return "short";
  return null;
};

/**
 * Read the exchange's own lifecycle label off a fill.
 *
 * Hyperliquid sends `dir` as "Open Long", "Close Short", "Long > Short", or
 * "Liquidated Isolated Long". Matching on words rather than on the exact
 * strings keeps a label the exchange words slightly differently readable — and
 * anything that carries neither "long" nor "short" (a spot "Buy", a settlement)
 * returns null rather than a guess, so the card falls back to naming the order.
 */
export function readFillLifecycle(dir: string | undefined): PositionLifecycle | null {
  if (dir === undefined) return null;
  const text = dir.toLowerCase();

  // A reversal reads "Long > Short". The side it ended on is the one the
  // mission now holds, so that is the side the card shows.
  const arrow = text.indexOf(">");
  if (arrow >= 0) {
    const direction = exposureSide(text.slice(arrow + 1));
    return direction === null ? null : { direction, action: "reverse", actionLabel: "Reverse" };
  }

  const direction = exposureSide(text);
  if (direction === null) return null;
  // A liquidation is a close the mission did not choose, and that is worth its
  // own word: every other close on the thread was a decision.
  if (text.includes("liquidat")) return { direction, action: "close", actionLabel: "Liquidation" };
  if (text.includes("close")) return { direction, action: "close", actionLabel: "Close" };
  if (text.includes("open")) return { direction, action: "open", actionLabel: "Open" };
  return null;
}

/**
 * The same reading for an order that has not filled yet.
 *
 * Nothing has to be inferred here: reduce-only is the flag that says the order
 * may only give exposure back, so it and the side together name the position
 * the order is about — a reduce-only sell closes a long, a plain sell opens a
 * short.
 */
export function readIntentLifecycle(intent: {
  readonly side: "buy" | "sell";
  readonly reduceOnly: boolean;
}): PositionLifecycle {
  if (intent.reduceOnly) {
    return {
      direction: intent.side === "sell" ? "long" : "short",
      action: "close",
      actionLabel: "Close",
    };
  }
  return {
    direction: intent.side === "buy" ? "long" : "short",
    action: "open",
    actionLabel: "Open",
  };
}

/**
 * The leverage a position is actually running at: notional over margin.
 *
 * The fallback for when the exchange's own `leverage` has not been read yet —
 * a mission whose last reconcile predates that field, or one that has never
 * held a position. Notional ÷ margin is the figure the exchange charges margin
 * on, so it matches what Hyperliquid shows next to the market for an isolated
 * position.
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
  /**
   * The first fill's timestamp, carried so a review chart can window to the
   * trade's actual span. Null when there were no fills.
   */
  readonly firstFillAt: string | null;
  /**
   * The last fill's timestamp, carried so a review chart can window to the
   * trade's actual span. Null when there were no fills.
   */
  readonly lastFillAt: string | null;
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
 * The missions worth a card in the workspace: the live ones.
 *
 * A finished mission is deleted server-side once it is flat, so in practice
 * nothing is filtered here — the projection stops carrying it within a poll
 * tick. This stays as the client's own guarantee that a settled mission is not
 * shown, for the window between the terminal status landing and the row going
 * away.
 *
 * Input order is the projection's: newest first.
 */
export function visibleMissions<T extends { readonly status: TradingMissionStatus }>(
  missions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return missions.filter((mission) => !isMissionComplete(mission.status));
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
    firstFillAt: result.firstFillAt,
    lastFillAt: result.lastFillAt,
    plannedLossUsd,
    // Positive means the mission did better than the loss it planned to risk.
    deviationFromPlanUsd: plannedLossUsd === null ? null : netResultUsd + plannedLossUsd,
  };
}

/** The two prices a review chart marks: where the trade went on, and off. */
export interface ReviewMarkers {
  readonly entryPrice: number | null;
  readonly exitPrice: number | null;
}

/**
 * Read the entry and exit prices off a finished mission's fill receipts.
 *
 * `recentFills` is newest-first and capped at three, which is exactly right for
 * the ordinary shape (one open, one close) and honest about the rest: a mission
 * that scaled in and out more than that gets its most recent close as the exit
 * and the oldest fill still on the receipt list as the entry. The chart is a
 * review of what happened, not an audit trail, so an approximate entry beats no
 * chart at all.
 *
 * `direction` is preferred where the exchange supplied it ("Open Long" /
 * "Close Long"); fills recorded before that field was carried fall back to
 * position in the list.
 */
export function deriveReviewMarkers(
  fills: ReadonlyArray<{
    readonly avgFillPrice: number;
    readonly direction?: string | undefined;
  }>,
): ReviewMarkers {
  if (fills.length === 0) return { entryPrice: null, exitPrice: null };

  const opening = fills.toReversed().find((fill) => fill.direction?.startsWith("Open") === true);
  const closing = fills.find((fill) => fill.direction?.startsWith("Close") === true);

  const oldest = fills[fills.length - 1]!;
  const newest = fills[0]!;

  return {
    entryPrice: (opening ?? oldest).avgFillPrice,
    exitPrice: (closing ?? newest).avgFillPrice,
  };
}

/**
 * The profit-target basis, flattened to the four lines the plan card shows.
 *
 * `targetProfitBasis` is the harness showing its work — measurement over a
 * lookback, expected hold, and the historical hit rate the median came from —
 * and is the most interesting thing on the card. Each slot maps one basis field
 * to a short string; null when the basis itself is absent or a field is unset.
 */
export interface StrategyPlanBasis {
  /** Which measurement produced the move, humanized (`excursion_quantile` → …). */
  readonly measurement: string | null;
  /** The interval and lookback the measurement was taken on, e.g. "5m · 60b". */
  readonly lookback: string | null;
  /** How long the position is expected to be held, in bars, e.g. "10b". */
  readonly hold: string | null;
  /** Share of historical windows the move was available in, e.g. "50%". */
  readonly hitRate: string | null;
}

/**
 * The published trading plan, rendered as a display-only timeline card.
 *
 * Mirrors {@link deriveCompletionSummary}'s shape: a flat, render-ready object
 * derived purely from the mission projection, so the React component holds no
 * logic of its own. Null when no strategy has been published yet.
 */
export interface StrategyPlan {
  /** `mission.strategyVersion` — the version the harness published. */
  readonly version: number;
  /** The free-text mode label, humanized for display. */
  readonly modeLabel: string;
  readonly thesis: string | null;
  readonly regime: string | null;
  /** Each entry condition's prose description; empty when none were published. */
  readonly entryTriggers: ReadonlyArray<string>;
  /** The order preference, humanized (`marketable_ioc` → …). */
  readonly orderType: string | null;
  readonly initialSizeUsd: number | null;
  /** "{method} · {price}" when a price was set, else just the method. */
  readonly stopSummary: string | null;
  /**
   * The conservative rung of the target ladder. Required positive on the
   * contract — never null.
   */
  readonly targetUsd: number;
  /** The full target ladder in prose; null when the harness published none. */
  readonly targetRationale: string | null;
  readonly basis: StrategyPlanBasis | null;
  readonly maxLossUsd: number | null;
  readonly scaleInAllowed: boolean;
  readonly partialReductionAllowed: boolean;
  /** Each abandonment condition's prose description; empty when none. */
  readonly invalidation: ReadonlyArray<string>;
  /** The strategy's timeframes, for an optional header chip. */
  readonly timeframes: ReadonlyArray<string>;
}

/**
 * Read the prose description off a condition the harness published.
 *
 * `AgentConditionInput` is a union of the full object and a bare string; after
 * decode the persisted form is always `{ description }`, but the TS type is the
 * union, so a structural guard is what reaches `.description` safely. Anything
 * the guard rejects returns null rather than a guess.
 */
function readConditionDescription(condition: unknown): string | null {
  if (typeof condition !== "object" || condition === null) return null;
  if (!("description" in condition)) return null;
  const description = (condition as { description?: unknown }).description;
  return typeof description === "string" ? description : null;
}

/**
 * The published plan as a render-ready card shape, or null before publish.
 *
 * Reads the strategy structurally via `mission.strategy?.<field>`: the contract
 * type is accessed only through the projection, never imported by name, so a
 * future field the schema gains still renders rather than failing the build.
 */
export function deriveStrategyPlan(mission: {
  readonly strategyVersion: number;
  readonly strategy: {
    readonly mode: string;
    readonly timeframes: ReadonlyArray<string>;
    readonly belief: {
      readonly summary: string;
      readonly regime: string;
    };
    readonly entryPlan: {
      readonly conditions: ReadonlyArray<unknown>;
      readonly orderPreference: string;
      readonly initialNotionalUsd?: number | undefined;
    };
    readonly positionManagement: {
      readonly scaleInAllowed: boolean;
      readonly partialReductionAllowed: boolean;
    };
    readonly protection: {
      readonly stopMethod: string;
      readonly stopPrice?: number | undefined;
      readonly targetProfitUsd: number;
      readonly targetProfitRationale?: string | undefined;
      readonly targetProfitBasis?:
        | {
            readonly measurement: string;
            readonly timeframe: string;
            readonly lookbackBars: number;
            readonly expectedHoldBars: number;
            readonly historicalHitRatePercent?: number | undefined;
          }
        | undefined;
      readonly maximumPlannedLossUsd?: number | undefined;
    };
    readonly abandonmentConditions: ReadonlyArray<unknown>;
  } | null;
}): StrategyPlan | null {
  const strategy = mission.strategy;
  if (strategy === null) return null;

  const entryTriggers = (strategy.entryPlan?.conditions ?? [])
    .map(readConditionDescription)
    .filter((value): value is string => value !== null);

  const stopMethod = strategy.protection?.stopMethod ?? null;
  const stopPrice = strategy.protection?.stopPrice ?? null;
  const stopSummary =
    stopMethod === null
      ? null
      : stopPrice === undefined || stopPrice === null
        ? humanizeLiteral(stopMethod)
        : `${humanizeLiteral(stopMethod)} · ${formatPrice(stopPrice)}`;

  const basisStruct = strategy.protection?.targetProfitBasis;
  const basis: StrategyPlanBasis | null =
    basisStruct === undefined
      ? null
      : {
          measurement: humanizeLiteral(basisStruct.measurement),
          lookback: `${basisStruct.timeframe} · ${basisStruct.lookbackBars}b`,
          hold: `${basisStruct.expectedHoldBars}b`,
          hitRate:
            basisStruct.historicalHitRatePercent === undefined
              ? null
              : `${basisStruct.historicalHitRatePercent}%`,
        };

  return {
    version: mission.strategyVersion,
    modeLabel: humanizeLiteral(strategy.mode),
    thesis: strategy.belief?.summary ?? null,
    regime: strategy.belief?.regime ?? null,
    entryTriggers,
    orderType:
      strategy.entryPlan?.orderPreference === undefined
        ? null
        : humanizeLiteral(strategy.entryPlan.orderPreference),
    initialSizeUsd: strategy.entryPlan?.initialNotionalUsd ?? null,
    stopSummary,
    // Required positive on the contract (PositiveUsdAmount): it is never null.
    targetUsd: strategy.protection?.targetProfitUsd ?? 0,
    targetRationale: strategy.protection?.targetProfitRationale ?? null,
    basis,
    maxLossUsd: strategy.protection?.maximumPlannedLossUsd ?? null,
    scaleInAllowed: strategy.positionManagement?.scaleInAllowed ?? false,
    partialReductionAllowed: strategy.positionManagement?.partialReductionAllowed ?? false,
    invalidation: (strategy.abandonmentConditions ?? [])
      .map(readConditionDescription)
      .filter((value): value is string => value !== null),
    timeframes: strategy.timeframes,
  };
}

// ---------------------------------------------------------------------------
// armed-conditions checklist (state 04)
// ---------------------------------------------------------------------------
//
// A flat mission holding authority is "armed" while it has active watches:
// each one is a deterministic predicate the evaluator will wake it for (§11.3),
// and the prototype's conditions checklist reads them back as a row per
// condition, showing the live number a watch is measuring against rather than a
// bare checkbox. The server carries `lastObservedValue` / `lastEvaluatedAt` on
// each watch, and this derivation flattens those into a render-ready shape.
//
// Pure, like {@link deriveStrategyPlan}: the React component holds no logic of
// its own. The predicate is never re-evaluated client-side — `met` comes from
// `status === "triggered"`, which the server already tracks.

/** One row of the armed-conditions checklist. */
export interface WatchConditionRow {
  /** The watch's id, for React keys. */
  readonly id: string;
  /** One line describing what the predicate is waiting for. */
  readonly description: string;
  /** The watch's lifecycle status, for the ✓/○ glyph. */
  readonly status: PersistedWatchStatus;
  /**
   * The value the evaluator last read for this predicate (mark/mid price for
   * `price_cross`, unrealised PnL for `pnl_above`/`pnl_below`, drawdown for
   * `pnl_giveback`). Null when the watch has never been swept.
   */
  readonly observedValue: number | null;
  /**
   * The threshold the predicate is measuring against (`price` for `price_cross`,
   * `valueUsd`/`drawdownUsd` for the PnL watches). Null for `scheduled_reassessment`,
   * which carries no numeric level.
   */
  readonly thresholdValue: number | null;
  /** True when the predicate has fired (`status === "triggered"`). */
  readonly met: boolean;
  /** When the evaluator last swept this watch, epoch millis. */
  readonly evaluatedAt: number | null;
}

/**
 * The armed-conditions checklist, derived from a mission's watches.
 *
 * `rows` carries one row per active numeric or lifecycle watch. `nextReassessmentAt`
 * is the earliest `runAt` among active `scheduled_reassessment` watches — the
 * countdown the card shows next to its title. Returns null when no watch is
 * active, so the card is absent rather than empty.
 */
export interface ArmedConditions {
  readonly rows: ReadonlyArray<WatchConditionRow>;
  /** Epoch millis of the next scheduled reassessment, or null when none is armed. */
  readonly nextReassessmentAt: number | null;
}

/**
 * Describe a watch predicate as one line, without interpreting it.
 *
 * Inlined separately from {@link describeWatch} so the derivation covers the
 * full `MarketWatch` union (`pnl_below` / `pnl_giveback` included) regardless of
 * the pre-existing gap in that function.
 */
function describeWatchCondition(watch: MarketWatch): string {
  switch (watch.type) {
    case "price_cross":
      return `${watch.market} ${watch.priceSource} crosses ${watch.direction} ${formatPrice(watch.price)}`;
    case "candle_close":
      return `${watch.market} ${watch.interval} candle closes ${watch.direction} ${formatPrice(watch.price)}`;
    case "order_update":
      return `Order ${watch.cloid} updates`;
    case "position_update":
      return `${watch.market} position updates`;
    case "scheduled_reassessment":
      return `Scheduled reassessment`;
    case "pnl_above":
      return `${watch.market} unrealised PnL reaches ${formatUsd(watch.valueUsd)}`;
    case "pnl_below":
      return `${watch.market} unrealised PnL falls to ${formatSignedUsd(watch.valueUsd)}`;
    case "pnl_giveback":
      return `${watch.market} PnL gives back ${formatUsd(watch.drawdownUsd)}`;
  }
}

/**
 * Read the threshold value off a watch predicate, where one exists.
 *
 * `scheduled_reassessment` and the event watches carry no numeric level, so they
 * return null.
 */
function readWatchThreshold(watch: MarketWatch): number | null {
  switch (watch.type) {
    case "price_cross":
    case "candle_close":
      return watch.price;
    case "pnl_above":
    case "pnl_below":
      return watch.valueUsd;
    case "pnl_giveback":
      return watch.drawdownUsd;
    case "order_update":
    case "position_update":
    case "scheduled_reassessment":
      return null;
  }
}

/**
 * The armed-conditions checklist, or null when nothing is armed.
 *
 * The card is gated on at least one `active` watch (the mission must still hold
 * something that can wake it). Once it is armed, the row list shows both the
 * conditions already met (`triggered`, a ticked ✓) and those still waiting
 * (`active`, an empty ○) — the prototype reads each row back with its glyph, and
 * a checklist that hid the satisfied ones would read as a mission waiting on
 * conditions it had already cleared. `consumed` / `cancelled` / `expired` /
 * `superseded` watches are history and never make a row.
 *
 * `scheduled_reassessment` watches are excluded from `rows` (they carry no
 * numeric level the checklist could show) and instead contribute to
 * `nextReassessmentAt`, the countdown the card renders in its header. Only
 * active reassessments count toward that countdown: a triggered one has fired.
 */
export function deriveWatchConditions(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ArmedConditions | null {
  const active = mission.watches.filter((persisted) => persisted.status === "active");
  if (active.length === 0) return null;

  let nextReassessmentAt: number | null = null;
  for (const persisted of active) {
    const watch = persisted.watch;
    if (watch.type !== "scheduled_reassessment") continue;
    if (nextReassessmentAt === null || watch.runAt < nextReassessmentAt) {
      nextReassessmentAt = watch.runAt;
    }
  }

  const rows: WatchConditionRow[] = [];
  for (const persisted of mission.watches) {
    // `triggered` is kept (a met row shows ✓); `active` is kept (a waiting row
    // shows ○). Everything else is terminal and dropped.
    if (persisted.status !== "active" && persisted.status !== "triggered") continue;

    const watch = persisted.watch;
    if (watch.type === "scheduled_reassessment") continue;

    rows.push({
      id: persisted.id,
      description: describeWatchCondition(watch),
      status: persisted.status,
      observedValue: persisted.lastObservedValue ?? null,
      thresholdValue: readWatchThreshold(watch),
      met: persisted.status === "triggered",
      evaluatedAt: persisted.lastEvaluatedAt ?? null,
    });
  }

  return { rows, nextReassessmentAt };
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

/**
 * Whether a mission still holds its thread and the user's one active slot.
 *
 * `revoked` and `completed` are terminal: the server's create guard looks only
 * for a mission outside those two, so a thread whose only mission is terminal
 * is free again. A terminal mission is also deleted once it is flat, so this
 * mostly answers for the window between the two.
 */
export function isLiveMission(status: string): boolean {
  return status !== "revoked" && status !== "completed";
}
