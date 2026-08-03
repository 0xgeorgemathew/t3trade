import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerBuildIdentifier } from "./ServerBuildIdentifier.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({ run: (input) => runMock(input) }),
);

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** Answer `rev-parse` and `status` independently, the way git would. */
const gitReplies = (replies: {
  readonly revParse: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly status?: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
}) => {
  runMock.mockImplementation((input) =>
    input.args[0] === "rev-parse"
      ? replies.revParse
      : (replies.status ?? Effect.succeed(output(""))),
  );
};

const resolve = resolveServerBuildIdentifier({ cwd: "/repo" }).pipe(
  Effect.provide(ProcessRunnerTest),
);

afterEach(() => {
  runMock.mockReset();
});

describe("resolveServerBuildIdentifier", () => {
  it.effect("reports the short SHA of a clean checkout", () =>
    Effect.gen(function* () {
      gitReplies({ revParse: Effect.succeed(output("3c239953ea69\n")) });
      expect(yield* resolve).toBe("3c239953ea69");
    }),
  );

  // A dev checkout mid-edit is a build no SHA describes on its own, and that is
  // exactly the state an execution discrepancy is most likely found in.
  it.effect("marks a working tree with uncommitted changes", () =>
    Effect.gen(function* () {
      gitReplies({
        revParse: Effect.succeed(output("3c239953ea69\n")),
        status: Effect.succeed(output(" M apps/server/src/trading/OrderMapper.ts\n")),
      });
      expect(yield* resolve).toBe("3c239953ea69+dirty");
    }),
  );

  // A packaged build has no checkout to read. "unknown" is the true answer;
  // a SHA from whatever repository the process happens to sit in is not.
  it.effect("reports nothing when there is no git checkout", () =>
    Effect.gen(function* () {
      gitReplies({ revParse: Effect.succeed(output("", 128)) });
      expect(yield* resolve).toBeNull();
    }),
  );

  it.effect("reports nothing when git cannot be run at all", () =>
    Effect.gen(function* () {
      gitReplies({
        revParse: Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "git",
            argumentCount: 3,
            cause: new Error("ENOENT"),
          }),
        ),
      });
      expect(yield* resolve).toBeNull();
    }),
  );

  // A SHA that might be dirty still narrows a discrepancy to a dozen commits.
  // No SHA narrows it to none, so a failed status must not discard the SHA.
  it.effect("keeps the SHA when the dirty check itself fails", () =>
    Effect.gen(function* () {
      gitReplies({
        revParse: Effect.succeed(output("3c239953ea69\n")),
        status: Effect.succeed(output("", 128)),
      });
      expect(yield* resolve).toBe("3c239953ea69");
    }),
  );
});
