# Patch Ledger

Tracks every place T3 Trades has diverged from the pinned upstream baseline
(`docs/upstream/BASELINE.md`), so future syncs know which upstream changes
are expected to conflict and why. Each entry should stay small enough to
resolve independently during a sync.

Statuses: `applied` (change is in `main`), `deferred` (identified, not yet
applied — listed so a later phase doesn't have to rediscover it).

## PROMPT-00 · Fork and integration baseline

### Applied

| Seam                                 | File(s)                                                                                                                                                             | Change                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop app identity                 | `scripts/build-desktop-artifact.ts`, `apps/desktop/scripts/electron-launcher.mjs`, `apps/desktop/src/app/DesktopEnvironment.ts`                                     | `DESKTOP_APP_ID` / bundle & AppUserModelIDs: `com.t3tools.t3code(.dev)` → `com.t3trades.app(.dev)`                                                                                                                                                                                 |
| Desktop product name                 | `apps/desktop/package.json`, `scripts/build-desktop-artifact.ts`, `apps/desktop/scripts/electron-launcher.mjs`, and all runtime strings under `apps/desktop/src/**` | Display name `"T3 Code"` (and its `(Alpha)`/`(Dev)`/`(Nightly)` variants) → `"T3 Trades"`                                                                                                                                                                                          |
| Desktop artifact naming              | `scripts/build-desktop-artifact.ts`                                                                                                                                 | `artifactName` pattern `T3-Code-${version}-${arch}.${ext}` → `T3-Trades-${version}-${arch}.${ext}`                                                                                                                                                                                 |
| Release/CLI copy                     | `scripts/resolve-nightly-release.ts`, `scripts/notify-discord-release.ts`, `scripts/build-desktop-artifact.ts` (CLI description)                                    | User-facing release name/announcement copy rebranded to T3 Trades                                                                                                                                                                                                                  |
| Doc/help copy                        | `packages/shared/src/devHome.ts`, `packages/shared/src/relayClient.ts`, `scripts/dev-runner.ts`                                                                     | Comments/CLI help text referencing the installed app rebranded                                                                                                                                                                                                                     |
| Update/release endpoint independence | `scripts/build-desktop-artifact.ts` (`resolveGitHubPublishConfig`)                                                                                                  | Already parametrized via `T3CODE_DESKTOP_UPDATE_REPOSITORY` / CI `GITHUB_REPOSITORY` with no hardcoded upstream owner — verified, no upstream-owned release/update endpoint is reachable from a fork build. No code change required; confirmed by grep (see Tests in `PROMPT-00`). |

### Deferred (identified, not yet applied)

These are internal, non-user-facing identifiers still reading `t3code`.
Renaming them touches OS-level registration (protocol handlers, window
manager class), on-disk state locations, and lint tooling wiring — all
higher blast-radius than PROMPT-00's "additive branding" scope, and are
left for a dedicated branding phase once trading code exists and can
exercise them under test:

| Seam                             | File(s)                                                                                                                                                                                                                                 | Note                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Custom URL protocol scheme       | `apps/desktop/src/electron/ElectronProtocol.ts` (`DESKTOP_PRODUCTION_SCHEME`/`DESKTOP_DEVELOPMENT_SCHEME` = `t3code`/`t3code-dev`), `scripts/build-desktop-artifact.ts` (mac `protocols`), `apps/desktop/scripts/electron-launcher.mjs` | OS-registered protocol handler; renaming requires a migration path for existing installs                                   |
| Linux executable name / WM class | `scripts/build-desktop-artifact.ts` (`executableName`, `StartupWMClass`), `apps/desktop/src/app/DesktopEnvironment.ts` (`linuxDesktopEntryName`, `linuxWmClass`)                                                                        | Coupled to the protocol scheme change above                                                                                |
| User data directory names        | `apps/desktop/src/app/DesktopEnvironment.ts` (`userDataDirName`, `legacyUserDataDirName`)                                                                                                                                               | Changing breaks continuity with any existing on-disk state; needs an explicit migration, not a rename                      |
| Git worktree branch prefix       | `packages/shared/src/git.ts` (`WORKTREE_BRANCH_PREFIX = "t3code"`)                                                                                                                                                                      | Referenced by dev tooling across the monorepo; rename requires an audit of all call sites                                  |
| oxlint plugin namespace          | `oxlint-plugin-t3code/*`, rule references like `t3code/no-global-process-runtime`                                                                                                                                                       | Renaming the package/namespace is a lint-config-wide change, independent of product branding                               |
| WSL prebuild marker filename     | `apps/desktop/src/wsl/DesktopWslEnvironment.ts` (`t3code-wsl-node-pty.json`)                                                                                                                                                            | Internal build artifact marker, not user-visible                                                                           |
| Mobile showcase demo data        | `scripts/mobile-showcase.ts`, `scripts/mobile-showcase-environment.ts`                                                                                                                                                                  | Seeds a _simulated_ "T3 Code" project as example content for App Store screenshot generation; not this fork's own identity |

## Future entries

Add a new `## PROMPT-NN · <phase name>` section per phase that touches
upstream-owned files, so `SYNC_RUNBOOK.md` batches can be checked against
this ledger for expected conflicts.
