# Spec Evidence Pin

This records which **upstream T3 Code commit** the spec's seam evidence was
verified against, and which **spec revision** the phase acceptance criteria
were checked against. It is tracked separately from
`docs/upstream/BASELINE.md`'s pinned upstream commit:

- `BASELINE.md` pins the **T3 Code (`pingdotgg/t3code`) commit** this fork's
  `main` descends from — the code.
- This file pins the evidence behind the **requirements**: the spec site
  (market-bender) is not itself a git repository, so its revisions are
  identified by the dated reconciliation passes recorded on the site and in
  `market-bender/docs/roadmap.md`, and its upstream-seam claims are verified
  at a specific t3code commit.

The two are independent and move on different schedules: a spec revision can
land without an upstream sync, and vice versa.

## Current pin

| Field                                  | Value                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Upstream commit of original seam audit | `55dd01612efc51e19de479da5a0e348cbe2521e3` (the spec's published audit pin, 2026-07-28)      |
| Seams re-verified at                   | `a8e05cbb92633a1351529f2bc402071f615e5051` (= the accepted baseline, see `BASELINE.md`)      |
| Spec revision                          | market-bender reconciliation of 2026-07-30 (PROMPT-01 ratified as-built, phases resequenced) |
| Pinned by                              | PROMPT-00 · Fork and integration baseline; updated at PROMPT-01 close-out                    |
| Pinned on                              | 2026-07-30                                                                                   |

## Updating this file

When a later phase's acceptance criteria are checked against a newer spec
revision, add a new row (or superseding section) recording the new revision
date and, if the spec's upstream-seam claims were re-verified, the t3code
commit they were verified at — do not silently overwrite history, mirroring
`BASELINE.md`'s update convention.
