/**
 * What this CLI is published as on npm — `npx t3trade`.
 *
 * Deliberately NOT `package.json`'s `name`. The workspace package is still
 * called `t3`, because that name is woven through the monorepo: the task graph
 * (`t3#build`), every `--filter t3`, and — the one that makes a rename
 * genuinely expensive — Effect's deterministic service keys, which are derived
 * from the package name and would all have to move from `t3/...` to
 * `t3trade/...` across the whole server.
 *
 * The published identity is a different thing from the workspace identity, and
 * only the published one has to change: upstream owns `t3` on npm, so this
 * fork publishes as `t3trade`. `apps/server/scripts/cli.ts` rewrites the
 * manifest's `name` and `bin` to this before handing the package to npm, and
 * every command string the CLI prints reads it from here — so what the user is
 * told to type and what actually exists on the registry cannot drift apart.
 *
 * @module CliPackageName
 */
export const CLI_PACKAGE_NAME = "t3trade";
