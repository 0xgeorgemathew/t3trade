/**
 * The inbox key an execution refusal is recorded under.
 *
 * The reactor writes the refusal; `TradingExecutionOutcome` reads it back so
 * `trading_request_entry` can tell the harness why its request was refused,
 * and the harness's next wakeup carries the same summary as a pending event.
 * Both sides deriving the key from the execution sequence is what makes that
 * one refusal, not two unrelated rows.
 *
 * @module ExecutionRefusal
 */
export const executionRefusedKey = (executionSequence: number): string =>
  `execution_refused:${executionSequence}`;

/**
 * The inbox key a deterministic action's success is recorded under.
 *
 * `cancel` and `modify_stop` place no order of their own, so they write no
 * execution record, so `TradingExecutionOutcome` had nothing to find and waited
 * out its full twenty seconds before answering "submitted" — for an action that
 * had already succeeded. This is the missing answer, and it reaches the harness
 * on both paths: the tool's own return, and the next wakeup's pending events.
 */
export const executionSettledKey = (executionSequence: number): string =>
  `execution_settled:${executionSequence}`;
