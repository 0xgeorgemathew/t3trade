# T3 Trade — trading subsystem handoff

Scope of this brief: the agent-facing tool surface, position/order reconciliation,
and the mission harness loop. Everything outside `apps/server/src/trading`,
`apps/server/src/mcp/toolkits/trading`, `packages/trading-contracts`, and
`packages/hyperliquid` is upstream T3 Code and is not your problem.

Running against **Hyperliquid testnet only**. Live execution is armed solely by the
presence of an interim signer key — there is no second flag. A server started with
the key present places real orders.

---

## 1. The tool surface the agent actually sees

Two files define it, and they are the right place to start:

| File                                                                                                            | What it holds                                                    |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`apps/server/src/mcp/toolkits/trading/tools.ts`](apps/server/src/mcp/toolkits/trading/tools.ts) (295 ll)       | Tool declarations — names, schemas, descriptions the model reads |
| [`apps/server/src/mcp/toolkits/trading/handlers.ts`](apps/server/src/mcp/toolkits/trading/handlers.ts) (507 ll) | Handlers; the boundary between model input and the services      |
| [`packages/trading-contracts/src/tools.ts`](packages/trading-contracts/src/tools.ts)                            | Shared request/response schemas for the above                    |

Currently registered, grouped by what they do:

**Read** — `trading_get_mission`, `trading_get_account_state`, `trading_get_position`,
`trading_get_open_orders`, `trading_get_market_snapshot`, `trading_get_market_history`,
`trading_get_order_book`, `trading_resolve_market`, `trading_list_watches`

**Write** — `trading_request_entry`, `trading_register_watch`, `trading_cancel_watch`,
`trading_schedule_reassessment`, `trading_publish_momentum_strategy`

Note the asymmetry: exactly one tool can move money (`trading_request_entry`). Exit and
risk reduction are _not_ agent tools — they are the seven deterministic controls in
[`TradingControlService.ts`](apps/server/src/trading/TradingControlService.ts), which run
with the provider process stopped. Keep that boundary when adding tools.

## 2. Reconciliation — the part to read most carefully

The invariant: the database records what we _did_; the exchange is the authority on what
is _true_. Position size, fills, and resting orders are always read back.

| File                                                                                          | Role                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`HyperliquidReconciler.ts`](apps/server/src/trading/HyperliquidReconciler.ts) (542 ll)       | The read-back itself. Pulls position, open orders, fills into `ReconciledState` and writes the canonical tables. **Densest file in the subsystem.**   |
| [`TradingFillReconciler.ts`](apps/server/src/trading/TradingFillReconciler.ts) (123 ll)       | `follow(mission)` — three forked loops: fill stream, WS reconnect, and a 5s periodic backstop. All scoped to the caller.                              |
| [`TradingProtectionService.ts`](apps/server/src/trading/TradingProtectionService.ts) (423 ll) | Every acknowledged increase must have a confirmed exchange-native reduce-only stop, sized against the **canonical** position, not the submitted size. |

Spec §18.2 defines eight reconciliation triggers (`server_startup`, `websocket_reconnect`,
`before_execution`, `after_submission`, `after_fill`, `after_position_update`,
`before_resuming_paused_mission`, `periodic_while_position_open`). Worth verifying each is
still wired — two of them were reachable only through the follow loop that Bug 1 below broke.

## 3. The harness loop

[`TradingMissionReactor.ts`](apps/server/src/trading/TradingMissionReactor.ts) (1017 ll) is
the centre of gravity — mission lifecycle, wake dispatch, and the follow-retarget loop.
Read it before anything else in this section.

Supporting cast:

- [`WatchEvaluator.ts`](apps/server/src/trading/WatchEvaluator.ts) (520 ll) — sweeps armed
  watches and decides what fires. Five watch types: `price_cross`, `candle_close`,
  `order_update`, `position_update`, `scheduled_reassessment`.
- [`TradingWatchService.ts`](apps/server/src/trading/TradingWatchService.ts) — arm/cancel/persist.
- [`TradingTurnCoordinator.ts`](apps/server/src/trading/TradingTurnCoordinator.ts) — serialises agent turns.
- [`TradingWakeupComposer.ts`](apps/server/src/trading/TradingWakeupComposer.ts) — builds the
  snapshot handed to the agent on wake.
- [`TradingEventInbox.ts`](apps/server/src/trading/TradingEventInbox.ts) — useful for debugging;
  if a mission looks deaf, check whether anything ever landed here.

---

## 4. Bugs found (fixed, commit `a50af0292`) — worth re-reviewing

Both were found from a live session where a position was opened at 1833.9, price climbed
to 1859.5, and the harness did nothing at all.

**Bug 1 — the follow loop pinned to the first mission it ever saw.**
`TradingMissionReactor` started `TradingFillReconciler.follow`, set `started = true`, and
exited the loop. A mission rotation (one revoked, a successor taking over in the same
instant) left the _revoked_ mission followed forever. The live mission inherited none of
§18.2 — no `after_fill`, no reconnect convergence, no periodic backstop — so its position
snapshot was written once at entry and never again. Symptoms were a UI card frozen at
Mark == Entry with $0.00 P&L, and endless `periodic_while_position_open` log spam from a
dead mission that was also writing the live position into its own snapshot row.

Fix re-reads the active mission each tick and retargets, each `follow` owning a `Scope` so
old subscriptions actually stop. Pinned by
[`TradingFillReconciler.test.ts`](apps/server/src/trading/TradingFillReconciler.test.ts).

**Bug 2 — two published watch types were evaluated by nothing.**
`order_update` and `position_update` are members of the `MarketWatch` union, the agent can
arm them, and `causeForWatch` maps them to run causes — but `WatchEvaluator.sweep` only
handled `price_cross` and `scheduled_reassessment`. The watch sat `active` forever. The
agent had told the user "any position or order update also wakes it", which was false.

Now evaluated against the reconciled tables, firing on _change_ rather than first sight.

**Open design gap — not a bug, needs a decision.**
A mission can hold a live position with no watch that can ever fire. In the observed
session the agent armed only a downside `candle_close` and a `position_update` that
correctly never fired (size unchanged; only the mark moved). No upside watch, no
`scheduled_reassessment`. Suggested guardrail: refuse to end a run holding an open
position unless at least one armed watch can fire on the profitable side, or enforce a
mandatory reassessment floor. Deliberately left unimplemented — it is a policy call.

**Minor, unfixed by choice.** `trading_publish_momentum_strategy` rejected a call because
`description` is required on each `entryPlan.conditions[]` entry
([`strategy.ts:52`](packages/trading-contracts/src/strategy.ts)). The schema is right to
insist and the error named the exact path; the model simply omitted it. Possibly a tool-description
problem rather than a schema one.

---

## Running the suites

Monorepo quirk: `cd` into the package and run `npx vitest run`. The root `--project` filter
does not resolve these workspace names.

Baseline as of `fe092c004`: server 2000 passed / 9 skipped, contracts 95, hyperliquid 129 /
16 skipped. `tsc` is clean apart from a pre-existing `HostPowerMonitor.ts:69` error unrelated
to trading.
