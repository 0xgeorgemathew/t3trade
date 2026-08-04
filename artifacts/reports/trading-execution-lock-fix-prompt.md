# T3 Trade — execution-lock fix: verification results and remaining work

You are working in `/Users/george/Workspace/t3trade` (fork of T3 Code; LLM harness trades
ETH perps on **Hyperliquid testnet only**). A live incident on 2026-08-03 showed that after
one successful entry, every subsequent write for the mission was rejected forever with
`no_conflicting_execution_pending: an execution for this mission is already in flight`,
mislabelled to the agent as `TradingExhaustionError(budget_exhausted)`.

The root-cause fix has been **partially applied** in the working tree. This prompt records
what was verified as done and what remains. Your job is the "Remaining work" section only.

## The incident, restated with the operator's exchange-UI evidence

Mission `1653758f-29f8-444b-9ef9-e7df8c745199`, 1m-candle testing:

1. ~16:00 — entry IOC **filled**: short 0.0130 ETH at 1848.7. In the same grouped
   `normalTpsl` action, the mandatory protective stop was placed and confirmed:
   **Stop Market, Close Short, 0.0130, reduce-only, trigger `price above 1851.8`**.
   That trigger order is _correct and expected_ — it is the stop-loss for a short
   (entry 1848.7, stop above at 1851.8), not a failed update. It rests until price
   rises to 1851.8 or the position closes, and at 16:29 it was still (rightly) live
   on the exchange while the position sat in profit at mark ~1841.
2. ~16:20 — price reached the take-profit level. The agent submitted
   `actionType: "reduce"`, sequence 2, reduce-only, `marketable_ioc`, half size.
   **Rejected** by preview item 16 (`no_conflicting_execution_pending`) — the
   "in-flight execution" was the _successfully filled entry_, whose record was
   parked at `accepted` forever. Every retry failed identically; the rejections were
   wrapped as `budget_exhausted` in a payload that itself said `exhausted: false`.
   The reduce IOCs never reached the exchange — which is why the stop was the only
   order the operator ever saw on the book.
3. Also at 16:00:17: `trading_request_entry` rejected `intent.limitPrice = 0`
   (schema requires > 0) — the model expected market semantics from
   `marketable_ioc`. See remaining item R3.

## Already implemented and verified (do not redo; build on top)

Verified against the working tree on 2026-08-03; `cd apps/server && npx vitest run` is
green (227 files, 2015 passing after two stale assertions in
`HyperliquidExecutionService.test.ts` were updated to the new `filled` expectation).

1. **Submit path records `filled`**
   ([HyperliquidExecutionService.ts](../../apps/server/src/trading/HyperliquidExecutionService.ts) ~line 655):
   entry-leg response `filled` → record `filled`; only `resting` → `accepted`;
   else `rejected`.
2. **`settleAcceptedExecutions`**
   ([HyperliquidReconciler.ts](../../apps/server/src/trading/HyperliquidReconciler.ts) ~line 480):
   runs each reconcile pass after `settleAbandonedExecutions`, before the
   reservation release. Fill under the record's cloid → `filled`; not resting and
   past `ABANDONED_EXECUTION_AFTER_MS` → `cancelled`; still resting → left alone.
   **But see R1 — it has a precedence flaw and no direct unit tests.**
3. **Pending query narrowed**
   ([TradingMissionReactor.ts](../../apps/server/src/trading/TradingMissionReactor.ts) ~line 210):
   `status IN ('previewed','reserved','signed','submitted')` — an acknowledged
   resting order no longer blocks reduce/close/cancel/modify_stop. Covered by new
   cases in `ExecutionReactorLoop.test.ts`.
4. **Partially done — error taxonomy**: `TradingExecutionGuard.ts` now declares a
   `ReduceOnlyError` union (`TradingExhaustionError | TradingExecutionError |
TradingReconciliationError`) with a doc comment explaining exactly why the three
   must stay distinct — but the implementation does not honour it. See R2.

## Remaining work, in order

### R1. Fix `settleAcceptedExecutions` precedence and add unit tests

In [HyperliquidReconciler.ts](../../apps/server/src/trading/HyperliquidReconciler.ts),
the settler currently decides `filled` the moment _any_ fill exists under the cloid —
the still-resting check only guards the `cancelled` branch. A **partially filled
resting order** therefore settles to `filled` while its remainder is still working:
the record leaves the lifecycle and its risk reservation is released in the same
pass, so the remaining resting size works with no reservation behind it.

Reorder the checks so live state wins:

1. still resting on the canonical book → leave the record alone, whatever fills exist;
2. not resting, fill under the cloid → `filled`;
3. not resting, no fill, `updated_at` older than the grace window → `cancelled`;
4. otherwise (recently gone, no fill yet) → leave for the next pass.

Then add direct unit tests in `HyperliquidReconciler.test.ts` (none exist for this
settler today — the only coverage is indirect via the reactor loop tests):

- `accepted` + canonical fill + not resting → `filled`, reservation released same pass;
- `accepted` + still resting (with and without a partial fill) → untouched;
- `accepted` + vanished from book + no fill + grace elapsed → `cancelled`;
- `accepted` + vanished + grace not yet elapsed → untouched.

### R2. Make the guard's error taxonomy honour its own declared union

In [TradingExecutionGuard.ts](../../apps/server/src/trading/TradingExecutionGuard.ts),
`submitReduceOnly` still relabels **every** failure as
`TradingExhaustionError({ reason: "budget_exhausted" })` — the pre-reconcile
(~line 293), the `submitOrder` call (~line 330), and the post-reconcile
(~line 348). This is the exact mislabel from the incident, and it survives despite
the `ReduceOnlyError` union added at the top of the file.

Change `submitReduceOnly`'s error channel to `ReduceOnlyError` and pass
`TradingExecutionError` (including `preview_rejected` with its checklist item) and
`TradingReconciliationError` through unchanged. Reserve `TradingExhaustionError`
for genuine §16.4 verdicts (`guardAction`, `close_did_not_flatten`). Then follow the
type errors outward: the reactor's dispatch of `reduce`/`close` and the MCP tool's
`detail` rendering must surface the true cause to the agent. The agent's `detail`
string is an operating instruction — treat its accuracy as a correctness requirement.
Update `TradingExecutionGuard.test.ts` to pin the pass-through (a preview rejection
surfaced from `reduceOnlySized` must NOT arrive as `budget_exhausted`).

### R3. Tool guidance: `limitPrice` must be a real crossing price

`trading_request_entry`'s description in
[tools.ts](../../apps/server/src/mcp/toolkits/trading/tools.ts) was expanded to cover
the action lifecycle but still says nothing about pricing. Fix at the description
layer, not the schema (the schema's `limitPrice > 0` refusal is correct — a
marketable IOC with no limit bound is unbounded slippage): state that
`marketable_ioc` requires an explicit limit price on the crossing side of the book —
"buy: at or above best ask; sell: at or below best bid; `limitPrice <= 0` is
rejected" — so the model stops trying `limitPrice: 0` as market semantics.

## Verification expectations

- `cd apps/server && npx vitest run` (the root `--project` filter does not resolve
  workspaces). Baseline as of this prompt: 227 files, 2015 passed / 10 skipped, 0 failed.
- Regression narrative that must hold end-to-end: open via IOC entry (record goes
  `filled` at submit), a grouped stop rests as a trigger order, then a `reduce` at
  sequence 2 passes preview item 16 and reaches the exchange.
- Re-run `HyperliquidReconciler.test.ts`, `TradingFillReconciler.test.ts`,
  `ExecutionReactorLoop.test.ts`, `TradingExecutionGuard.test.ts` after R1/R2.

## Boundaries

- Testnet only; never widen the signer/arming model.
- Do not weaken the mandatory-stop gate, the §16.2 loss-budget equations, or the
  §16.4 blocked-mission no-auto-resume rule.
- Reconciliation doctrine: DB records what we did; the exchange is the authority on
  what is true. Settlements derive only from canonical reads (`trading_fills` from
  `userFills`, canonical `frontendOpenOrders`), never from local hints.
- Do not give the agent the user's deterministic controls; no new exchange-writing
  tool surfaces.

## Operator notes (context, not work items)

- The Stop Market trigger at 1851.8 seen in the Hyperliquid UI is the mission's
  mandatory protection, placed with the entry. Cancelling it by hand leaves the
  position unprotected until the next protection reconcile; the reactor escalates
  to §17.5 (mission blocked) when protection cannot be confirmed, rather than
  re-placing silently. Prefer closing the position over cancelling its stop.
- Trigger orders ARE visible to the harness: `trading_get_open_orders` reads
  `frontendOpenOrders`, which includes trigger/stop orders with their reduce-only
  and trigger fields.
- Separately scoped wake-loop gaps (not this prompt): boot-time reclaim of
  non-terminal `trading_harness_runs` leases; a re-driver for pending
  `trading_event_inbox` events after the 5s×60 retry fiber dies.
