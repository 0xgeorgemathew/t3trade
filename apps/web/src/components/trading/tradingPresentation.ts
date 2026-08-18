import type {
  MarketWatch,
  PersistedWatch,
  PersistedWatchStatus,
  TradingMissionStatus,
  TradingTimeframe,
} from "@t3tools/trading-contracts";
import { findUnarmedEntryConditions, planPhase } from "@t3tools/trading-contracts";

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
    // Whole dollars once the cents stop mattering, cents while they are the
    // whole figure. A plan targeting $0.66 printed "$1" — a 50% overstatement
    // of the only number on the panel that says what the trade is for — and
    // the same rounding turned a $0.40 risk into "$0".
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
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

/**
 * A figure at the position ledger's own precision: exactly three decimals.
 *
 * Fixed rather than trimmed, and the same for sizes and prices, because the
 * ledger is read down its columns as much as across its rows. Every figure the
 * same width means right-aligning the price column also aligns the arrows
 * between the two prices, which no per-row alignment could achieve while
 * `0.2631` sat above `0.4`.
 *
 * Three, not four: the finest lot the POC's markets quote is a thousandth of a
 * unit once the size has been through a partial fill, and the fourth decimal
 * was only ever floating-point noise printed as data.
 */
export const formatFixed3 = (value: number): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });

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
    case "metric_threshold":
      return `${watch.market} ${humanizeLiteral(watch.metric)} crosses ${watch.direction} ${watch.value}`;
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
  /**
   * The same cause, verbatim — `market_watch_triggered`, `mission_created`.
   *
   * The label is prose for the reader; this is what the timeline keys its icon
   * and its tone off. A mission wakes several times a minute, and only the
   * event wakes earn the amber accent, so the beacon has to match on the
   * literal rather than on a humanized string that exists to be read.
   */
  readonly cause: string;
  /**
   * The kind of watch that woke the run, when a watch did — `price_cross`,
   * `pnl_above`, `candle_close`. Null when the cause was not a watch, or when
   * the payload did not name one.
   *
   * The cause alone says "a watch fired" but not which sort, and a P&L floor
   * being hit and a price level being crossed are different enough events to
   * be worth different icons.
   */
  readonly triggeringWatchType: string | null;
  /**
   * When the wake happened, in epoch millis. Null when the payload carried no
   * readable timestamp.
   *
   * The timeline uses it to tell a wakeup that has just landed from the
   * hundred a thread opens with, so only the arrival animates. Mount order
   * cannot answer that — opening a thread mounts the whole scrollback at once,
   * and every row would read as new.
   */
  readonly occurredAtMillis: number | null;
  /** True for the `mission_created` bootstrap, which carries no snapshot. */
  readonly bootstrap: boolean;
  /** "ETH · 3,142.50" while a snapshot is present; null on the bootstrap. */
  readonly marketLabel: string | null;
  /** How many coalesced inbox events the run was started with. */
  readonly pendingEventCount: number;
  /** The raw payload, pretty-printed for the expander. */
  readonly rawJson: string;
}

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Read a card out of the flat key=value rendering the server switched the
 * wakeup to (`TradingWakeupComposer.renderWakeup`): a `trading-harness-wakeup`
 * first line, `section:` headers at column 0, and indented `key=value` pairs
 * beneath them. The JSON branch above stays for older persisted messages.
 *
 * Same posture as the JSON parse: every field optional, only the first line
 * decides, and a shape this build does not fully understand still renders as a
 * card over the raw text.
 */
function deriveFlatWakeupCard(text: string): WakeupCard | null {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  if (firstLine.trim() !== "trading-harness-wakeup") return null;

  /** The scalar rendered on its own indented line under a top-level `name:`. */
  const sectionScalar = (name: string): string | null => {
    const match = text.match(new RegExp(`^${name}:\\n\\s+(\\S+)`, "m"));
    return match?.[1] ?? null;
  };
  /** The first `key=value` pair anywhere in the payload. */
  const pairValue = (key: string): string | null => {
    const match = text.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    return match?.[1] ?? null;
  };
  /** The indented body of a top-level section, or null when absent. */
  const sectionBody = (name: string): string | null => {
    const match = text.match(new RegExp(`^${name}:\\n((?:[ ].*(?:\\n|$))*)`, "m"));
    return match?.[1] ?? null;
  };

  const marketName = pairValue("market");
  const markPriceRaw = pairValue("markPrice");
  const markPrice = markPriceRaw === null ? null : readNumber(Number(markPriceRaw));

  const eventsBody = sectionBody("pendingEvents");
  const pendingEventCount =
    eventsBody === null ? 0 : (eventsBody.match(/^\s*\[\d+\]/gm) ?? []).length;

  const cause = sectionScalar("cause") ?? "wakeup";
  // The `type=` pair inside the triggering watch's own section, so a `type=`
  // belonging to some other section cannot be read as the watch's.
  const watchBody = sectionBody("triggeringWatch");
  const triggeringWatchType = watchBody?.match(/(?:^|\s)type=([^\s]+)/)?.[1] ?? null;

  const occurredAtRaw = sectionScalar("occurredAt");

  return {
    causeLabel: humanizeLiteral(cause),
    cause,
    triggeringWatchType,
    occurredAtMillis: occurredAtRaw === null ? null : readNumber(Number(occurredAtRaw)),
    bootstrap: false,
    marketLabel:
      marketName === null
        ? null
        : markPrice === null
          ? marketName
          : `${marketName} · ${formatPrice(markPrice)}`,
    pendingEventCount,
    rawJson: text,
  };
}

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
  if (trimmed.startsWith("trading-harness-wakeup")) return deriveFlatWakeupCard(trimmed);
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

  const pendingEvents = payload["pendingEvents"];

  const cause = readString(payload["cause"]) ?? "wakeup";
  const triggeringWatch = payload["triggeringWatch"];
  const watchFields =
    typeof triggeringWatch === "object" && triggeringWatch !== null
      ? (triggeringWatch as Record<string, unknown>)
      : null;
  // The persisted wrapper carries the predicate under `watch`; older payloads
  // put the type on the wrapper itself. Both are read rather than guessed at.
  const watchInner = watchFields?.["watch"];
  const innerFields =
    typeof watchInner === "object" && watchInner !== null
      ? (watchInner as Record<string, unknown>)
      : null;

  return {
    causeLabel: humanizeLiteral(cause),
    cause,
    triggeringWatchType:
      (innerFields === null ? null : readString(innerFields["type"])) ??
      (watchFields === null ? null : readString(watchFields["type"])),
    occurredAtMillis: readNumber(payload["occurredAt"]),
    bootstrap: payload["bootstrap"] === true,
    marketLabel:
      marketName === null
        ? null
        : markPrice === null
          ? marketName
          : `${marketName} · ${formatPrice(markPrice)}`,
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
 * How late a position read may be before the surface says anything at all.
 *
 * This is NOT §13's 5s account window, and setting it to that window was the
 * bug. The refresh it measures is §18.2 #8's periodic reconcile, whose schedule
 * is `Schedule.spaced(5s)` — spaced from *completion*, so one cycle is five
 * seconds plus an exchange round trip plus the reconcile's own writes. On top of
 * that, `observed_at` is the server's clock at the top of the pass and this
 * compares it against the browser's, so any skew between the two lands here too.
 *
 * A threshold equal to the refresh period is therefore below the floor of what
 * it measures: the age sweeps past it near the end of every single cycle, and
 * the banner blinked on and off for the life of every position. Three missed
 * reconciles is the first age that means a read has actually stopped landing.
 */
export const POSITION_DELAYED_AFTER_MILLIS = 15_000;

/**
 * How late a read must be before the surface claims placement is suspended.
 *
 * "Order placement is suspended" is a strong claim about the execution path, so
 * it waits until the read has missed roughly nine reconciles — by then the feed
 * is not late, it is broken. Between the two thresholds the panel shows a quiet
 * `stale 20s` chip instead: enough to say the numbers are not current, without
 * asserting something about the order path that is probably not true yet.
 */
export const POSITION_STALE_AFTER_MILLIS = 45_000;

/** How current the position read is, in the three bands the surfaces show. */
export type PositionFreshness = "current" | "delayed" | "stale";

export interface StalenessSubject {
  readonly status: TradingMissionStatus;
  readonly position: { readonly size: number; readonly observedAt: string } | null;
}

/**
 * The age of the position read, or null when there is nothing to age.
 *
 * Null in three cases, each of which used to produce a false warning: a
 * completed mission (its final row never refreshes again), a flat mission
 * (§18.2 #8's reconcile only runs against exposure, so a flat snapshot ages out
 * once and stays aged out), and an unparseable timestamp.
 */
export function readPositionReadAge(subject: StalenessSubject, nowMs: number): number | null {
  if (isMissionComplete(subject.status)) return null;

  const position = subject.position;
  if (position === null || position.size === 0) return null;

  const observedAt = Date.parse(position.observedAt);
  if (Number.isNaN(observedAt)) return null;

  return Math.max(0, nowMs - observedAt);
}

export function readPositionFreshness(subject: StalenessSubject, nowMs: number): PositionFreshness {
  const age = readPositionReadAge(subject, nowMs);
  if (age === null) return "current";
  if (age > POSITION_STALE_AFTER_MILLIS) return "stale";
  if (age > POSITION_DELAYED_AFTER_MILLIS) return "delayed";
  return "current";
}

/** The panel header's quiet chip — `stale 20s` — or null while current. */
export function describeDelayedRead(subject: StalenessSubject, nowMs: number): string | null {
  const freshness = readPositionFreshness(subject, nowMs);
  if (freshness === "current") return null;

  const age = readPositionReadAge(subject, nowMs);
  return age === null ? "stale" : `stale ${formatDuration(age)}`;
}

/**
 * The staleness banner's own text, or null below the suspension threshold.
 *
 * The age is the whole point of the sentence: a read that is a second late and
 * one that stopped four minutes ago are very different situations to be holding
 * a position through, and "Position data is stale" alone said the same thing
 * about both.
 */
export function describeStaleness(subject: StalenessSubject, nowMs: number): string | null {
  if (readPositionFreshness(subject, nowMs) !== "stale") return null;

  const age = readPositionReadAge(subject, nowMs);
  const lastUpdate = age === null ? "" : ` Last update ${formatDuration(age)} ago.`;
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
 * The missions worth a full card in the workspace: the live ones.
 *
 * Finished missions survive in the projection now (plan 27 H1 stopped
 * deleting them at settle), so this filter is what keeps the workspace to the
 * missions that can still act. The finished ones render in the history list
 * instead — see {@link settledMissions}.
 *
 * Input order is the projection's: newest first.
 */
export function visibleMissions<T extends { readonly status: TradingMissionStatus }>(
  missions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return missions.filter((mission) => !isMissionComplete(mission.status));
}

/** The finished missions, newest first: the history list's input. */
export function settledMissions<T extends { readonly status: TradingMissionStatus }>(
  missions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return missions.filter((mission) => isMissionComplete(mission.status));
}

/** One line of the mission history list, everything already formatted. */
export interface MissionHistoryRow {
  readonly missionId: string;
  readonly threadId: string;
  readonly market: string;
  /** "Long" / "Short" / "Stand aside" from the published plan; null when none was. */
  readonly direction: string | null;
  readonly statusLabel: string;
  readonly netUsd: number;
  readonly netLabel: string;
  readonly feesLabel: string;
  readonly fillCount: number;
  /** First fill to last fill; null for a mission that never traded twice. */
  readonly durationLabel: string | null;
  /** When the mission reached its terminal status (the row's last write). */
  readonly settledAtIso: string;
}

/**
 * A settled mission compressed to the line the history list shows.
 *
 * The full record — fills, review chart, plan — lives on the mission's
 * thread; this row exists to find that thread and to make the ledger scan
 * well: market, direction, what it netted, what it cost, how long it traded.
 */
export function deriveMissionHistoryRow(mission: {
  readonly id: string;
  readonly threadId: string;
  readonly market: string;
  readonly status: TradingMissionStatus;
  readonly strategy: { readonly intent: string } | null;
  readonly result: {
    readonly realizedPnlUsd: number;
    readonly feesPaidUsd: number;
    readonly fillCount: number;
    readonly firstFillAt: string | null;
    readonly lastFillAt: string | null;
  };
  readonly updatedAt: string;
}): MissionHistoryRow {
  const net = mission.result.realizedPnlUsd - mission.result.feesPaidUsd;
  const tradedMillis =
    mission.result.firstFillAt === null ||
    mission.result.lastFillAt === null ||
    mission.result.fillCount < 2
      ? null
      : Date.parse(mission.result.lastFillAt) - Date.parse(mission.result.firstFillAt);
  return {
    missionId: mission.id,
    threadId: mission.threadId,
    market: mission.market,
    direction: mission.strategy === null ? null : planIntentLabel(mission.strategy.intent),
    statusLabel: MISSION_STATUS_LABELS[mission.status],
    netUsd: net,
    netLabel: formatSignedUsd(net),
    feesLabel: formatUsd(mission.result.feesPaidUsd),
    fillCount: mission.result.fillCount,
    durationLabel: tradedMillis === null || tradedMillis < 0 ? null : formatDuration(tradedMillis),
    settledAtIso: mission.updatedAt,
  };
}

export function deriveCompletionSummary(mission: {
  readonly result: {
    readonly realizedPnlUsd: number;
    readonly feesPaidUsd: number;
    readonly fillCount: number;
    readonly firstFillAt: string | null;
    readonly lastFillAt: string | null;
    /** Planned loss at the approved stop, scaled to what actually filled. */
    readonly plannedLossAtStopUsd?: number | null | undefined;
  };
  readonly strategy: {
    readonly stop: { readonly maximumPlannedLossUsd?: number | undefined };
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

  // What was really at stake, preferred over what the plan said was — plan 34
  // step 7.3. `maximumPlannedLossUsd` is a number the model writes, and it
  // writes it from the authority's per-position ceiling; the entry records say
  // what the stop was actually going to cost at the size that actually filled.
  // On the mission that found this the two were $63 and $1.70.
  const plannedLossUsd =
    mission.result.plannedLossAtStopUsd ?? mission.strategy?.stop.maximumPlannedLossUsd ?? null;

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
 * The published trading plan, rendered as a display-only timeline card.
 *
 * Mirrors {@link deriveCompletionSummary}'s shape: a flat, render-ready object
 * derived purely from the mission projection, so the React component holds no
 * logic of its own. Null when no strategy has been published yet.
 */
export interface StrategyPlan {
  /**
   * The narrative: setup, indicators, regime, and the plan in plain terms, in
   * one field. Null when the harness published none (decodes as "").
   */
  readonly because: string | null;
  /**
   * The plan's intent as a label — "Long", "Short", "Stand aside" — so every
   * surface that shows a plan names its direction the same way.
   */
  readonly intentLabel: string;
  /** Each entry trigger's prose description; empty when none were published. */
  readonly entryTriggers: ReadonlyArray<string>;
  /** How urgently the plan wants its entry to land, humanized ("now"/"patient"). */
  readonly orderType: string | null;
  readonly initialSizeUsd: number | null;
  /** "{method} · {price}" when a price was set, else just the method. */
  readonly stopSummary: string | null;
  /**
   * The plan's stated profit rung, when it named one. Null on a plan that
   * named none — including every stand-aside, where there is no target at all.
   */
  readonly targetUsd: number | null;
  /**
   * Whether this plan stood aside (`intent: "stand_aside"`): the turn read the
   * market, found nothing worth taking after costs, and published that
   * conclusion rather than inventing a target. Nothing is armed at
   * `targetUsd` on such a plan — there is no position and no `pnl_above`.
   */
  readonly isStandAside: boolean;
  readonly maxLossUsd: number | null;
  /** Each invalidation condition's prose; empty when none. */
  readonly invalidation: ReadonlyArray<string>;
  /** How much longer an untriggered plan stays fresh, in minutes. */
  readonly reassessMinutes: number;
  /**
   * The plan's phase, derived from what the mission holds: flat is waiting on
   * a trigger, a position is holding (plan 29 step 4.4's two-state model).
   */
  readonly planPhase: "waiting" | "holding";
}

/**
 * The plan's intent as a display label: "Long", "Short", "Stand aside".
 *
 * The old document carried this as a stand-down code the surfaces had to
 * interpret; the intent is the whole statement now, and this is the one place
 * that turns it into prose.
 */
function planIntentLabel(intent: string): string {
  const humanized = humanizeLiteral(intent);
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * Read the prose description off a trigger the harness published.
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
  /** The mission's position snapshot; absent or flat means the plan is waiting. */
  readonly position?: { readonly size: number } | null;
  readonly strategy: {
    readonly intent: string;
    readonly entry: {
      readonly triggers: ReadonlyArray<unknown>;
      readonly urgency: string;
      readonly initialNotionalUsd?: number | undefined;
    };
    readonly stop: {
      readonly method: string;
      readonly price?: number | undefined;
      readonly maximumPlannedLossUsd?: number | undefined;
    };
    readonly target: {
      readonly profitUsd?: number | undefined;
    };
    readonly invalidation: ReadonlyArray<unknown>;
    readonly reassess: { readonly afterMinutes: number };
    readonly because?: string | undefined;
  } | null;
}): StrategyPlan | null {
  const strategy = mission.strategy;
  if (strategy === null) return null;

  const entryTriggers = (strategy.entry?.triggers ?? [])
    .map(readConditionDescription)
    .filter((value): value is string => value !== null);

  const stopMethod = strategy.stop?.method ?? null;
  const stopPrice = strategy.stop?.price ?? null;
  const stopSummary =
    stopMethod === null
      ? null
      : stopPrice === undefined || stopPrice === null
        ? humanizeLiteral(stopMethod)
        : `${humanizeLiteral(stopMethod)} · ${formatPrice(stopPrice)}`;

  const because = strategy.because?.trim() ?? "";

  return {
    because: because === "" ? null : because,
    intentLabel: planIntentLabel(strategy.intent),
    entryTriggers,
    orderType:
      strategy.entry?.urgency === undefined ? null : humanizeLiteral(strategy.entry.urgency),
    initialSizeUsd: strategy.entry?.initialNotionalUsd ?? null,
    stopSummary,
    targetUsd: strategy.target?.profitUsd ?? null,
    isStandAside: strategy.intent === "stand_aside",
    maxLossUsd: strategy.stop?.maximumPlannedLossUsd ?? null,
    invalidation: (strategy.invalidation ?? []).filter(
      (line): line is string => typeof line === "string",
    ),
    reassessMinutes: strategy.reassess?.afterMinutes ?? 90,
    // The phase the nine-value `currentAction` pretended to be: flat is
    // waiting, holding is holding.
    planPhase: planPhase(mission.position?.size ?? 0),
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
   * `price_cross`, unrealised PnL for `pnl_below`, drawdown for
   * `pnl_giveback`). Null when the watch has never been swept.
   *
   * `pnl_above` is the one that is not gross: the target is compared net of
   * the taker fee the exit has yet to pay, and this is the net figure, so the
   * row and the predicate agree about how far away the threshold is.
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
      // Net of the exit it has yet to pay: the evaluator subtracts the taker
      // fee on the way out before it compares, so a target that fires is one
      // the mission can actually bank.
      return `${watch.market} PnL net of the exit reaches ${formatUsd(watch.valueUsd)}`;
    case "pnl_below":
      return `${watch.market} unrealised PnL falls to ${formatSignedUsd(watch.valueUsd)}`;
    case "pnl_giveback":
      return `${watch.market} PnL gives back ${formatUsd(watch.drawdownUsd)}`;
    case "metric_threshold":
      // "ETH volume ratio above 2" / "ETH funding rate 8h below -0.0001":
      // the metric named in plain words, the threshold as the raw number the
      // evaluator compares — a formatter that guessed units would lie about
      // at least one metric.
      return `${watch.market} ${humanizeLiteral(watch.metric)} ${watch.direction} ${watch.value}`;
  }
}

/**
 * Whether this predicate only means anything while a position is held.
 *
 * All three are measured against unrealised PnL, which is zero and meaningless
 * when flat — so the server retires them with the position rather than leaving
 * them to fire at a trade that is over. The stream says "retired" for those and
 * keeps "replaced" for a level a replan swapped out.
 */
function isPositionScopedWatch(watch: MarketWatch): boolean {
  return watch.type === "pnl_above" || watch.type === "pnl_below" || watch.type === "pnl_giveback";
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
    case "metric_threshold":
      return watch.value;
    case "order_update":
    case "position_update":
    case "scheduled_reassessment":
      return null;
  }
}

/**
 * Which side of its threshold a predicate waits on, where that means anything.
 *
 * The stream draws this as the chart gutter's own ▲ / ▼ glyph, so a row and the
 * dotted line it belongs to read as one object in two places. A give-back
 * measures a fall from a moving high-water mark rather than a fixed side, and
 * the event watches compare nothing, so all three return null.
 */
function readWatchDirection(watch: MarketWatch): "above" | "below" | null {
  switch (watch.type) {
    case "price_cross":
    case "candle_close":
    case "metric_threshold":
      return watch.direction;
    case "pnl_above":
      return "above";
    case "pnl_below":
      return "below";
    case "pnl_giveback":
    case "order_update":
    case "position_update":
    case "scheduled_reassessment":
      return null;
  }
}

/**
 * The short qualifier that follows the row's figure.
 *
 * A candle close is only meaningful with the bar it closes on, and a metric
 * threshold is only meaningful with the metric it reads — both are the same
 * slot in the row, because both answer "the figure is what, exactly".
 */
function readWatchQualifier(watch: MarketWatch): string | null {
  if (watch.type === "candle_close") return watch.interval;
  if (watch.type === "metric_threshold") return humanizeLiteral(watch.metric);
  return null;
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

// ---------------------------------------------------------------------------
// The watch stream — one list, armed at the top and everything settled beneath
// it, newest first.
// ---------------------------------------------------------------------------

/**
 * Where a watch is in its life.
 *
 * Four states because four things can happen to a watch and the operator needs
 * to tell them apart: it is still waiting, its predicate matched, someone took
 * it down, or its clock ran out. `replaced` is `disarmed` with a different word
 * in the row — a newer prediction moved the level, which is not the same event
 * as a level being cancelled, but it is the same fact about the watch.
 */
export type WatchLifecycleState = "armed" | "triggered" | "disarmed" | "expired";

/** Every watch predicate that can make a stream row (a reassessment cannot). */
export type WatchRowType = Exclude<MarketWatch["type"], "scheduled_reassessment">;

/** One row of the stream: a watch, where it is, and what it belongs to. */
export interface WatchStreamRow {
  /** Discriminates a single watch from a supersession group in the same list. */
  readonly kind: "watch";
  readonly id: string;
  readonly state: WatchLifecycleState;
  /** One line describing what the predicate is (or was) waiting for. */
  readonly description: string;
  /**
   * The predicate's own type. The row renders an icon per type, and reading the
   * type off the description string would be the panel parsing its own prose.
   */
  readonly watchType: WatchRowType;
  /**
   * Which side of the threshold the predicate waits on, where it has one. Null
   * for the event watches and for a give-back, which measure no direction.
   */
  readonly direction: "above" | "below" | null;
  /**
   * The short qualifier that follows the figure: a candle's interval, or a
   * metric's name in plain words. Null when the type has neither.
   */
  readonly intervalLabel: string | null;
  /**
   * The word the row shows for how it ended. `armed` rows carry null — they
   * have not ended. Distinguishes `replaced` from `cancelled`, which share a
   * dot but not a cause.
   */
  readonly outcomeLabel: string | null;
  /** Epoch millis: when it was armed, or when it settled. */
  readonly atMillis: number;
  /**
   * The plan version whose projection this was armed for, when the runtime
   * armed it for one. Null for everything the harness armed itself.
   */
  readonly predictionVersion: number | null;
  /** The live reading the evaluator last took, for a row still waiting. */
  readonly observedValue: number | null;
  /** The number the predicate compares against, where it has one. */
  readonly thresholdValue: number | null;
  /**
   * The first thing the mission did at or after the watch fired, read off the
   * timeline: a plan publish or stop move wins over the wake itself, because
   * "woke" is the mechanism and the publish is the decision. Null on rows that
   * did not fire, and on firings the timeline has not caught up with.
   */
  readonly actionLabel: string | null;
}

/**
 * A burst of take-downs, folded into one row.
 *
 * Every replan supersedes the previous prediction's watches, so one
 * reassessment retires three to six levels in the same tick. Left as
 * individual rows they open the settled half with a wall of near-identical
 * "cancelled" lines, and the row the operator came for — the one that fired —
 * is pushed off screen by administrative churn.
 */
export interface WatchStreamGroup {
  readonly kind: "group";
  /** Stable across polls: derived from the newest member's id. */
  readonly id: string;
  readonly count: number;
  /** `replaced` when every member was superseded, `retired` when they are mixed. */
  readonly outcomeLabel: "replaced" | "retired";
  /** The newest member's settle time, which is what the group's age reads from. */
  readonly atMillis: number;
  /** Newest first, so expanding the group reads in the same order as the stream. */
  readonly members: ReadonlyArray<WatchStreamRow>;
}

/** One entry in the stream: a watch, or a burst of take-downs standing for several. */
export type WatchStreamItem = WatchStreamRow | WatchStreamGroup;

/** Whether this entry is still live, which is what orders the stream. */
export function isArmedRow(item: WatchStreamItem): boolean {
  return item.kind === "watch" && item.state === "armed";
}

/**
 * How close two take-downs must settle to count as the same burst.
 *
 * One replan writes its supersessions inside a single transaction, so the real
 * spread is milliseconds; five seconds is slack for a slow write, and short
 * enough that two separate reassessments never merge into one row.
 */
const SUPERSESSION_BURST_MILLIS = 5_000;

/** Whether this settled row is a take-down, which is the only thing that groups. */
function isTakeDownRow(row: WatchStreamRow): boolean {
  return row.outcomeLabel === "replaced" || row.outcomeLabel === "cancelled";
}

/**
 * Fold consecutive take-downs that settled together into one row each.
 *
 * Only take-downs group. A firing is an event the operator follows to the
 * decision it produced, and an expiry is a level the mission let lapse; both
 * stay individual however many land at once. A burst of one is left as the
 * ordinary row it already was — group chrome for a lone cancel would be a
 * disclosure over a single line.
 */
function groupSupersessionBursts(
  settled: ReadonlyArray<WatchStreamRow>,
): ReadonlyArray<WatchStreamItem> {
  const items: WatchStreamItem[] = [];
  let index = 0;

  while (index < settled.length) {
    const first = settled[index]!;
    if (!isTakeDownRow(first)) {
      items.push(first);
      index += 1;
      continue;
    }

    // The window is anchored on the burst's newest member rather than chained
    // member to member, so a long drizzle of cancels cannot drift into one
    // group that spans minutes.
    const burst: WatchStreamRow[] = [first];
    let next = index + 1;
    while (next < settled.length) {
      const candidate = settled[next]!;
      if (!isTakeDownRow(candidate)) break;
      if (first.atMillis - candidate.atMillis > SUPERSESSION_BURST_MILLIS) break;
      burst.push(candidate);
      next += 1;
    }

    if (burst.length === 1) {
      items.push(first);
    } else {
      items.push({
        kind: "group",
        id: `group-${first.id}`,
        count: burst.length,
        outcomeLabel: burst.every((row) => row.outcomeLabel === "replaced")
          ? "replaced"
          : "retired",
        atMillis: first.atMillis,
        members: burst,
      });
    }
    index = next;
  }

  return items;
}

/**
 * Every watch the mission has, as one ordered stream.
 *
 * This used to be two derivations feeding two lists under two headings: a
 * checklist of what was armed, and a separate scrollback of what had fired.
 * They are the same objects at different points in one life, and splitting
 * them meant a watch disappeared from one list and reappeared in another — the
 * single event the operator most wants to follow was the one the layout hid.
 *
 * Armed rows come first, in the order the projection gave them. Everything
 * settled follows, newest first. `scheduled_reassessment` watches stay out of
 * both halves: they carry no level, and the panel already counts down to the
 * next one in its header.
 */
export function deriveWatchLifecycle(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly missionTimeline: ReadonlyArray<{
    readonly at: string;
    readonly kind: "wake" | "stop_adjusted" | "strategy_published" | "journal";
    readonly label: string;
  }>;
}): { readonly stream: ReadonlyArray<WatchStreamItem> } {
  // Timeline entries as (millis, kind, label), oldest first, so "the first
  // thing after the firing" is a forward scan.
  const timeline = mission.missionTimeline
    .map((entry) => ({ at: Date.parse(entry.at), kind: entry.kind, label: entry.label }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => a.at - b.at);

  const actionAfter = (firedAt: number): string | null => {
    // The wake for this firing lands within moments; the decision it produced
    // (a publish, a stop move) lands within the turn. Prefer the decision.
    const after = timeline.filter((entry) => entry.at >= firedAt - 2_000);
    const decision = after.find((entry) => entry.kind !== "wake");
    if (decision !== undefined) return decision.label;
    const wake = after.find((entry) => entry.kind === "wake");
    return wake === undefined ? null : wake.label;
  };

  const armed: WatchStreamRow[] = [];
  const settled: WatchStreamRow[] = [];

  for (const persisted of mission.watches) {
    const watch = persisted.watch;
    if (watch.type === "scheduled_reassessment") continue;

    const shared = {
      kind: "watch" as const,
      id: persisted.id,
      description: describeWatchCondition(watch),
      watchType: watch.type,
      direction: readWatchDirection(watch),
      intervalLabel: readWatchQualifier(watch),
      predictionVersion: persisted.predictionVersion ?? null,
      thresholdValue: readWatchThreshold(watch),
    };

    if (persisted.status === "active") {
      armed.push({
        ...shared,
        state: "armed",
        outcomeLabel: null,
        atMillis: persisted.createdAt,
        observedValue: persisted.lastObservedValue ?? null,
        actionLabel: null,
      });
      continue;
    }

    const fired = persisted.status === "triggered" || persisted.status === "consumed";
    settled.push({
      ...shared,
      state: fired
        ? "triggered"
        : persisted.status === "expired"
          ? "expired"
          : // `cancelled` and `superseded` both mean the level was taken down
            // rather than reached. The word below says which.
            "disarmed",
      outcomeLabel: fired
        ? null
        : persisted.status === "superseded"
          ? // A superseded price level was replaced by the plan that took it
            // down. A superseded PnL watch was not: nothing replaces it, the
            // position it measured ended and it went with the position.
            isPositionScopedWatch(watch)
            ? "retired"
            : "replaced"
          : persisted.status,
      atMillis: persisted.updatedAt,
      observedValue: persisted.lastObservedValue ?? null,
      actionLabel: fired ? actionAfter(persisted.updatedAt) : null,
    });
  }

  settled.sort((a, b) => b.atMillis - a.atMillis);
  return { stream: [...armed, ...groupSupersessionBursts(settled)] };
}

// ---------------------------------------------------------------------------
// The "Up next" strip — plan 24 §3
// ---------------------------------------------------------------------------

/** One pill in the strip: a single thing the mission is going to do or meet. */
export interface UpNextItem {
  /** Stable across polls, so React does not remount the pill every 3s. */
  readonly key: string;
  readonly kind: "order" | "stop" | "price" | "pnl" | "time" | "entry";
  /** The pill's own words, e.g. `wake @ 1899 ↓`. */
  readonly label: string;
  /** How far away it is, in its own units. Null when nothing measures it. */
  readonly detail: string | null;
  /** A short provenance chip — `auto`, `target`, `stop`. Null for harness-armed. */
  readonly chip: string | null;
  /** `warning` is the plan naming a level nothing is armed at. */
  readonly tone: "normal" | "warning";
  /** The chart level this pill points at, for the click-to-flash interaction. */
  readonly priceLevel: number | null;
}

/**
 * Everything the mission is waiting on, as one ordered list of pills.
 *
 * The panel already showed the *nearest* reassessment as a countdown and the
 * armed watches as a checklist. Neither answers "what happens next", because
 * the checklist is a set of predicates in registration order and the countdown
 * is one item out of several. This is the schedule: every future event the
 * projection already carries, in the order it is likely to arrive.
 *
 * Ordering is by class, then by nearness inside the class — deliberately, not
 * for want of a cleverer sort. A price two dollars away and a reassessment
 * three minutes away have no common unit, and a single blended rank would be a
 * number no one could check. The classes are ordered by how settled the event
 * is: an order already working, then the stop that is standing, then the levels
 * the market has to reach, then the clock, then the entry view a waiting plan
 * named but did not arm.
 *
 * Derives from the projection alone — no RPC, no new server state.
 */
export function deriveUpNextItems(
  mission: {
    readonly watches: ReadonlyArray<PersistedWatch>;
    readonly marketPrice?: number | undefined;
    readonly inFlightExecution: { readonly limitPrice?: number | undefined } | null;
    readonly position: {
      readonly size: number;
      readonly entryPrice?: number | undefined;
      readonly unrealisedPnl: number;
    } | null;
    readonly strategy: {
      readonly entry?: { readonly triggers?: ReadonlyArray<unknown> | undefined } | undefined;
      readonly stop?: { readonly price?: number | undefined } | undefined;
    } | null;
  },
  nowMillis: number,
): ReadonlyArray<UpNextItem> {
  const markPrice = mission.marketPrice ?? null;
  const position = mission.position;

  const orders: UpNextItem[] = [];
  if (mission.inFlightExecution !== null) {
    const limit = mission.inFlightExecution.limitPrice;
    orders.push({
      key: "order",
      kind: "order",
      label: "order working",
      detail: limit === undefined ? null : formatPrice(limit),
      chip: null,
      tone: "normal",
      priceLevel: limit ?? null,
    });
  }

  // The stop is a standing future event, not just a line on the chart: it is
  // the one thing on this list that ends the trade without the agent acting.
  const stops: UpNextItem[] = [];
  const stopPrice = mission.strategy?.stop?.price;
  if (stopPrice !== undefined && position !== null && position.size !== 0) {
    const entry = position.entryPrice;
    const risk =
      entry === undefined
        ? null
        : Math.max(0, position.size > 0 ? entry - stopPrice : stopPrice - entry) *
          Math.abs(position.size);
    stops.push({
      key: "stop",
      kind: "stop",
      label: `stop ${formatPrice(stopPrice)}`,
      detail: risk === null ? null : `${formatUsdPrecise(risk)} risk`,
      chip: null,
      tone: "normal",
      priceLevel: stopPrice,
    });
  }

  const levels: Array<{ readonly item: UpNextItem; readonly distance: number }> = [];
  const times: Array<{ readonly item: UpNextItem; readonly at: number }> = [];

  for (const persisted of mission.watches) {
    if (persisted.status !== "active") continue;
    const watch = persisted.watch;

    if (watch.type === "price_cross" || watch.type === "candle_close") {
      const arrow = watch.direction === "above" ? "↑" : "↓";
      const distance = markPrice === null ? null : Math.abs(markPrice - watch.price);
      levels.push({
        item: {
          key: persisted.id,
          kind: "price",
          label: `wake @ ${formatPrice(watch.price)} ${arrow}`,
          detail: distance === null ? null : `${formatPrice(distance)} away`,
          chip: persisted.armedReason === "stop_proximity" ? "stop" : null,
          tone: "normal",
          priceLevel: watch.price,
        },
        distance: distance ?? Number.POSITIVE_INFINITY,
      });
      continue;
    }

    if (watch.type === "pnl_above" || watch.type === "pnl_below") {
      const isTarget = watch.type === "pnl_above";
      // Measured from the evaluator's own last reading rather than from the
      // position's gross PnL: a target is compared net of the exit still to be
      // paid, so the gross figure would say "$0.00 away" while the watch sat
      // there unfired. `lastObservedValue` is exactly the number the predicate
      // compares, whichever side it measures.
      const observed = persisted.lastObservedValue ?? position?.unrealisedPnl ?? null;
      const gap = observed === null ? null : Math.abs(observed - watch.valueUsd);
      levels.push({
        item: {
          key: persisted.id,
          kind: "pnl",
          // "wake at", not "bank at". The target is a decision point now, not
          // an exit: nothing rests at it, and reaching it wakes the mission to
          // weigh banking against holding on against live conditions.
          label: `${isTarget ? "wake at" : "flag at"} ${formatSignedUsd(watch.valueUsd)}`,
          detail: gap === null ? null : `${formatUsdPrecise(gap)} away`,
          chip: persisted.armedReason === "profit_target" ? "target" : null,
          tone: "normal",
          priceLevel: derivePnlLevelPrice(
            watch.valueUsd,
            position === null || position.entryPrice === undefined
              ? null
              : { entryPrice: position.entryPrice, size: position.size },
          ),
        },
        distance: gap ?? Number.POSITIVE_INFINITY,
      });
      continue;
    }

    if (watch.type === "pnl_giveback") {
      // Measured from the position's own peak, which the projection does not
      // carry — so it is listed without a distance rather than with a guess.
      levels.push({
        item: {
          key: persisted.id,
          kind: "pnl",
          label: `give back ${formatUsdPrecise(watch.drawdownUsd)}`,
          detail: "from peak",
          chip: null,
          tone: "normal",
          priceLevel: null,
        },
        distance: Number.POSITIVE_INFINITY,
      });
      continue;
    }

    if (watch.type === "scheduled_reassessment") {
      times.push({
        item: {
          key: persisted.id,
          kind: "time",
          label: `reassess in ${formatDuration(watch.runAt - nowMillis)}`,
          detail: null,
          chip: persisted.armedReason === "staleness_floor" ? "auto" : null,
          tone: "normal",
          priceLevel: null,
        },
        at: watch.runAt,
      });
    }
  }

  // A waiting plan's own trigger levels. Only the ones nothing is armed at
  // make a pill: an armed trigger is already in the list above, and showing it
  // twice would say the mission is watching two things when it is watching one.
  const entries: UpNextItem[] = [];
  // The phase the nine-value `currentAction` used to carry, derived from what
  // the mission holds: flat is waiting, a position is holding (plan 29 step
  // 4.4). Flat is `size === 0`, not `position === null`: a closed position
  // leaves its snapshot row behind zeroed, and the wakeup composer gates on the
  // same test.
  const isWaiting = position === null || planPhase(position.size) === "waiting";
  if (isWaiting) {
    const triggers = (mission.strategy?.entry?.triggers ?? []).flatMap((trigger) => {
      const hint = readConditionHint(trigger);
      return hint === null ? [] : [hint];
    });
    const unarmed = findUnarmedEntryConditions({ conditions: triggers, watches: mission.watches });
    for (const condition of unarmed) {
      entries.push({
        key: `entry:${condition.priceLevel}`,
        kind: "entry",
        label: `entry? ${formatPrice(condition.priceLevel)}`,
        detail: "not armed",
        chip: null,
        tone: "warning",
        priceLevel: condition.priceLevel,
      });
    }
  }

  return [
    ...orders,
    ...stops,
    // One pill per level, however many watches point at it. A trigger armed as
    // both a touch and a close is the doctrine working — and as two identical
    // "wake @ 1,876.6 ↑" pills it reads as two things to wait for.
    ...dedupeLevelItems(levels.sort((a, b) => a.distance - b.distance).map((entry) => entry.item)),
    ...times.sort((a, b) => a.at - b.at).map((entry) => entry.item),
    ...entries,
  ];
}

/** Drop repeats of the same label — see the call site. Order is preserved. */
function dedupeLevelItems(items: ReadonlyArray<UpNextItem>): ReadonlyArray<UpNextItem> {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A published condition as `findUnarmedEntryConditions` wants it.
 *
 * Same structural read as {@link readConditionDescription}: the decoded form is
 * always the object, but the TS type is the input union, so the hints are
 * reached through a guard rather than a cast. Null when there is no prose at
 * all — a condition with no description is not a condition.
 */
function readConditionHint(condition: unknown): {
  readonly description: string;
  readonly priceLevel?: number | undefined;
  readonly timeframe?: TradingTimeframe | undefined;
} | null {
  const description = readConditionDescription(condition);
  if (description === null) return null;
  const hints = condition as {
    readonly priceLevel?: unknown;
    readonly timeframe?: unknown;
  };
  return {
    description,
    ...(typeof hints.priceLevel === "number" ? { priceLevel: hints.priceLevel } : {}),
    ...(typeof hints.timeframe === "string"
      ? { timeframe: hints.timeframe as TradingTimeframe }
      : {}),
  };
}

/**
 * A dollar figure with its cents, for the strip.
 *
 * {@link formatUsd} rounds to whole dollars, which is right for a plan's size
 * and wrong for a $0.50 stop risk on a POC-sized position — the whole figure
 * would round to "$1" or vanish to "$0".
 */
const formatUsdPrecise = (value: number): string => `$${Math.abs(value).toFixed(2)}`;

/** A drawable chart level derived from one armed watch. */
export interface DrawableCondition {
  readonly price: number;
  readonly direction: "above" | "below";
  readonly met: boolean;
}

/**
 * The exposure a PnL watch has to be resolved against to become a price.
 *
 * Both figures come from the position snapshot. `size` is signed — that sign is
 * what decides which way price has to move for PnL to rise.
 */
export interface PnlLevelBasis {
  readonly entryPrice: number;
  readonly size: number;
}

/**
 * Turn an unrealised-PnL threshold into the price that produces it.
 *
 * `pnl = size × (mark − entry)`, so `mark = entry + pnl / size`. The signed
 * size carries the direction for free: a short's `size` is negative, so a
 * profit target resolves BELOW its entry, which is exactly where a short's
 * profit lives. Null without an exposure to divide by — a flat mission's PnL
 * watch has no price, and inventing one would put a line on the chart at a
 * level nothing is actually watching.
 */
export function derivePnlLevelPrice(valueUsd: number, basis: PnlLevelBasis | null): number | null {
  if (basis === null || basis.size === 0) return null;
  return basis.entryPrice + valueUsd / basis.size;
}

/**
 * The armed price levels a chart can draw; nearest-first is the caller's job.
 *
 * Three watch types resolve to a y. `price_cross` and `candle_close` carry a
 * price outright. `pnl_above` and `pnl_below` carry one too, once there is a
 * position to resolve them against — and those are the levels that matter most
 * while exposed, because they are where the plan has decided to bank a winner
 * or cut a loser. They used to be dropped as "no y on a price chart", which was
 * true only of a flat mission.
 *
 * `pnl_giveback` still has no level: it is measured from the position's peak
 * unrealised PnL, and `TradingPositionView` does not carry the peak even though
 * the reconciler records it. It stays a checklist row until the projection
 * surfaces `peakUnrealisedPnl`.
 *
 * A `pnl_above` line is drawn at the price that produces its threshold GROSS,
 * while the evaluator fires it net of the exit fee — so the real wake sits a
 * fee's worth further out (cents of price on a position this size). The
 * projection carries no fee rate, and a line drawn from a guessed one would be
 * wrong in a way nothing could check.
 */
export function deriveChartConditions(
  mission: { readonly watches: ReadonlyArray<PersistedWatch> },
  /** The open position, when there is one. Null while flat. */
  basis: PnlLevelBasis | null = null,
): ReadonlyArray<DrawableCondition> {
  const drawable: DrawableCondition[] = [];

  for (const persisted of mission.watches) {
    if (persisted.status !== "active" && persisted.status !== "triggered") continue;
    // A watch that has already fired is context while the position it fired
    // for is still open — "this is the level that woke me". Once the mission
    // is flat it is a level nothing is waiting on, and leaving it drawn is how
    // a closed trade's stop and target stayed on the chart with ticks beside
    // them for the rest of the session.
    if (persisted.status === "triggered" && basis === null) continue;
    const watch = persisted.watch;
    const met = persisted.status === "triggered";

    if (watch.type === "price_cross" || watch.type === "candle_close") {
      drawable.push({ price: watch.price, direction: watch.direction, met });
      continue;
    }

    if (watch.type === "pnl_above" || watch.type === "pnl_below") {
      const valueUsd = watch.valueUsd;
      const price = derivePnlLevelPrice(valueUsd, basis);
      if (price === null) continue;
      // Which way price must move to satisfy the watch. PnL rises with price
      // on a long and falls with it on a short, so a short's profit target is
      // a "below" and its loss floor is an "above".
      const pnlRisesWithPrice = basis!.size > 0;
      const wantsPnlUp = watch.type === "pnl_above";
      drawable.push({
        price,
        direction: wantsPnlUp === pnlRisesWithPrice ? "above" : "below",
        met,
      });
    }
  }

  return drawable;
}

/**
 * The moment the plan's armed entry triggers stop being the current plan.
 *
 * A plan states how long it stays fresh untriggered (`reassess.afterMinutes`),
 * measured from the publish that authored it. That is the honest right-hand
 * bound on drawing an entry trigger into the future: past it the mission is
 * meant to be reassessing, not still waiting at that price.
 *
 * Null once there is a position — `reassess` is about an *untriggered* plan,
 * and the levels a holding mission watches (its profit rung, its stop
 * proximity) are not on that clock. Null too without a plan to read.
 */
export function deriveTriggerExpiryMillis(mission: {
  readonly position?: { readonly size: number } | null;
  readonly strategy: {
    readonly updatedAt: number;
    readonly reassess: { readonly afterMinutes: number };
  } | null;
}): number | null {
  const strategy = mission.strategy;
  if (strategy === null) return null;
  if ((mission.position?.size ?? 0) !== 0) return null;
  const minutes = strategy.reassess?.afterMinutes;
  if (typeof minutes !== "number" || !(minutes > 0)) return null;
  return strategy.updatedAt + minutes * 60_000;
}

/**
 * What a fill was, in the one dimension a chart marker can carry.
 *
 * An open and a close are the two ends of a position's life, and a close is
 * worth colouring by what it realised — the chart is then a record of every
 * position the session took, not only the one it is in.
 */
export type ChartFillKind = "open" | "close_profit" | "close_loss" | "close_flat" | "unknown";

/** One fill, ready to be placed on the chart's time axis. */
export interface ChartFillMarker {
  readonly key: string;
  /** Epoch millis of the fill. */
  readonly at: number;
  readonly price: number;
  readonly kind: ChartFillKind;
}

/**
 * Every fill in the mission, as markers for the chart's time axis.
 *
 * The panel used to draw only the current entry, so a session that had opened
 * and closed twice before the trade on screen showed no sign of either. These
 * are the session's activity: where it went in, where it came out, and whether
 * coming out paid.
 *
 * A fill whose `direction` the exchange did not label reads as `unknown` rather
 * than being guessed at — `side` alone cannot tell an open from a close.
 * Unparseable timestamps are dropped; there is no honest x for them.
 */
export function deriveChartFillMarkers(mission: {
  readonly recentFills: ReadonlyArray<{
    readonly orderId: number;
    readonly tradedAt: string;
    readonly avgFillPrice: number;
    readonly closedPnl: number;
    readonly direction?: string | undefined;
  }>;
}): ReadonlyArray<ChartFillMarker> {
  const markers: ChartFillMarker[] = [];

  for (const fill of mission.recentFills) {
    const at = Date.parse(fill.tradedAt);
    if (Number.isNaN(at)) continue;

    const lifecycle = readFillLifecycle(fill.direction);
    const kind: ChartFillKind =
      lifecycle === null
        ? "unknown"
        : lifecycle.action === "open"
          ? "open"
          : fill.closedPnl > 0
            ? "close_profit"
            : fill.closedPnl < 0
              ? "close_loss"
              : "close_flat";

    markers.push({ key: `${fill.orderId}-${fill.tradedAt}`, at, price: fill.avgFillPrice, kind });
  }

  return markers;
}

/**
 * One completed round trip: a position taken on and given back.
 *
 * The stat grid describes the exposure the mission is in. This describes the
 * ones it is out of — which the panel had nowhere to say at all, so a session
 * that had opened and closed three times before the trade on screen showed the
 * chart's fill markers and nothing that named what they came to.
 */
export interface RoundTrip {
  /** The side of the exposure, not the side of either order. */
  readonly direction: "long" | "short";
  /** What came back out, in base units. */
  readonly size: number;
  /** Null when the opening fill is older than the projection's fill window. */
  readonly entryPrice: number | null;
  readonly exitPrice: number;
  /** What the pair actually paid: realised PnL less BOTH legs' fees. */
  readonly netUsd: number;
  /** The realised PnL the exchange attributed, before fees. */
  readonly closedPnlUsd: number;
  /** Both legs' fees. Only the closing leg's when the open is off the window. */
  readonly feesUsd: number;
  readonly closedAtMillis: number;
  readonly openedAtMillis: number | null;
  /** The closing order's id. */
  readonly orderRef: string;
  /** The opening order's id, when that fill is still in the window. */
  readonly openOrderRef: string | null;
}

/** An opening leg waiting for the close, or closes, that will pair with it. */
interface OpenLeg {
  readonly price: number;
  /** The whole leg's fee. A close pays the share of it that it consumes. */
  readonly feeUsd: number;
  /** Base units the leg opened with — the denominator of that share. */
  readonly size: number;
  /** Base units not yet paired with a close. */
  remaining: number;
  readonly atMillis: number;
  readonly orderRef: string;
}

/**
 * Base units below which a leg counts as consumed.
 *
 * Sizes come off the exchange as decimals and the arithmetic that pairs them
 * is subtraction, so a leg closed exactly can be left holding 1e-17 of itself.
 */
const LEG_DUST = 1e-9;

/**
 * Every completed round trip in the mission's fill window, newest first.
 *
 * Fills are walked oldest-first and paired per side: an open pushes a leg, a
 * close pops the oldest leg on its side and emits the pair. A reversal is both
 * at once — "Long > Short" closes the long and opens the short — so it is
 * handled as the two events it is rather than as a third kind of thing.
 *
 * Two honest gaps, both left visible rather than papered over:
 *
 *   - The projection carries a bounded window of fills, so a close whose open
 *     scrolled off it still yields a round trip, with `entryPrice: null`. The
 *     alternative is dropping a position the mission genuinely held.
 *   - The size reported is the size that came OUT, so partial closes read as
 *     one round trip per closing fill — which is what the operator watched
 *     happen.
 *
 * Legs are consumed BY SIZE (plan 34 step 4): a close takes as much of the
 * oldest open leg as it needs, splitting it and leaving the remainder for the
 * next close, and pays that fraction of the leg's fee. Popping a whole leg per
 * closing fill charged the entire opening fee to whichever rung happened to
 * close first — a $0.03 profit read as a $0.30 loss, and the two rungs behind
 * it reported no entry price at all, while the column total stayed right.
 *
 * The position currently open has no closing leg, so it never appears here —
 * it is the stat grid's subject, not this band's.
 */
export function deriveRoundTrips(
  fills: ReadonlyArray<{
    readonly orderId: number;
    readonly tradedAt: string;
    readonly filledSize: number;
    readonly avgFillPrice: number;
    readonly feeUsd: number;
    readonly closedPnl: number;
    readonly direction?: string | undefined;
  }>,
): ReadonlyArray<RoundTrip> {
  // The projection hands these over newest first; pairing only makes sense in
  // the order they happened.
  const chronological = fills
    .map((fill) => ({ fill, at: Date.parse(fill.tradedAt) }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => a.at - b.at);

  const openLegs: Record<"long" | "short", OpenLeg[]> = { long: [], short: [] };
  const trips: RoundTrip[] = [];

  /** Base units of a side the window still shows as open. */
  const openExposure = (direction: "long" | "short"): number =>
    openLegs[direction].reduce((sum, leg) => sum + leg.remaining, 0);

  /** Pair a closing fill against the open legs, and report what it consumed. */
  const closeOut = (
    direction: "long" | "short",
    entry: { readonly fill: (typeof chronological)[number]["fill"]; readonly at: number },
    closingSize: number,
  ): number => {
    const legs = openLegs[direction];
    let unpaired = closingSize;
    let consumedSize = 0;
    let consumedNotional = 0;
    let openFeeUsd = 0;
    let firstLeg: OpenLeg | null = null;

    while (unpaired > LEG_DUST && legs.length > 0) {
      const leg = legs[0]!;
      const taken = Math.min(leg.remaining, unpaired);
      firstLeg ??= leg;
      consumedSize += taken;
      consumedNotional += taken * leg.price;
      openFeeUsd += leg.size > 0 ? (leg.feeUsd * taken) / leg.size : 0;
      leg.remaining -= taken;
      unpaired -= taken;
      if (leg.remaining <= LEG_DUST) legs.shift();
    }

    const feesUsd = entry.fill.feeUsd + openFeeUsd;
    trips.push({
      direction,
      size: closingSize,
      entryPrice: consumedSize > 0 ? consumedNotional / consumedSize : null,
      exitPrice: entry.fill.avgFillPrice,
      netUsd: entry.fill.closedPnl - feesUsd,
      closedPnlUsd: entry.fill.closedPnl,
      feesUsd,
      closedAtMillis: entry.at,
      openedAtMillis: firstLeg?.atMillis ?? null,
      orderRef: String(entry.fill.orderId),
      openOrderRef: firstLeg?.orderRef ?? null,
    });
    return consumedSize;
  };

  for (const entry of chronological) {
    const lifecycle = readFillLifecycle(entry.fill.direction);
    // A fill the exchange did not label is not guessed at: `side` alone cannot
    // tell an open from a close, and a wrong pairing invents a position.
    if (lifecycle === null) continue;

    if (lifecycle.action === "open" || lifecycle.action === "reverse") {
      // A reversal gives back the other side before it takes this one on. It
      // is one fill and so one fee: it is charged to the close, and the open
      // leg it also is carries none — charging it twice would overstate the
      // cost of both round trips.
      const isReverse = lifecycle.action === "reverse";
      const filledSize = Math.abs(entry.fill.filledSize);
      // A reversal's fill size covers both halves: it gives back everything
      // the other side held and takes on the rest. When that side is not in
      // the window at all, the split is unknowable, so both halves are
      // reported at the whole fill rather than one of them at zero.
      const heldOnTheOtherSide = isReverse
        ? openExposure(lifecycle.direction === "long" ? "short" : "long")
        : 0;
      if (isReverse) {
        closeOut(
          lifecycle.direction === "long" ? "short" : "long",
          entry,
          heldOnTheOtherSide > 0 ? Math.min(filledSize, heldOnTheOtherSide) : filledSize,
        );
      }
      const openedSize =
        isReverse && heldOnTheOtherSide > 0
          ? filledSize - Math.min(filledSize, heldOnTheOtherSide)
          : filledSize;
      if (openedSize > LEG_DUST) {
        openLegs[lifecycle.direction].push({
          price: entry.fill.avgFillPrice,
          feeUsd: isReverse ? 0 : entry.fill.feeUsd,
          size: openedSize,
          remaining: openedSize,
          atMillis: entry.at,
          orderRef: String(entry.fill.orderId),
        });
      }
      continue;
    }

    closeOut(lifecycle.direction, entry, Math.abs(entry.fill.filledSize));
  }

  // Built oldest-first because that is the only order pairing works in;
  // rendered newest-first because that is the order the band reads in.
  return trips.toReversed();
}

/**
 * One line of the position ledger: a position the mission holds, or held.
 *
 * The band used to show only what the mission was out of, which left the
 * position it is IN described nowhere near the ones it came from — the operator
 * could see three finished trades and their sizes, and had to look at a
 * different block to learn what the fourth one was. One list, open row first,
 * and the same five figures on every row.
 */
export interface PositionLedgerRow {
  /** Stable across polls, so React does not remount a row every 3s. */
  readonly key: string;
  /** True for the position still open: its exit figure is the live mark. */
  readonly isActive: boolean;
  readonly direction: "long" | "short";
  readonly size: number;
  /** Null when the opening fill is older than the projection's fill window. */
  readonly entryPrice: number | null;
  /** The closing fill's price, or the live mark while the position is open. */
  readonly exitPrice: number | null;
  /**
   * What the position committed: size at the price it was opened at.
   *
   * Null rather than approximated when the opening price is unknown. The exit
   * price is not a stand-in — a position that ran a long way would report a
   * notional it never had, and the ledger states no figure it was not given.
   */
  readonly notionalUsd: number | null;
  /** Realised net for a closed row; unrealised P&L for the open one. */
  readonly netUsd: number;
  /** Exchange-attributed realised PnL. Null while the position is open. */
  readonly closedPnlUsd: number | null;
  /** Both legs' fees. Null while the position is open: the close has not paid. */
  readonly feesUsd: number | null;
  /** Margin the exchange holds against the open position. Null once closed. */
  readonly marginUsd: number | null;
  readonly openedAtMillis: number | null;
  /** Null while the position is open. */
  readonly closedAtMillis: number | null;
  readonly orderRef: string | null;
  readonly openOrderRef: string | null;
}

/**
 * Every position the mission has taken, open one first, newest first after it.
 *
 * The open position has no closing leg and so is not a round trip; it is folded
 * in here rather than in {@link deriveRoundTrips}, which stays the pure pairing
 * of fills it was. Its exit column is the live mark, which is the honest reading
 * of "where this position is now" and the reason the row can be told apart from
 * a settled one without a colour of its own.
 */
export function derivePositionLedger(input: {
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly unrealisedPnl: number;
    readonly marginUsed?: number | undefined;
    readonly observedAt?: string | undefined;
  } | null;
  readonly markPrice: number | null;
  readonly trips: ReadonlyArray<RoundTrip>;
  /**
   * When the open position's own entry fill landed, where the panel already
   * knows it (the chart marks the same moment). The position snapshot carries
   * no opening time, and the alternative was walking the fills a second time.
   */
  readonly openedAtMillis: number | null;
}): ReadonlyArray<PositionLedgerRow> {
  const closed: PositionLedgerRow[] = input.trips.map((trip) => ({
    key: `${trip.orderRef}-${trip.closedAtMillis}`,
    isActive: false,
    direction: trip.direction,
    size: trip.size,
    entryPrice: trip.entryPrice,
    exitPrice: trip.exitPrice,
    notionalUsd: trip.entryPrice === null ? null : trip.size * trip.entryPrice,
    netUsd: trip.netUsd,
    closedPnlUsd: trip.closedPnlUsd,
    feesUsd: trip.feesUsd,
    marginUsd: null,
    openedAtMillis: trip.openedAtMillis,
    closedAtMillis: trip.closedAtMillis,
    orderRef: trip.orderRef,
    openOrderRef: trip.openOrderRef,
  }));

  const position = input.position;
  if (position === null || position.size === 0) return closed;

  const size = Math.abs(position.size);
  const entryPrice = position.entryPrice ?? null;
  return [
    {
      key: "open-position",
      isActive: true,
      direction: position.size > 0 ? "long" : "short",
      size,
      entryPrice,
      exitPrice: input.markPrice,
      notionalUsd: entryPrice === null ? null : size * entryPrice,
      netUsd: position.unrealisedPnl,
      closedPnlUsd: null,
      feesUsd: null,
      marginUsd: position.marginUsed ?? null,
      openedAtMillis: input.openedAtMillis,
      closedAtMillis: null,
      orderRef: null,
      openOrderRef: null,
    },
    ...closed,
  ];
}

/**
 * The next scheduled reassessment, as epoch millis, or null when none is armed.
 *
 * Separate from {@link deriveWatchConditions} because it is wanted in states
 * that function is not called for: a reassessment is scheduled just as often
 * while a position is open as while one is being waited for, and the chart
 * marks it on the axis either way.
 */
export function deriveNextReassessmentAt(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
}): number | null {
  let next: number | null = null;
  for (const persisted of mission.watches) {
    if (persisted.status !== "active") continue;
    const watch = persisted.watch;
    if (watch.type !== "scheduled_reassessment") continue;
    if (next === null || watch.runAt < next) next = watch.runAt;
  }
  return next;
}

/** One past event, ready to hand to the chart's `pastMarkers` input. */
export interface ChartPastMarkerInput {
  readonly key: string;
  readonly kind: string;
  /** Epoch millis — the projection sends ISO, the axis wants a number. */
  readonly at: number;
  readonly cause?: string;
  readonly failed?: boolean;
}

/**
 * The mission's own turns, as ticks for the time axis — plan 24 §4.2.
 *
 * `missionTimeline` is newest-first and already bounded server-side, so this is
 * a parse and a filter rather than a derivation: entries whose `at` will not
 * parse are dropped, because a tick at a time it did not happen is worse than
 * no tick. The order is preserved, which is what lets the geometry's cap drop
 * the oldest rather than the nearest.
 *
 * A failed run is read off the label the projection composed — the entry
 * carries the raw cause separately, so the suffix is the only place the outcome
 * lives.
 */
export function deriveChartPastMarkers(mission: {
  readonly missionTimeline?:
    | ReadonlyArray<{
        readonly at: string;
        readonly kind: string;
        readonly label: string;
        readonly cause?: string | undefined;
      }>
    | undefined;
}): ReadonlyArray<ChartPastMarkerInput> {
  const markers: ChartPastMarkerInput[] = [];
  (mission.missionTimeline ?? []).forEach((entry, index) => {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return;
    markers.push({
      // The timeline carries no id of its own, and two wakes can share a
      // millisecond only if they share an index too.
      key: `${entry.kind}-${index}-${entry.at}`,
      kind: entry.kind,
      at,
      ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      ...(entry.label.endsWith("(failed)") ? { failed: true } : {}),
    });
  });
  return markers;
}

/** How many future ticks the chart's gutter holds before it says "+N". */
export const MAX_DRAWN_TIME_MARKERS = 5;

/**
 * One future moment, ready to hand to the chart's `timeMarkers` input.
 *
 * `tone` separates the two kinds of schedule the mission keeps: `auto` is the
 * runtime's staleness floor — a backstop nobody chose — and `planned` is a time
 * the harness itself armed because it wants to see that moment. Drawing them
 * identically reads as "the plan has five appointments" when four of them are
 * the floor rearming itself.
 */
export interface ChartTimeMarkerInput {
  readonly key: string;
  /** Empty on every tick but the nearest: five captions in one gutter collide. */
  readonly label: string;
  readonly at: number;
  readonly tone: "auto" | "planned";
}

/**
 * Every armed reassessment, as ticks on the axis — not only the nearest.
 *
 * The panel drew one marker, from {@link deriveNextReassessmentAt}, which is
 * the countdown the header already shows. A mission that has republished a few
 * times can be holding several scheduled reassessments at once, and the shape
 * of that queue — three minutes apart and all `auto`, versus one at the funding
 * timestamp — is the difference between a loop idling and a plan waiting.
 *
 * Capped at {@link MAX_DRAWN_TIME_MARKERS}: beyond that the last slot becomes a
 * `+N` tick standing at the furthest moment, so the axis still says how far the
 * schedule reaches without drawing a picket fence.
 */
export function deriveChartTimeMarkers(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ReadonlyArray<ChartTimeMarkerInput> {
  const scheduled: ChartTimeMarkerInput[] = [];
  for (const persisted of mission.watches) {
    if (persisted.status !== "active") continue;
    const watch = persisted.watch;
    if (watch.type !== "scheduled_reassessment") continue;
    scheduled.push({
      // Replaced by a rank-based key once sorted; see below.
      key: persisted.id,
      label: "",
      at: watch.runAt,
      tone: persisted.armedReason === "staleness_floor" ? "auto" : "planned",
    });
  }
  if (scheduled.length === 0) return [];

  scheduled.sort((a, b) => a.at - b.at);

  // Re-keyed by rank once sorted, so the chart can render the queue as a set of
  // moving markers rather than as a set of rows. A reassessment is re-armed on
  // every wake: the old watch is consumed and a new row takes its place minutes
  // further out. Keyed by row id that is one marker unmounting and another
  // mounting, so the rule vanishes from one x and appears at another. Keyed by
  // rank, the nearest reassessment is one continuous thing whatever row is
  // currently carrying it, and the renderer can ease it to its new moment —
  // which is what makes a reset legible as a reset.
  const ranked = scheduled.map((marker, index) => ({ ...marker, key: `reassess-${index}` }));

  const nearest = ranked[0]!;
  const labelled: ChartTimeMarkerInput[] = [
    { ...nearest, label: nearest.tone === "auto" ? "reassess (auto)" : "reassess" },
    ...ranked.slice(1),
  ];
  if (labelled.length <= MAX_DRAWN_TIME_MARKERS) return labelled;

  const hidden = labelled.length - (MAX_DRAWN_TIME_MARKERS - 1);
  return [
    ...labelled.slice(0, MAX_DRAWN_TIME_MARKERS - 1),
    {
      key: "reassess-overflow",
      label: `+${hidden}`,
      // The furthest moment, so the tick marks how far out the queue runs
      // rather than piling onto the ones already drawn.
      at: labelled[labelled.length - 1]!.at,
      tone: "planned",
    },
  ];
}

/**
 * How long ago something happened, in the coarsest true words: "just now",
 * "4m ago", "1h 12m ago".
 *
 * Deliberately not {@link formatDuration}. A stream of rows all reading
 * "armed 8m 47s ago" reprints every second, so every row looks freshly minted
 * and the eye is pulled to whichever digits happen to be changing — while the
 * seconds themselves answer nothing about a level armed eight minutes ago.
 * Countdowns keep their seconds (the bottom bar really is counting one down);
 * ages lose them the moment a minute has passed.
 */
export function formatAge(millis: number): string {
  const totalSeconds = Math.max(0, Math.floor(millis / 1_000));
  if (totalSeconds < 60) return "just now";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
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
 * is free again — the terminal row itself stays as history (plan 27 H1).
 */
export function isLiveMission(status: string): boolean {
  return status !== "revoked" && status !== "completed";
}
