# Spec Evidence Pin

This records where the specification lives, which **spec revision** the phase
acceptance criteria were checked against, and which **upstream T3 Code
commit** the spec's seam evidence was verified against. It is tracked
separately from `docs/upstream/BASELINE.md`'s pinned upstream commit:

- `BASELINE.md` pins the **T3 Code (`pingdotgg/t3code`) commit** this fork's
  `main` descends from — the code.
- This file pins the **requirements**: the spec revision (a commit of the
  spec repository) and the t3code commit its upstream-seam claims were
  verified at.

The two are independent and move on different schedules: a spec revision can
land without an upstream sync, and vice versa.

## Where the spec lives

| Surface           | Location                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| Canonical site    | <https://market-bender.mathew.workers.dev> (holds the KV review-state toggles) |
| Mirror            | <https://market-bender.pages.dev> (same `dist/`, redeployed alongside)         |
| Source repository | <https://github.com/0xgeorgemathew/market-bender>                              |

## Current pin

| Field                                  | Value                                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec revision                          | `market-bender@3c1c2256` — the 2026-07-30 reconciliation (PROMPT-01 ratified as built; phases resequenced 04 execution → 05 protection → 06 Privy signer swap; PROMPT-02 re-scoped as the testnet lab; no-runtime-SDK decision recorded) |
| Upstream commit of original seam audit | `55dd01612efc51e19de479da5a0e348cbe2521e3` (the spec's published audit pin, 2026-07-28)                                                                                                                                                  |
| Seams re-verified at                   | `a8e05cbb92633a1351529f2bc402071f615e5051` (= the accepted baseline, see `BASELINE.md`)                                                                                                                                                  |
| Pinned by                              | PROMPT-00 · Fork and integration baseline; updated at PROMPT-01 close-out                                                                                                                                                                |
| Pinned on                              | 2026-07-30                                                                                                                                                                                                                               |

## Updating this file

When a later phase's acceptance criteria are checked against a newer spec
revision, add a new row (or superseding section) recording the new
`market-bender` commit and, if the spec's upstream-seam claims were
re-verified, the t3code commit they were verified at — do not silently
overwrite history, mirroring `BASELINE.md`'s update convention.
