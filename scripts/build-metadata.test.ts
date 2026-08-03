import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { extractPinnedUpstreamCommit, resolveBuildMetadata } from "./build-metadata.ts";

const SAMPLE_BASELINE_MARKDOWN = `# Upstream Baseline

| Field | Value |
|---|---|
| Upstream repository | \`https://github.com/pingdotgg/t3code.git\` |
| Pinned commit (full SHA) | \`a8e05cbb92633a1351529f2bc402071f615e5051\` |
| Pinned commit (short SHA) | \`a8e05cbb\` |
`;

it("extracts the pinned upstream commit SHA from BASELINE.md", () => {
  assert.equal(
    extractPinnedUpstreamCommit(SAMPLE_BASELINE_MARKDOWN),
    "a8e05cbb92633a1351529f2bc402071f615e5051",
  );
});

it("returns undefined when BASELINE.md has no pinned commit row", () => {
  assert.equal(
    extractPinnedUpstreamCommit("# Upstream Baseline\n\nnothing pinned yet\n"),
    undefined,
  );
});

it.effect("asserts the fork name and upstream SHA in resolved build metadata", () =>
  Effect.gen(function* () {
    const metadata = yield* resolveBuildMetadata({
      desktopPackageJson: `{"version":"0.0.31"}`,
      baselineMarkdown: SAMPLE_BASELINE_MARKDOWN,
    });

    assert.equal(metadata.fork, "T3 Trade");
    assert.equal(metadata.productVersion, "0.0.31");
    assert.equal(metadata.t3UpstreamCommit, "a8e05cbb92633a1351529f2bc402071f615e5051");
  }),
);

it.effect("fails when the desktop package version is missing", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      resolveBuildMetadata({
        desktopPackageJson: "{}",
        baselineMarkdown: SAMPLE_BASELINE_MARKDOWN,
      }),
    );
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("fails when BASELINE.md has no pinned commit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      resolveBuildMetadata({
        desktopPackageJson: `{"version":"0.0.31"}`,
        baselineMarkdown: "# Upstream Baseline\n",
      }),
    );
    assert.equal(result._tag, "Failure");
  }),
);
