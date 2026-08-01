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

| Field                                  | Value                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spec revision                          | `market-bender@67d3650` — the 2026-08-01 Phase D close-out (testnet lab verified live, account mode recorded; execution prototype ratified as canonical UI intent). Supersedes the 2026-07-30 `3c1c2256` reconciliation. |
| Upstream commit of original seam audit | `55dd01612efc51e19de479da5a0e348cbe2521e3` (the spec's published audit pin, 2026-07-28)                                                                                                                                  |
| Seams re-verified at                   | `a8e05cbb92633a1351529f2bc402071f615e5051` (= the accepted baseline, see `BASELINE.md`)                                                                                                                                  |
| Pinned by                              | PROMPT-04 close-out                                                                                                                                                                                                      |
| Pinned on                              | 2026-08-01                                                                                                                                                                                                               |

## Per-phase evidence

| Phase | Spec revision at close-out | t3code commit | Evidence                                                                                                                                                                                                                                                                                       |
| ----- | -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 02    | `3c1c2256` (2026-07-30)    | baseline      | Market-data + strategy contracts, watch evaluator, harness wake — merged as fork PR #4.                                                                                                                                                                                                        |
| 03    | `3c1c2256` (2026-07-30)    | baseline      | Watches + harness wake-up closed loop, §11.1 state machine — merged as fork PR #6 (2026-07-31).                                                                                                                                                                                                |
| 04    | `67d3650` (2026-08-01)     | this branch   | Execution + reconciliation: signed idempotent orders, reconciled fills/positions, §16.2 loss budget, §16.4 exhaustion, Eq-4 fee reserve. Live testnet proof (Gate E) recorded separately. Deferrals: §17.2 steps 6–8 and `protected` status → PROMPT-05; approved-wallet registry → PROMPT-06. |

## Updating this file

When a later phase's acceptance criteria are checked against a newer spec
revision, add a new row (or superseding section) recording the new
`market-bender` commit and, if the spec's upstream-seam claims were
re-verified, the t3code commit they were verified at — do not silently
overwrite history, mirroring `BASELINE.md`'s update convention.
