/**
 * Getting out — the one tool for everything that removes or protects exposure.
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
 * So `trading_exit` takes almost nothing: an `action`, and only the fields
 * that action cannot derive. And getting out is the one thing that must never
 * fail for a reason belonging to getting in, which is why it does not share
 * the entry path's input at all.
 *
 * @module TradingExit
 */
import { Effect, Schema } from "effect";

import { Price, TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { StopAdjustmentJustification } from "./stopAdjustment.ts";
import { TradingUrgency } from "./strategy.ts";

export const TRADING_EXIT_TOOL = "trading_exit";

/**
 * The four things a mission does to exposure it already has — plan 29 step 6.5.
 *
 * `trading_close_position`, `trading_reduce_position`, `trading_cancel_order`
 * and `trading_exit`'s `move_stop` were four names for one decision class: this
 * position, or the orders standing behind it, should be smaller or safer than
 * it is. They are one tool with an `action` because the model was choosing
 * between four descriptions of the same situation before it could act on it.
 *
 * `move_stop` is here rather than with the plan for the reason that matters:
 * a stop is a resting reduce-only order, and it answers to the exit path's
 * gates, not the plan's. Its policy — the approved envelope, the ATR step cap,
 * the noise floor, the breakeven ratchet, the rate limit — is unchanged and
 * still runs in `TradingStopAdjustmentService` before anything reaches the
 * exchange.
 */
export const TradingExitAction = Schema.Literals(["close", "reduce", "cancel_order", "move_stop"]);
export type TradingExitAction = typeof TradingExitAction.Type;

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

/**
 * One call, one `action`, and only the fields that action needs.
 *
 * Deliberately a flat struct rather than a discriminated union of four: the
 * tool boundary rejects a root `anyOf`, and a harness filling in a flat object
 * has one schema to read instead of four. The combinations that do not make
 * sense — a `reduce` naming no size, a `cancel_order` naming no `cloid` — are
 * refused by name at the handler with a `recovery`, not guessed at.
 */
export const TradingExitInput = Schema.Struct({
  ...missionBound,
  action: TradingExitAction,
  /** Defaults to the market the mission is mandated to. Ignored by `cancel_order`. */
  market: Schema.optional(TradingMarket),
  /** `reduce` only: base units to remove, clamped to what is actually held. */
  sizeEth: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** `reduce` only: share of the position to remove, 0–1. `0.5` takes half off. */
  fraction: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
  ),
  /** `cancel_order` only: the client order id of the resting order to withdraw. */
  cloid: Schema.optional(Schema.String),
  /** `move_stop` only: where the stop should rest. */
  newStopPrice: Schema.optional(Price),
  /** `move_stop` only: which of the named reasons this move is. */
  justification: Schema.optional(StopAdjustmentJustification),
  /**
   * `move_stop` only: the `updatedAt` of the plan the harness last read. A move
   * asked against a plan the server has since revised is refused.
   */
  expectedPlanUpdatedAt: Schema.optional(UnixMillis),
  /** `close` and `reduce` only. `patient` rests at the near side. */
  urgency: UrgencyWithDefault,
});
export type TradingExitInput = typeof TradingExitInput.Type;

/**
 * Why an exit call did not name an exit.
 *
 * These are rules about the call, so the identical call gets the identical
 * answer and the recovery is always a stand-down. Nothing was sent.
 */
export const TradingExitRefusalCode = Schema.Literals([
  /** `reduce` naming neither `sizeEth` nor `fraction`, or naming both. */
  "reduce_needs_one_size",
  /** `cancel_order` with no `cloid` to withdraw. */
  "cancel_needs_cloid",
  /** `move_stop` missing `newStopPrice`, `justification` or `expectedPlanUpdatedAt`. */
  "move_stop_needs_stop_and_plan",
]);
export type TradingExitRefusalCode = typeof TradingExitRefusalCode.Type;

/** A call the exit path will not act on, and why. Pure; costs no transaction. */
export interface TradingExitRefusal {
  readonly code: TradingExitRefusalCode;
  readonly detail: string;
}

/**
 * Check one exit call names an exit, before anything is measured or sent.
 *
 * `null` means the call is well formed for its action. `close` names nothing
 * beyond the market, so it can never fail here.
 */
export function readExitRequest(input: {
  readonly action: TradingExitAction;
  readonly sizeEth?: number | undefined;
  readonly fraction?: number | undefined;
  readonly cloid?: string | undefined;
  readonly newStopPrice?: number | undefined;
  readonly justification?: string | undefined;
  readonly expectedPlanUpdatedAt?: number | undefined;
}): TradingExitRefusal | null {
  switch (input.action) {
    case "close":
      return null;
    case "reduce": {
      const named = Number(input.sizeEth !== undefined) + Number(input.fraction !== undefined);
      return named === 1
        ? null
        : {
            code: "reduce_needs_one_size",
            detail:
              "a reduce names exactly one of sizeEth or fraction; to remove the whole " +
              'position use action "close"',
          };
    }
    case "cancel_order":
      return input.cloid !== undefined && input.cloid.length > 0
        ? null
        : { code: "cancel_needs_cloid", detail: "name the cloid of the resting order to withdraw" };
    case "move_stop":
      return input.newStopPrice !== undefined &&
        input.justification !== undefined &&
        input.expectedPlanUpdatedAt !== undefined
        ? null
        : {
            code: "move_stop_needs_stop_and_plan",
            detail:
              "a stop move names newStopPrice, justification, and the expectedPlanUpdatedAt " +
              "of the plan you read it against",
          };
  }
}

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
