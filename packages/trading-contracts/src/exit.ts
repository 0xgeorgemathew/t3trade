/**
 * Getting out — the three actions that remove exposure, as their own contracts.
 *
 * Exiting used to be a shape of `trading_execute`: the harness hand-built an
 * intent with an action type of `reduce` or `close`, a side, a size, a limit
 * price, a strategy version, an authority version, a lease-owning run and a
 * monotonic sequence — the same eight-field ceremony an entry demands, for an
 * action that has no discretion in it at all. Every one of those fields is
 * either something the server already knows or something only the canonical
 * position can answer: the side of an exit is the opposite of what is held, and
 * the size of a close is all of it.
 *
 * So the tools here take almost nothing. `trading_close_position` takes a
 * market. `trading_reduce_position` takes a market and how much. And getting
 * out is the one thing that must never fail for a reason belonging to getting
 * in, which is why these do not share `trading_execute`'s input at all.
 *
 * @module TradingExit
 */
import { Effect, Schema } from "effect";

import { TradingId, TradingMarket } from "./primitives.ts";
import { TradingUrgency } from "./strategy.ts";

export const TRADING_CLOSE_POSITION_TOOL = "trading_close_position";
export const TRADING_REDUCE_POSITION_TOOL = "trading_reduce_position";
export const TRADING_CANCEL_ORDER_TOOL = "trading_cancel_order";

/**
 * Shared mission binding. Optional everywhere, as on every other tool: the
 * calling thread is bound to exactly one mission.
 */
const missionBound = {
  missionId: Schema.optional(TradingId),
} as const;

/**
 * How urgently an exit should land. Defaults to `now`, which crosses the spread
 * immediately; `patient` rests at the near side as a reduce-only maker order
 * that may never fill. The harness never names a time-in-force — the server
 * maps urgency to one and the execution result reports what went out.
 */
const UrgencyWithDefault = TradingUrgency.pipe(Schema.withDecodingDefault(Effect.succeed("now")));

export const TradingClosePositionInput = Schema.Struct({
  ...missionBound,
  /** Defaults to the market the mission is mandated to. */
  market: Schema.optional(TradingMarket),
  urgency: UrgencyWithDefault,
});
export type TradingClosePositionInput = typeof TradingClosePositionInput.Type;

/**
 * Take part of a position off.
 *
 * `sizeEth` and `fraction` are two ways to say the same thing; give one. Giving
 * neither reduces nothing and is refused rather than silently read as a close —
 * "close" is a different tool because it is a different decision.
 */
export const TradingReducePositionInput = Schema.Struct({
  ...missionBound,
  market: Schema.optional(TradingMarket),
  /** Base units to remove, clamped to what is actually held. */
  sizeEth: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Share of the position to remove, 0–1. `0.5` takes half off. */
  fraction: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
  ),
  urgency: UrgencyWithDefault,
}).check(
  Schema.makeFilter((input) => {
    const named = Number(input.sizeEth !== undefined) + Number(input.fraction !== undefined);
    return named === 1 || "Give exactly one of sizeEth or fraction.";
  }),
);
export type TradingReducePositionInput = typeof TradingReducePositionInput.Type;

export const TradingCancelOrderInput = Schema.Struct({
  ...missionBound,
  /** The client order id of the resting order to withdraw. */
  cloid: Schema.String,
});
export type TradingCancelOrderInput = typeof TradingCancelOrderInput.Type;

// ---------------------------------------------------------------------------
// Canonical sizing — the arithmetic, without a database or an exchange
// ---------------------------------------------------------------------------

/**
 * Why an exit could not be sized. None of these are about the market: they are
 * the three ways the request itself does not name an exit.
 */
export type ExitSizingRefusal = "no_position" | "no_size_named" | "size_rounds_to_zero";

export interface ExitSizingInput {
  /**
   * The canonical position, signed: positive is long, negative is short. The
   * exchange is the authority on this — never the intent, and never the last
   * fill the harness happens to remember.
   */
  readonly positionSize: number;
  /** The price the remainder would be worth, for the dust test. */
  readonly markPrice: number;
  readonly szDecimals: number;
  readonly minimumNotionalUsd: number;
  /** Absent for a close: a close is all of it, whatever the harness thinks. */
  readonly requestedSize?: number | undefined;
  readonly requestedFraction?: number | undefined;
  /** A close ignores both requests above and takes the whole position. */
  readonly closeWholePosition: boolean;
}

export interface ExitSizing {
  readonly refusal: null;
  /** Base units to send. Truncated to exchange precision, never rounded up. */
  readonly size: number;
  /** The side that closes the position — the opposite of the one held. */
  readonly side: "buy" | "sell";
  /** Signed size still held after this exit fills completely. */
  readonly remainingSize: number;
  /**
   * True when a partial reduce was promoted to a full exit because the
   * remainder would have been dust.
   */
  readonly promotedToClose: boolean;
  /** What the harness needs told, when the size it gets is not the size it asked for. */
  readonly note: string | null;
}

export interface ExitSizingRefused {
  readonly refusal: ExitSizingRefusal;
  readonly detail: string;
}

/** Floor to the exchange's size precision. An exit never rounds up. */
const truncate = (size: number, szDecimals: number): number => {
  const scale = 10 ** szDecimals;
  return Math.floor(size * scale) / scale;
};

/**
 * The size and side of one exit, from the canonical position.
 *
 * Two rules do the work. The side is derived, never taken: a reduce named with
 * the wrong side is an increase wearing a reduce's name. And a reduce that
 * would leave behind less than the exchange's minimum notional is promoted to a
 * full exit — dust is not a position anyone chose to hold, it is the residue of
 * one, and leaving it behind means the mission cannot go flat without a second
 * round trip it has no reason to make.
 */
export function resolveExitSize(input: ExitSizingInput): ExitSizing | ExitSizingRefused {
  const exposure = Math.abs(input.positionSize);
  if (exposure === 0) {
    return { refusal: "no_position", detail: "there is no open position to exit" };
  }

  const side = input.positionSize > 0 ? ("sell" as const) : ("buy" as const);
  const sign = input.positionSize > 0 ? 1 : -1;

  if (input.closeWholePosition) {
    return {
      refusal: null,
      size: exposure,
      side,
      remainingSize: 0,
      promotedToClose: false,
      note: null,
    };
  }

  const asked =
    input.requestedSize ??
    (input.requestedFraction === undefined ? undefined : exposure * input.requestedFraction);
  if (asked === undefined) {
    return {
      refusal: "no_size_named",
      detail: "name either sizeEth or fraction; to remove the whole position use the close tool",
    };
  }

  const clamped = Math.min(asked, exposure);
  const size = truncate(clamped, input.szDecimals);
  if (size <= 0) {
    return {
      refusal: "size_rounds_to_zero",
      detail: `${clamped} is smaller than one unit of this market's size precision`,
    };
  }

  // Rounded, not truncated: this is a report of what is left, not a size going
  // on the wire, and truncating a float artefact turns 0.1 into 0.0999.
  const scale = 10 ** input.szDecimals;
  const remainder = Math.round((exposure - size) * scale) / scale;
  const remainderIsDust = remainder > 0 && remainder * input.markPrice < input.minimumNotionalUsd;
  if (remainderIsDust) {
    return {
      refusal: null,
      size: exposure,
      side,
      remainingSize: 0,
      promotedToClose: true,
      note:
        `reducing by ${size} would leave ${remainder} behind, worth less than the ` +
        `$${input.minimumNotionalUsd} exchange minimum; the whole position was closed instead`,
    };
  }

  return {
    refusal: null,
    size,
    side,
    remainingSize: sign * remainder,
    promotedToClose: false,
    note: size < asked ? `clamped to the ${exposure} actually held` : null,
  };
}
