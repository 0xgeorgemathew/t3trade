// @effect-diagnostics nodeBuiltinImport:off - reads a static repo doc file in a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { T3_FORK_NAME, T3_UPSTREAM_COMMIT } from "./buildMetadata.ts";

describe("buildMetadata", () => {
  it("T3_UPSTREAM_COMMIT matches the pinned SHA in docs/upstream/BASELINE.md", () => {
    const baselinePath = fileURLToPath(
      new URL("../../../docs/upstream/BASELINE.md", import.meta.url),
    );
    const baseline = readFileSync(baselinePath, "utf8");
    const match = /\| Pinned commit \(full SHA\)\s*\| `([0-9a-f]{40})`\s*\|/.exec(baseline);

    expect(match?.[1]).toBe(T3_UPSTREAM_COMMIT);
  });

  it("T3_FORK_NAME is the fork's product name", () => {
    expect(T3_FORK_NAME).toBe("T3 Trades");
  });
});
