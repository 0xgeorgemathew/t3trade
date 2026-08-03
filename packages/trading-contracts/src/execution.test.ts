/**
 * The shared execution-status sets (§18).
 *
 * These exist because the same lists were written by hand in four SQL queries
 * and could drift silently — a query that forgot `previewed` would let a second
 * entry past the lock. The assertions below are what makes the drift loud.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  NON_TERMINAL_EXECUTION_STATUSES,
  PENDING_EXECUTION_STATUSES,
  TradingExecutionStatus,
  isPendingExecutionStatus,
} from "./execution.ts";

describe("PENDING_EXECUTION_STATUSES", () => {
  it("is the mid-submission set, and nothing the exchange has answered", () => {
    expect([...PENDING_EXECUTION_STATUSES]).toEqual([
      "previewed",
      "reserved",
      "signed",
      "submitted",
    ]);
    expect(isPendingExecutionStatus("submitted")).toBe(true);
    // `accepted` means the order rests on the book: visible, manageable state,
    // and no longer a reason to refuse the next write.
    expect(isPendingExecutionStatus("accepted")).toBe(false);
    expect(isPendingExecutionStatus("filled")).toBe(false);
    expect(isPendingExecutionStatus("nonsense")).toBe(false);
  });

  it("names only statuses the lifecycle actually has", () => {
    const known = new Set(TradingExecutionStatus.literals);
    for (const status of NON_TERMINAL_EXECUTION_STATUSES) {
      expect(known.has(status)).toBe(true);
    }
  });

  it("extends to the non-terminal set by exactly `accepted`", () => {
    expect([...NON_TERMINAL_EXECUTION_STATUSES]).toEqual([
      ...PENDING_EXECUTION_STATUSES,
      "accepted",
    ]);
  });
});
