/**
 * Telling a broken market from a broken connection.
 *
 * Every failure the harness could see arrived as the same thing: a turn that
 * did not trade. A rate-limited fee read, a socket that dropped mid-request,
 * and an authority that genuinely forbids the direction all reached the model
 * as one undifferentiated refusal, and the model's only available response to
 * all three was to stand down. Two of the three would have worked on a second
 * attempt half a second later.
 *
 * So a failure carries two more things than its message: whether trying again
 * could plausibly change the answer, and what the harness should do instead if
 * it could not. Neither is a guess about the market. Both are properties of the
 * error itself, which is why they are derived here rather than reasoned about
 * in a prompt.
 *
 * @module TradingRecovery
 */
import { Schema } from "effect";

/**
 * What to do next. Deliberately four, because the harness's real options are
 * four: try the same call, get a fresh price, look at what is actually true
 * now, or accept that this turn is not going to trade.
 */
export const RecoveryAction = Schema.Literals([
  /** Transient. The same call, once, after `retryAfterMillis`. */
  "retry",
  /** The prices this was built on have moved. Cut a fresh quote. */
  "re_quote",
  /** Something durable changed. Read the mission, position, and orders first. */
  "read_state",
  /** A rule refused, and no amount of retrying changes a rule. */
  "stand_down",
]);
export type RecoveryAction = typeof RecoveryAction.Type;

/** How a failure should be treated, attached to the outcome that reports it. */
export const FailureRecovery = Schema.Struct({
  /** Whether the identical call could succeed on a second attempt. */
  retryable: Schema.Boolean,
  action: RecoveryAction,
  /**
   * How long to wait before that second attempt, in milliseconds. Zero for
   * anything not retryable — there is no delay that helps.
   */
  retryAfterMillis: Schema.Number,
  /** The class of failure, for the harness and for the funnel alike. */
  reason: Schema.String,
});
export type FailureRecovery = typeof FailureRecovery.Type;

/**
 * A rate limit answers slower than a dropped socket, and a dropped socket
 * answers immediately. One backoff for both would either hammer the rate limit
 * or make every network blip cost a second.
 */
const RATE_LIMIT_BACKOFF_MILLIS = 2_000;
const NETWORK_BACKOFF_MILLIS = 250;

const permanent = (action: RecoveryAction, reason: string): FailureRecovery => ({
  retryable: false,
  action,
  retryAfterMillis: 0,
  reason,
});

const transient = (reason: string, retryAfterMillis: number): FailureRecovery => ({
  retryable: true,
  action: "retry",
  retryAfterMillis,
  reason,
});

/** What the classifier can see of a failure without knowing which layer threw it. */
export interface ClassifiableFailure {
  /** The error's `_tag`, when it has one. */
  readonly tag?: string | undefined;
  /** The error's own sub-reason: `network`, `not_found`, a preview item, … */
  readonly reason?: string | undefined;
  /** HTTP status, when the failure came from a request. */
  readonly status?: number | undefined;
  /** Write-path stage when a service wraps the original failure. */
  readonly stage?: string | undefined;
  /** Structured wrapper detail, including the preview item when applicable. */
  readonly detail?: string | undefined;
}

/**
 * Classify one failure.
 *
 * The rule underneath every branch: retryable means the call could succeed
 * unchanged, and nothing that spends a nonce is ever classified that way from
 * here — a write whose outcome is unknown is settled by reading the receipt,
 * never by sending it again. Anything unrecognised is treated as permanent,
 * because the cost of retrying something that should not be retried is higher
 * than the cost of one extra stand-down.
 */
export function classifyFailure(failure: ClassifiableFailure): FailureRecovery {
  if (failure.tag === "TradingExecutionError" && failure.stage === "preview_rejected") {
    const item = /^([a-z_]+):/.exec(failure.detail ?? "")?.[1];
    return classifyFailure({ tag: "TradingPreviewRejection", reason: item });
  }
  switch (failure.tag) {
    case "HyperliquidRequestError": {
      if (failure.reason === "network" || failure.reason === "timeout") {
        return transient(`exchange_${failure.reason}`, NETWORK_BACKOFF_MILLIS);
      }
      const status = failure.status ?? 0;
      if (status === 429) return transient("exchange_rate_limited", RATE_LIMIT_BACKOFF_MILLIS);
      if (status >= 500) return transient("exchange_unavailable", RATE_LIMIT_BACKOFF_MILLIS);
      // A 4xx that is not a rate limit is the exchange saying the request was
      // wrong. Sending it again produces the same answer.
      return permanent("read_state", "exchange_rejected_request");
    }

    // The exchange answered; T3 could not read the answer. That is a contract
    // drift on our side, and the next identical call decodes identically.
    case "HyperliquidDecodeError":
      return permanent("stand_down", "exchange_response_unreadable");

    case "HyperliquidMarketError":
      return failure.reason === "unavailable"
        ? transient("market_temporarily_unavailable", RATE_LIMIT_BACKOFF_MILLIS)
        : permanent("stand_down", "market_not_found");

    // A nonce collision is the one write-side failure that is safe to retry:
    // the coordinator issues a new nonce, and the cloid is unchanged, so the
    // exchange still sees one order.
    case "HyperliquidNonceError":
      return transient("nonce_conflict", NETWORK_BACKOFF_MILLIS);

    case "HyperliquidIdentityError":
      return permanent("stand_down", "identity_misconfigured");

    case "TradingPreviewRejection":
      // A refused check is a verdict about this intent, not about the
      // connection. One of them is worth re-quoting rather than abandoning:
      // it is about numbers that were current a moment ago. The other
      // historical re-quote — a stale strategy version — left the checklist
      // with plan-29 §3.3.
      return failure.reason === "account_and_bbo_fresh"
        ? permanent("re_quote", `preview_${failure.reason}`)
        : permanent("stand_down", `preview_${failure.reason ?? "rejected"}`);

    default:
      return permanent("read_state", failure.reason ?? failure.tag ?? "unknown");
  }
}

/**
 * Classify a failure that only survives as a sentence.
 *
 * A refusal recorded in the mission inbox is a string by the time the tool
 * reads it back — the cause it came from was squashed to one line and stored.
 * Every tagged error in this system renders as `Tag(reason): detail`, so the
 * two fields the classifier needs are still in there, and recovering them from
 * the message is better than classifying the whole class of refusals as
 * unknown.
 */
export function classifyFailureMessage(message: string): FailureRecovery {
  const wrappedPreview = /TradingExecutionError\(preview_rejected\):\s*([a-z_]+):/.exec(message);
  if (wrappedPreview !== null) {
    return classifyFailure({ tag: "TradingPreviewRejection", reason: wrappedPreview[1] });
  }
  const match = /([A-Za-z]+Error|[A-Za-z]+Rejection)\(([a-z_]+)\)/.exec(message);
  if (match === null) return permanent("read_state", "unknown");
  return classifyFailure({ tag: match[1], reason: match[2] });
}

/**
 * Read a classifiable shape off an unknown error.
 *
 * Effect's tagged errors all carry `_tag`; most of the ones that matter here
 * also carry `reason` or `status`. Anything that carries none of them falls
 * through to the permanent default, which is the safe direction.
 */
export function classifyUnknownFailure(error: unknown): FailureRecovery {
  if (typeof error !== "object" || error === null) {
    return permanent("read_state", "unknown");
  }
  const shape = error as Record<string, unknown>;
  return classifyFailure({
    tag: typeof shape["_tag"] === "string" ? shape["_tag"] : undefined,
    reason:
      typeof shape["reason"] === "string"
        ? shape["reason"]
        : typeof shape["item"] === "string"
          ? shape["item"]
          : undefined,
    status: typeof shape["status"] === "number" ? shape["status"] : undefined,
    stage: typeof shape["stage"] === "string" ? shape["stage"] : undefined,
    detail: typeof shape["detail"] === "string" ? shape["detail"] : undefined,
  });
}
