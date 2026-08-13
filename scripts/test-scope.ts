#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - simple CI decision script.
/** Decides whether a PR can run the fork-scoped test suite (`test:fork`)
    instead of the full one.

    Reads a newline-separated list of changed files (path given as argv[2],
    as produced by `gh pr diff --name-only`) and prints `scope=fork` or
    `scope=full` on stdout for `$GITHUB_OUTPUT`.

    Rationale: this repo is a fork that rarely touches upstream code
    (see docs/upstream/PATCH_LEDGER.md). Files under the
    fork-owned paths below are never imported by upstream tests, so a change
    confined to them cannot break the upstream suite — running only the
    fork's own tests is sufficient. Any file outside the list (upstream code,
    the lockfile, workflows, ledger seam files) forces the full suite. */
import * as NodeFSP from "node:fs/promises";

/** Paths wholly owned by the fork. Keep in sync with the `test:fork`
    scripts in the root and package `package.json`s.

    Two of these live inside upstream-owned directories and are only safe
    here because `test:fork` runs every test that imports them: the trading
    MCP toolkit is imported by `apps/server/src/mcp` tests, and
    TradingSessionProfile by the provider adapters' tests, so the server's
    `test:fork` covers `src/mcp` and `src/provider` whole. Widening this list
    without widening that glob is how a fork-only change breaks main. */
const FORK_OWNED = [
  /^packages\/trading-contracts\//,
  /^packages\/hyperliquid\//,
  /^apps\/server\/src\/trading\//,
  /^apps\/server\/src\/mcp\/toolkits\/trading\//,
  /^apps\/server\/src\/provider\/TradingSessionProfile\.ts$/,
  /^apps\/web\/src\/components\/trading\//,
  /^apps\/web\/src\/lib\/trading/,
  /^docs\//,
  /^\.claude\//,
  /^experiments\//,
  /\.md$/,
];

/** Files that look fork-owned by the rules above but are asserted by tests
    outside the fork's own paths, so they must force the full suite.
    BASELINE.md is checked against `T3_UPSTREAM_COMMIT` by
    `packages/shared/src/buildMetadata.test.ts`, which `test:fork` does not
    run — that pair was found already out of sync once. */
const NEVER_FORK_ONLY = [/^docs\/upstream\/BASELINE\.md$/];

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
    (file) =>
      NEVER_FORK_ONLY.some((pattern) => pattern.test(file)) ||
      !FORK_OWNED.some((pattern) => pattern.test(file)),
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
