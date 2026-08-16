# Plan 29 — Restructure T3 Trade around the trader model

Execution plan derived from
[`docs/architecture/agent-tool-architecture-research.md`](../architecture/agent-tool-architecture-research.md).
Read that first; this document does not re-argue any of it.

**Goal.** A user says "Trade BTC", walks away, and a model trades on their behalf
under hard constraints — taking many small positive-expectancy trades, keeping a
plan it revises, setting its own triggers, and narrating in plain language.

**Baseline at time of writing.** `pnpm test` 2,518 passed / 10 skipped across
271 files; `pnpm lint` exit 0 with ~25 pre-existing warnings. That line is out
of date — the current count is in Appendix A, which is the one to read.

At the time this was written there was uncommitted work in flight across 18
files (chart geometry, cost sizing, quote service, momentum detectors). It was
NOT landed before phases 1–7 ran, despite step 0.1 saying so; it landed with
phase 8. See Appendix A, A15.

---

## Guiding rules

1. **Every step ships alone.** No step depends on a later one to be correct.
2. **Measure before you change.** Phase 0 exists so every later claim is
   falsifiable.
3. **Cheap and reversible first.** Doctrine before code, code before schema,
   schema before UI.
4. **Never loosen a risk gate.** Discipline gates go; size, leverage, per-trade
   loss, session loss and the resting stop do not move.
5. **A step is done when its number moves**, not when the code compiles.

---

## Phase order and why

The order this plan intended is no longer the order that happened — P6 landed
before P4, and P8, P9 and P10 landed together in an afternoon. What actually
ran, from the commit history:

```
P0 → P1 → P2 → P3 → P6 → P4 → P5 → P7 → P8 → P9 → P10
```

P1, P2 and P7 were independent of each other and of everything else, which is
why the order could move without anything breaking. P4 was the entangled one
and was deliberately late.

---

## Phase 0 — Baseline and instrumentation

**Why first.** Every claim in the research is a hypothesis about numbers nobody
is currently recording. Without this phase, no later phase can be shown to have
helped.

### Step 0.1 — Settle the working tree

- Land or stash the 18 in-flight files. The chart geometry work (`nowX`, future
  gutter, `ChartTimeMarker`) is wanted by P8 — land it.
- Confirm green: `pnpm typecheck`, `pnpm test`, `pnpm lint`.

### Step 0.2 — Session metrics

Record per session, queryable:

- trades, win rate, **net bps per trade** (the headline number)
- cost as a share of gross (fees + spread + slippage, separately)
- plan versions published, wakes taken, wakes that changed nothing
- time in market as a share of session length
- stand-down code histogram

Most of this already exists in `assessActivity` and `TradingRunTelemetry`; the
gap is a single readable per-session rollup.

### Step 0.3 — Capture a baseline session

One testnet session on today's code. This is the control group. Everything after
is compared to it.

**Done when:** a single command prints the eight numbers above for a session.

---

## Phase 1 — Doctrine (prompt only, no code paths)

**Why here.** Research Part 12 F7: most of the friction is prose the model obeys,
not code that rejects. This phase tests that hypothesis for the cost of editing
strings, and it is fully revertible.

### Step 1.1 — Rewrite `playbook.ts` prose

- Delete "READ THE REGIME BEFORE YOU LOOK FOR A TRADE" and the mandatory
  classify-first ordering.
- Delete the requirement to publish on every assessment turn (`playbook.ts:248`).
- Delete the mandatory tournament and the "justify a stand-down against the best
  candidate" instruction.
- Keep: stop discipline, the risk envelope, the session cooldown.

### Step 1.2 — Rewrite `POC_STANDING_INSTRUCTION`

Replace the scolding-about-stand-downs paragraph with the single gate:
_is the expected move over your intended hold bigger than the round trip is
worth?_ No taxonomy, no tournament.

### Step 1.3 — Shrink tool descriptions

Target: under 6,000 chars total (from ~15,000). Strip rejection-code
enumerations, cross-references and formatting instructions. Lower the budget
assertions in `tools.test.ts` to lock the gain in.

### Step 1.4 — Re-measure

Run a session. Compare to the 0.3 baseline.

**Done when:** plan versions per session and no-op wakes both fall materially,
with no code path changed. If they don't, the F7 hypothesis is wrong and P3
becomes more important than assumed — a useful result either way.

---

## Phase 2 — Cost and order type

**Why here.** Independent of everything, highest economic value, no schema
change. Research Part 3: this is worth more than any strategy improvement.

### Step 2.1 — Maker rate in the cost model

- `TradingCostEstimator` reads `userAddRate` alongside `userCrossRate` — both are
  already in the `userFees` response it fetches.
- `TradingCostEstimate` gains `makerFeeBpsPerSide` and per-combination round
  trips: taker/taker, taker/maker, maker/maker.
- Note in the estimate that a maker side pays no spread crossing.

### Step 2.2 — ALO in the wire mapper

- `OrderMapper.ts:152,179,320` currently emit `Ioc | Gtc` only. Add `Alo`.
- **GTC is not a maker guarantee** — a GTC priced through the book crosses and
  pays taker. Only ALO guarantees maker. Add a rejection path for "would have
  crossed".
- ~~Extend `MomentumOrderPreference` (or its successor) with `post_only`.~~
  **Overtaken by step 2.3 before it landed.** The model names no order type at
  all now: `OrderPreference` (`strategy.ts`) is server-internal and the tools
  take `urgency`. Right outcome, stale step text.

### Step 2.3 — Urgency on entry and exit

- `enter` / `exit` take `urgency: "now" | "patient"`.
- `now` → IOC. `patient` → ALO at a stated price.
- **The model never names a time-in-force.** The execution layer maps urgency to
  TIF and reports what was actually paid.

### Step 2.4 — Order working loop

The one genuinely new component. An ALO entry that rests unfilled needs an owner:

- re-price on a stated cadence, or
- cross after a stated wait, or
- abandon and tell the model.

Keep it small and explicit. Note that Hyperliquid's `Chase` order type is a
browser-tab feature (max 5 active) and is **not** usable server-side.

### Step 2.5 — Maker exits by default

Take-profit becomes a resting reduce-only ALO. Stops stay market orders — a stop
is not a place to be patient.

### Step 2.6 — Cost at traded size, not ceiling

Plan-28 defect 5: the gate is priced at the approved ceiling, where slippage was
55% of the round trip. Price it at the size the mission would actually take.
Reconcile `roundTripCostFractionOfNotional` (excludes slippage) with
`estimateTradingCosts` (includes it in full at ceiling size).

### Step 2.7 — Measure

Fee share of gross, and maker fill rate.

**Done when:** realised cost per round trip falls from ~9 bps toward ~6 bps
blended, measured on real fills — not modelled.

**Which number that is.** The 9→6 measure is `economics.feesBps +
entrySpreadBps + entrySlippageBps` — cost per ROUND TRIP. It is not
`feeShareOfGross`, which is fees over PER-FILL notional and therefore prints
~0.05% at the old all-taker rate; a round trip is two fills, so the two cannot
be compared digit for digit. `feeShareOfGross` measures something else worth
measuring: how much maker execution you are actually getting, per side. Step
10.2 put `feeShareOfGross` in the report's headline block and demoted the
round-trip number below it, so a reader checking 9→6 must scroll past the
headline to the line that answers them.

**Risk to watch:** adverse selection on maker _entries_. Track fill rate and
post-fill drift. If resting entries fill 85% of the time and price keeps going
against you, revert entries to taker and keep maker exits only.

---

## Phase 3 — Remove the gates

**Why after P2.** Loosening entry criteria before costs are cheap produces more
trades at negative expectancy. Cost first, then freedom.

### Step 3.1 — Cost stops being a gate

Remove as gates: `minimumViableTargetUsd`, `clearsCostGate`,
`requiredCostMultiple`, `entryCostMultiple`. Cost survives as **one line of
context** in the observation and nothing compares against it.

### Step 3.2 — Delete the target-basis ceremony

- Remove `checkProfitTarget` rejections (`target_basis_missing`,
  `target_basis_arithmetic_mismatch`) and the eleven-field `ProfitTargetBasis`.
- Remove `TARGET_BASIS_TOLERANCE`.

### Step 3.3 — Discipline checks out of preview

From the 17-item ENTRY checklist remove exactly three:
`strategy_version_current`, `authority_version_current`, `market_is_eth`.
**Keep all risk, correctness, control and concurrency checks.**

`market_is_eth` is removed from the ENTRY list only. It survives in
`EXIT_CHECKS` (`TradingPreviewService.ts`), where refusing to close a position
in a market the mandate does not name would be the wrong answer, and the entry
side keeps the same check earlier under the same name in
`TradingEntryService.ts`. That is the right call; this text is amended to
match what landed. This is the same reasoning the exit checklist
already applies — apply it a second time.

### Step 3.4 — Detectors report near-misses

`readEmaCross`, `readRsi` and friends return the candidate with a `rejectedBy`
field naming the gate and its margin, instead of `null`. A signal 5% under
threshold and no signal at all must stop being indistinguishable.

### Step 3.5 — Drop the ATR proof-of-work

`trading_adjust_stop`'s `atr_mismatch` asks the model to restate a number the
server computed. Remove it. Keep the risk-envelope, noise-floor and
breakeven-ratchet checks.

### Step 3.6 — Measure

Trades per session, time in market, and **net bps per trade**. If trade count
rises and net bps per trade goes negative, the gates were load-bearing and this
phase needs partial revert.

---

## Phase 4 — Reshape the plan

**The entangled phase.** Touches reactor, strategy service, watch binding, wakeup
composer, schema, and the UI.

### Step 4.1 — Position-centric plan schema

Replace the twenty-field document with:
`market, intent, entry, stop, target, invalidation, reassess, because`.

Removed: strategy name, mode, regime, `belief.evidence[]`, `timeframes[]`,
`scaleInConditions[]`, `abandonmentConditions[]`, `reentryConditions[]`,
`alternativesConsidered[]`, `targetProfitBasis`, `currentAction`,
`standDownCode`.

Strategies and indicators move into `because` as prose.

**Note:** `tradingPresentation.ts` already flattens the document to ~10 display
fields (`thesis`, `entryTriggers`, `stopSummary`, `targetUsd`, `maxLossUsd`,
`invalidation`, `initialSizeUsd`, `isStandDown`, `alternatives`). It is a
ready-made specification for this schema — use it.

### Step 4.2 — Revise, don't version

- Drop `strategy_version` from `trading_watches` and its index.
- Drop `strategy_version` / `strategy_family` from `trading_missions`.
- Rename `momentum_strategy_versions` to something position-shaped; keep history
  for the journal, but **nothing gates on it**.
- Remove supersede-on-publish (`TradingStrategyService.ts:268`). Revising a plan
  updates its triggers in place; only genuinely changed conditions re-arm.

### Step 4.3 — Publishing stops being a precondition for waking

Reactor coordinator check 7 currently allows only `mission_created` to proceed
without a published strategy. **This is the ignition of the churn loop** — the
model must publish to stay wakeable, and publishing cancels its own alerts.
Remove the precondition.

### Step 4.4 — Rewire the status machine

`analysing → waiting` is currently an edge only the publish act can take. Give it
a new reason: _a plan exists and its triggers are armed._ Collapse the nine-value
`MomentumStrategyAction` to `waiting | holding`.

### Step 4.5 — Plan writes protection

Writing the plan places or moves the stop and target on the exchange. The plan is
the position's declared state; the server reconciles the exchange to it. This is
why a separate `protect` tool is unnecessary.

### Step 4.6 — Plan expiry

An untriggered plan goes stale on its own and prompts a reassessment.

### Step 4.7 — UI migration

`strategyVersion` appears 29 times across the trading components;
`plainSummary`, `targetProfitUsd`, `targetProfitBasis`, `currentAction` and the
belief fields are all rendered. This is the larger half of the phase — budget for
it accordingly.

**Done when:** a session runs with no version numbers anywhere, watches survive a
plan revision, and discarded wake firings fall to zero.

---

## Phase 5 — Strategy-agnostic execution

### Step 5.1 — `strategyVersion` out of the execution path

69 references across 22 files, including `HyperliquidExecutionService`,
`TradingExitService`, `execution.ts`, `quote.ts`, `history.ts`, `watch.ts`.

**Target state:** the execution path takes market, side, size, price, urgency and
stop — and nothing about why. Trade history records the reason as an annotation,
never as a key that can invalidate an order.

**Done when:** a grep in `HyperliquidExecutionService`, `TradingExitService`,
`execution.ts`, `quote.ts` and `watch.ts` returns nothing. NOT "grep returns
nothing" anywhere: `strategyVersion` survives on purpose as a label on trade
history (`history.ts`, `calibration.ts`, `TradingTradeHistoryService`,
`TradingClosedTradeReview`, `TradingCalibrationService`), which is the target
state, not a leftover.

### Step 5.2 — Rename the strategy-coupled types

81 `Momentum*` occurrences across 13 type names: `MomentumBelief`,
`MomentumEntryPlan`, `MomentumProtection`, `MomentumPositionManagement`,
`MomentumStrategyAction`, `MomentumStrategyDirection`, `MomentumOrderPreference`.
A stop is not a momentum concept.

### Step 5.3 — Rename `momentum.ts`

It holds pivots, EMAs, RSI, ATR, swing structure, excursion distributions and
breakouts — generic market readings, not momentum. Name it for what it is.

### Step 5.4 — Retire `strategyFamily`

A single-value enum on the mission.

**Done when:** grep for `strategyVersion` in the execution path returns nothing.

---

## Phase 6 — Consolidate the tools

24 tools → 6. Ordered after P4 because most of the removals are plan machinery.

### Step 6.1 — `look(market?)`

Merge the eight read tools and `TradingWakeupComposer` into one. They are two
implementations of "what does the model need to know"; the composer becomes the
implementation. Include the one-line cost context.

### Step 6.2 — `plan(...)`, `enter(...)`, `exit(...)` — LANDED

Retire the quote-then-execute two-step and its table (`trading_entry_quotes`).
**`enter` must work with or without a plan.**

`trading_execution_sequences` is NOT part of the two-step and stays: the exit
service, the stop-adjustment path and both lanes of the working-order loop
allocate from it, its counter is what derives every cloid, and the
working-order lineage walk orders on it.

The evidence the quote row carried — the book, the stop, the plan-27 C1 setup
snapshot — moved to `trading_entry_context`, keyed by the mission-local
execution sequence, before the table went.

### Step 6.3 — `watch(condition)` — LANDED

One predicate union replacing the eight watch types the model had to choose
between. `WatchCondition` is five kinds — `price`, `pnl`, `giveback`, `fill`,
`time` — and `trading_watch` is the one tool that arms one. `MarketWatch`
survives as the persisted and evaluated encoding, derived by `toMarketWatch`
and read back by `toWatchCondition`, so no row in `trading_watches` migrated
and the evaluator, the coverage floor and the wake composer are untouched.

Two defaults are applied because neither can be wrong: a level with no stated
confirmation is a touch, and a touch with no stated source is the mark. The
`interval` under `confirm: "close"` is refused rather than guessed — guessing
it arms a 1h breakout on a 1m wick.

A condition the server will not arm returns `outcome: "refused"` with a
`recovery`, not a thrown error. `close_needs_interval`,
`pnl_target_not_a_gain` and `fill_needs_order_or_market` all stand down (rules
about the condition, so the identical call gets the identical answer); an
ended mission reads `read_state`. `replacesWatchId` still reaches
`registerWatch` unchanged, so the cancel and the insert stay one transaction.

Carried forward from the 6.1 review: `listWatchesForRead` bounds the registry
read that rides every `trading_look`. The cap is not recency — a watch that
FIRED and has not been reasoned about is older than every level armed after
it — so every `active` and `triggered` row is returned in full and only the
settled tail is capped at ten. `listWatches` is unchanged and still unbounded
for the evaluator, the coverage floor and the composer, none of which may miss
an armed watch. `trading_execution_sequences` was not touched.

The playbooks and the session doctrine were retranslated into the condition
vocabulary: they no longer instruct the model in type names it cannot write.

Toolkit is still 12 tools at 3,640 description chars.

### Step 6.4 — `journal(note?)` — LANDED

Append-only. This is the deliberate replacement for the memory role the plan
document was accidentally serving, and it is the same object the UI timeline
renders.

One tool for both halves, because they are one vocabulary: `note` is the field
the model writes and `note` is the field it reads back, in `entries`. A
separate read tool would be a second name for the same thing and a second
chance to drift — the split 6.3's review turned on.

`trading_journal` with a `note` appends; without one it reads. The table
(`trading_journal`, migration 066) has no update and no delete, which is the
point: the plan document is replaced on every revision, so everything the model
wanted to remember across revisions was being smuggled into `because` and lost
with it.

Two refusals are rules about the note (`note_empty`, `note_too_long` — refused,
never truncated, since a note cut mid-sentence reads back as something the
model did not say) and one is not (`mission_not_found`, the mission ending
underneath the call). All three carry a `recovery` from `classifyFailure`, and
the journal rides the refusal so a rejected note costs no second call.

The notes join the wakes, the stop steps and the publishes on
`missionTimeline`, read at projection-read time like every other source. They
draw in muted grey rather than the armed amber a triggered wake uses — a note
is the model talking, not the market moving.

Toolkit is 13 tools at 3,928 description chars.

### Step 6.5 — Retire the rest — LANDED except `trading_get_playbook`

Thirteen tools to seven. `trading_get_playbook` was later renamed
`trading_strategy` (step 9.2) rather than retired, which is the right outcome. Per tool:

- **`trading_publish_plan` → renamed `trading_plan`.** Nothing else moved: the
  same `tradingPlanAuthoredFields`, the same `expectedMissionVersion` guard,
  the same publish aftermath (the 4.5 reconcile, the `scope: "entries"`
  retraction). Plans are still published, so `misarmedEntryConditions` and the
  `confirmation`-vs-`confirm` distinction are untouched, and the funnel's
  plan-published signal is the same one-line comparison in
  `TradingRunTelemetry` — now against `TRADING_PLAN_TOOL`. `deriveDecisionOutcome`
  reads the identical `publishedPlan` fact.
- **`trading_close_position`, `trading_reduce_position`, `trading_cancel_order`,
  `trading_adjust_stop` → folded into `trading_exit`,** one `action` each.
  The first three are the same `executeExit` call three names used to make;
  `move_stop` is the retired handler lifted whole, so
  `TradingStopAdjustmentService.evaluate` and `checkStopAdjustment` still gate
  every stop move — the approved envelope, the ATR step cap, the noise floor,
  the breakeven ratchet, the rate limit. No gate loosened. `urgency` is still
  the only order knob named. The input is a flat struct rather than a union
  because the tool boundary rejects a root `anyOf`; the combinations that make
  no sense are refused by name in `readExitRequest`, before anything is read or
  sent, with a `recovery` from `classifyFailure`.
- **`trading_list_watches` → removed outright.** The registry rides
  `trading_look` as `mission.watches`, bounded by 6.3's `listWatchesForRead`.
- **`trading_cancel_watch` → folded into `trading_watch` as `cancel`.**
  Cancelling is a watch shape. Exactly one of `condition` and `cancel` per
  call; neither or both is `needs_condition_or_cancel`. The two ways a cancel
  can miss — `watch_not_found` and `watch_not_active` — stay distinguishable,
  because a level that fired and a level that was never there are different
  facts about the armed set.
- **`trading_get_target_calibration` → off the hot path, onto
  `trading_look`** as `mission.targetCalibration`, omitted entirely until the
  mission has a closed trade to grade. It answers a question the one read was
  already half-answering: `strategyHistory` says what was targeted, this says
  whether any of it was reachable.
- **`trading_get_playbook` — NOT retired.** It is the one that is not a
  mechanical fold. Retiring it means moving ~25KB of static playbook prose into
  the prompt, and that is a _worse_ trade for four of the five adapters: only
  Claude gets a system prompt sent once per session — the other four carry
  `TRADING_TURN_PREFIX` on every turn, where 25KB per wake costs more than the
  tool call it replaces. Doing it properly means either splitting the doctrine
  by adapter or cutting the playbooks down, and either is its own step with its
  own measurement.

No surviving description grew to absorb a retired one on net: `trading_exit`
at 452 is shorter than the four it replaces were together (776), and
`trading_watch` grew 48 chars to carry `cancel`. The rest are unchanged.

`trading_execution_sequences`, `idx_trading_harness_runs_one_active_per_mission`,
`abandon`'s `all`/`entries` scopes and `trading_enter`'s non-idempotence were
not touched.

**Done when:** the toolkit is 6 tools under ~4,000 description chars. Seven at
2,797 — the char budget is met with room to spare and is deliberately not being
spent.

---

## Phase 7 — Enrich the observation — LANDED

Six commits, one per step, plus one review fix. Every reading is in
`packages/trading-contracts/src/microstructure.ts`, built once in
`TradingWakeupComposer.observe` so the look and the wake cannot disagree, and
rendered onto the wake for 519 characters against a 5,000-character budget.

Two things worth carrying forward:

- **The book is read once.** `trading_look` used to take its own `getOrderBook`
  while the wake took none. Both now take the composer's, and the read is
  guarded with `suspend` + `catchCause` — not `orElseSucceed` — because a
  gateway that throws while _building_ the effect and one that dies mid-read
  both produce something the error channel never sees.
- **A delta needs a gap.** `observe` runs on every look, so the market sample it
  compares against is only replaced once it is older than
  `MARKET_SAMPLE_MIN_SPAN_MILLIS`, and the change fields are withheld below it.
  Without both halves, a model that looked twice in a turn measured open
  interest over three seconds — during which it never moves — against a mark
  that had ticked, and read a squeeze that the act of looking had invented.

Independent; can run any time after P0.

### Step 7.1 — Order book imbalance

Bid vs ask depth over top N levels. Highest-value addition — its predictive
horizon matches the intended holding period.

### Step 7.2 — Aggressor flow

Share of recent trade volume crossing into the ask vs the bid.

### Step 7.3 — Depth and spread stability

A thinning book means slippage is about to rise and stops are about to be run.
Also feeds Phase 2's cost model and the market-stress detection noted in the
research limitations.

### Step 7.4 — Open interest change vs price

Rising OI with price is new longs; falling OI with rising price is a squeeze.

### Step 7.5 — VWAP distance and short/long realized-vol ratio

The vol ratio is the single number gating whether to trade at all.

### Step 7.6 — Indicators become readings, not verdicts

`readEmaCross() → CandidateSetup | null` becomes an always-present reading with
no score, no `clearsCostGate`, no null. Depends on Step 3.4.

**Landed for the EMA cross only.** `readEmaCross` is gone and `EmaTrend` always
carries `direction` and `separationAtr`; `readRsiReversion` and
`readTrendContinuation` still return a 0–1 score. Step 3.4's `rejectedBy` means
near-misses survive either way, so the problem this step was aimed at is
solved — but "no score, no null" is true of one detector out of four.

**Explicitly not adding:** MACD, Bollinger, Ichimoku, stochastics — same
information as the candles, more tokens.

---

## Phase 8 — The chart as the mission interface

Depends on P4 (the plan's shape decides what is drawn) and on the in-flight
geometry work landed in Step 0.1.

### The visual system this phase builds inside

`MissionLivePanel` was restyled by hand before this phase started, and the
result is the baseline every step below works within rather than something to
be redesigned. It is not up for revision as a side effect of a step:

- **One typeface for figures.** Every number on the panel is mono, at one of
  two sizes: the P&L at 16px because it is the number being read, everything
  else at 10.5–11px because it is context for it. Prose — the plan's thesis,
  the disclosure — stays in the UI face. A proportional face in a column of
  prices is what made four rows of numbers read as four unrelated facts.
- **Band legends on the left rule.** `next`, `armed`, `held` — mono, 10px,
  uppercase, wide-tracked, in the faintest ink on the card (`BAND_LEGEND_CLASS`).
  They label the row beneath them and are never figures.
- **Two context bands bracket the checklist.** The schedule strip and the held
  line share one faint ground a shade off the card (`CONTEXT_BAND_CLASS`), so
  the checklist between them reads as the panel's centre of gravity.
- **One number, one place.** P&L, ROI and progress-to-target are header
  figures; the position strip does not repeat them.
- **Progress-to-target is drawn in the accent, not the P&L tone.** Distance
  travelled toward a target is not the same statement as whether the position
  is up, and painting the rule red through a drawdown said the plan had gone
  wrong when only the mark had moved.

Any step that changes type, colour or band structure has to say why, and has to
keep these five rules true or replace them deliberately.

### Step 8.1 — Finish the future gutter

`nowX`, the gutter and `ChartTimeMarker` exist. Add: bounded trigger segments
that stop at their expiry, and a visual register that makes gutter contents read
as hypothetical (thinner, dashed, lower opacity).

### Step 8.2 — Motion

Advance `nowX` smoothly rather than jumping per projection update. This is what
makes the conveyor metaphor legible.

### Step 8.3 — Sliding markers

Relative conditions (a stall trigger) render as markers that slide right as the
condition resets.

### Step 8.4 — Direct manipulation

Drag stop, target, trigger price, and trigger expiry, with a live dollar-risk
readout. **A drag is a `plan()` revision** — the UI writes the same object the
model writes. The user's drag wins, is journaled with `author: user`, and the
model is told on its next wake.

Three things this walks into, none of them optional:

- **The journal has no author.** `trading_journal` is `(id, mission_id, note,
created_at)` and `TradingJournalEntry` is `(id, note, at)`. `author` is a
  migration (067 is free; 068 is taken by the market samples) plus a contract
  field plus a default of `model` for every existing row. Land it before the
  drag handler, not with it.
- **A drag sends orders.** `trading_plan` holds an optimistic lock on
  `expectedMissionVersion`, and since step 4.5 an accepted publish reconciles
  the exchange immediately — the stop and the resting target move at publish
  time. So a drag can lose the lock to a model publishing in the same second,
  and it can be accepted while the reconcile refuses to widen a stop. Both need
  an answer on screen.
- **The eight authored fields are the contract.** A drag writes the same fields
  `tradingPlanAuthoredFields` names, in the same shape. A UI-local plan object
  would drift, and `misarmedEntryConditions` compares the plan's `confirmation`
  against the watch's `confirm` on the assumption that it has not.

### Step 8.5 — Strip the panel

Down to: P&L hero number, the chart, one sentence, and the journal timeline in a
drawer. The model speaks in sentences, never fields. Values appear only when
actionable.

**Amended.** This step was written before the panel was restyled, and one of
its clauses — "prices become lines, never rows" — now argues with the landed
design, which deliberately keeps two rows of figures: the armed checklist
(observed against threshold, read _down_ the list in fixed-width columns) and
the `held` strip. Those rows are not the duplication the step was aimed at.
What it was aimed at is a panel that says everything it knows at all times.

So the rule for this step is narrower than the original sentence: a figure
earns its place by being one the operator would act on now. The checklist rows
stay — they are the one place a threshold and its live reading sit side by
side. What goes is anything the chart already draws as a line, anything
repeated from the header, and any field that is present only because the plan
has a field for it. Cut _within_ the visual system above; do not replace it.

### Step 8.6 — State-driven layout

Waiting / in-position / between-trades render differently.

**Partly landed.** `readPanelState` already discriminates
`planning | armed | live | complete`, and the header, the checklist gate and
the chart gate already branch on it. What remains is layout rather than
content: the four states currently draw the same bands in the same order and
differ only in what is absent. Decide per state what belongs at the top.

### Step 8.7 — The phone test

If the default view does not fit a phone, it is not the default view.

**Done when:** a walk-away user answers all six questions from one screen, and no
more than five future markers are ever visible.

---

## Phase 9 — Mode B: "Execute strategy X"

### Step 9.1 — Mode on the mission

Discretionary is the default.

**Amended to what landed and what was decided.** The mode is DERIVED from the
mandate rather than stored beside it (`mode.ts`), which keeps one source of
truth and costs no migration; the panel shows it, so a wrong read is visible in
the first ten seconds.

- **System prompt: done, as one paragraph rather than two prompts.** Step 2 of
  the decision contract in `TradingSessionProfile` now points at
  `mission.mode`, says the doctrine there wins, and states what execute mode
  means. Two whole prompts were not built: the mode is known at
  `trading_look`-time, not at the seam where the five adapters build a session,
  and threading a mission read into all five to vary one paragraph buys less
  than it costs.
- **Tool subset: dropped deliberately.** There are seven tools and no subset of
  them that execute mode should be denied — an execute-mode mission still
  looks, plans, arms, journals, enters and exits. The step should not have
  promised one.

### Step 9.2 — `strategy(name)` tool

Returns the rule set. In this mode the playbook **is** the decision procedure and
the model's job changes from _decide_ to _execute faithfully and report
deviations_.

### Step 9.3 — Existing playbooks become the library

`momentum`, `range_reversion`, `opening_range`, `ema_cross`, `rsi_reversion`
survive here unchanged, doing the job they were written for.

---

## Phase 10 — Soak and learn

### Step 10.1 — Testnet soak

The standing outstanding item since plan 23. Run it.

### Step 10.2 — The four numbers

Trades per session, net bps per trade, cost as a share of gross, maker fill rate.

### Step 10.3 — Turn the journal into a learning loop

`assessEntryGovernance` already splits trades by whether a scored setup was
behind them. Extend it to tag which readings were notable at entry, so the
question _do EMA-cross entries actually pay?_ is answered from real trades.

**This inverts the relationship:** strategies stop being a priori rules with a
veto and become a posteriori evidence the model weighs.

---

## What this plan does not do

- **It does not loosen a risk gate.** Size, leverage, per-trade loss, session
  loss and the always-resting exchange stop are untouched throughout.
- **It does not claim to create edge.** Every phase removes an obstacle or
  reduces a cost. If the model's directional reads are coin flips, this makes
  losing more efficient. Phase 10 is what finds out — on testnet, then at small
  size for a long time.
- **It does not rewrite the engine.** The Hyperliquid gateway, signing and
  submission, the reconciler, fill reconciliation, the decision lease, the
  measurements and the replay discipline all survive. That is most of the code
  and all of the parts that are hard to get right.
- **It does not widen scope to multi-market or multi-mission.** Both are
  database unique indexes; both are out of scope here.

## The one invariant worth restating

`idx_trading_harness_runs_one_active_per_mission` — at most one non-terminal run
per mission, enforced in SQLite — survives every phase untouched. It is what
stops two turns racing to open the same position.

---

# Appendix A — Audit before human testing

First pass 2026-08-16 at commit `add220b1a` (phases 0–7). **Re-run at commit
`a15c4dd1e`**, after 27 more commits landed phases 8, 9 and 10.

**The numbers in every example below** are the testnet defaults the code ships
([authority.ts:152-161](../../packages/trading-contracts/src/authority.ts:152)),
so you can check any of them against a real session:

| Setting                         | Value            | On $100 of capital     |
| ------------------------------- | ---------------- | ---------------------- |
| Market                          | ETH (default)    | —                      |
| Max position size               | 8 × capital      | $800                   |
| Max you can lose on one trade   | 7% of capital    | $7                     |
| Max you can lose in the session | 35% of capital   | $35                    |
| Max leverage                    | 20×              | —                      |
| Taker fee (crossing)            | 4.5 bps per side | $0.045 per $100 traded |
| Maker fee (resting)             | 1.5 bps per side | $0.015 per $100 traded |

ETH is priced at $3,000 throughout. One basis point (bp) is 0.01%, so 30 bps of
ETH is $9.

**Test run at `a15c4dd1e`.** `pnpm typecheck` passed. `pnpm test`: 2,249 passed,
14 skipped, **1 failed**, 2 files failed, across 226 files.

Both failures are timeouts in the jsdom web suite, not assertions: a 15-second
test timeout in `apps/web/src/lib/imageCompression.test.ts`, and a 30-second
`beforeAll` hook timeout while `MessagesTimeline.test.tsx` was importing its
module. **The first pass at `add220b1a` had four such timeouts in a different
set of files** (`imageCompression` ×3 and `Sidebar.logic`), which is what a
load-sensitive flake looks like rather than a regression. No trading test fails
in either run.

**I re-ran those two files on their own: both pass, 26 tests in 3.0 seconds.**
So they are not broken — they are timing out because the full run has them
competing for the machine. Raise the timeouts or mark them serial before the
soak: a suite that fails in a different file every run cannot tell you a real
regression from a busy machine, and during a soak that is exactly the signal you
will be relying on.

The number at the top of this plan (2,518 across 271 files) is out of date — use
this line.

---

## Where the first pass stands

|         | Finding                                                 | Status at `a15c4dd1e`                                   |
| ------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **A1**  | Stop can be widened past your per-trade limit           | **Fixed** in `542fbf1a0`. Two follow-ups left — see A1. |
| **A2**  | Every trade sized as if both sides pay the taker fee    | Open                                                    |
| **A3**  | Book imbalance compares unequal sides                   | Open                                                    |
| **A4**  | `aggressorFlow.bars` counts empty bars                  | Open                                                    |
| **A5**  | "VWAP" is a rolling two-hour average                    | Open                                                    |
| **A6**  | Publishing a plan is two writes with no transaction     | Open — **and now on two code paths**                    |
| **A7**  | One bad plan row kills the mission                      | Open                                                    |
| **A8**  | Phase-7 readings vanish silently from an oversized wake | Open                                                    |
| **A9**  | `move_stop` still requires proof you read the plan      | Open                                                    |
| **A14** | The model is never told what the phase-7 readings mean  | Open                                                    |
| **A15** | Phase-8 chart work uncommitted                          | **Resolved** — committed, and phases 8–10 finished      |
| **A16** | Code that could be shorter                              | Open, and two items got bigger                          |

Phases 8, 9 and 10 brought four new findings: **A17** (mode is guessed from
your sentence, and guesses wrong), **A18** (mode selects neither a prompt nor a
tool subset, so step 9.1 is half-done), **A19** (a dragged target has no failure
feedback and a dragged trigger would be wrong if it were reachable), **A20**
(the learning loop ranks setups by total dollars, so one lucky trade wins).

> **This table is the audit as it stood, and is left that way on purpose.**
> Every row in it has since been fixed, decided or declined — **Appendix B** is
> the record of what was actually done, and is the one to read for current
> state. Nothing below this line is outstanding work.

---

## A1 — Fixed, with two follow-ups

`542fbf1a0` fixed it exactly as described: the envelope lookup now gives the
entry record a minute of lead
([TradingPlanProtectionService.ts:221](../../apps/server/src/trading/TradingPlanProtectionService.ts:221),
[:361](../../apps/server/src/trading/TradingPlanProtectionService.ts:361)), and
the test fixture now stamps the two timestamps in the order production does.

**Two of the four fixes are still outstanding.**

### A1a — The same query in `move_stop` was not fixed

[TradingStopAdjustmentService.ts:254](../../apps/server/src/trading/TradingStopAdjustmentService.ts:254)
still reads `AND created_at >= ${openedAt}`, with no lead. It looks for the
entry's approved stop and, for the same reason A1 explained, never finds it —
so it falls back to _the stop that is currently resting_
([:258](../../apps/server/src/trading/TradingStopAdjustmentService.ts:258)).

The direction is safe, but the behaviour is not what the code says. What you
will see in a session:

```
Entry:    long 0.13 ETH @ $3,000, stop $2,946   (risk $7.02, approved)
10:38     good move — model tightens the stop to $2,970
10:51     pullback — model wants to give it room back to $2,955
          (still $5.85 of risk, well inside the approved $7)
          → refused: risk_envelope
```

Once the stop moves in, it can never move back out, even inside the approval.
The comment at
[TradingStopAdjustmentService.ts:246-250](../../apps/server/src/trading/TradingStopAdjustmentService.ts:246)
describes a scoping rule that never takes effect. **Fix:** apply the same
`ENTRY_RECORD_LEAD_MILLIS` lead, and add a test that seeds `opened_at` later
than the entry record (no test seeds it at all today, so this path only ever
runs with `openedAt = 0`).

### A1b — A missing approval still permits the widening

[TradingPlanProtectionService.ts:141](../../apps/server/src/trading/TradingPlanProtectionService.ts:141)
still returns "allowed" when the limit comes back `null`. With the query fixed
this is now rare rather than routine — but "we could not read what you approved"
should not mean "so anything goes" on a live position. **Fix:** return
`stopStatus: "refused"` with a refusal naming the missing approval. The model
still has `trading_exit`'s `move_stop`.

---

## A2 — Every trade is sized as if it will pay the expensive fee twice

**Unchanged.** `roundTripCostFractionOfNotional`
([costs.ts:337-345](../../packages/trading-contracts/src/costs.ts:337)) still
takes only `takerFeeBpsPerSide` and still charges the spread twice, with no
maker rate — even though `estimateTradingCosts` in the same file has one at
[costs.ts:238](../../packages/trading-contracts/src/costs.ts:238).

Step 2.5 made the take-profit a resting order paying 1.5 bps instead of 4.5.
The position sizer never heard about it. That function is the floor every entry
is sized up to
([TradingEntryService.ts:318-324](../../apps/server/src/trading/TradingEntryService.ts:318)),
and the arithmetic at
[costs.ts:412](../../packages/trading-contracts/src/costs.ts:412) is:

```
position size = target profit ÷ (expected move − round-trip cost)
```

Overstate the cost, shrink the divisor, and the position comes out bigger.

**Worked example.** $10,000 of capital, ETH at $3,000, aiming for $30 of profit
with a take-profit $9 above entry (a 30 bps move). Half the ETH spread is about
$0.15, or 0.5 bps.

|                                           | Cost it charges                      | Divisor  | Position it demands |
| ----------------------------------------- | ------------------------------------ | -------- | ------------------- |
| What the code does (taker both sides)     | 4.5 + 4.5 + 0.5 + 0.5 = **10.0 bps** | 20 bps   | **$15,000**         |
| What the trade actually pays (maker exit) | 4.5 + 1.5 + 0.5 = **6.5 bps**        | 23.5 bps | **$12,766**         |

$2,234 too big — 17% — for a target it would have reached anyway. With a stop
1% away that is $150 at risk instead of $128: **$22 more per trade for
nothing.**

It gets worse on the small moves this plan exists to make tradeable:

| Expected move      | Sized as    | Should be   | Too big by |
| ------------------ | ----------- | ----------- | ---------- |
| 30 bps ($9 on ETH) | $15,000     | $12,766     | 17%        |
| 20 bps ($6)        | $30,000     | $22,222     | 35%        |
| **15 bps ($4.50)** | **$60,000** | **$35,294** | **70%**    |

Every risk ceiling still binds above this floor, so it cannot break your
mandate — but it pushes size against the ceiling on every small-move trade, and
a bigger position loses more when the stop is hit.

**Fix:** give `roundTripCostFractionOfNotional` two more inputs —
`exitIsMaker: boolean` and `makerFeeBpsPerSide?: number`. When the exit rests,
charge taker + maker fees and **one** spread crossing, exactly as
`roundTripTakerMakerUsd` already does at
[costs.ts:266-267](../../packages/trading-contracts/src/costs.ts:266). Thread it
through `targetNotionalForPlan`
([costs.ts:434](../../packages/trading-contracts/src/costs.ts:434)) and pass
`exitIsMaker: true` from
[TradingEntryService.ts:318](../../apps/server/src/trading/TradingEntryService.ts:318).
Leave slippage out — the reasoning at
[costs.ts:332-335](../../packages/trading-contracts/src/costs.ts:332) is right
and it errs small — but note in that comment that the number now depends on
order type.

---

## A3 — Book imbalance compares ten levels of bids against three levels of asks

**Unchanged.** [microstructure.ts:280-294](../../packages/trading-contracts/src/microstructure.ts:280)
still asks for the top 10 levels of each side independently, and still reports
`levels: Math.min(bid.counted, ask.counted)`
([:292](../../packages/trading-contracts/src/microstructure.ts:292)) — a level
count it did not actually compare over.

**Worked example (I ran this).** ETH at $3,000, quiet hour, 2 ETH resting at
every level. The bid side shows 10 levels; the ask side has been swept and shows 3.

```
bid depth summed:  10 levels × 2 ETH × $3,000 = $60,000
ask depth summed:   3 levels × 2 ETH × $3,000 = $18,000
imbalance = (60,000 − 18,000) / 78,000 = +0.538
reported levels: 3
```

The model reads **+0.54 — bids outweigh asks nearly 2 to 1** and concludes
buyers are stacked. Comparing three levels against three, the honest answer is
**0.0, perfectly balanced.**

The two errors point the same way, which is what makes it worse than a wrong
number: it says "go long" _because_ the ask side is thin — which is exactly the
state where a buy order walks up through an empty book and pays slippage.

This is not a freak case. The field's own comment at
[microstructure.ts:53](../../packages/trading-contracts/src/microstructure.ts:53)
says "a thin book serves fewer".

**Fix:**

```ts
const depth = Math.min(book.bids.length, book.asks.length, levels);
const bid = depthUsd(book.bids, depth);
const ask = depthUsd(book.asks, depth);
```

and report `levels: depth`. Add a test with more bid levels than ask levels and
identical size per level, asserting `imbalance === 0`.

---

## A4 — `aggressorFlow.bars` counts bars that had no trades in them

**Unchanged.** [microstructure.ts:313](../../packages/trading-contracts/src/microstructure.ts:313)
skips bars with no volume; [:323](../../packages/trading-contracts/src/microstructure.ts:323)
reports `bars: window.length` — the whole window. The field says "Bars actually
read".

**Example.** ETH at 03:00 UTC, dead tape. Of the last 15 one-minute bars, 12 had
no trades. The three that did all closed near their highs. The model is told:

```
aggressorFlow: buyShare 0.87, bars 15, basis bar_close_location
```

which reads as "buyers have been paying up for a quarter of an hour". It should
say `bars: 3`. `readVwap` gets this right
([:463](../../packages/trading-contracts/src/microstructure.ts:463)), so two
readings in the same payload count the same thing two different ways.

**Fix:** count a local `bars` inside the loop, incremented where `volume` is.

---

## A5 — What is labelled "VWAP" is a rolling two-hour average

**Unchanged.** `readVwap`
([microstructure.ts:452-473](../../packages/trading-contracts/src/microstructure.ts:452))
gets the whole 120-bar window from
[TradingWakeupComposer.ts:885](../../apps/server/src/trading/TradingWakeupComposer.ts:885).
On the 1-minute timeframe that is the last two hours, rolling forward every
minute.

When a trader says VWAP they mean the average from a **fixed** starting point,
usually the session open. That is the entire point: everyone computes it from
the same origin, so everyone reacts to the same level. A rolling two-hour mean
has no such agreement behind it — it is a smoothed price. The research doc's
argument for adding VWAP (Part 4, item 5) rests wholly on the shared anchor.

**Example.** ETH ran from $2,950 to $3,050 over the last two hours and sits at
$3,050.

- Rolling 120-bar VWAP ≈ $3,000 → the model is told **+166 bps above VWAP**.
- Session VWAP anchored at 00:00 UTC ≈ $2,970 → every other desk sees
  **+269 bps**.

The model reasons about being "stretched above VWAP" using a number nobody else
has.

**Fix,** pick one and write it into the field's comment:

- Cheap: rename it (`RollingVwapReading`), add `barsSpanMinutes`, and say in
  `distanceBps` that the anchor rolls.
- Right: anchor it to the UTC session open or the mission's own start, and
  publish `anchoredAt` on the reading.

Prefer the second. As it stands the reading does not do the job it was added
for.

---

## A6 — Publishing a plan is two database writes with nothing tying them together

**Unchanged, and now more exposed.**
[TradingStrategyService.ts:325-357](../../apps/server/src/trading/TradingStrategyService.ts:325)
still has no transaction around the `UPDATE` that bumps the mission version and
flips `analysing → waiting`, and the `INSERT` that stores the plan.

If the second write fails — disk full, `SQLITE_BUSY`, process killed between
them:

```
Mission version:   7 → 8                 ✓ written
Mission status:    analysing → waiting   ✓ written
Plan rows stored:  0                     ✗ never written
```

The mission says it is waiting on a plan that does not exist.
`getCurrentStrategy` returns nothing. The panel shows "Waiting" with nothing
under it. `move_stop` skips its staleness check because there is no plan to be
stale against.

**What changed since the first pass:** step 8.4 gave this path a second caller.
A drag on the chart now runs the same `publishPlanWithAftermath`
([TradingPlanPublication.ts:129](../../apps/server/src/trading/TradingPlanPublication.ts:129)),
so the half-written state is now reachable by an operator dragging a stop, not
only by the model publishing. And an operator who sees "Waiting" with no plan
after dragging has no idea what happened.

Step 6.3 keeps a watch cancel and its replacement insert in one transaction.
This deserves the same.

**Fix:** wrap lines 325–357 in `sql.withTransaction`.

---

## A7 — One unreadable plan row kills the mission instead of degrading it

**Unchanged.** [TradingStrategyService.ts:205](../../apps/server/src/trading/TradingStrategyService.ts:205)
calls `decodeStrategyJson`, which **throws** when the stored JSON does not match
the current schema. Twelve lines earlier,
[:170-174](../../apps/server/src/trading/TradingStrategyService.ts:170) catches
exactly that failure and skips the row, with a comment saying why one bad row
should not cost the caller everything.

So the history read survives a bad row and the current-plan read crashes on it —
and the current-plan read is on the wake path, the `trading_look` path, the
`move_stop` staleness check, and now the drag path too.

**When this bites.** Migration 062 rewrote every stored plan. On the next change
like that, if one row does not convert: the wake throws → the run is marked
failed → the watch that woke it is consumed → nothing is left to wake the
mission → **the mission goes permanently deaf.** Same shape as the stuck-mission
bug from plan 23.

**Fix:** wrap the decode in `try`/`catch`, return `Option.none()`, log a warning
naming the mission. A mission with an unreadable plan should behave like a
mission with no plan, not like a crashed turn.

---

## A8 — When the wake gets too big, the phase-7 readings vanish without saying so

**Unchanged.** The last-resort projection
([TradingWakeupComposer.ts:472-510](../../apps/server/src/trading/TradingWakeupComposer.ts:472))
lists its fields by hand and `microstructure` is not among them, so book
imbalance, aggressor flow, depth change, positioning and the vol ratio all
disappear.

Cutting them is fair. Not saying so is not: the `omitted` line at
[:509](../../apps/server/src/trading/TradingWakeupComposer.ts:509) mentions the
plan, authority, watches and pending state, and nothing else. A model that has
read book imbalance every turn for an hour gets a wake without it and no
statement that it was dropped — it just looks like the reading could not be
taken. Every other omission in this renderer is announced: trim steps are
logged, truncated lists say `(+4 more)`.

**Fix:** add `microstructure` to the `omitted` string, or add a `microstructure`
step to `TRIM_LADDER`
([:387](../../apps/server/src/trading/TradingWakeupComposer.ts:387)) so the drop
is logged.

---

## A9 — Moving a stop still requires the model to prove it read the plan first

**Unchanged.** A stop move must carry `expectedPlanUpdatedAt`
([exit.ts:154-165](../../packages/trading-contracts/src/exit.ts:154),
[TradingStopAdjustmentService.ts:127-133](../../apps/server/src/trading/TradingStopAdjustmentService.ts:127)),
and `trading_exit`'s description
([tools.ts:187](../../apps/server/src/mcp/toolkits/trading/tools.ts:187)) does
not mention it, so the model finds out by being refused.

**What it costs.** Price is running against a position and the model wants to
tighten the stop. It cannot just call `trading_exit` — it has to call
`trading_look` first for `plan.updatedAt`, then `trading_exit`. Two round trips
of inference, roughly 8–15 seconds, on the tool it reaches for when a trade is
going wrong.

This is the same kind of check as `strategy_version_current` (removed by step
3.3) and `atr_mismatch` (removed by step 3.5 **from this very tool**).

**It is a judgement call, not a defect** — since step 4.5 a publish moves the
stop, so a stop move racing a publish is a real conflict, and step 8.4 added a
second publisher. Decide it deliberately:

- **Keep it** and put `expectedPlanUpdatedAt` into `trading_exit`'s description.
  There is room: the toolkit spends 2,882 characters of a ~4,000 budget.
- **Or drop it** and have `TradingStopAdjustmentService` read the plan itself.
  Every gate that protects _you_ — the risk limit, the ATR step cap, the noise
  floor, the breakeven ratchet, the rate limit — still runs.

Write the decision down here either way.

---

## A10 — Where the code went a different way, and was right to

- **`market_is_eth` survives, on exits only.** Step 3.3 says remove it. It is
  gone from the entry list and kept in `EXIT_CHECKS`
  ([TradingPreviewService.ts:545](../../apps/server/src/trading/TradingPreviewService.ts:545)),
  and the entry side checks the mandate earlier at
  [TradingEntryService.ts:233-237](../../apps/server/src/trading/TradingEntryService.ts:233)
  under the same name. Right call. **Amend step 3.3** to say "remove from the
  entry checklist" and note where the check moved.
- **Step 7.6 was done for the EMA cross only.** `readEmaCross` is gone
  ([marketStructure.ts:1424-1435](../../packages/trading-contracts/src/marketStructure.ts:1424))
  and `EmaTrend` always carries `direction` and `separationAtr`. But
  `readRsiReversion` and `readTrendContinuation` still return a 0–1 `score`
  ([marketStructure.ts:263](../../packages/trading-contracts/src/marketStructure.ts:263)).
  Step 3.4's `rejectedBy` means near-misses survive either way, so the problem
  the step was aimed at is solved — but its words ("no score, no null") are true
  of one detector out of four. **Amend step 7.6**, or finish it.
- **`strategyVersion` survives as a label on trade history, which is the target
  state.** The remaining mentions are all in `history.ts`, `calibration.ts`,
  `TradingTradeHistoryService`, `TradingClosedTradeReview` and
  `TradingCalibrationService`. Nothing in the execution path reads it. **Step
  5.1's "Done when: grep returns nothing" is wrong as written.** Restate as:
  "grep in `HyperliquidExecutionService`, `TradingExitService`, `execution.ts`,
  `quote.ts` and `watch.ts` returns nothing."
- **`trading_get_playbook` was renamed to `trading_strategy`** (phase 9), which
  is what step 9.2 asked for. Step 6.5's "NOT retired" note stands and should
  add the new name. The toolkit is 7 tools at **2,882** characters, up from
  2,797.
- **Migration 067 landed** as the journal's `author` column
  ([067_TradingJournalAuthor.ts](../../apps/server/src/persistence/Migrations/067_TradingJournalAuthor.ts)),
  exactly as §8.4 reserved it. `NOT NULL DEFAULT 'model'` with the backfill as
  the default — clean.

---

## A11 — Where this plan itself was wrong

- **The phase diagram at the top no longer matches what happened.** It puts P6
  after P4; P6 landed first, and P8–P10 then landed in three hours. Redraw it
  against the commit history or delete it.
- **Step 0.1 says the in-flight files were landed.** They were not, at the time
  — they are now (see A15). Fix the sentence so it stops asserting something
  that was untrue for the whole of phases 1–7.
- **Step 2.7's target and the tool that measures it use different units, and
  step 10.2 made this worse.** The step says "cost per round trip falls from ~9
  bps toward ~6". `feeShareOfGross`
  ([sessionReport.ts:177](../../apps/server/src/cli/sessionReport.ts:177)) is
  fees ÷ **per-fill** notional, and a round trip is two fills — so at the old
  all-taker rate it prints **0.05%**, not 9 bps. Step 10.2 then lifted that very
  number into the new "the four numbers" block at the top of the report
  ([sessionReport.ts:276-292](../../apps/server/src/cli/sessionReport.ts:276))
  and demoted the round-trip number (`economics.feesBps`) into the block below.
  So the report now leads with:

  ```
  the four numbers
    trades: 8
    net bps per trade: 4.1
    cost fees, share of gross notional traded: 0.05% (16 fills)
    maker fill rate (by fill count): 44.0% (7 of 16 flagged fills)
  ```

  A reader checking "did the round trip fall from 9 bps to 6?" reads `0.05%`,
  cannot connect it to 9, and scrolls past the line that answers the question.
  **Amend step 2.7**: the 9→6 measure is
  `feesBps + entrySpreadBps + entrySlippageBps`; `feeShareOfGross` measures how
  much maker execution you are getting, per side.

- **The four numbers are averaged two different ways.** `netBpsPerTrade` is a
  plain average across trades
  ([sessionReport.ts:130-134](../../apps/server/src/cli/sessionReport.ts:130));
  `feeShareOfGross` is weighted by fill size. Sitting one under the other in the
  same block, they invite subtraction, and subtracting them is wrong. Either
  weight both by notional, or print one line under the block saying they do not
  add up.
- **Step 2.2 ("extend `MomentumOrderPreference` with `post_only`") was overtaken
  by step 2.3** before it landed. The model never names an order type now;
  `OrderPreference`
  ([strategy.ts:211](../../packages/trading-contracts/src/strategy.ts:211)) is
  server-internal and the tools take `urgency`. Right outcome, stale step text.
- **Step 9.1 says the mode "selects a system prompt and a tool subset". Neither
  happens.** See A18.

---

## A12 — Comments in the code that describe a world plan 29 removed

- [strategy.ts:6-7](../../packages/trading-contracts/src/strategy.ts:6) — still
  says "every execution is still gated against the version row that carries it."
  Not true since 4.2/5.1. Replace with the revise-in-place wording the same file
  already uses at
  [strategy.ts:412-419](../../packages/trading-contracts/src/strategy.ts:412).
- [TradingPreviewService.ts:442](../../apps/server/src/trading/TradingPreviewService.ts:442) —
  the entry list is `CHECKS` and the exit list `EXIT_CHECKS`. Since 3.3 gave the
  entry list its own reasoning
  ([:475-480](../../apps/server/src/trading/TradingPreviewService.ts:475)), the
  lopsided names read as though one is the default. Rename `CHECKS` to
  `ENTRY_CHECKS`. (The "14 items" counts are correct — leave them.)
- [costs.ts:5-9](../../packages/trading-contracts/src/costs.ts:5) — the header
  still tells the story of a $1.70 target being refused. Cost stopped being a
  gate in step 3.1. Say so up front.

---

## A13 — Two things in the working-order loop, neither blocking

- **The exit half returns before the entry half runs**
  ([TradingWorkingOrderService.ts:777-780](../../apps/server/src/trading/TradingWorkingOrderService.ts:777)).
  A resting exit still marked `accepted` hides the entry half for that pass. It
  clears itself within seconds via `settleAcceptedExecutions`
  ([HyperliquidReconciler.ts:674-724](../../apps/server/src/trading/HyperliquidReconciler.ts:674)),
  and the two halves barely overlap anyway — an entry needs a flat position, an
  exit needs one open. **No change needed; written down so nobody re-derives
  it.**
- **`readLineage` matches on `AND size = ${resting.size}`**
  ([TradingWorkingOrderService.ts:621](../../apps/server/src/trading/TradingWorkingOrderService.ts:621)) —
  exact floating-point equality in SQL. Safe only because every replacement
  copies `original.size` byte for byte
  ([:717](../../apps/server/src/trading/TradingWorkingOrderService.ts:717)). The
  day anything rounds a replacement's size, the lineage breaks silently and the
  wait clock resets. Add one comment naming the assumption.

---

## A14 — The model gets six new readings and is told nothing about what they mean

**Unchanged, and now the cheapest open item on the list.**

- `trading_look`'s description
  ([tools.ts:93](../../apps/server/src/mcp/toolkits/trading/tools.ts:93)) lists
  mark, book, candles, volatility, structure, position, account, openOrders,
  trades, mission, cost and positionCosts — **and not `microstructure`.** Six
  readings landed in phase 7 and the tool returning them does not say they
  exist. About 1,100 characters of the ~4,000 budget are unspent.
- Neither `playbook.ts` nor `POC_STANDING_INSTRUCTION`
  ([strategy.ts:106-107](../../packages/trading-contracts/src/strategy.ts:106))
  mentions book imbalance, aggressor flow, depth change, positioning or the vol
  ratio. Step 6.3 did exactly this job for watches; the same job for phase 7 was
  never done.

**Why it matters, concretely.** The standing instruction states the one gate:
_is the expected move over your intended hold bigger than the round trip is
worth?_ The reading that answers it is `volatilityRatio` — and the instruction
never names it. The model gets:

```
volatilityRatio: { ratio: 0.42, shortPercent: 0.021, longPercent: 0.050 }
```

with nothing saying that 0.42 means _the last 20 minutes have moved at 40% of
the two-hour pace, so the 30 bps you need is probably not there — stand down._
It is one more number in a payload full of numbers.

**Fix:** one clause in `trading_look`'s description naming `microstructure`, and
a short paragraph in the standing instruction tying `volatilityRatio` to the
cost gate and `bookImbalance` / `aggressorFlow` to entry timing. Prose only — no
code, no migration, no test to rewrite.

---

## A15 — Resolved

The seven files that were uncommitted at the first pass are committed, and
phases 8, 9 and 10 are finished on top of them. The working tree now holds only
`apps/marketing/src/pages/index.astro`, two `scripts/` files, and this document.

There are screenshots of each phase-8 step under
[`docs/operations/plan-29-screens/`](../operations/plan-29-screens/) and a
step-by-step record in
[`plan-29-phase-8-9-10-log.md`](plan-29-phase-8-9-10-log.md). Neither this plan
nor that log records what remains, which is what A17–A20 below are for.

---

## A16 — Code that could be shorter, without changing what it does

Ordered by lines saved. None of these changes behaviour.

### A16.1 — The working-order loop's two halves are one function written twice (~450 lines)

[TradingWorkingOrderService.ts](../../apps/server/src/trading/TradingWorkingOrderService.ts)
is 1,445 lines. `reconcile`/`reconcileExit`, `crossWorkingEntry`/`crossWorkingExit`
and `repriceWorkingEntry`/`repriceWorkingExit` do the same seven steps in the
same order. They differ in exactly seven values:

|                           | Entry half                        | Exit half                |
| ------------------------- | --------------------------------- | ------------------------ |
| Which records to read     | `readNewestAcceptedEntry`         | `readNewestAcceptedExit` |
| Position present means    | stop — the stop machinery owns it | keep working             |
| Position absent means     | keep working                      | it filled, or withdraw   |
| Mission paused            | withdraw the order                | keep working             |
| Plan revised              | withdraw the order                | leave it alone           |
| Cross succeeded when      | a position appears                | the position shrinks     |
| `reduceOnly` on the order | `false`                           | `true`                   |

One `Lane` record holding those seven, and one `reconcileLane`, `crossLane`,
`repriceLane`. About 450 lines go, and a fix to the re-price ordering or the
confirmation window then applies to both halves automatically. The module header
prose already spells out the differences; it becomes the `Lane` docstring.

### A16.2 — The same "two prices are the same price" constant, now in three files (~15 lines)

Was two at the first pass, now three:

- [TradingWorkingOrderService.ts:304](../../apps/server/src/trading/TradingWorkingOrderService.ts:304) — `PRICE_EPSILON_RELATIVE = 1e-5`
- [TradingPlanProtectionService.ts:224](../../apps/server/src/trading/TradingPlanProtectionService.ts:224) — `STOP_PRICE_EPSILON_RELATIVE = 1e-5`
- [TradingProtectionService.ts:737](../../apps/server/src/trading/TradingProtectionService.ts:737) — `TAKE_PROFIT_PRICE_EPSILON_RELATIVE = 1e-5`

Three names, one number, all justified as "wire precision". Move it to
`@t3tools/trading-contracts/protection` next to `PROTECTION_SIZE_EPSILON`, which
is already where this kind of constant lives.

### A16.3 — `readMicrostructure` writes the same line six times (~15 lines)

[microstructure.ts:512-529](../../packages/trading-contracts/src/microstructure.ts:512):
a six-part `if` checking every reading for `null`, then six lines of
`...(x === null ? {} : { x })`. Replace with one object and a single filter over
its entries. Adding a seventh reading stops being a three-place edit.

### A16.4 — Four files are past the size where they can be read

`MissionLivePanel.tsx` **1,460** (was ~900 before phase 8), `handlers.ts` 1,305,
`TradingWakeupComposer.ts` 1,137, `TradingWorkingOrderService.ts` 1,445. Three
clean splits, all mechanical:

- Move the wakeup **renderer** — `renderFlatRecord`, `renderValue`,
  `renderWakeupProjection`, `renderWakeup`, `capList`, `boundWakeupProse`,
  `boundStrategyLists`, `digestStrategy`, `TRIM_LADDER`, `renderBoundedWakeup`
  ([TradingWakeupComposer.ts:245-531](../../apps/server/src/trading/TradingWakeupComposer.ts:245)) —
  into `TradingWakeupRender.ts`. Pure, already separately tested, shares nothing
  with `observe` but the wakeup type. ~290 lines. Do this **after** A8.
- Move `handlers.ts`'s **read half** — `readObservation`, `readMarketHalf`,
  `withMicrostructure`, `readMarketStructure`, `describeMarketReadFailure` —
  into `lookHandler.ts`.
- Split `MissionLivePanel.tsx` by panel state. `readPanelState` already
  discriminates `planning | armed | live | complete`, and phase 8.6 gave each
  state its own header and ordering — so the four headers and their band
  ordering are four components that happen to live in one file.

### A16.5 — "Is this an exit?" is answered two different ways

[TradingWorkingOrderService.ts:547](../../apps/server/src/trading/TradingWorkingOrderService.ts:547)
hard-codes `["close", "reduce"]`, while `isPositionIncreasing`
([protection.ts:50](../../packages/trading-contracts/src/protection.ts:50)) is
the contracts package's answer to the same question — used eight lines earlier
at [:538](../../apps/server/src/trading/TradingWorkingOrderService.ts:538). Two
definitions that must stay in step as action types change. Export
`POSITION_REDUCING_ACTION_TYPES` from the contracts package and use it in the
SQL `IN`.

---

## A17 — The mission's mode is guessed from your sentence, and it guesses wrong

Step 9.1 said "Mode on the mission". What landed instead reads the mode out of
the mandate text with two regular expressions, on every `trading_look`
([mode.ts:118-132](../../packages/trading-contracts/src/mode.ts:118),
[handlers.ts:245](../../apps/server/src/mcp/toolkits/trading/handlers.ts:245)).

Deriving rather than storing is a defensible call, and the module says why: one
source of truth, no migration. The problem is the pattern
([mode.ts:82](../../packages/trading-contracts/src/mode.ts:82)):

```
/\b(?:execute|run|follow|trade)\s+(?:the\s+)?([a-z][a-z _-]{2,40})/gi
```

`trade` is in the verb list. In a trading product, "trade X" is how every
mandate starts.

**I ran the real function over fourteen realistic mandates.** These are the
results:

| Mandate you would type                        | Mode it gets                  |
| --------------------------------------------- | ----------------------------- |
| `Trade ETH`                                   | discretionary ✓               |
| `Trade ETH on testnet using 1m candles`       | discretionary ✓               |
| `Trade BTC, take small profits`               | discretionary ✓               |
| `Execute the momentum playbook`               | execute momentum ✓            |
| `run the ema cross strategy`                  | execute ema_cross ✓           |
| `Follow opening range on the 5m`              | execute opening_range ✓       |
| `momentum has been working today, trade ETH`  | discretionary ✓               |
| **`Trade momentum on ETH`**                   | **execute momentum ✗**        |
| **`Trade momentum when the book is offered`** | **execute momentum ✗**        |
| **`Do not run momentum today`**               | **execute momentum ✗**        |
| **`Trade the range reversion setup only`**    | **execute range_reversion ✗** |

The last four are the problem, and the third-to-last is the clearest: **"Do not
run momentum today" puts the mission into execute-momentum mode.** A negation
turns into the standing order it forbade.

**What that actually does to a session.** In execute mode the model is told its
job is "faithful execution and honest reporting, not finding a better trade" and
that when the playbook's conditions are not met it must stand aside and name the
failing step
([mode.ts:58-65](../../packages/trading-contracts/src/mode.ts:58)). So an
operator who typed "Trade momentum on ETH" — meaning _lean momentum, use your
judgement_ — gets a mission that will refuse every non-momentum setup all
session and report which step failed each time. That is the exact stand-down
churn this whole plan was written to remove.

The module's own docstring
([mode.ts:70-72](../../packages/trading-contracts/src/mode.ts:70)) claims the
guard: "A mandate that merely mentions momentum must not silently become a
standing order to trade it, so the verb has to be there and the name has to
follow it." With `trade` as one of the verbs, that guard does almost nothing.

**Fix, in order of how much you want to change:**

1. **Drop `trade` from the verb list.** One character class. "Execute", "run"
   and "follow" are what someone writes when they mean a procedure; "trade" is
   what everyone writes for everything. This alone fixes three of the four bad
   rows.
2. **Refuse a negated match.** If the 20 characters before the verb contain
   `not`, `don't`, `avoid`, `never` or `except`, skip that match. Fixes the
   fourth.
3. **Say the mode back to the operator.** The panel already knows
   `mission.mode`; a mission in execute mode should say so on the card, so a
   wrong guess is visible in the first ten seconds rather than after a session
   of stand-downs.

Add the eleven rows above as test cases — the module has tests
([mode.test.ts](../../packages/trading-contracts/src/mode.test.ts)) but not
these.

---

## A18 — Mode selects neither a system prompt nor a tool subset

Step 9.1: _"Mode on the mission. Selects a system prompt and a tool subset."_
Neither happened.

- **The system prompt is static.**
  [TradingSessionProfile.ts](../../apps/server/src/provider/TradingSessionProfile.ts)
  builds one prompt and never branches on mode. Its step 2 tells every mission,
  in both modes, to read a playbook "for what you are weighing" — reference
  language, which is the opposite of what execute mode means.
- **The tool list is identical in both modes.** `TRADING_TOOL_NAMES`
  ([TradingSessionProfile.ts:45](../../apps/server/src/provider/TradingSessionProfile.ts:45))
  is the same seven tools either way.
- **The execute-mode doctrine reaches the model only as a JSON field**:
  `mission.mode.doctrine` inside `trading_look`'s result
  ([tools.ts:178](../../packages/trading-contracts/src/tools.ts:178)).

So the paragraph that redefines the model's whole job sits in a payload field,
while the system prompt — which the model is far more likely to follow — still
describes discretionary work. The two disagree, and nothing points the model at
the one that is meant to win.

**Fix:** in `TradingSessionProfile`, when the mission's mode is
`execute_strategy`, replace step 2 of the contract with the mode's own doctrine
and name the strategy in the opening line. That is the "selects a system prompt"
half of 9.1. The tool subset can wait — with seven tools there is not much of a
subset to select, and step 9.1 should say so instead of promising one.

---

## A19 — Two gaps in the drag path

Step 8.4 landed well: a drag goes through the same `publishPlanWithAftermath`
the model's `trading_plan` goes through
([ws.ts:1503+](../../apps/server/src/ws.ts:1503)), the RPC needs operate scope
([RpcAuthorization.ts:33](../../apps/server/src/auth/RpcAuthorization.ts:33)),
the optimistic lock is honoured, and the journal note is composed server-side by
diffing the two plans rather than captioned by the client
([TradingPlanRevisionNote.ts:34](../../apps/server/src/trading/TradingPlanRevisionNote.ts:34)).
Two gaps.

### A19a — A dragged target has no failure feedback; a dragged stop does

The RPC returns only the **stop** half of the reconcile
([ws.ts:1573](../../apps/server/src/ws.ts:1573)), and the panel surfaces only
`refusedStop`
([useMissionPlanRevision.ts:124-131](../../apps/web/src/components/trading/useMissionPlanRevision.ts:124)).
The take-profit half has its own outcome with a `failed` status — "a placement
could not be confirmed inside the window; nothing was cancelled"
([TradingProtectionService.ts:157-163](../../apps/server/src/trading/TradingProtectionService.ts:157)) —
and it is dropped on the floor.

**What you would see.** You drag the target from $3,009 to $3,015 on a 0.13 ETH
long. The publish is accepted, the chart redraws the target line at $3,015, and
the resting order on Hyperliquid is still at $3,009. If price runs, you bank
$0.78 earlier than the chart said you would.

**Severity is low** because it self-heals: the watchdog runs the same
`reconcileTakeProtection` against the plan every ~5 seconds, so the order
converges on the next pass. The stop is the one that stays wrong when refused,
and that one _is_ surfaced. Still — the panel is briefly showing a target the
exchange does not have, and the fix is to carry the `target` outcome back
alongside `stop` in the same result.

### A19b — The trigger-drag branch is unreachable, and would be wrong if reached

`applyPlanDrag` has a `case "trigger"`
([useMissionPlanRevision.ts:59-68](../../apps/web/src/components/trading/useMissionPlanRevision.ts:59))
that nothing calls: `draggableKinds`
([MissionLivePanel.tsx:306-312](../../apps/web/src/components/trading/MissionLivePanel.tsx:306))
only ever contains `stop` and `target`, and `onLevelDragEnd`
([:294-303](../../apps/web/src/components/trading/MissionLivePanel.tsx:294))
handles only those two.

That is the right call for now, but step 8.4's own text asks for "drag stop,
target, trigger price, and trigger expiry", so someone will try to enable it by
adding `"condition_above"` to that array. **Two things would break, and neither
is obvious:**

1. **The plan's prose would contradict its own price.** A trigger is
   `{ description, priceLevel? }`, and the branch replaces `priceLevel` only.
   Drag a trigger from $3,009 to $3,015 and the plan reads: _"Short if we tag
   3,009"_ with `priceLevel: 3015`. The schema says the description is the
   authoritative one
   ([strategy.ts:131-133](../../packages/trading-contracts/src/strategy.ts:131)),
   so the model would act on the old number.
2. **The armed watch would not move.** Step 4.2 removed supersede-on-publish:
   revising a plan leaves its watches exactly where they are. So you drag the
   trigger to $3,015, the chart draws it at $3,015, and the mission still wakes
   at $3,009.

**Fix now:** delete the `trigger` branch and the `PlanDragTarget` variant, so
the unreachable code cannot be enabled by a one-line change. **Or**, if trigger
drags are wanted, note here that it needs three things — rewrite the
description's price, replace the armed watch through `replacesWatchId`, and
handle a trigger whose description was published as a bare string.

---

## A20 — The learning loop ranks setups by total dollars, so one lucky trade wins

Step 10.3 landed as `bySetup` on `assessEntryGovernance`
([policy.ts:397-409](../../packages/trading-contracts/src/policy.ts:397)). It
groups closed trades by the setup recorded at entry and sorts them
[best net first](../../packages/trading-contracts/src/policy.ts:408). It is the
inversion the plan wanted — a strategy becomes a row with a number against it.

Two things will mislead you the first time you read one.

**It ranks by total dollars, not per trade.** Sorted by `netUsd`:

```
setup                trades   net
momentum_breakout        18   +$41.00     ← ranked first
rsi_reversion             2   +$38.00     ← $19/trade, three times better
range_reversion           9    −$12.00
(unrecorded)              4    −$3.00
```

`momentum_breakout` wins the table on $2.28 a trade while `rsi_reversion` made
$19 a trade. The plan's own headline number is _net bps per trade_; this table
sorts by the one number the plan says not to optimise for.

**The `reason` sentence names a "best setup" with no minimum sample.**
[policy.ts:411-418](../../packages/trading-contracts/src/policy.ts:411)
composes: `best setup at entry: <setup> at <net> USD net over <n> trades`. With
one lucky trade, `n` is 1 and the sentence still calls it the best setup. That
string rides back to the model, which will reasonably act on it.

**Fix:**

1. Add `netUsdPerTrade` to `SetupAttribution` and sort by it, with total net
   kept as a column.
2. Require a minimum sample before the `reason` names a best setup — five
   trades is a defensible floor and matches nothing else in the codebase, so
   pick it deliberately and name the constant. Below it, say "not enough closed
   trades to rank setups yet".

Neither changes behaviour: nothing gates on any of it, which the commit is
careful to say.

---

## If you only do five things

**All six of these were done — see Appendix B.** Kept here as the audit's own
ranking, which is what it thought mattered most before any of it was fixed.

In order:

1. **A17** — "Do not run momentum today" starts a momentum-execution mission,
   and "Trade momentum on ETH" does too. One character class fixes most of it,
   and it is the finding most likely to make a real session behave strangely
   from the first turn.
2. **A3** — book imbalance reports a confident wrong direction on a thin book.
3. **A2** — every trade is sized 17–70% too big because the sizer still assumes
   both sides pay the taker fee.
4. **A14** — tell the model what the six phase-7 readings mean. Prose only, best
   value per hour on the list.
5. **A1a** — finish A1: `move_stop` still has the unfixed twin of the query that
   was just fixed next door.

A6 (the untransacted publish) is the one to add if you want a sixth: the drag
path made it reachable by an operator, not just by the model.

---

# Appendix B — What the audit changed

Worked through on 2026-08-16, on top of `a15c4dd1e`.

**Verified after the fixes.** `pnpm typecheck` exit 0. `pnpm test` exit 0 —
**2,652 passed, 10 skipped, 0 failed, across 282 files** (280 passed, 2
skipped), in 274s. `pnpm lint` exit 1 on two pre-existing errors in
`apps/marketing/scripts/check-scroll-timelines.mjs`
(`t3code(namespace-node-imports)`), which are on committed code and untouched
by any of this.

An earlier draft of this appendix reported "2,263 passed / 14 skipped / 0
failed" and that was wrong twice over. 2,263 is the `apps/server` sub-total, not
the monorepo's — the real figure is ~2,650 across 282 files — and the run it was
read from **had one failing test**, which the sub-total line does not show. The
failure was caused by the A1b fix itself: `leaves a previous trade's record out
of the envelope` asserted the old "unstated envelope never refuses" behaviour,
which A1b deliberately replaced. The test has been rewritten to assert the new
rule and to prove the out-of-scope record still supplies nothing — it is the
refusal's own wording that proves it, since the fallback and the approval say
different sentences. Read the grand total at the foot of a `pnpm test` run, not
a project's.

| Finding | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1a     | The `move_stop` envelope query takes the same `ENTRY_RECORD_LEAD_MILLIS` lead. A stop that tightened can move back out inside its approval again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A1b     | A missing approval no longer means "anything goes": the RESTING stop stands in as the ceiling, so tightenings and watchdog repairs still go through and only a widening is refused. **Second pass:** a ceiling of zero is now treated as a ceiling. `plannedLossAtStopUsd` floors at zero, so a stop trailed past break-even plans no loss and the first version read that as "no ceiling" and permitted anything — in exactly the state a widening costs the most. Long 0.5 ETH from 3,000 with the stop trailed to 3,010: a republish at 2,900 turned a locked-in gain into $50 of risk, and now refuses. Six unit tests on `planStopRefusal` pin the fallback.                                                           |
| A2      | `roundTripCostFractionOfNotional` takes `exitIsMaker` and `makerFeeBpsPerSide`; the entry sizer passes both, reading the taker AND maker rate from `getUserFeeRatesBps`. A 30 bps trade sizes at $12,766 rather than $15,000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A3      | Both book sides are summed over the same number of levels, and `levels` reports that number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A4      | `aggressorFlow.bars` counts only bars that traded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A5      | VWAP is anchored at the UTC session open and publishes `anchoredAt`; a window that does not reach back says `anchor: "window_start"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A6      | The publish's version bump and plan insert are one `sql.withTransaction`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A7      | `getCurrentStrategy` degrades an undecodable plan row to `Option.none()` with a warning, matching the history read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A8      | The last-resort wake projection names the microstructure readings it drops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A9      | **Decided: keep the check.** `expectedPlanUpdatedAt` is now in `trading_exit`'s description, so the model does not find out by being refused. A publish moves the stop, step 8.4 added a second publisher, and a stop move racing one is a real conflict.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A10     | Step 3.3, 5.1, 6.5 and 7.6 restated in the plan body against what landed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A11     | Phase diagram redrawn to the commit order; step 0.1 corrected; step 2.7 says which number the 9→6 target is; step 2.2 marked overtaken; step 9.1 rewritten (see A18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A12     | `strategy.ts`'s header, `costs.ts`'s header, and `CHECKS` → `ENTRY_CHECKS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A13     | The lineage's exact float equality now names the assumption it rests on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A14     | `trading_look`'s description names `microstructure`; `POC_STANDING_INSTRUCTION` ties `volatilityRatio` to the cost gate and `bookImbalance`/`aggressorFlow` to entry timing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A16.2   | One `PRICE_EPSILON_RELATIVE` and `samePrice` in `@t3tools/trading-contracts/protection`; the three local copies are gone. `ENTRY_RECORD_LEAD_MILLIS` moved there too, since two services now need it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A16.3   | `readMicrostructure` builds one object and filters it once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A17     | `trade` is out of the verb list and a negation within 20 characters before the verb skips the match. Fourteen realistic mandates are now test rows. The panel already showed the mode. **Second pass:** the negation now only cancels its own clause. `no` has to be in the negation list ("no need to run momentum" carries no other negation word) and `no` is common enough that twenty bare characters reach into the sentence before — "There is no edge in chop; run the range_reversion playbook" is an INSTRUCTION and the first version silently dropped it to discretionary. The lookbehind stops at the nearest `.` `;` `,` `:` or newline, so the negation has to be in the same breath as the verb it cancels. |
| A18     | Step 2 of the decision contract points at `mission.mode`, states that its doctrine wins, and says what execute mode means. The tool subset was dropped deliberately — see step 9.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A19a    | The take-profit half of the reconcile is carried back through `OrchestrationReviseTradingPlanResult.target` and surfaced by the panel, so a `failed` placement is not silently redrawn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A19b    | The trigger branch and its `PlanDragTarget` variant are deleted, with the three things a real trigger drag would need written into the type's docstring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A20     | `SetupAttribution` carries `netUsdPerTrade` and the table sorts by it; the reason line names no best setup below `SETUP_RANKING_MINIMUM_TRADES` (5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Flakes  | `apps/web`'s unit project moves to a 45s test / 60s hook timeout, with the reason written next to it. Two consecutive full runs are green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Declined, with reasons:**

- **A16.1** (fold the working-order loop's two halves into one `Lane`, ~450
  lines) and **A16.4** (split four oversized files). Both are large mechanical
  refactors of the code that places and cancels real orders, and the audit's
  own framing is that they change nothing. Doing them immediately before a
  soak trades a real risk for a readability gain that will still be available
  after it. A16.4's wakeup-renderer split is the one worth doing first — it is
  pure and separately tested — and A8 is now landed, which was its stated
  precondition.
- **A16.5** (share one answer to "is this an exit?"). The two definitions
  answer different questions: `EXPOSURE_REDUCING_ACTION_TYPES` includes
  `cancel` and `modify_stop`, which are not exits, so using it in
  `readNewestAcceptedExit`'s `IN` clause would widen the query to rows that
  lane must not manage. The existing comment already explains the
  discrimination.

**Two clean runs.** The timeout raise holds: neither full run after it had a
single timeout, in `imageCompression`, `MessagesTimeline` or anywhere else. The
only failure either run produced was the real one described above.

**One thing left in passing, not fixed.**
[handlers.test.ts:103](../../apps/server/src/mcp/toolkits/trading/handlers.test.ts:103)
has a debugging leftover on a committed path: when the MCP body fails to
decode, the test helper appends the raw body and payload to `/tmp/mcp-body.txt`
and re-throws, behind a bare `// eslint-disable-next-line` that lint now reports
as unused. It predates all of this work and nothing in plan 29 touches it, so it
was left alone — but a test that writes request bodies to a fixed path outside
the repo should either log through the harness or not log at all.

Everything left is the testnet soak (step 10.1), which is the user's to run.
