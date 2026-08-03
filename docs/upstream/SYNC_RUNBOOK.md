# Upstream Sync Runbook

How to pull an accepted batch of upstream commits from
`https://github.com/pingdotgg/t3code.git` into `origin/main`, per the Git
strategy repository model. Follow this exactly — the accepted-baseline tag
and `docs/upstream/BASELINE.md` are the audit trail; skipping steps breaks
that trail.

## Preconditions

- `origin` resolves to the writable T3 Trade fork
  (`https://github.com/0xgeorgemathew/t3trade.git`).
- `upstream` resolves to `https://github.com/pingdotgg/t3code.git`, fetch-only
  (`git remote get-url --push upstream` must NOT return a usable URL).
- Local `main` is up to date with `origin/main`.

## Steps

1. **Fetch and pick the range.**

   ```sh
   git fetch upstream
   git log --oneline <current-baseline-SHA>..upstream/main
   ```

   Decide how much of that range to accept as one batch — the whole range,
   or a prefix of it if you want a smaller/safer batch. The batch's upper
   bound is the _new_ candidate baseline SHA.

2. **Create the review branch.**

   ```sh
   git checkout -b sync/upstream-YYYY-MM-DD-<newShortSHA> main
   ```

   Name it after the _new_ candidate baseline commit's date and short SHA,
   not today's date if they differ.

3. **Merge the batch.**

   ```sh
   git merge --no-ff upstream/main
   # or, for a partial batch:
   git merge --no-ff <newBaselineSHA>
   ```

   `--no-ff` is required: it produces a real merge commit even when the
   range is a linear fast-forward, so the sync is a visible, revertable
   unit in `main`'s history rather than silently rewriting it.

4. **Resolve conflicts against `docs/upstream/PATCH_LEDGER.md`.**

   Every conflict should correspond to a seam already listed in the ledger.
   If a conflict shows up in a file the ledger doesn't mention, the ledger
   is out of date — fix the ledger as part of this sync, not as a follow-up.

5. **Run the full gate.**

   ```sh
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint --report-unused-disable-directives
   pnpm test
   pnpm build
   ```

   All must pass on the merge commit before it can be proposed.

6. **Open the sync PR.**

   Base: `origin/main`. Head: the `sync/upstream-...` branch. The PR
   description must state:
   - The commit range (`<oldBaseline>..<newBaseline>`)
   - Who reviewed it and what conflicts (if any) were resolved
   - Links to the gate run (step 5) for both upstream's own tests and T3
     Trades' conformance tests
   - The new tag name this sync will create once merged

7. **On merge: tag and record.**

   ```sh
   git tag -a upstream-base/YYYY-MM-DD-<newShortSHA> <newBaselineSHA> \
     -m "Accepted upstream baseline: pingdotgg/t3code@<newBaselineSHA>"
   git push origin upstream-base/YYYY-MM-DD-<newShortSHA>
   ```

   Update `docs/upstream/BASELINE.md` with the new SHA, tag, date, and a
   link to the sync PR, in the same PR or an immediate follow-up commit on
   `main`.

## Rehearsal record (PROMPT-00 validation)

This procedure was dry-run once to validate it before any trading code
exists:

- Review branch: `sync/upstream-2026-07-30-a8e05cbb`, created from
  `main@694f8d1c` (the `v0.0.30` release point).
- Merged `upstream/main` at `a8e05cbb92633a1351529f2bc402071f615e5051`
  (`v0.0.31`) with `git merge --no-ff`.
- Result: a clean merge commit (`9ea39265`), zero conflicts — the 12-commit
  range `694f8d1c..a8e05cbb` applied cleanly. The resulting tree was
  byte-identical to `main`, confirming the rehearsal reproduced the real
  baseline.
- The rehearsal branch is local-only and is not merged into `main` (`main`
  was already pinned directly at `a8e05cbb`, see `BASELINE.md`); it exists
  to prove the procedure, not to move the baseline.
