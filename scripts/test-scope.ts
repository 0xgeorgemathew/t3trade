#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - simple CI decision script.
/** Decides whether a PR can run the fork-scoped test suite (`test:fork`)
    instead of the full one.

    Reads a newline-separated list of changed files (path given as argv[2],
    as produced by `gh pr diff --name-only`) and prints `scope=fork` or
    `scope=full` on stdout for `$GITHUB_OUTPUT`.

    Rationale: this repo is a fork of pingdotgg/t3code and rarely touches
    upstream code (see docs/upstream/PATCH_LEDGER.md). Files under the
    fork-owned paths below are never imported by upstream tests, so a change
    confined to them cannot break the upstream suite — running only the
    fork's own tests is sufficient. Any file outside the list (upstream code,
    the lockfile, workflows, ledger seam files) forces the full suite. */
import * as NodeFSP from "node:fs/promises";

/** Paths wholly owned by the fork. Keep in sync with the `test:fork`
    scripts in the root and package `package.json`s. */
const FORK_OWNED = [
  /^packages\/trading-contracts\//,
  /^packages\/hyperliquid\//,
  /^apps\/server\/src\/trading\//,
  /^apps\/web\/src\/components\/trading\//,
  /^apps\/web\/src\/lib\/trading/,
  /^docs\//,
  /^\.claude\//,
  /^experiments\//,
  /\.md$/,
];

async function main() {
  const listPath = process.argv[2];
  if (!listPath) {
    console.error("usage: node scripts/test-scope.ts <changed-files.txt>");
    process.exit(1);
  }
  const changed = (await NodeFSP.readFile(listPath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const upstreamTouching = changed.filter(
    (file) => !FORK_OWNED.some((pattern) => pattern.test(file)),
  );

  if (changed.length === 0 || upstreamTouching.length > 0) {
    console.error(
      changed.length === 0
        ? "test-scope: no changed files listed; defaulting to the full suite."
        : `test-scope: full suite — ${upstreamTouching.length} file(s) outside fork-owned paths:`,
    );
    for (const file of upstreamTouching.slice(0, 20)) {
      console.error(`  ${file}`);
    }
    console.log("scope=full");
    return;
  }

  console.error(`test-scope: all ${changed.length} changed file(s) are fork-owned.`);
  console.log("scope=fork");
}

await main();
