/**
 * Which build of the server is actually running.
 *
 * `serverVersion` is the package version, and it moves on release, not on
 * commit — two servers a dozen commits apart report the same one. So an
 * execution discrepancy could be traced to "0.0.31" and no further, which is
 * the wrong granularity for a domain where the difference between two builds is
 * whether an order gets priced from BBO.
 *
 * This resolves the git SHA the server was started from, with `+dirty` when the
 * working tree carried uncommitted changes — a dev checkout mid-edit is a build
 * no SHA describes on its own. It returns null rather than guessing: a packaged
 * build has no git checkout to read, and "unknown" in the About panel is a
 * truer answer than a SHA from whatever repository the process happens to sit
 * in.
 *
 * @module ServerBuildIdentifier
 */
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

/** Long enough to be unambiguous in this repository, short enough to read. */
const SHORT_SHA_LENGTH = 12;

const git = (args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args,
      cwd,
      // Boot must not wait on a slow or hung git. No identifier is a fine
      // outcome; a server that will not start is not.
      timeout: "3 seconds",
      timeoutBehavior: "timedOutResult",
    });
  }).pipe(Effect.orElseSucceed(() => null));

/**
 * The build identifier for the checkout at `cwd`, or null when there is none.
 *
 * Never fails: every git error, timeout, and non-zero exit resolves to null.
 */
export const resolveServerBuildIdentifier = Effect.fn("resolveServerBuildIdentifier")(
  function* (input: { readonly cwd: string }) {
    const head = yield* git(["rev-parse", "--short=" + SHORT_SHA_LENGTH, "HEAD"], input.cwd);
    if (head === null || head.code !== 0) return null;

    const sha = head.stdout.trim();
    if (sha.length === 0) return null;

    // `--porcelain` prints one line per changed path and nothing at all for a
    // clean tree, so emptiness is the whole test. A failure here leaves the SHA
    // unqualified rather than dropping it: a SHA that might be dirty still
    // narrows a discrepancy to a dozen commits; no SHA narrows it to none.
    const status = yield* git(["status", "--porcelain"], input.cwd);
    const dirty = status !== null && status.code === 0 && status.stdout.trim().length > 0;

    return dirty ? `${sha}+dirty` : sha;
  },
);
