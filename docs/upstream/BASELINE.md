# Upstream Baseline

This file records the pinned upstream commit that T3 Trade' fork was built
from, per the Git strategy repository model. See `SPEC_EVIDENCE.md` for the
separately tracked pin of the requirements/spec commit this baseline's
acceptance criteria were checked against.

## Current baseline

| Field                       | Value                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| Upstream repository         | `https://github.com/pingdotgg/t3code.git`                           |
| Upstream branch             | `main`                                                              |
| Pinned commit (full SHA)    | `3b72d17cbca691f0b64e6d4a10c9e349f42873a5`                          |
| Pinned commit (short SHA)   | `3b72d17cb`                                                         |
| Upstream commit date        | 2026-08-10                                                          |
| Upstream release tag at pin | `v0.0.33`                                                           |
| Accepted-baseline tag       | `upstream-base/2026-08-10-3b72d17cb`                                |
| Fork repository             | `https://github.com/0xgeorgemathew/t3trade.git`                     |
| Fork product line           | `origin/main`                                                       |
| Pinned by                   | Plan 26 · Upstream sync to v0.0.33                                  |
| Pinned on                   | 2026-08-13                                                          |
| Accepted range              | `a8e05cbb..3b72d17cb` (236 upstream commits, merged in two batches) |

## Superseded baseline (PROMPT-00)

| Field                           | Value                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Upstream repository             | `https://github.com/pingdotgg/t3code.git`                                            |
| Upstream branch                 | `main`                                                                               |
| Pinned commit (full SHA)        | `a8e05cbb92633a1351529f2bc402071f615e5051`                                           |
| Pinned commit (short SHA)       | `a8e05cbb`                                                                           |
| Upstream commit date            | 2026-07-29                                                                           |
| Upstream package version at pin | `0.0.31`                                                                             |
| Accepted-baseline tag           | `upstream-base/2026-07-29-a8e05cbb`                                                  |
| Fork repository                 | `https://github.com/0xgeorgemathew/t3trade.git`                                      |
| Fork product line               | `origin/main`                                                                        |
| Fork version at baseline        | `0.0.31` (unchanged from upstream; fork versioning splits at the first fork release) |
| Pinned by                       | PROMPT-00 · Fork and integration baseline                                            |
| Pinned on                       | 2026-07-30                                                                           |

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
