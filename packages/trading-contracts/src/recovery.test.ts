/**
 * Retryable versus final — step 6 of the viability plan.
 *
 * The whole value of this module is that it never says "retry" about something
 * that spent a nonce and never says "stand down" about a dropped socket, so
 * both halves are pinned here.
 */
import { assert, describe, it } from "@effect/vitest";

import { classifyFailure, classifyFailureMessage, classifyUnknownFailure } from "./recovery.ts";

describe("classifyFailure", () => {
  it("treats a dropped connection and a timeout as worth one more try", () => {
    for (const reason of ["network", "timeout"]) {
      const recovery = classifyFailure({ tag: "HyperliquidRequestError", reason });
      assert.strictEqual(recovery.retryable, true);
      assert.strictEqual(recovery.action, "retry");
      assert.isAbove(recovery.retryAfterMillis, 0);
    }
  });

  it("waits longer for a rate limit than for a blip", () => {
    const limited = classifyFailure({
      tag: "HyperliquidRequestError",
      reason: "http_error",
      status: 429,
    });
    const blip = classifyFailure({ tag: "HyperliquidRequestError", reason: "network" });

    assert.strictEqual(limited.retryable, true);
    assert.isAbove(limited.retryAfterMillis, blip.retryAfterMillis);
  });

  it("retries a server error and gives up on a client error", () => {
    const server = classifyFailure({
      tag: "HyperliquidRequestError",
      reason: "http_error",
      status: 503,
    });
    assert.strictEqual(server.retryable, true);

    const client = classifyFailure({
      tag: "HyperliquidRequestError",
      reason: "http_error",
      status: 422,
    });
    assert.strictEqual(client.retryable, false);
    assert.strictEqual(client.action, "read_state");
  });

  it("sends a stale-price refusal back for a fresh quote, not a retry", () => {
    const stale = classifyFailure({
      tag: "TradingPreviewRejection",
      reason: "account_and_bbo_fresh",
    });
    assert.strictEqual(stale.retryable, false);
    assert.strictEqual(stale.action, "re_quote");

    // A rule that refused is a rule. Re-quoting will not change it.
    const rule = classifyFailure({ tag: "TradingPreviewRejection", reason: "direction_permitted" });
    assert.strictEqual(rule.action, "stand_down");
  });

  it("separates a condition that is wrong from a mission that has ended", () => {
    // Both refuse the same call, and the harness's next move is different:
    // one is fixed by saying a different condition, the other by looking.
    const badCondition = classifyFailure({
      tag: "TradingWatchRefusal",
      reason: "close_needs_interval",
    });
    assert.strictEqual(badCondition.action, "stand_down");
    assert.strictEqual(badCondition.reason, "watch_close_needs_interval");

    const gone = classifyFailure({ tag: "TradingWatchRefusal", reason: "mission_not_found" });
    assert.strictEqual(gone.action, "read_state");
    assert.strictEqual(gone.retryable, false);
  });

  it("retries a nonce conflict, because the cloid is what the exchange dedupes on", () => {
    const conflict = classifyFailure({ tag: "HyperliquidNonceError" });
    assert.strictEqual(conflict.retryable, true);
  });

  it("never calls an unrecognised failure retryable", () => {
    // Retrying something that should not be retried costs more than one extra
    // stand-down, so the default falls the safe way.
    const unknown = classifyFailure({ tag: "SomethingNobodyHasWrittenYet" });
    assert.strictEqual(unknown.retryable, false);

    assert.strictEqual(classifyUnknownFailure("a bare string").retryable, false);
    assert.strictEqual(classifyUnknownFailure(null).retryable, false);
  });

  it("reads the tag and reason back out of a refusal that survived as a sentence", () => {
    const recovered = classifyFailureMessage(
      "execution 3 refused: TradingPreviewRejection(account_and_bbo_fresh): BBO aged 5200ms past the 2s window",
    );
    assert.strictEqual(recovered.action, "re_quote");

    const network = classifyFailureMessage("HyperliquidRequestError(network): userFees status=-");
    assert.strictEqual(network.retryable, true);

    assert.strictEqual(classifyFailureMessage("something went wrong").retryable, false);
  });

  it("unwraps the execution service's production preview wrapper", () => {
    const message =
      "execution 3 refused: TradingExecutionError(preview_rejected): " +
      "account_and_bbo_fresh: BBO aged 5200ms past the 2s window";
    assert.strictEqual(classifyFailureMessage(message).action, "re_quote");

    const object = classifyUnknownFailure({
      _tag: "TradingExecutionError",
      stage: "preview_rejected",
      detail: "direction_permitted: authority does not permit short",
    });
    assert.strictEqual(object.action, "stand_down");
    assert.strictEqual(object.reason, "preview_direction_permitted");
  });

  it("classifies a real tagged error object by its own fields", () => {
    const recovery = classifyUnknownFailure({
      _tag: "HyperliquidRequestError",
      reason: "http_error",
      status: 429,
    });
    assert.strictEqual(recovery.reason, "exchange_rate_limited");
  });
});
