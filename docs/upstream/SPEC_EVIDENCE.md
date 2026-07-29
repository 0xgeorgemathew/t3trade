# Spec Evidence Pin

This records the commit of the requirements/spec source that PROMPT-00 ("Fork
and integration baseline") was written and verified against. It is tracked
separately from `docs/upstream/BASELINE.md`'s pinned upstream commit:

- `BASELINE.md` pins the **T3 Code (`pingdotgg/t3code`) commit** this fork's
  `main` descends from — the code.
- This file pins the **spec/evidence commit** the PROMPT-00 acceptance
  criteria were checked against — the requirements.

The two are independent and move on different schedules: a spec revision can
land without an upstream sync, and vice versa.

## Current pin

| Field                | Value                                      |
| -------------------- | ------------------------------------------ |
| Spec evidence commit | `55dd01612efc51e19de479da5a0e348cbe2521e3` |
| Pinned by            | PROMPT-00 · Fork and integration baseline  |
| Pinned on            | 2026-07-30                                 |

## Updating this file

When a later phase's acceptance criteria are checked against a newer spec
revision, add a new row (or superseding section) recording the new commit —
do not silently overwrite history, mirroring `BASELINE.md`'s update
convention.
