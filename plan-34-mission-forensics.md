# Plan 34 — Forensics of mission 38502fa8 (2026-08-18 03:19–03:53 IST) and the fixes it orders

Mission: `38502fa8-68ed-4d10-a1e1-668748f9720b`, thread `f8a6acf0-cb45-468c-83a3-7c7a548a6154`,
ETH short on the ema_cross prompt, first mission on the round-5 build.
Evidence sources: `~/.t3/userdata/state.sqlite` (snapshot taken 04:13), Hyperliquid CSV export,
the completion-card screenshot, and the web/server sources on `plan-33-wake-token-fixes`.
Every number below was recomputed from the DB, not read off the UI.

---

## Part 1 — Findings

### F1. Wake sizes: flat wakes got 60% leaner; holding wakes did NOT shrink

Old build (thread `f0f7658f`, mission 353592af, same night): every wake carried
marketSnapshot + accountSnapshot + recentCandles — 2,958–4,433 chars, mean ≈ 3,540.

New build (this mission, 11 wakes):

| wake state         | sizes (chars)                                 | mean                   |
| ------------------ | --------------------------------------------- | ---------------------- |
| flat (waiting)     | 1,691 / 1,582 / 1,525                         | **1,600** (−55%)       |
| holding a position | 3,252 / 3,487 / 3,407 / 3,870 / 3,141 / 3,145 | **3,384 (≈ old size)** |

The operator's eyeball ("still visually long") is correct for holding wakes. The
snapshot halves are gone, but three blocks replaced them:

- **`positionCosts` renders the FULL cost record** — 27 lines, ~1,050 chars
  (takerFeeBps, both leg fees, three slippage lines, funding, three round-trip
  variants, breakEven twice, measuredAt, degraded, a prose `notes` line). The
  lean doctrine said "one cost line"; the flat wakes honour it
  (`costContext: referenceNotionalUsd=… roundTripUsd=… roundTripBps=…`), the
  holding wakes do not.
- `armedWatches` at 5–7 entries ≈ 650 chars, each with a full UUID.
- `triggeringWatch` echoes the whole persisted row (~350 chars, 3 UUIDs, both
  the `watch=` and `condition=` forms of the same condition).
- `misarmedEntryConditions` noise rode every holding wake (see F8).

### F2. The context hog moved: `trading_look` results are 85% of context growth

From the `context-window.updated` events (Codex-reported, exact):
context grew **16,394 → 171,198 tokens across 11 turns (33 min)** — ≈ 14k tokens
per wake-turn. Per-turn anatomy: wake ≈ 0.9k tokens, model output ≈ 1k,
**trading_look result ≈ 8–10k tokens (29,266–35,954 chars)**.

Section sizes of the first look (33,462 chars total):

| section               | chars   | note                                               |
| --------------------- | ------- | -------------------------------------------------- |
| candles               | 18,334  | **raw 120-bar echo is 18,161 of it**               |
| structure             | 10,077  | timeframes 4,734 / candidates 2,434 / setups 1,846 |
| mission               | 3,118   | full mandate + plan echo, every look               |
| orderBook             | 1,688   |                                                    |
| indicators            | **140** | the new path — works, and is 0.4% of the payload   |
| volatility + HTF pair | 1,504   |                                                    |

The model did exactly what the mandate asked: `indicators:[{ema,20},{ema,50}]`
on every look, and it even cut `bars` 120→60→30 on its own trying to slim the
result — but the raw-bar echo plus `structure` kept every look ≈ 30k chars.
At this cadence a 2-hour mission crosses the 258k window ~2.5 times.

Rate pressure is also still real: the close-turn reconciliation logged
`frontendOpenOrders status=429` (recorded on run `9097c316`, retried, non-fatal).

### F3. Entry sizing: the server asked for 8× what the account could take

`trading_enter` result (22:11): `size: 3.7946 ETH, notionalUsd: 7,229.85,
constrainedBy: "gross_notional", timeInForce: ioc, limitPrice: 1895.8`.
The authority's `maximumGrossNotionalUsd` is 7,229.89 (= allocatedCapital
903.74 × 8). The exchange account's ETH leverage is **1×**, so margin capacity
was ≈ $903 — the IOC filled **0.474 ETH ($903)**, 12.5% of the request, and the
93% shortfall surfaced nowhere: no warning, `status: "filled"`.

Knock-on: the model published `maximumPlannedLossUsd: 63.26` — which is exactly
the authority ceiling `maximumPlannedRiskPerPositionUsd`, itself derived from
the 8×-leverage sizing. The true worst case of the position actually opened was
(1906.94 − 1905.11) × 0.474 ≈ **$0.87 + fees ≈ $1.7**. The completion card's
"Planned risk $63" and "Versus plan +$62.81" (= 63.26 − 0.45, arithmetic
verified correct in `deriveMissionCompletion`, tradingPresentation.ts:1062) are
therefore fiction built on a size that never existed.

### F4. Close behavior: NOT erratic — two of the three closes were the server's own take-profit

Full trace, reconciled across thread, DB and exchange:

1. 22:11:20 — model enters short 0.474 @ 1905.11 (4 partial fills, one order).
   Protection stop rests; `reconcileTakeProtection` rests a **full-size
   reduce-only ALO at 1903.7** (the plan's 1903.66 target, tick-rounded).
2. 22:14 / 22:18 — model holds, trails stop 1906.90→1906.68, arms $0.10 giveback.
3. 22:20:32–22:20:55 — price grazes 1903.7; the resting TP **partial-fills
   0.0956, then (as a replaced order) 0.0394** — maker fills (`crossed=0`),
   orders 57981968170 / 57981979732. **No model involvement.**
4. 22:20:57 — giveback wake (peak $0.62 → $0.51). The model _misattributes_ the
   size drop: "The giveback trigger banked part of the short." It couldn't know
   better — **TP fills produce no pendingEvent**; the position just shrinks
   silently between wakes.
5. 22:21–22:22 — churn: giveback re-armed at $0.08 when drawdown was already
   ≈ $0.18 → fired in 8s; re-armed at $0.25 when drawdown was ≈ $0.41 → fired
   in 5s. Three wakes in 90 seconds doing nothing but widening a threshold.
   Two `move_stop` calls refused `step_too_large` (1905.61, then 1906.25).
6. 22:22:38 — model closes the remaining 0.339 @ 1904.82 after $0.41 giveback.
   One close call, total. Defensible: open profit $0.21 was under the $0.75
   round trip and the giveback doctrine said bank.

Verdict: the model issued exactly one entry, one close, and legal stop trails.
The "multiple closes" in the CSV are the server's TP rungs plus partial fills.
Defects worth fixing are (a) invisible TP fills, (b) giveback re-arms below the
current drawdown being accepted, (c) the TP orders appearing in NO ledger —
they have no execution-record row and no orchestration event (only the
stop-moves took sequences 1–2; the TP path writes nothing).

### F5. Math: the completion card is exactly right; two derived stores are wrong

Recomputed independently from `trading_fills` (11 fills; the CSV's 7 rows are
Hyperliquid's aggregation of the 4-part open into one row — sizes and fees
reconcile to the cent):

- Realized P&L Σ closed_pnl = **$0.28778** → card "$0.29" ✓
- Fees Σ fee_usd = **$0.735485** → card "$0.74" ✓
- Net = **−$0.44771** → card "−$0.45" ✓
- Fills **11** ✓, duration 22:11:20→22:22:39 = **11m 19s** ✓
- Entry 1905.11 (volume-weighted) ✓, per-row realized figures = per-order
  pre-fee closedPnl ✓ (fees shown separately per row ✓)

The card reads `SUM(...) FROM trading_fills WHERE mission_id` — unbounded, correct
(TradingMissionProjection.ts:633).

**Wrong store #1 — `trading_closed_trades`** (TradingClosedTradeReview.ts:118):
the totals query filters `traded_at >= opened_at`, but `opened_at` is when the
reconciler first _observed_ the position — 307ms **after** the entry fills
traded. All 4 open fills are excluded, so the persisted review says
`fees_paid 0.329` (close side only), `net_pnl −0.041` (true −0.448),
`fill_count 7`, `size −0.339` (the last chunk, not the 0.474 exposure).
This is the model's own scorecard: `roundTrips` /
`summary.recentFeeShareOfGrossPercent` in trading_look retrospect and target
calibration all read this table — the standing-rules fee-share gate currently
sees roughly **half** the real fee load.

**Wrong store #2 — the live ledger** (`deriveRoundTrips`,
tradingPresentation.ts:2248): pairing pops **one whole open leg per closing
row** and charges its entire fee to that row. `mission.recentFills` is
per-order (GROUP BY order_id), so this mission's live panel showed, while the
position was open:

| live row           | shown                 | truth                                   |
| ------------------ | --------------------- | --------------------------------------- |
| Short 0.0956 close | net **−$0.30**        | ≈ **+$0.03** (prorated open fee $0.082) |
| Short 0.0394 close | entry "—", net +$0.04 | entry 1905.11, ≈ +$0.01                 |
| Short 0.339 close  | entry "—", net −$0.19 | entry 1905.11, ≈ −$0.48                 |

The aggregate coincidentally sums right; every row is individually wrong. This
is live-state-only (the completed card derives elsewhere) — which matches the
operator's report that the suspicious figure only shows during a live mission.

### F6. "Truncated" tool results: display-only; nothing was lost

Every tool call's arguments and full result are intact in
`projection_thread_activities` (largest stored result: 35,954 chars; zero
occurrences of any truncation marker across all 34 tool payloads), and the
expanded row does receive the complete item (`entry.toolData = data.item`,
session-logic.ts:868). The model received complete results. No decision was
affected.

What makes them _look_ truncated is presentation, in three layers:

1. Collapsed rows show an 84-char one-line preview
   (`truncateInlinePreview`, session-logic.ts:1326) plus CSS `truncate`.
2. The expanded body is `JSON.stringify(item, null, 2)`
   (MessagesTimeline.tsx:2207) — but the tool result lives at
   `item.result.content[0].text` as a nested JSON **string**, so a 35k-char
   observation renders as one giant escaped line.
3. That body sits in a `max-h-64` box (MessagesTimeline.tsx:2539) —
   scrollable, but visually it cuts off after ~16 lines.

### F7. Regression check: the original failures did not recur

- 10/10 harness runs `completed`; mission reached `completed` cleanly; no
  wakeup-too-large, no stuck lease, no cwd-restart kill (P0.1/P0.2 held).
- `tool_error_count = 0` on every run. One non-fatal 429 during close
  reconciliation (recorded on the run row, retried).
- The indicators path worked end-to-end on its first real mission; the candle
  cache cannot be measured from the DB but no rate errors occurred on the
  candle path.
- The user-message queue was NOT exercised this mission (no operator message
  mid-mission) — still unverified on the new build.

### F8. Minor: stale `misarmedEntryConditions` advisory

The model entered at market on the same turn it published the trigger, so the
"armedAs=price_cross shouldBe=candle_close" advisory described a condition that
no longer mattered — yet it rode all six holding wakes (~230 chars each).
An advisory about entry watches should stop rendering once the position is open.

---

## Part 2 — Execution plan

Ordered by value; steps are independent unless a dependency is named.
All server work happens on `plan-33-wake-token-fixes` (or its successor), tests
via targeted `vp` suites only; do not run the full suite. Known pre-existing
failures to ignore: 11 in TradingWatchCoverageFloor.test.ts, HostPowerMonitor.ts
typecheck, 3 lint errors in ProviderCommandReactor.test.ts.

### Step 1 — Slim the `trading_look` observation (targets F2; biggest win)

1.1 In the candles scope (`readMarketHalf`, apps/server/src/mcp/toolkits/trading/handlers.ts):
when the request names `indicators[]` and does not explicitly ask for bars,
or when `bars: 0` is passed, omit the raw candle echo entirely — keep
`volatility`, `finalisedClose`, `freshness`, `indicators`. When bars ARE
wanted, cap the echo at the requested `bars` (already true) but default the
unspecified case to 20, not the full window. Indicators/volatility still
compute over the full fetched window (unchanged).
1.2 In the structure scope: stop echoing per-timeframe raw detail — keep per
timeframe only {interval, trend/direction score, swing high/low, ATR,
regime vote}; keep `regime`, `setups[]`, `candidates[]` as they are.
Target: structure ≤ 4k chars.
1.3 Mission scope: render the mandate as a pointer + the plan numbers (the wake
already proves the flat form works); full mandate text only on the
bootstrap turn.
Acceptance: the ema-loop look (`market,candles+indicators,structure,
    position,mission`) ≤ 8k chars (from ≈ 33k); an indicators-only candles
scope ≤ 2k. Update handlers tests; the tool description already documents
`bars`/`indicators` (500-char budget is at 494 — do not grow it).

### Step 2 — One cost line on holding wakes (targets F1)

In `renderLeanWakeup` (TradingWakeupComposer.ts): replace the full
`positionCosts` block with one line in `costContext` style:
`positionCosts: sizeEth=… roundTripUsd=… takerMakerUsd=… breakEvenMoveUsd=… preferredTargetUsd=…`.
Also: render `triggeringWatch` as one condensed line (kind, level/threshold,
status — no UUID echo of both watch= and condition= forms), and drop
`misarmedEntryConditions` whenever position.size ≠ 0 (F8).
Acceptance: a holding wake ≤ 2,000 chars (from ≈ 3,400); composer tests updated
(the "carries the plan's numbers" and "<2000" assertions extend to a holding
fixture with a full cost estimate).

### Step 3 — Fix `trading_closed_trades` under-count (targets F5 #1)

In `buildClosedTradeReview` (TradingClosedTradeReview.ts): bound the fills
window with the same slack the entry-context join already uses —
`traded_at >= openedAt − 60_000` — so the entry fills that trade moments before
the first snapshot observation are included. Set `size` to the peak exposure
(max |Σ signed fills| over the window, or simpler: Σ open-side filled_size) and
`fill_count` to all fills in the window. Fix-forward only; no backfill.
Acceptance: a unit test replaying this mission's 11 fills yields
fees 0.7355, net −0.4477, fill_count 11, size 0.474.
Dependency: none, but land before any soak that reads the scorecard — the
standing-rules fee-share gate is currently reading half the real fees.

### Step 4 — Fix the live ledger pairing (targets F5 #2)

In `deriveRoundTrips` (apps/web/src/components/trading/tradingPresentation.ts):
consume open legs **by size**: a close of size S pops legs proportionally
(splitting the last leg), prorating each leg's fee by the fraction consumed,
and a leg remainder stays available for the next close. entryPrice becomes the
size-weighted entry of consumed legs. Keep the honest-gap behaviour for closes
whose opens are off the window.
Acceptance: unit test with this mission's 4 per-order rows produces
{+0.026, +0.011, −0.485} nets (Σ = −0.448) with no null entries.
(Web work is uncommitted plan-32 territory — keep these edits in the same
uncommitted set or commit per the operator's instruction at the time.)

### Step 5 — Take-profit fills must be visible (targets F4 a+c)

5.1 When reconciliation observes fills on a protection-owned TP cloid, enqueue a
`system` pendingEvent for the next wake: "take-profit rung filled
<size> @ <price>; position now <size>" (same style as execution_settled).
5.2 Record TP placements/replacements in the execution ledger (a row or a
dedicated record with cloid, size, price) so the thread and forensics can
attribute exchange orders. Today those orders exist nowhere server-side.
Acceptance: replaying a TP partial fill produces the event on the next wake and
a queryable record of the order's provenance.

### Step 6 — Refuse a giveback armed below the current drawdown (targets F4 b)

In the watch service's arm validation: when `condition.kind = "giveback"` and
the mission's current `drawdownFromPeakUsd` already ≥ `drawdownUsd`, refuse
with `recovery` naming the current drawdown and suggesting a threshold above
it (the wake-churn loop this mission hit: armed 0.08 under 0.18 → fired in 8s;
armed 0.25 under 0.41 → fired in 5s). A refusal changes nothing, per doctrine.
Acceptance: watch-service test for the refusal + recovery text.

### Step 7 — Size entries to real margin capacity; make planned risk honest (targets F3)

7.1 TradingEntryService: bound the derived size by the account's actual buying
power for the market — free collateral × the exchange-configured leverage
(both already on the account/position snapshots) — and report
`constrainedBy: "account_margin"` when it binds. The 8×-capital
gross-notional ceiling stays, but can no longer be the binding constraint
when the exchange cannot fund it.
7.2 When an IOC fills < 90% of the approved size, say so in the enter result
(`notes`: "filled 0.474 of 3.7946; account margin capped the rest") so the
model's plan math starts from the real position.
7.3 The completion card's "Planned risk": derive from the entry's
stop-distance × _filled_ size (+ fee reserve) — the enter path already
computes `plannedLossAtStopUsd`; recompute it at fill size and persist it
for the card, instead of the plan's `maximumPlannedLossUsd` echo of the
authority ceiling. "Versus plan" then compares against a number that was
ever at stake ($1.7, not $63).
Acceptance: entry-service test where margin < gross-notional ceiling derives
the margin-bound size; card test showing planned risk from the filled size.

### Step 8 — Full-fidelity tool-call inspection in the thread UI (targets F6)

In `buildToolCallExpandedBody` (MessagesTimeline.tsx:2201): for
`mcp_tool_call` entries, stop dumping the raw item. Render two blocks —
"Arguments" (`JSON.stringify(item.arguments, null, 2)`) and "Result": when
`item.result.content[0].text` parses as JSON, pretty-print the parsed value;
otherwise show the text as-is. Errors (`item.error`) get their own block.
Raise the expanded box's `max-h-64` to something usable (e.g. `max-h-[32rem]`,
still `overflow-auto`) and add a copy button for the whole payload.
Acceptance: expanding a trading_look shows the observation as readable,
indented JSON, all ~35k chars reachable by scroll, nothing escaped inline.

### Step 9 — Soak (operator's)

Re-run the same ema_cross prompt on the next build and re-measure from the DB:
per-turn context growth (target ≤ 4k tokens/turn steady-state), holding-wake
chars (≤ 2k), look chars (≤ 8k), and the closed-trade scorecard after one
banked trade (fees must include the open leg). The user-message queue still
needs one live exercise (send an operator message mid-mission).
