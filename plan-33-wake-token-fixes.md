# Plan 33 — Where the wake tokens go: targeted fixes

Source: the 2026-08-17 token audit (artifact "Where the Wake Tokens Go"), measured against
`~/.t3/userdata/state.sqlite`. The audit's numbers: a real turn ran ~130k input tokens, of
which the wake message was ~800 (0.9%). The spend is in (1) every MCP tool result sent
twice, (2) the `mission` scope of `trading_look` being a monolith, (3) the 9.5k-char
decision contract prefixed to every wake on the four CLI adapters, plus two real bugs and
one cheap wake compression.

Guiding principle (the user's stated intent): the model is _given tools_ so a wake can be
small — wake, fetch what you need, execute. Every fix below pushes data out of the pushed
payloads and back behind the tools, and fixes each problem at the layer that owns it.

---

## Phase 1 — Stop sending every tool result twice

**Fix 1.1 — drop `structuredContent` from `CallToolResult`.**
[McpHttpServer.ts:366-373](apps/server/src/mcp/McpHttpServer.ts) builds every success as
both `structuredContent: encodedResult` **and** `content: [{type:"text", text:
JSON.stringify(encodedResult)}]` — verified byte-equal on a live `trading_look`, so a
39,510-char read costs 79,020 on the wire.

- The registered tools declare **no `outputSchema`** (the `McpSchema.Tool` at
  [McpHttpServer.ts:331-346](apps/server/src/mcp/McpHttpServer.ts) sets only
  `inputSchema`), so per MCP spec `structuredContent` is optional; `content` is the
  channel every client reads. Keep `content`, delete `structuredContent`.
- Error path (`toolErrorResult`) and the telemetry tap (`isRejectedToolResult`,
  `result.content[0]`) already read `content` only — no server-side consumer of
  `structuredContent` exists (repo grep: only this file and a generated Codex schema).
- **Pre-check (one query, before coding):** confirm the Codex client forwards `content`
  to the model (not only `structuredContent`) — one live `trading_look` after the change,
  read back from the harness run log in state.sqlite. If a client turns out to consume
  `structuredContent` only, the alternative is the inverse (keep `structuredContent`,
  make `content` a one-line pointer) — but evidence so far says `content` is the one.
- Test: adjust/extend the McpHttpServer test that asserts the result shape.

Expected effect: every tool result halves. On the audited turn that is ~27k tokens back
from ~55k of tool results.

---

## Phase 2 — `trading_look` returns the working set, not the archive

**Fix 2.1 — `triggered` watches belong to the settled tail.**
[TradingStrategyService.ts:240-268](apps/server/src/trading/TradingStrategyService.ts)
`listWatchesForRead` returns `status IN ('active','triggered')` **unbounded** and only
caps the other terminal states at 10. A triggered watch has fired; it is history. The
audited mission read 30 watches, 6 active. Move `'triggered'` out of the unbounded arm
and into the bounded settled arm (`SETTLED_WATCH_READ_LIMIT` stays 10 across all
non-active states). `active` stays unbounded — it is the live armed set and small by
construction.

- Check the wake path too: the composer filters to `status === "active"` before
  rendering ([TradingWakeupComposer.ts:1109-1111](apps/server/src/trading/TradingWakeupComposer.ts)),
  so this only shrinks the look, not the wake.
- Test: `TradingStrategyService.test.ts` — a mission with 6 active + 24 triggered
  returns 6 + 10, newest-first ordering preserved.

**Fix 2.2 — split retrospect out of the `mission` scope.**
[handlers.ts:222-288](apps/server/src/mcp/toolkits/trading/handlers.ts) `readMission`
attaches plan history (10 full revisions), the journal, and target calibration whenever
`scope` includes `mission` — plus `mission.instruction` and `authority`, which never
change. A model scoping correctly (`["position","mission"]`) still pays 20k chars.

- Add one scope value `retrospect` to `TradingLookScope` /
  `resolveLookScopes` (packages/trading-contracts). `withRetrospect` in `readMission`
  keys off `scopes.has("retrospect")` instead of `scopes.has("mission")`.
- `mission` keeps the live working set: mission row (instruction/authority — the mandate
  stays; it is the authority for what the turn may do), mode, current plan, watches
  (post-2.1), pendingExecutions, missionVersion, control, harness.
- `retrospect` adds: `strategyHistory`, `journal`, `targetCalibration`.
- Omitted `scope` (the full assessment read) includes retrospect — unchanged behavior
  for the "read everything" call.
- Tool description: the budget is nearly full (plan-24 memory), so the edit is surgical —
  in [tools.ts:93](apps/server/src/mcp/toolkits/trading/tools.ts) change
  `mission (mandate, authority, plan, watches, journal)` to
  `mission (mandate, plan, watches), retrospect (plan history, journal, calibration)`.
  Net ≈ +30 chars; re-run the toolkit char-budget test.
- Update the DECISION_CONTRACT sentence in step 3 only if it names the moved fields
  (`mission.targetCalibration` is named in step 3 — repoint to the `retrospect` scope).
- Tests: handlers test asserting `mission` scope no longer carries history/journal/
  calibration and `retrospect` does; `TradingSessionProfile.test.ts` still passes
  (tool-name constants unchanged).

**Fix 2.3 (measure-first, optional) — `structure` scope size.** 13,688 chars on the
audited call. Do not change behavior in this plan; add one log line (or reuse the run
log) recording per-scope rendered size so the next trim is chosen from data, not
eyeballing. Candidates if it stays hot: cap `levelHistory` entries, cap `candidates[]`.

---

## Phase 3 — The wake message

**Fix 3.1 — one line per armed watch (render-side only).**
`armedWatches` is 2,394 of 4,802 chars on a real wake, ~55% UUIDs, repeated `missionId`,
`createdAt`/`updatedAt`, and a `condition={…}` restating the `watch={…}` beside it.
The fix is in the _rendering_, not the schema: `TradingHarnessWakeup.armedWatches` keeps
`WakeupArmedWatch` (the UI/schema consumers are untouched), and the three render sites —
`renderWakeup`'s projection, the `essential` projection, and `renderLeanWakeup`
([TradingWakeupComposer.ts:517,596](apps/server/src/trading/TradingWakeupComposer.ts)) —
map each watch through a new compact formatter before rendering:

    - <watchId> <kind> <one-line condition summary> (+123.4 USD / 65 bps away, prediction v7)

- Keep the full `watchId` (it is what `trading_watch cancel`/`replacesWatchId` takes);
  drop `missionId` (the wake already carries it once), `createdAt`/`updatedAt`, the
  duplicated condition object, and `armedReason` except on the triggering watch.
- Implement as `describeArmedWatchLine(persisted, markPrice): string` next to
  `describeArmedWatch` in
  [packages/trading-contracts/src/wakeup.ts:68](packages/trading-contracts/src/wakeup.ts)
  so the arithmetic (signed distance) is written once.
- Expected: wake drops ~a third; the audit's lean-wake average 3,256 → ~2,200 chars.
- Tests: composer render tests — a wake with 8 watches renders 8 single lines; the
  triggering watch keeps its full detail block.

**Fix 3.2 — the lean wake gets a ceiling.**
[TradingWakeupComposer.ts:1237-1239](apps/server/src/trading/TradingWakeupComposer.ts)
returns `renderLeanWakeup(validated)` directly — the one render path that never passes
through `renderBoundedWakeup`, so a pathological review line or event tail has no cap.

- Bound it structurally (same doctrine as `renderBoundedWakeup`: never cut mid-field):
  if the lean text exceeds `MAX_WAKEUP_CHARS`, re-render with `armedWatches.slice(0,4)`
  and `pendingEvents.slice(-1)`; if it still exceeds, fall through to the existing
  `minimal` projection (extract it from `renderBoundedWakeup` or mirror it) and log the
  same "trimmed to fit" warning with steps.
- After 3.1 this ceiling should never fire in practice — it exists so the lean path can
  no longer be the unbounded one.
- Test: a lean wake with an oversized synthetic review line comes back ≤ `MAX_WAKEUP_CHARS`.

---

## Phase 4 — The decision contract rides once, not 206 times

**Fix 4.1 — full contract once per provider-session instance.**
[TradingSessionProfile.ts:147-150](apps/server/src/provider/TradingSessionProfile.ts)
`applyTradingTurnContract` prefixes all 9.5k chars on **every** turn of the four CLI
adapters. The comment says there is no reliable first-turn signal at that seam — but the
adapters _do_ have a per-session-instance seam: `startSession`
([CodexAdapter.ts:1646](apps/server/src/provider/Layers/CodexAdapter.ts), and its Grok/
OpenCode/Cursor counterparts) runs exactly once per in-process session, fresh or resumed.

- In `TradingSessionProfile`, keep the pure text but add a small in-memory delivery
  registry keyed by `threadId`:
  - `resetTradingContractDelivery(threadId)` — called from each adapter's
    `startSession` (fresh **and** resumed: a resume after a server restart means the
    in-process state is new, and after Codex's own compaction the transcript copy may be
    gone — one full copy per session instance is the cheap insurance).
  - `applyTradingTurnContract(threadId, text)` — first call after a reset prefixes the
    full `TRADING_TURN_CONTRACT`; subsequent calls prefix only a slim header:
    `[t3-trade trading session] Trading mission turn — use ONLY the t3-trade MCP tools;
no shell, files, or web. The wakeup follows.` (~150 chars).
  - Mark "delivered" only after the adapter's `sendTurn` dispatch succeeds — a turn that
    failed to send must not swallow the contract. Simplest correct shape: the apply
    function returns `{text, markDelivered}` or the adapters call
    `confirmTradingContractDelivered(threadId)` after a successful dispatch; pick one and
    use it in all four adapters identically.
- Claude adapter unchanged (contract is the system prompt there, already per-session).
- Optional hardening (note, don't build yet): re-send the full contract every Nth turn
  (e.g. 25) as compaction insurance. Decide after Phase 5's architecture call — if wakes
  stop resuming a mega-thread, this becomes moot.
- Expected: on the audited 206-wake thread this retires ~1.9M chars of identical prefix.
- Tests: `TradingSessionProfile.test.ts` — first turn after reset carries the full
  contract, second carries the slim header, a new `startSession` resets; non-trading
  threads untouched.

**Fix 4.2 — one contract, not two (kills the doctrine conflict structurally).**
`FIRST_TURN_CONTRACT`
([TradingTurnCoordinator.ts:165-188](apps/server/src/trading/TradingTurnCoordinator.ts))
calls the projection "an informed estimate, not a prediction" and gives a stale field
list `{price, byMinutes}`; `DECISION_CONTRACT` says the projection _is_ the prediction
with `{direction, price, zone?, byMinutes, invalidationPrice}`. On Codex both landed in
the same first-turn message. Nearly everything else in `FIRST_TURN_CONTRACT` restates
contract steps 1–6.

- **Delete `FIRST_TURN_CONTRACT`** (and `firstTurnContract` from the `BootstrapWakeup`
  schema — it is `Schema.optional`, so old persisted messages still decode). The
  bootstrap wake carries the mission instruction, `defaultTimeframe`, and the optional
  `userMessage` — the contract arrives via the session seam (4.1) or the Claude system
  prompt.
- Fold the two facts only it stated into `DECISION_CONTRACT` where they belong:
  - step 4 (plan): `reassess.afterMinutes` is measured from the last look, values under
    5 are raised to 5, choose the longest interval the thesis tolerates, prefer market
    triggers over the clock;
  - step 5 (watch): already names the metric kinds — carry over only the `volume_ratio`
    parenthetical ("bar volume vs its recent average") if it is not already there.
- The contract's own projection wording is the doctrine that survives (it matches the
  prediction-loop plan and the stand-aside rule).
- Tests: coordinator test asserting the bootstrap message shape; contract prose is
  covered by `TradingSessionProfile.test.ts` tool-name checks.

---

## Phase 5 — Session recycling at episode boundaries (staged, measured)

The finding: thread 76251c29 ran 206 wakes / 181M tokens and was auto-compacted **26
times** on a metronome (~every 8 wakes; the compacted floor stabilizes at ~82k by cycle 3
and never comes down). Only 4 of the 26 surfaced to the harness as a `context-compaction`
activity — for the other 22, a generic coding-agent compactor rewrote the mission's
reasoning invisibly. The 82k floor is a permanent per-wake tax, and it is a _second,
lossy, uncontrolled copy_ of memory that already lives durably in ObservedFacts, the
plan + projection + version, watches, journal, and `trading_harness_runs`.

**Invariant this phase establishes: nothing important lives only in the transcript.**
The database is the mission's memory; a session is a worker that borrows it for a turn.
`threadId` stays fixed as the operator's record — the session behind it stops being
immortal. The seam exists: `ProviderService` resumes only when a persisted cursor is present
([Layers/ProviderService.ts:373-412](apps/server/src/provider/Layers/ProviderService.ts) —
`hasResumeCursor` gates whether `startSession` receives one) and starts fresh otherwise. The mission just has to stop persisting its cursor at
the right moments.

**Stage 5.1 — halve the input first (no architecture change).** This is Phases 1–3 of
this plan. Landing them roughly doubles wakes-per-compaction-cycle on their own and
resets the measurement baseline; draw no architecture conclusions before they land.

**Stage 5.2 — recycle at episode boundaries.** A mission that is flat, with a plan
published and nothing in flight, has nothing load-bearing in its transcript. Drop the
cursor there; mid-trade turns are untouched. Precisely:

- **Boundary condition (all must hold):** run outcome is `waiting_with_setup` or
  `no_setup`, position flat, plan published, **no pending inbox events, no pending
  executions, and the turn was not a `user_message` wake** (operator context in flight
  is never dropped mid-thought).
- **Mechanics:** at settlement of a boundary run, clear the persisted `resumeCursor`;
  the next wake's `startSession` starts fresh. Composes with fix 4.1 automatically —
  every recycle is a `startSession`, so the full decision contract rides the first turn
  of each episode with zero extra logic.
- **The episode brief:** the first wake of a fresh episode is composed from durable
  state, as an extension of the composer's existing full-snapshot path — not a new
  artifact. Missing pieces to add: the `trading_journal` tail and the last N run
  outcomes from `trading_harness_runs` ("woken 4 times, done nothing" is load-bearing
  context a fresh session cannot smell). Target 3–5k tokens, deterministic, testable —
  replacing an 82k opaque summary.
- **Journal as contract, scoped:** the model's uncommitted between-turn reasoning is
  what recycling gives up, so the journal absorbs it — but not as a flat tax. The
  obligation applies to turns that acted or changed the read (entered, exited,
  republished, flipped intent), stated in `DECISION_CONTRACT`, and run settlement
  _records_ whether a state-changing turn journaled, so compliance is visible in
  telemetry rather than hoped for.
- **Compaction observability (regardless of recycling):** surface every runtime
  compaction of a live mission as a harness event. 22 of 26 happening invisibly is its
  own defect; each one is a bounded amount of silent memory loss the operator should be
  able to see.

**Stage 5.3 — measure, then decide the endgame.** Metrics up front, from the run log:
wakes-per-compaction-cycle, per-wake input tokens, cached vs. uncached cost. If an
episode-scoped session never approaches the ceiling, stateless-per-wake is a purity
argument — stop there. If sessions still saturate **while holding a position** (the case
recycling deliberately doesn't touch, and the most likely saturator), the brief is the
thing to invest in — and by then it is already built and proven on episode boundaries.

**Cost math (why the caching objection fails):** resumed turns run ~128.7k of ~129.6k
input cached (99%); at a tenth of price that is ~13k token-equivalents per wake. A fresh
episode start is ~6k uncached — roughly half, before counting the 26 full-context
compaction reads it removes. And the 99%-cached assumption only holds while wakes come
faster than the provider cache TTL: the no-op backoff deliberately stretches quiet
missions toward long intervals, exactly the wakes where the cache has expired and a
resumed turn pays full freight on 130k. Fresh-at-6k wins those turns by ~20×, not 2×.

---

## Order of work and verification

1. Phase 4.2 first (deletes text other phases would otherwise have to keep consistent),
   then 4.1, then 1.1, 2.1, 2.2, 3.1, 3.2. Each lands as its own commit with its tests.
2. After each phase: `typecheck`, the touched test suites, lint.
3. End-to-end: one testnet mission through several wakes; then re-run the audit's
   queries against state.sqlite and compare — expected on a lean-alert turn:
   tool results halved (1.1), `trading_look scope:["position","mission"]` down ~15–20k
   chars (2.1+2.2), wake ~⅓ smaller (3.1), non-first turns lose the 9.5k prefix (4.1).
4. The testnet soak remains the user's to run, per standing convention.
5. Phase 5 stages gate on each other: 5.2 does not start until 1–4 have landed and been
   re-measured (5.1); 5.3's endgame decision (stateless-per-wake or not) is made from
   the soak numbers, not taste.

## Explicitly out of scope

- Any change to `TradingHarnessWakeup`'s schema (3.1 is render-only).
- Stateless-per-wake sessions (the Phase 5.3 endgame — decided by measurement, not now).
- `structure` scope trimming (2.3 measures first).
- Replacing the compactor itself — Phase 5.2 makes it irrelevant at episode boundaries,
  and 5.2's observability event makes the remaining (mid-trade) compactions visible.

---

## Round 2 — four fixes at the encoding boundary (landed 2026-08-18)

Measured, not eyeballed: the 2.3 log line and a synthetic four-timeframe read.

**Fix A — round derived numbers in the observation read models.**
New `packages/trading-contracts/src/precision.ts`. Significant figures, not decimal
places (these markets are not all priced alike): `PRICE_SCALE_DIGITS` 6 for derived
price-scale values, `RATIO_DIGITS` 3 for scores, ratios, percents and bps. Each read
model names the fields it derives — the map is an allowlist, so prices, sizes,
timestamps and ids ride through exact and a field nobody listed stays exact, which is
the safe direction to be wrong in. Applied at two seams only:
`TradingWakeupComposer.observe`'s return (the one gather step a wake and the look's
market half both come through) and `readMarketStructure` in the toolkit handlers, so
the detectors still score on the exact numbers.
Measured: `timeframes` 5,542 → 4,438 (−20%), volatility 1,798 → 1,325 (−26%).

**Fix B — the look's watch rows are rows, not storage.**
`TradingWatchRow` + `toWatchRow` in `watch.ts`; `TradingBoundMissionResult.watches`
now carries them. Drops `missionId` (the look is already about that mission), the
persisted `watch` encoding beside the `condition` that says the same thing in the only
vocabulary `trading_watch` takes, and `lastEvaluatedAt`. Keeps the whole id, the
condition, the status and both timestamps.
Measured: 386 → 233 chars a row (−40%); ~2.1k off a 14-row mission read.

**Fix C — one scope-discipline line in `DECISION_CONTRACT` step 3.**
Full look on the first read of a session or a replan; scope to what fired when
reacting; add `retrospect` for a post-trade review. Doctrine, not enforcement — the
model stays free to take a full look when it judges it needs one.

**Fix D — `structure.regime.conflicts` is bounded.**
It was a cross product: a real four-timeframe read produced **84 entries, 8,758
characters**, out of a dozen distinct labels each repeated seven times — far more than
the 2.8k the audit estimated. `MAX_REGIME_CONFLICTS` is 4, taken one per trending fact
before a second of any of them (breadth over depth), with a final line counting what
was dropped so the bound is never silent.
Measured: regime 9,842 → 1,552.

**Net on the structure scope: 20,526 → 10,744 chars (−48%).** Typecheck, lint, and the
full trading-contracts (474) and server (1,172) suites are green. The testnet soak
remains the user's to run.

**Then stop optimizing tools.** After A–D what is left in a look is information the
model uses, encoded tightly. Further reduction is either lossy or complexity.
