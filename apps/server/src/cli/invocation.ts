import * as Effect from "effect/Effect";

import { HostProcessArguments } from "@t3tools/shared/hostProcess";

import packageJson from "../../package.json" with { type: "json" };
import { CLI_PACKAGE_NAME } from "./packageName.ts";

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

// Re-exported so callers that already reach for the invocation helpers do not
// need a second import for the name those helpers print.
export { CLI_PACKAGE_NAME } from "./packageName.ts";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; callers must fail closed to a plain `t3` command.
 */
export function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

/**
 * The package spec to suggest. The literal spec the user typed (e.g.
 * `t3trade@nightly`) is resolved away before our process starts, so re-derive
 * it from the running version: nightly builds re-suggest the nightly channel,
 * anything else suggests the bare package.
 *
 * The name comes from the manifest rather than a literal, so the published
 * package and every command this CLI prints cannot disagree about what to
 * type — the fork renamed the package once and would otherwise have gone on
 * telling people to run upstream's.
 */
export function suggestedPackageSpec(version: string): string {
  return version.includes("-nightly.") ? `${CLI_PACKAGE_NAME}@nightly` : CLI_PACKAGE_NAME;
}

/**
 * Render a `<cli> <subcommand>` suggestion that matches how this process was
 * launched, so copy/pasting it actually works: `npx t3trade connect` suggests
 * `npx t3trade serve`, a global install suggests `t3trade serve`, and a
 * nightly build keeps the `@nightly` tag.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    return `${CLI_PACKAGE_NAME} ${input.subcommand}`;
  }
  return `${runner} ${suggestedPackageSpec(input.version)} ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcessArguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );
