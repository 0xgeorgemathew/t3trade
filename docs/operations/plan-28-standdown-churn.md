# Plan 28 — Stop the stand-down churn loop

Source: the 13:10–13:18 mission log. Eleven strategy versions published in eight
minutes, zero entries, two watch firings discarded, and a cost estimate that
moved $2.24 between consecutive turns on an unchanged position.

Every number below is read off the log and traced to the code that produced it.

---

## What the log actually shows

| Time  | Version | EMA spread | Gate  | Round trip | Min target |
| ----- | ------- | ---------- | ----- | ---------- | ---------- |
| 13:10 | 2       | $0.025     | $2.13 | $18.50     | $24.05     |
| 13:11 | 3       | $0.025     | $2.13 | $17.61     | $22.90     |
| 13:13 | 4       | $0.60      | $1.93 | $16.26     | $21.14     |
| 13:13 | 5       | $0.85      | $1.66 | $15.88     | $20.64     |
| 13:14 | 6       | $1.16      | $1.52 | $17.52     | $22.78     |
| 13:15 | 7       | $1.16      | $1.52 | $17.54     | $22.80     |
| 13:16 | 8       | —          | —     | $17.50     | $22.74     |
| 13:17 | 9       | stale      | —     | —          | $23.22     |
| 13:17 | 10      | 7 bars old | —     | $16.96     | —          |
| 13:18 | 11, 13  | stale      | —     | $18.39     | —          |

Two watch firings were thrown away: one "misarmed", one "from superseded
version 5". No entry was ever attempted.

---

## Defect 1 — the publish/supersede/re-arm loop is self-sustaining

**Cause.** `playbook.ts:248` makes a publish mandatory on _every_ assessment
turn, stand-downs included. `TradingStrategyService.ts:268` supersedes the prior
version's active watches on every publish. So each stand-down turn destroys the
watches it armed one turn earlier and arms replacements — and any watch that
fires inside that window is bound to version N while version N+1 is already
current, which is exactly the 13:15 discard.

The 1m confirmation watches are armed at the fast EMA, which price is sitting
on. They fire in well under the 5-minute reassessment floor
(`policy.ts:249-250`, 10 bars clamped to [5, 30] min), so the loop drives itself
faster than the floor was ever meant to allow.

**Fix.**

1. Add a `republish` path that carries watches forward: when the new version's
   `entryPlan.conditions[]` name the same level, type, direction and timeframe
   as a live watch, rebind that watch to the new version instead of superseding
   and re-arming it. Only genuinely changed conditions get a new watch.
2. Introduce a stand-down _amendment_ distinct from a version bump. A turn that
   re-runs the tournament and reaches the same verdict should record an
   observation against the current version, not mint version N+1. Reserve the
   bump for a changed thesis, a changed mandate, or a changed level set.
3. Rate-limit entry-trigger re-arms on the primary timeframe: a level within
   one ATR-tick of the level just armed is the same level. Re-arming it a third
   time inside the reassessment floor is the "same trap a third time" the
   playbook already forbids at `playbook.ts:151` — enforce it in code.

**Files.** `TradingStrategyService.ts`, `TradingTurnCoordinator.ts`,
`packages/trading-contracts/src/watch.ts`, `playbook.ts`.

---

## Defect 2 — misarm is detected at wake time, one turn too late

**Cause.** `findMisarmedEntryConditions` (`watch.ts:476`) runs in the wakeup
composer (`TradingWakeupComposer.ts:830`). By then the wrong watch has already
been armed, has already fired, and has already burned a turn — which is
precisely what the 13:13 and 13:18 entries in the log are. The function's own
doc comment describes the failure it is meant to prevent, and it is running at
the wrong end of the cycle to prevent it.

**Fix.** Call the same check at publish time, inside `trading_publish_plan`,
against the watches the turn is about to arm. A condition declaring
`confirmation: "close"` armed as a `price_cross` is a rejected publish with the
corrected arming named in the error, not a wake to be discarded later. Keep the
wake-time check as a backstop for watches armed outside a publish.

**Files.** `TradingStrategyService.ts` (publish validation),
`apps/server/src/mcp/toolkits/trading/handlers.ts`.

---

## Defect 3 — the separation gate's goalposts move faster than the signal

**Cause.** `readEmaCross` gates on `separation < policy.emaCross.minSpreadAtrRatio`
(`momentum.ts:1371-1372`) — 0.15 × the _1m_ ATR, re-measured every turn. Over the
eight logged minutes the required spread went $2.13 → $0.93 → $1.52 → $1.66 →
$1.93: the 1m ATR swung more than 2x while the EMA spread crawled from $0.025 to
$1.16. The harness is chasing a target that moves faster than the thing being
measured.

**Fix.**

1. Measure the separation gate against a smoothed ATR — the median of the last
   N bars' ATR, or the higher-timeframe ATR — so the gate is a property of the
   market rather than of the last candle. Ship it as `TRADING_POLICY_V3` with a
   replay against V2, per the versioning discipline in `policy.ts:192-198`.
2. Publish the gate's inputs in the stand-down record: the ATR used, its
   lookback, and the spread. "roughly $2.13 required" with no ATR attached is
   not a number a replay can check.

**Files.** `momentum.ts`, `policy.ts`, `replay.ts`.

---

## Defect 4 — near-misses are invisible to the funnel

**Cause.** `readEmaCross` returns `null` on any failed gate — age
(`momentum.ts:1367`), separation (`:1372`), or close agreement (`:1373`). A null
never reaches `setups[]`, so `compareCandidates` never scores it, so the turn
reports "no scored candidate". A cross 5% under its separation gate and no cross
at all are indistinguishable in the record.

This is the reason the log alternates between "spread $1.16 vs $1.52 required"
(prose the harness computed by hand) and "no scored candidate" (what the
tournament actually returned). Those two statements are about the same signal.

**Fix.** Return the candidate with a `rejectedBy` field naming the gate it
failed and its margin, instead of `null`. `compareCandidates` carries it through
as a non-competing row. The stand-down then records _which_ gate stopped the
session, which is the evidence `EnrichmentEvidence` (`policy.ts:337`) is
supposed to be drawn from and currently cannot be.

**Files.** `momentum.ts`, `packages/trading-contracts/src/strategy.ts`,
`setupEvidence.test.ts`.

---

## Defect 5 — costs are priced at the ceiling, and the two cost paths disagree

**Cause.** Slippage is 55–60% of every logged round trip ($9.56 of $17.50, $10.29
of $16.96, $9.99 of $18.39). `walkBook` (`costs.ts:132`) walks the visible book
for the _full_ requested size, and the size being costed is the approved ceiling
— the $7,281.89 gross the 13:18 turn quoted. On a thin book that prices the
worst fill the mission could possibly take and then gates every candidate
against it.

Worse, `bookDepthSufficient` comes back false (the log's "slippage beyond
displayed liquidity is not fully priced"), which sets `degraded: true`
(`costs.ts:208-213`) — and the estimate is used as a hard gate anyway.

And the new `roundTripCostFractionOfNotional` (`costs.ts`, uncommitted)
deliberately _excludes_ slippage because it does not scale with notional, while
`estimateTradingCosts` includes it in full at ceiling size. The sizing path and
the gating path are now answering the same question two different ways.

**Fix.**

1. Cost the gate at the size the mission would actually take, not the ceiling.
   Feed `notionalForProfitTarget`'s result back as the `sizeEth` for the gating
   estimate; the ceiling stays a ceiling.
2. Make `degraded: true` a stated caveat on the gate rather than a silent input:
   a candidate rejected on an estimate whose slippage could not be measured
   should say so in `standDownCode` terms.
3. Reconcile the two paths. Either both include slippage or neither does, and
   the one that does must be the one that sizes. Add a test asserting the round
   trip implied by `roundTripCostFractionOfNotional` at the sized notional
   agrees with `estimateTradingCosts` at that same notional.

**Files.** `costs.ts`, `TradingCostEstimator.ts`, `TradingQuoteService.ts`,
`costs.test.ts`.

---

## Defect 6 — a turn spent on arithmetic that changed no decision

Nine of the eleven versions differ only in numbers that never crossed a
threshold. The log's own $23.22 / $22.80 / $22.74 minimum targets are three
restatements of one unchanged verdict.

**Fix.** Suppress the publish when the verdict, the mode, the level set and the
stand-down code are all unchanged and no gate margin moved by more than a stated
epsilon. Record a heartbeat against the current version instead. This is
downstream of Defect 1's amendment path and should land with it.

---

## Sequencing

Each step is independently shippable and testable.

1. **Defect 2** — publish-time misarm rejection. Smallest change, removes a
   whole class of wasted wake immediately, no policy version needed.
2. **Defect 4** — `rejectedBy` on failed candidates. Pure observability; every
   step after this is easier to verify because the funnel finally says why.
3. **Defect 1 + 6** — watch carry-forward, amendment path, publish suppression.
   The churn fix proper. Needs 2 and 4 landed first so the reduced turn count is
   attributable.
4. **Defect 5** — cost path reconciliation and gate-at-traded-size. Touches
   sizing, so it wants the churn quiet before it lands.
5. **Defect 3** — `TRADING_POLICY_V3` smoothed separation gate, shipped through
   replay against V2 like every other threshold.
6. **Testnet soak** — the standing outstanding item. Run it after 1–5 and check
   the funnel: versions per session, discarded wakes, and the `rejectedBy`
   histogram.

## What this plan does not do

It does not loosen a gate to make the harness trade. Every logged refusal was
arithmetically correct given its inputs — a $0.025 spread is not a cross, and a
seven-bar-old cross is not a signal. The defects are that the harness spent
eleven versions saying so, threw away two firings that might have been evidence,
priced its costs at a size it would not have taken, and left no record of which
gate was actually binding.
