# Plan 29 — Restructure T3 Trade around the trader model

Execution plan derived from
[`docs/architecture/agent-tool-architecture-research.md`](../architecture/agent-tool-architecture-research.md).
Read that first; this document does not re-argue any of it.

**Goal.** A user says "Trade BTC", walks away, and a model trades on their behalf
under hard constraints — taking many small positive-expectancy trades, keeping a
plan it revises, setting its own triggers, and narrating in plain language.

**Baseline at time of writing.** Typecheck clean; `pnpm test` 2,518 passed / 10
skipped / 0 failed across 271 files; `pnpm lint` exit 0 with ~25 pre-existing
warnings. There is uncommitted work in flight across 18 files (chart geometry,
cost sizing, quote service, momentum detectors) — Phase 0 lands it or stashes it
before anything else starts.

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

```
P0 Baseline ──┬── P1 Doctrine ────┐
              ├── P2 Cost & maker ─┼── P3 Un-gate ──┐
              └── P7 Observation ──┘                │
                                                    ├── P4 Plan reshape ── P5 Execution ── P6 Tools
                                                    │        │
                                                    │        └── P8 Chart
                                                    └── P9 Mode B ── P10 Soak
```

P1, P2 and P7 are independent of each other and of everything else. P4 is the
entangled one and is deliberately late.

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
- Extend `MomentumOrderPreference` (or its successor) with `post_only`.

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

From the 17-item entry checklist remove exactly three: `strategy_version_current`,
`authority_version_current`, `market_is_eth`. **Keep all risk, correctness,
control and concurrency checks.** This is the same reasoning the exit checklist
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

Thirteen tools to seven, at 2,797 description chars. Per tool:

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

Selects a system prompt and a tool subset. Discretionary is the default.

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
