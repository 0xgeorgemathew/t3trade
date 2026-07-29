# Upstream Baseline

This file records the pinned upstream commit that T3 Trades' fork was built
from, per the Git strategy repository model.

## Current baseline

| Field                           | Value                                                                    |
| ------------------------------- | ------------------------------------------------------------------------ |
| Upstream repository             | `https://github.com/pingdotgg/t3code.git`                                |
| Upstream branch                 | `main`                                                                   |
| Pinned commit (full SHA)        | `a8e05cbb92633a1351529f2bc402071f615e5051`                               |
| Pinned commit (short SHA)       | `a8e05cbb`                                                               |
| Upstream commit date            | 2026-07-29                                                               |
| Upstream package version at pin | `0.0.31`                                                                 |
| Accepted-baseline tag           | `upstream-base/2026-07-29-a8e05cbb`                                      |
| Fork repository                 | `https://github.com/0xgeorgemathew/t3trade.git`                          |
| Fork product line               | `origin/main`                                                            |
| Fork version at baseline        | `0.0.31` (unchanged from upstream; product versioning begins at Phase 1) |
| Pinned by                       | PROMPT-00 · Fork and integration baseline                                |
| Pinned on                       | 2026-07-30                                                               |

## How this was pinned

1. Cloned `https://github.com/pingdotgg/t3code.git` with
   `--single-branch --branch main`.
2. Renamed the cloned remote to `upstream` and disabled its push URL.
3. Added the writable fork `https://github.com/0xgeorgemathew/t3trade.git`
   as `origin`.
4. Configured `upstream` to fetch only `main`
   (`+refs/heads/main:refs/remotes/upstream/main`).
5. Recorded `upstream/main` at `a8e05cbb92633a1351529f2bc402071f615e5051`
   as the accepted baseline and created the immutable annotated tag
   `upstream-base/2026-07-29-a8e05cbb` pointing at it.
6. `main` on the fork descends directly from this commit; no trading code
   has been added yet.

## Updating this file

Each future accepted upstream sync batch (see `SYNC_RUNBOOK.md`) must:

- Add a new row (or superseding section) recording the new pinned SHA, tag,
  and date — do not silently overwrite history.
- Create a new immutable `upstream-base/YYYY-MM-DD-<shortSHA>` tag; never
  reuse or move an existing tag.
- Reference the rehearsal/production sync PR that performed the merge.
