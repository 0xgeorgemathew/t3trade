// @effect-diagnostics nodeBuiltinImport:off - statically scans the trading source tree in a test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

/**
 * Architecture §6.3 forbids the trading extension from starting provider
 * processes directly or creating a second provider-session directory:
 * ProviderService remains the only provider runtime. This test enforces that
 * statically, so a future phase cannot quietly shell out to a provider CLI.
 */
const tradingDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const readTradingSources = (): ReadonlyArray<{
  readonly file: string;
  readonly source: string;
}> => {
  const walk = (dir: string): ReadonlyArray<string> =>
    NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });

  return walk(tradingDir)
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => ({
      file: NodePath.relative(tradingDir, file),
      source: NodeFS.readFileSync(file, "utf8"),
    }));
};

/** Every way a module could start an OS process. */
const PROCESS_SPAWNING_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["node:child_process import", /from\s+["']node:child_process["']/],
  ["child_process import", /from\s+["']child_process["']/],
  ["spawn(", /\bspawn(?:Sync)?\s*\(/],
  ["exec(", /\bexec(?:Sync|File|FileSync)?\s*\(/],
  ["fork(", /\bchildProcess\.fork\s*\(/],
  ["node-pty", /from\s+["']node-pty["']/],
  ["Command.make", /\bCommand\.make\s*\(/],
];

/** Provider CLI binaries the harness would otherwise be launched with. */
const PROVIDER_CLI_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["claude CLI invocation", /["'`]claude["'`]\s*,\s*\[/],
  ["codex CLI invocation", /["'`]codex["'`]\s*,\s*\[/],
  ["opencode CLI invocation", /["'`]opencode["'`]\s*,\s*\[/],
];

describe("trading code never spawns a provider runtime (§6.3)", () => {
  const sources = readTradingSources();

  it("finds trading sources to scan", () => {
    assert.ok(sources.length > 0, "no trading sources were scanned");
  });

  it("never imports or calls a process-spawning API", () => {
    for (const { file, source } of sources) {
      for (const [label, pattern] of PROCESS_SPAWNING_PATTERNS) {
        assert.equal(
          pattern.test(source),
          false,
          `${file} must not use ${label}; ProviderService owns session start and resume`,
        );
      }
    }
  });

  it("never invokes a provider CLI directly", () => {
    for (const { file, source } of sources) {
      for (const [label, pattern] of PROVIDER_CLI_PATTERNS) {
        assert.equal(pattern.test(source), false, `${file} must not use ${label}`);
      }
    }
  });

  it("never reaches into a provider adapter or session directory", () => {
    for (const { file, source } of sources) {
      assert.equal(
        /from\s+["'][^"']*provider\/Layers\/[^"']*Adapter/.test(source),
        false,
        `${file} must not import a provider adapter directly`,
      );
      assert.equal(
        /ProviderSessionRuntime/.test(source),
        false,
        `${file} must not manage provider session runtime state itself`,
      );
    }
  });
});
