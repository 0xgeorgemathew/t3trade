#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

/** Version metadata a T3 Trades build artifact exposes: the fork's own
    product version, alongside the exact upstream T3 Code commit it was
    built against (see docs/upstream/BASELINE.md). */
export const BuildMetadata = Schema.Struct({
  fork: Schema.Literal("T3 Trades"),
  productVersion: Schema.NonEmptyString,
  t3UpstreamCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
});
export type BuildMetadata = typeof BuildMetadata.Type;

const DesktopPackageJsonSchema = Schema.Struct({
  version: Schema.NonEmptyString,
});
const decodeDesktopPackageJson = Schema.decodeUnknownEffect(
  fromJsonStringPretty(DesktopPackageJsonSchema),
);
const encodeBuildMetadataJson = Schema.encodeEffect(fromJsonStringPretty(BuildMetadata));

const BASELINE_SHA_PATTERN = /\| Pinned commit \(full SHA\) \| `([0-9a-f]{40})` \|/;

export class BuildMetadataParseError extends Schema.TaggedErrorClass<BuildMetadataParseError>()(
  "BuildMetadataParseError",
  {
    filePath: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to parse build metadata from ${this.filePath}: ${this.reason}.`;
  }
}

export function extractPinnedUpstreamCommit(baselineMarkdown: string): string | undefined {
  return BASELINE_SHA_PATTERN.exec(baselineMarkdown)?.[1];
}

export const resolveBuildMetadata = Effect.fn("resolveBuildMetadata")(function* (input: {
  readonly desktopPackageJson: string;
  readonly baselineMarkdown: string;
}) {
  const desktopPackage = yield* decodeDesktopPackageJson(input.desktopPackageJson).pipe(
    Effect.mapError(
      (cause) =>
        new BuildMetadataParseError({
          filePath: "apps/desktop/package.json",
          reason: "missing or invalid `version` field",
          cause,
        }),
    ),
  );

  const t3UpstreamCommit = extractPinnedUpstreamCommit(input.baselineMarkdown);
  if (!t3UpstreamCommit) {
    return yield* new BuildMetadataParseError({
      filePath: "docs/upstream/BASELINE.md",
      reason: "no pinned commit SHA found",
    });
  }

  return { fork: "T3 Trades" as const, productVersion: desktopPackage.version, t3UpstreamCommit };
});

const readBuildMetadata = Effect.fn("readBuildMetadata")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "..");

  const [desktopPackageJson, baselineMarkdown] = yield* Effect.all([
    fs.readFileString(path.join(repoRoot, "apps/desktop/package.json")),
    fs.readFileString(path.join(repoRoot, "docs/upstream/BASELINE.md")),
  ]);

  return yield* resolveBuildMetadata({ desktopPackageJson, baselineMarkdown });
});

const command = Command.make("build-metadata", {}, () =>
  Effect.gen(function* () {
    const metadata = yield* readBuildMetadata();
    const json = yield* encodeBuildMetadataJson(metadata);
    yield* Console.log(json);
  }),
).pipe(
  Command.withDescription(
    "Print the T3 Trades build artifact's version metadata (productVersion, t3UpstreamCommit).",
  ),
);

if (import.meta.url === `file://${process.argv[1]}`) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
