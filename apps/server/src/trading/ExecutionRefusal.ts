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
