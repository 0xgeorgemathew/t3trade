/**
 * The failure derivation behind the §14.7 controls.
 *
 * The hook itself needs a renderer the web suite does not have, so the part
 * worth pinning is extracted: what an operator is told when a pause, a close,
 * or a revoke does not happen. `void send()` used to swallow every one of
 * these, which made a refused control indistinguishable from a slow one.
 */
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { describeControlFailure } from "./useMissionControls";

describe("describeControlFailure", () => {
  it("says nothing about a command that succeeded", () => {
    expect(describeControlFailure(AsyncResult.success(undefined))).toBeNull();
  });

  it("reports the reason the domain refused the control", () => {
    const result = AsyncResult.failure(
      Cause.fail(new Error("mission is revoked; the control is not legal from a terminal")),
    );
    expect(describeControlFailure(result)).toBe(
      "mission is revoked; the control is not legal from a terminal",
    );
  });

  it("reports a non-Error failure rather than dropping it", () => {
    expect(describeControlFailure(AsyncResult.failure(Cause.fail("close_position rejected")))).toBe(
      "close_position rejected",
    );
  });

  it("never returns an empty string, which would read as no error at all", () => {
    expect(describeControlFailure(AsyncResult.failure(Cause.fail(new Error("   "))))).toBe(
      "The command failed.",
    );
  });

  // An unmount or a navigation interrupts the command. Showing "the close
  // failed" for a panel the operator just closed would be a false alarm on the
  // one control that must stay trustworthy.
  it("treats an interrupt as no failure", () => {
    expect(describeControlFailure(AsyncResult.failure(Cause.interrupt()))).toBeNull();
  });
});
