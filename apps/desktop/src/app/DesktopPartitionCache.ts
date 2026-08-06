/**
 * DesktopPartitionCache - keep Chromium's per-partition cache directories
 * present before it needs them.
 *
 * Every dev run logged a line like:
 *
 *   Failed to create directory: …/Partitions/<name>/Shared Dictionary/cache
 *
 * once per preview partition, at ERROR level, from inside Chromium. It is
 * benign — the shared-dictionary cache is an optimisation and the browser goes
 * on without it — but an error a developer learns to ignore is an error they
 * will ignore when it matters, so the noise is worth removing.
 *
 * The fix is the conservative half of the problem: pre-create the directory so
 * Chromium finds it rather than trying to make it. Nothing is deleted. A path
 * occupied by something that is not a directory is reported and left exactly
 * where it is — that is the user's profile, and guessing what to remove from it
 * is not this module's business.
 *
 * @module DesktopPartitionCache
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The subdirectory Chromium could not create, relative to a partition root. */
const SHARED_DICTIONARY_CACHE = ["Shared Dictionary", "cache"] as const;

/**
 * Ensure `<userData>/Partitions/<each>/Shared Dictionary/cache` exists.
 *
 * A missing `Partitions` directory is the normal first-run state and means
 * there is nothing to prepare yet; Chromium creates the partition root itself
 * and this runs again on the next launch.
 */
export const ensurePartitionCaches = (userDataPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const partitionsRoot = path.join(userDataPath, "Partitions");
    const exists = yield* fileSystem.exists(partitionsRoot);
    if (!exists) return;

    const partitions = yield* fileSystem.readDirectory(partitionsRoot);
    for (const partition of partitions) {
      const cachePath = path.join(partitionsRoot, partition, ...SHARED_DICTIONARY_CACHE);
      const info = yield* fileSystem.stat(cachePath).pipe(Effect.option);
      if (info._tag === "Some") {
        if (info.value.type !== "Directory") {
          yield* Effect.logWarning(
            "desktop: a partition's shared-dictionary cache path is not a directory",
            { cachePath, type: info.value.type },
          );
        }
        continue;
      }
      yield* fileSystem.makeDirectory(cachePath, { recursive: true });
    }
  }).pipe(
    // Housekeeping for a log line. A failure here must never affect startup.
    Effect.catchCause((cause) =>
      Effect.logDebug("desktop: could not prepare partition caches", { cause: String(cause) }),
    ),
  );
