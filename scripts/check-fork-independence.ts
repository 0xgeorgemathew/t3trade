#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - simple CI file-scanning script.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Guards against a future upstream sync silently reintroducing a live
    dependency on pingdotgg/t3code's own infrastructure (e.g. a hardcoded
    update/release endpoint). Scans non-test source files under apps/,
    packages/, scripts/, and infra/ for the upstream repo URL.

    Test fixtures that use "pingdotgg/t3code" as an example GitHub URL (git
    URL parsing tests, PR-link tests, etc) are expected and excluded by the
    *.test.ts(x) filter below. Docs recording the pinned baseline
    (docs/upstream/*.md) are expected to name the upstream repo. The mobile
    showcase's simulated demo project (see PATCH_LEDGER.md) is the one
    known non-test, non-doc reference, and is explicitly allow-listed. */
const UPSTREAM_REPO_PATTERN = /pingdotgg\/t3code/;

const ALLOWED_FILES = new Set([
  // Simulated demo project shown in App Store screenshots; see PATCH_LEDGER.md.
  "scripts/mobile-showcase-environment.ts",
  // This file's own pattern/allow-list.
  "scripts/check-fork-independence.ts",
  // npm `repository` metadata inherited from upstream; informational only,
  // not consulted by any update/release code path (see PATCH_LEDGER.md).
  "apps/server/package.json",
  // Doc comment linking to an upstream GitHub issue for context.
  "apps/server/src/provider/Layers/ClaudeAdapter.ts",
  // Marketing site links to upstream's GitHub repo/releases rather than the
  // fork's own; a real (not just cosmetic) gap, deferred in PATCH_LEDGER.md
  // pending a marketing rebrand pass.
  "apps/marketing/src/lib/site.ts",
  "apps/marketing/src/lib/releases.ts",
]);

const SEARCH_ROOTS = ["apps", "packages", "scripts", "infra"];
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mjs|cjs)$/;
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mjs|cjs)$/;
const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

async function collectFiles(root: string): Promise<string[]> {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const fullPath = NodePath.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const violations: string[] = [];

  for (const root of SEARCH_ROOTS) {
    const files = await collectFiles(NodePath.join(repoRoot, root));
    for (const filePath of files) {
      const relativePath = NodePath.relative(repoRoot, filePath);
      if (ALLOWED_FILES.has(relativePath) || TEST_FILE_PATTERN.test(relativePath)) {
        continue;
      }

      const contents = await NodeFSP.readFile(filePath, "utf8").catch(() => null);
      if (contents === null || !UPSTREAM_REPO_PATTERN.test(contents)) {
        continue;
      }
      violations.push(relativePath);
    }
  }

  if (violations.length > 0) {
    console.error(
      "Found references to upstream T3 Code infrastructure outside the allow-list:\n" +
        violations.map((file) => `  - ${file}`).join("\n") +
        "\n\nIf this is a new legitimate reference (e.g. test fixture data), rename the file " +
        "to *.test.ts, or add it to ALLOWED_FILES in scripts/check-fork-independence.ts with a " +
        "note explaining why it needs to hardcode the upstream repo.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("No unguarded references to upstream T3 Code infrastructure found.");
}

await main();
