# Plan 30 — Custom signals: user-defined datapoints as first-class triggers

Status: draft. Step 1 only (the datapoint plumbing). The script runtime,
authoring flow, and backtest are steps 2–4 and are sketched at the end so the
step-1 shapes are chosen with them in view.

---

## 1. Why this is a small change

The `metric` watch condition that landed in `packages/trading-contracts/src/watch.ts`
already made the argument. Its own doc comment:

> the generalisation the price and PnL watches are special cases of: the model
> names WHICH number it is waiting on rather than being limited to the mark.

`WatchMetricName` is a closed union of five numbers the runtime can already
read. A custom signal is the same idea with an **open** name space and a
**user-supplied producer**. Everything downstream of "a number crossed a
threshold" already exists and is reused unchanged:

| Seam                                          | Today                                      | Change                             |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `WatchCondition` union (`watch.ts:145`)       | six kinds the model writes                 | one more: `signal`                 |
| `toMarketWatch` (`watch.ts:258`)              | the single mapping to the persisted form   | one more case                      |
| `MarketWatch` union (`watch.ts:45`)           | nine persisted shapes                      | one more: `signal_threshold`       |
| `WatchEvaluator`                              | two sources: 2s sweep, candle finalisation | a third: **push**                  |
| `recordObservation` (`WatchEvaluator.ts:471`) | write-guarded proximity on every tick      | free                               |
| `TradingEventInbox` / firing / dedup          | keyed per watch                            | unchanged                          |
| `TradingLevelHistory`                         | level memory                               | untouched (signals are not levels) |
| `TradingObservation` (`observation.ts:48`)    | optional fields so a look never fails      | `signals: []`                      |
| `TradingWakeupComposer`                       | armed set + pending events                 | signals in the armed set           |

**Non-goal for step 1:** no code generation. Step 1 is fed by a hand-written
in-repo signal so the datapoint path is proved end to end against something we
control. Codegen is step 3 and must not be a prerequisite for landing this.

---

## 2. Orchestration: who writes the script

Decided: **request-and-wake, not a subagent of the trading session.**

Two constraints rule out an inline subagent:

1. `TradingSessionProfile.ts:123` states the lock in the system prompt itself —
   _"no shell, no filesystem, no Read/Edit/Write, no web access, and no
   subagents."_ The lock is load-bearing; it was tightened once already because
   an `mcp__t3-trade__*` wildcard handed a trading session a browser.
2. `TradingTurnCoordinator` holds one decision lease per mission
   (`idx_trading_harness_runs_one_active_per_mission`, migration 035). A turn
   that blocks on authoring — 30s to 5min of write/typecheck/dry-run — holds
   that lease for the whole window. Watches fire, the coordinator returns
   `queued_behind_active_run`, and the mission is **deaf to price while it
   writes TypeScript**. Structural, not tunable.

The shape instead:

```
trading turn   trading_signal({ request: "..." })  →  { signalId, status: "authoring" }
               arm a watch on signalId, publish the plan, END THE TURN
                                  ⋮
server         dispatches a separate authoring thread — an ordinary coding
               session with Write/Bash/typecheck/test and NO trading tools
                                  ⋮
completion     inbox event, category "system"  →  normal wake
               agent reacts to "signal ready" or "signal failed, because …"
```

Properties this preserves:

- **Disjoint tool sets.** The trading agent trades and cannot write code; the
  authoring agent writes code and has no trading tools and no signer. Neither
  can do the other's job.
- **The lease stays free** during authoring, so the mission keeps reacting.
- **Authoring is a visible thread** with a diff, a typecheck, and tests. The
  user can watch it and intervene.
- **Failure is already modeled.** `TradingDomainEventSummary` carries a
  `system` category; "authoring failed, here is why" is the same shape as an
  execution refusal and the agent reacts to it the same way.

An awaited request is a wait like any other — which is precisely the loop the
in-flight `DECISION_CONTRACT` rewrite establishes (predict → arm → wait →
react). The feature falls out of that loop rather than fighting it.

---

## 3. Contract — `packages/trading-contracts/src/signal.ts`

New module, sibling to `watch.ts` and `observation.ts`.

### 3.1 Signal identity and declaration

```ts
/** A signal's stable id. Referenced by watches, samples, and the look. */
export const SignalId = Schema.String.pipe(Schema.brand("SignalId"));

export const SignalOutputKind = Schema.Literals(["number", "boolean"]);

/**
 * How the producer runs.
 * - `continuous`: a long-lived process that pushes when it has something.
 * - `interval`: the host runs it every `intervalMs` and takes one value.
 */
export const SignalMode = Schema.Literals(["continuous", "interval"]);

export const SignalDeclaration = Schema.Struct({
  id: SignalId,
  /** Short slug the model writes in a watch: `war_risk`, `pool_buy_pressure`. */
  name: Schema.String,
  /** One line the model reads on `trading_look`. What the number MEANS. */
  description: Schema.String,
  output: SignalOutputKind,
  mode: SignalMode,
  intervalMs: Schema.optional(Schema.Number),
  /** e.g. "0-1", "ETH/min", "bps". Prose; the model quotes it in `because`. */
  unit: Schema.optional(Schema.String),
  /**
   * A signal that has not produced within this window is STALE and must not
   * read as its last value. See §3.3 — this is the field that stops a mission
   * holding a position on a feed that died an hour ago.
   */
  staleAfterMs: Schema.Number,
  /**
   * Clamp. A model-authored producer that returns 1e9 must not be able to
   * satisfy every threshold at once. Values outside are clamped and the
   * clamping is recorded on the sample.
   */
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  /**
   * Most a value may move per sample. A signal derived from adversarial text
   * (see §7) should not be able to jump 0 → 1 on one crafted headline.
   */
  maxDeltaPerSample: Schema.optional(Schema.Number),
});
```

`min`/`max`/`maxDeltaPerSample` are enforced by the **host** on ingest, not by
the producer. A producer is untrusted input; the clamp is the boundary.

### 3.2 A sample

```ts
export const SignalSample = Schema.Struct({
  signalId: SignalId,
  /** Booleans persist as 0/1 so one column serves both output kinds. */
  value: Schema.Number,
  observedAt: UnixMillis,
  /** Optional one-line justification the producer emitted. Prose, bounded. */
  note: Schema.optional(Schema.String),
  /** Set when the host clamped the raw value. The model should see this. */
  clamped: Schema.optional(Schema.Boolean),
});
```

### 3.3 Freshness — a first-class state

```ts
export const SignalHealth = Schema.Literals([
  /** Producing inside `staleAfterMs`. */
  "live",
  /** Declared and approved, but has never produced a sample. */
  "warming",
  /** Last sample older than `staleAfterMs`. The value is NOT to be trusted. */
  "stale",
  /** The producer exited non-zero or exceeded its restart budget. */
  "failed",
  /** Authoring in flight (step 3). No producer exists yet. */
  "authoring",
]);
```

`stale` exists because the alternative is silent: a producer that dies keeps
its last value in the table forever, and every threshold evaluated against it
stays exactly as satisfied as it was the moment the feed stopped. This mirrors
`marketReadFailed` on `TradingObservation` — the absence of a read is itself
reported, never papered over.

**Rule:** the evaluator does not fire a signal watch on a stale reading. When a
signal a mission has armed goes `stale`, the evaluator fires a distinct
_staleness_ wake instead, so the mission learns the feed died rather than
waiting on a level that can no longer be reached.

### 3.4 What the model reads on a look

```ts
export const SignalReading = Schema.Struct({
  declaration: SignalDeclaration,
  health: SignalHealth,
  /** Absent while `warming` or `authoring`. */
  latest: Schema.optional(SignalSample),
  /** Age of `latest` at observation time. Present whenever `latest` is. */
  ageMillis: Schema.optional(Schema.Number),
  /**
   * Recent history, oldest first, bounded. "Has it been elevated for twenty
   * minutes" is a question about a series, not a point.
   */
  recent: Schema.optional(Schema.Array(SignalSample)),
});
```

Bound `recent` the way the wakeup bounds everything else — a small constant
(propose 12), newest-window, so a look does not grow without limit.

---

## 4. The watch condition

### 4.1 Model-facing — `WatchCondition` gains a seventh member

```ts
/**
 * A user-defined signal reaches a threshold. The open version of `metric`:
 * `metric` names one of five numbers the runtime reads itself, `signal` names
 * a datapoint a producer supplies. Everything else is identical — a level, a
 * direction, and a wake when it is reached.
 *
 * A boolean signal is a threshold at 0.5: `direction: "above"` fires on true.
 *
 * Never fires on a stale reading; a signal that goes stale while armed wakes
 * the mission to report that instead.
 */
Schema.Struct({
  kind: Schema.Literal("signal"),
  signalId: SignalId,
  direction: WatchCrossDirection,
  value: Schema.Number,
  /**
   * Consecutive samples that must satisfy the threshold before it fires.
   * Defaults to 1. A noisy model-authored signal that oscillates across a
   * boundary would otherwise wake the mission on every sample.
   */
  sustainSamples: Schema.optional(Schema.Number),
});
```

### 4.2 Persisted — `MarketWatch` gains `signal_threshold`

```ts
Schema.Struct({
  type: Schema.Literal("signal_threshold"),
  signalId: SignalId,
  direction: WatchCrossDirection,
  value: Schema.Number,
  sustainSamples: Schema.optional(Schema.Number),
});
```

Note there is **no `market`** on a signal watch, unlike every other member.
A signal is not necessarily about a market — "war risk" is about the world.
Check the evaluator's per-market grouping and the wakeup composer's market
filters for assumptions that every watch carries one. This is the single
riskiest assumption in the change; find it before writing code.

### 4.3 `toMarketWatch` / `toWatchCondition`

One case each, in the existing switch (`watch.ts:258` and `watch.ts:352`).
Mechanical.

### 4.4 New refusal codes

Added to `WatchRefusalCode`:

- `signal_not_found` — no such signal id.
- `signal_not_approved` — declared but not yet approved to arm (§7).
- `signal_boolean_threshold` — a non-0.5 threshold on a boolean signal, which
  is almost always a mistake worth naming rather than silently rounding.

---

## 5. Migration `070_TradingSignals.ts`

069 is the last taken (`069_TradingWatchPredictionVersion.ts`).

```sql
CREATE TABLE IF NOT EXISTS trading_signals (
  signal_id            TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  description          TEXT NOT NULL,
  output               TEXT NOT NULL,   -- number | boolean
  mode                 TEXT NOT NULL,   -- continuous | interval
  interval_ms          INTEGER,
  unit                 TEXT,
  stale_after_ms       INTEGER NOT NULL,
  min_value            REAL,
  max_value            REAL,
  max_delta_per_sample REAL,
  health               TEXT NOT NULL,   -- SignalHealth
  approved_at          INTEGER,         -- NULL until the user approves (§7)
  created_at           INTEGER NOT NULL,
  -- populated in step 2; declared now so step 2 adds no migration
  producer_path        TEXT,
  producer_hash        TEXT,
  last_error           TEXT
);

CREATE TABLE IF NOT EXISTS trading_signal_samples (
  signal_id   TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  value       REAL NOT NULL,
  note        TEXT,
  clamped     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (signal_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_trading_signal_samples_recent
  ON trading_signal_samples (signal_id, observed_at DESC);
```

Deliberately a **real series**, unlike `trading_market_samples` (068), which
keeps one row per mission because the sample is only ever compared to the next
one. Two reasons signals differ:

1. The model will ask series questions ("elevated for twenty minutes").
2. **A signal with no history is unfalsifiable.** Replay
   (`TradingReplayFixtures`, `TradingReplayWindow20260813`) is what lets a
   signal be evaluated rather than believed. Retention/pruning is a follow-up;
   the series is not.

`producer_path`/`producer_hash`/`last_error` are declared now and unused in
step 1 so step 2 ships without a migration. `producer_hash` is what makes a
sample attributable to a specific version of the script.

---

## 6. Evaluator — the push path

`WatchEvaluator` today has two entry points (`WatchEvaluatorShape`):
`evaluateDelivery` (WS candles) and `sweep` (2s, gateway snapshot). Add a
third:

```ts
/**
 * Ingest one produced sample and evaluate the signal watches armed on it.
 *
 * The third evaluation source, beside the candle deliveries and the periodic
 * sweep: a value the runtime did not read but was handed. Clamping, the
 * staleness clock, and the sustain counter all live on this side of the
 * boundary — the producer is untrusted input, not a collaborator.
 */
readonly ingestSignalSample: (
  sample: SignalSample,
) => Effect.Effect<void, PersistenceSqlError>
```

Ingest order, all host-side:

1. **Clamp** to `min`/`max`; set `clamped` when it bit.
2. **Rate-limit** against `maxDeltaPerSample` relative to the previous sample.
3. **Persist** to `trading_signal_samples`; set `health = "live"` and bump the
   freshness clock.
4. **`recordObservation`** on every armed watch for this signal, before the
   match check — same discipline as the existing evaluators, so a signal that
   has not crossed still surfaces how close it is.
5. **Match** `direction` against `value`; increment or reset the sustain
   counter; fire only when it reaches `sustainSamples`.
6. **`enqueueFire`** with `deduplicationKey = signal_threshold:${watchId}` —
   the existing per-watch dedup scope, so a replay after restart cannot
   double-wake.

Staleness rides the existing 2s `sweep`, which already runs and already
touches every armed watch:

- For each `live`/`warming` signal with an armed watch, if
  `now - lastObservedAt > staleAfterMs`, flip `health = "stale"` and fire a
  staleness wake once (dedup key `signal_stale:${signalId}:${flippedAt}`).
- A `stale` signal's watches are skipped by the match check until a fresh
  sample flips it back to `live`.

No new fiber, no new subscription, no new timer.

### 6.1 Sustain counter placement

`sustainSamples` needs a per-watch count that survives a restart. Put it on
`trading_watches` beside `last_observed_value` rather than in memory —
in-memory means a backend restart silently resets every sustain window, which
is exactly the kind of quiet difference that makes a live run diverge from a
replay. One nullable integer column, in the same migration.

---

## 7. Trust boundary — write this down before writing code

Every datapoint the product has today is a number from an exchange. These are
derived from **adversarial text that anyone can write**. If a signal is "an LLM
reads headlines and outputs war risk 0–1", then whoever can get text in front
of that LLM can move a position.

What holds:

- **A signal cannot trade.** The producer gets no `~/.t3trade/secrets`, no
  signer, no MCP endpoint. It emits numbers. Every path from datapoint to order
  still runs through plan → watch → `trading_enter` with the server-enforced
  ceilings. Say this explicitly in the contract docs rather than relying on it
  being structurally true.
- **A signal wake produces a plan revision, never an entry.** Already true —
  only the model calls `trading_enter`, and only after a look. State it.
- **An LLM inside a producer is a classifier, never an agent.** Fixed rubric,
  numeric output, no tools. An agent with tools inside a signal producer is a
  second, unsupervised trading loop wearing a number as a disguise.
- **Clamp and rate-limit host-side** (§6), because the producer is the thing
  that might be wrong.
- **Approval gate.** A signal produces samples the moment it exists — so the
  series is visible and reviewable — but `approved_at` must be set before a
  watch may arm on it (`signal_not_approved`). Default on for testnet,
  user-approved for mainnet.

---

## 8. Where it reaches the model

Three surfaces, all existing:

1. **`trading_look`** → `signals: Schema.optional(Schema.Array(SignalReading))`
   beside `microstructure`. Optional, like every field in the market half, for
   the reason already stated there: a look must never fail.
2. **`trading_watch`** → the seventh condition kind. The tool description grows
   by one clause; check headroom, the toolkit description budget is tight.
3. **`because` prose** — and the contract must extend the same sentence the
   in-flight `DECISION_CONTRACT` work is drawing between indicators and
   playbooks:

   > A SIGNAL IS EVIDENCE, NEVER A STRATEGY. A custom datapoint crossing a
   > threshold is an observation, exactly like an RSI at 72. The playbook you
   > matched is the decision; the signal is a line in `because`.

   Without this, the feature is an expensive way to trade on a number the model
   invented, and the distinction gets relitigated in six weeks.

---

## 9. Sequencing and blockers

**Blocked on:** the in-flight uncommitted work (`DECISION_CONTRACT` rewrite,
projection/prediction loop, strategy-vs-indicator) landing first. It touches
`TradingSessionProfile.ts` and `mcp/toolkits/trading/tools.ts` — the same two
files any signal work edits — and it fixes the prose that §8.3 has to slot
into.

**Step 1 (this document):** contract, migration 070, `ingestSignalSample`,
staleness in the sweep, `signals[]` on the look, one hand-written in-repo
producer. No codegen.

**Step 2:** the producer runtime — one OS process per signal, spawned as
`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, reusing
`DesktopBackendManager`'s restart loop (500ms → 10s backoff,
`MAX_PREFLIGHT_FAILURE_ATTEMPTS` circuit breaker, per-instance rotating logs).
NDJSON on stdout, `--permission` with fs scoped to the script dir, no
`--allow-child-process`, no `--allow-worker`, `--max-old-space-size`.
Rejected alternatives and why: `node:vm` shares the event loop that runs the 2s
sweep and the execution reactor; `isolated-vm` is a native module to prebuild
and `asarUnpack` per platform-arch on a pipeline already fighting unsigned
arm64; a remote sandbox breaks local-app/offline and adds a hop to the trigger
path.

**Step 3:** the authoring flow of §2 — `trading_signal` tool, dispatched
authoring thread, `system` inbox event on completion. Dependencies come from a
curated bundled stdlib (fetch, a chain client, a WS client, parsers); anything
beyond it is a workspace package change with a diff and a build, never a
runtime `npm install`.

**Step 4:** replay/backtest over `trading_signal_samples`, then let signals
gate entries rather than only inform them.

**CI:** keep new server code under `src/trading`, `src/mcp`, or `src/provider`
so `test:fork` covers it.

---

## 10. Open questions

1. **Signals without a market** (§4.2). Does the evaluator's grouping or the
   wakeup composer's filtering assume every watch names one? Answer before
   writing the union member.
2. **Toolkit description budget.** Does `trading_watch` have room for a seventh
   condition clause, and is there room for an eighth tool in step 3? If not,
   what gets cut.
3. **Are signals mission-scoped or global?** Global is proposed here (a signal
   is about the world, and two missions should share one producer), which means
   the samples table has no `mission_id` and the watches join by `signal_id`.
   Confirm no reader assumes mission scoping.
4. **Sample retention.** A 5s continuous signal is ~17k rows/day. Pruning
   policy is a follow-up but should be decided before step 4 measures anything
   against the series.
