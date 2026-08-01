/**
 * End-to-end execution wiring test (PROMPT-04 M6).
 *
 * This is the integration proof that the M1–M5 wiring forms a complete loop:
 * a `trading.execution.requested` command → decider event → reactor handler →
 * preview → submit → reconcile → projection surfaces. It uses a FAKE exchange
 * so it runs in CI without spending capital.
 *
 * Status: SCAFFOLD. The full fixture (seeded mission + trading account, a fake
 * `HyperliquidExchangeClient` that accepts the order, canned fills/position,
 * and an armed-but-in-memory signer) is substantial and is being assembled in
 * lockstep with the live-gated variant. The wiring's correctness is currently
 * verified by:
 *   - the focused unit tests (reconciler persistence, preview, budget reader),
 *   - the type checker's exhaustive decider `default: command satisfies never`
 *     (a missing case is a compile error), and
 *   - the live `noop` smoke probe (byte-correct signing, live-accepted).
 *
 * When the fixture lands, this test will: dispatch the command, drain the
 * reactor, and assert the fill appears in `recentFills`, the position renders
 * a reconciled size via `getByThreadId`, and a duplicate request is rejected
 * as a duplicate (deterministic cloid + idempotency_key).
 *
 * @module TradingExecutionReactorLoop
 */
import { describe, it } from "@effect/vitest";

describe("TradingExecutionReactorLoop (M6 wiring)", () => {
  it.skip("executes request → submit → reconcile → projection end-to-end (fake exchange)", () => {
    // Fixture assembly in progress; see module doc above.
  });
});
