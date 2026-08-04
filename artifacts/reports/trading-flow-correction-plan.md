# T3 Trade — trading-flow correction plan

Execution agent instructions. Repo: `/Users/george/Workspace/t3trade`. Scope:
`apps/server/src/trading`, `apps/server/src/mcp/toolkits/trading`,
`packages/trading-contracts`, `packages/hyperliquid`, and the named
`apps/web/src/components/trading` files. Testnet only; never widen the
signer/arming model; the user's deterministic controls in
`TradingControlService.ts` must keep working with the provider dead. Fix
optimistically where the correct behaviour is stated below; where a task says
"decide", pick the simpler option and note it in the commit message.

Test baseline: `cd` into each package and run `npx vitest run` (the root
`--project` filter does not resolve these workspaces). `tsc` is clean except a
pre-existing `HostPowerMonitor.ts:69` error, which is not yours. Every
behavioural change lands with tests in the owning `*.test.ts`.

---

## Step 1 — the wake loop: a mission must never go silent

### 1.1 Extend the staleness floor to flat missions with an active strategy

- **Where:** `TradingTurnCoordinator.ts` `ensureNotDeaf` (~line 257); the early
  return `if (position === undefined) return;` at ~line 266.
- **Change:** when flat, do not return. If the mission has an active published
  strategy and is in an operative status (check `MissionTransitions.ts`),
  require a `scheduled_reassessment` due within `WATCH_COVERAGE_FLOOR_MILLIS`
  (`packages/trading-contracts/src/watch.ts:91`); if none, auto-arm one at
  `now + floor`, reusing the existing `coversByReassessment` check so
  duplicates never stack. Flat with no active strategy: no floor. Position-open
  behaviour unchanged. Tag the auto-armed watch so the wakeup can say
  `wakeReason: "staleness_floor"` (see 4.2).
- **Expected:** a flat mission with a live thesis wakes at least once per floor
  interval even when no trigger crosses; a mission with no thesis stays quiet.
- **Verify:** unit tests beside `TradingWatchCoverageFloor.test.ts` /
  `TradingTurnCoordinator.test.ts`: flat+strategy+no reassessment → one armed;
  flat+no strategy → nothing; already-armed future reassessment → no duplicate.
  End-to-end: publish a strategy with unreachable triggers on testnet and
  confirm an unprompted wake within ~10 min.

### 1.2 Route user messages on a bound thread through the coordinator

- **Where:** `TradingTurnCoordinator.requestRun` has a `user_message` cause in
  the contract (`mission.ts:88-96`) that no call site ever produces; a user
  typing in a bound thread takes the ordinary turn path with no wakeup snapshot
  and no decision lease.
- **Change:** when a user message arrives on a thread bound to an operative
  mission, request a run with cause `user_message` (carrying the text in the
  wakeup's `userMessage` field, which already exists) instead of the bare turn.
- **Expected:** an operator message gets the same fresh
  market/account/strategy context as any other wake, and cannot race a
  watch-fired run for the lease.
- **Verify:** coordinator test asserting the cause and the `userMessage`
  passthrough; on testnet, type into a bound thread and confirm the turn's
  first message is a wakeup JSON with `cause: "user_message"`.

### 1.3 Persist the differential-watch baseline

- **Where:** `WatchEvaluator.ts:257,346` — module-scope `lastDelivered` /
  `lastObserved` Maps; `fireOnChange` (~:361) returns early when
  `previous === undefined`, so the first position/order change after a server
  restart is silently swallowed.
- **Change:** persist the baseline signature per watch (a column on the
  persisted watch row or a small table), seeded at registration, so restart
  does not reset it.
- **Expected:** a `position_update`/`order_update` watch fires on the first
  real change after a restart.
- **Verify:** unit test: observe → simulate restart (new evaluator instance,
  same DB) → change → fires exactly once.

---

## Step 2 — execution feedback: every action gets a truthful answer

### 2.1 Give `cancel` and `modify_stop` a real outcome

- **Where:** `TradingMissionReactor.ts:934-950` routes `cancel` →
  `cancelRestingOrder` and `modify_stop` → `modifyStop`; neither path writes a
  `trading_execution_records` row (the only INSERT is
  `HyperliquidExecutionService.ts:220`, submitOrder-only), so
  `TradingExecutionOutcome.awaitOutcome` polls for the full 20 s
  (`TradingExecutionOutcome.ts:41`) and returns an ambiguous
  `status: "submitted"` even on success.
- **Change:** on success/failure of these two paths, either persist an
  execution record with the terminal status, or return the outcome to the tool
  result directly without going through `awaitOutcome`. Pick whichever is
  smaller; the result must state succeeded/failed and, for `modify_stop`, the
  confirmed new stop price.
- **Expected:** a successful cancel or stop-move returns in seconds with an
  unambiguous result; no 20-second stall.
- **Verify:** reactor/outcome unit tests for both action types;
  `ExecutionReactorLoop.test.ts` still green.

### 2.2 Stop reporting `cancelled`/`failed` records as `accepted`

- **Where:** `TradingExecutionOutcome.ts:145` —
  `status: record.status === "rejected" ? "rejected" : "accepted"`.
- **Change:** map record status honestly onto the wire status (extend
  `TradingRequestEntryResult` in `packages/trading-contracts/src/tools.ts` if
  the union is too narrow).
- **Expected:** the harness never sees `accepted` for an execution that was
  cancelled or failed.
- **Verify:** unit test per record status.

### 2.3 Name the blocking execution in `no_conflicting_execution_pending`

- **Where:** `TradingPreviewService.ts:340-346`; pending query at
  `TradingMissionReactor.ts:891-895`.
- **Change:** when the item rejects, include the blocking record's cloid,
  actionType, status, and age in the rejection detail, and surface the same
  in-flight summary in `trading_get_mission`.
- **Expected:** a lock rejection tells the agent exactly what is blocking and
  how stale it is, instead of a bare item name.
- **Verify:** preview test asserting the detail fields.

### 2.4 Settle stranded execution records regardless of position

- **Where:** `TradingFillReconciler.ts:110-112` gates the 5 s periodic
  reconcile on an open position, so `accepted`/`submitted` records on a
  flat mission sit until the next server start
  (`settleAcceptedExecutions` / `settleAbandonedExecutions`,
  `HyperliquidReconciler.ts:409-546`, only run inside `reconcile`).
- **Change:** when the position is flat, still run the settlement pass if any
  non-terminal execution records exist for the followed mission (a cheap
  count query; keep the full reconcile position-gated).
- **Expected:** no execution record can park in a non-terminal status for more
  than ~one settlement interval after the exchange has resolved it.
- **Verify:** reconciler test: flat mission + stranded `accepted` record →
  settled on the next pass.

### 2.5 Fix the remaining `budget_exhausted` mislabels and report remaining size

- **Where:** `TradingExecutionGuard.ts:200-204` and `:235-239` wrap a SQL read
  failure and a transition failure as `reason: "budget_exhausted"`; the guard
  computes `remainingSize` (~:329-333) but the reactor discards it
  (`TradingMissionReactor.ts:936`) and the result schema has no field, while
  the tool description promises "reports what remains" (`tools.ts:277`).
- **Change:** give those two failures honest reasons (infra/transition, not
  budget); add `remainingSize` to `TradingRequestEntryResult` and thread it
  through for `reduce`/`close`.
- **Expected:** `budget_exhausted` means the budget is exhausted, nothing
  else; a reduce ack states what remains.
- **Verify:** guard unit tests for both failure paths; handler test asserting
  `remainingSize` on a reduce.

---

## Step 3 — exchange truth: external actions must be seen, attributed, and escalated

### 3.1 Classify external position changes and wake the mission

- **Where:** `HyperliquidReconciler.ts` `persistPosition` (~:266-274) blanks
  the snapshot when the exchange says flat; `settleFlatPosition`
  (`TradingMissionReactor.ts:1199-1221`) then moves `position_open → waiting`
  with no harness wakeup and no attribution anywhere.
- **Change:** when reconcile observes a position change with no corresponding
  mission execution record (fill under a mission cloid), write an inbox event
  (`TradingEventInbox`) classifying it — `external_close`, `external_reduce`,
  `external_increase` — with before/after size, and request a run so the
  harness wakes with the event in `pendingEvents`. Same for a balance jump
  beyond fills/fees: an `external_transfer` event (information only; do not
  re-scale the mandate mid-mission).
- **Expected:** closing a position in the Hyperliquid UI produces a wake
  within one reconcile interval whose pending events say
  `external_close`, and chat/logs/state all agree on what happened.
- **Verify:** reconciler unit test with a mocked snapshot diff; on testnet,
  hand-close a position and confirm the wake and the event text.

### 3.2 Protection watchdog: an externally cancelled stop must escalate

- **Where:** `confirmedProtectedSize` is computed and persisted
  (`HyperliquidReconciler.ts:580-585`) but nothing compares
  `protected_size` to `size` outside an execution; protection is only
  reconciled on entry, `modify_stop`, and cancel-with-protection. A stop
  pulled in the exchange UI leaves the position naked indefinitely.
- **Change:** in the periodic reconcile (position open), when
  `protected_size < size`, write a `protection_lost` inbox event and invoke
  the existing protection escalation (re-place the stop via
  `TradingProtectionService`; if it cannot confirm, the existing
  emergency-close escalation applies). Wake the mission.
- **Expected:** cancelling the stop by hand results, within seconds, in a
  re-placed stop (or emergency close), a logged event, and a harness wake —
  never a silently naked position.
- **Verify:** reconciler test for the comparison + escalation call; testnet:
  hand-cancel the stop and watch it re-appear.

### 3.3 Graceful unbound-thread reads

- **Where:** `resolveBoundCall` (`handlers.ts:46-83`) fails every tool —
  including pure market reads that discard the binding — the moment the
  mission goes terminal, because `findMissionByThreadId`
  (`TradingMissionService.ts:302-306`) excludes `revoked`/`completed`.
- **Change:** for the read-only tools (`trading_resolve_market`,
  `trading_get_market_snapshot`, `trading_get_market_history`,
  `trading_get_order_book`, `trading_get_mission`), let an unbound thread
  through: market reads work normally; `trading_get_mission` returns a
  structured "unbound" result carrying the last mission bound to this thread,
  its terminal status, and — if a newer active mission exists — that mission's
  id. Write tools keep rejecting with `thread_not_bound_to_mission`.
- **Expected:** after a mission ends, the agent can still read the market and
  learn what happened and where the live mission went, instead of every tool
  erroring.
- **Verify:** handler tests: each read tool on an unbound thread succeeds;
  each write tool still rejects; the unbound `trading_get_mission` payload
  shape.

---

## Step 4 — tool contract accuracy and wakeup context

### 4.1 Make IOC pricing honest and configurable

- **Where:** `tools.ts:281-282` claims the agent's `limitPrice` is the
  slippage bound; the wire ignores it —
  `OrderMapper.ts:123-126` derives the IOC limit from BBO ×
  `allowedSlippageBps`, hardcoded `50` at `TradingMissionReactor.ts:927`; the
  deterministic exit path uses a second hardcoded `100`
  (`HyperliquidExecutionService.ts:180`).
- **Change:** (a) keep server-derived IOC pricing, but move both constants to
  one config point (env `T3_TRADES_IOC_SLIPPAGE_BPS`, default 50; exit path
  default 100) following the `AutoMissionConfig.ts` knob pattern; (b) return
  the actually-placed limit price and average fill price in the execution
  result; (c) rewrite the `trading_request_entry` description to state that
  for `marketable_ioc` the server prices the crossing limit from BBO and the
  agent's `limitPrice` feeds only preview arithmetic, and that the exchange
  UI's "Price" column shows this limit bound, not the fill.
- **Expected:** the agent's loss model matches reality; the constant ~0.5 %
  gap between reported fills and the Hyperliquid UI price column is explained
  in the tool contract.
- **Verify:** mapper/config unit tests; handler test asserting the placed
  limit price appears in the ack.

### 4.2 Enrich the wakeup snapshot (bounded)

- **Where:** `TradingWakeupComposer.ts:143-157`, schema
  `packages/trading-contracts/src/wakeup.ts:46-79`.
- **Change:** add: the full active-watch list with, for each
  `price_cross`/`candle_close`, distance from current mark in USD and bps;
  `strategyAgeMillis`; `wakeReason: "staleness_floor"` when the triggering
  reassessment was auto-armed (tag from 1.1); and the classified external
  events from 3.1/3.2 already flowing via `pendingEvents`. Remove the
  `sparkline` field entirely — the gateway always returns `[]`
  (`Gateway.ts:163`) and nothing fills it. Do not add candle arrays.
- **Expected:** a woken agent knows what is armed, how far away each trigger
  is, how old its thesis is, and why the runtime woke it, without extra tool
  calls.
- **Verify:** composer unit tests for each new field; schema round-trip test.

### 4.3 Tool-description truth pass

- **Where:** `tools.ts`.
- **Change:** in one pass, document: the pending-execution lock and its
  rejection item (`no_conflicting_execution_pending`), plus `mission_active`,
  `strategy_version_current`, and `market_is_eth` in the validation list; that
  `trading_get_market_history` caps at 500 bars (~8h20m on 1m) and supports
  `startTime`/`endTime` paging; that watches fire exactly once and must be
  re-registered for standing levels, the 2 s sweep interval, and that
  `position_update`/`order_update` read reconciled local tables; the
  `modify_stop` pre-refusal for unreachable prices and its
  emergency-close escalation; the staleness floor from 1.1 (an unprompted
  reassessment wake is the cue to republish or stand down); minimum candle
  count guidance for thesis formation on the mission's timeframe.
- **Expected:** no tool description makes a claim the code contradicts.
- **Verify:** read-through against the code paths named above; update
  `handlers.test.ts` snapshots if descriptions are asserted.

---

## Step 5 — logging: reconstructable, not spammy

### 5.1 One pass over trading log emission

- **Where:** `apps/server/src/trading` (47 `Effect.log*` sites) and
  `apps/server/src/mcp/toolkits/trading`.
- **Change:**
  - Demote to debug or log-on-change: `"trading reconciled"`
    (`HyperliquidReconciler.ts:620` — currently ≥12 identical lines/min while
    a position is open); `"fired watch could not start a run"`
    (`TradingMissionReactor.ts:502` — once per blocked fire, add the retry
    count instead of repeating).
  - Add info-level, once-per-event logs for what is currently silent: mission
    created (id, capital, capital source: env/live/fallback), every `advance`
    status transition with cause (`TradingMissionReactor.ts:200-221`),
    slot-takeover and thread-settled revocations, watch fired (type + summary),
    order/cancel/stop hitting the wire
    (`submitOrder`/`submitCancel`/`submitProtectiveStop` in
    `HyperliquidExecutionService.ts` currently log nothing), preview
    rejections with the failing item, and MCP tool-call rejections
    (`thread_not_bound_to_mission` etc., currently unlogged —
    `handlers.ts`).
  - Trim `Cause.pretty` dumps (`TradingMissionReactor.ts:1103`) to the
    squashed first line at warn, full cause at debug.
- **Expected:** the log reconstructs mission lifecycle, decisions, executions,
  rejections, and wake reasons without repeating steady-state noise.
- **Verify:** run one full testnet mission and read the log end-to-end: every
  step of the expected flow appears exactly once; the 5 s loops produce no
  steady-state info lines.

---

## Step 6 — agent chat: wakeups the operator can read

### 6.1 Discriminate and render wakeup messages

- **Where:** the full wakeup JSON is injected verbatim as a user message
  (`TradingTurnCoordinator.ts:366-379`) with no `kind` discriminator
  (bootstrap has one, full wakeup does not — `wakeup.ts:46-79`); the web app
  has no renderer, so the operator sees raw JSON blobs, one per wake.
- **Change:** add `kind: "trading-harness-wakeup"` to the full wakeup schema;
  in `MessagesTimeline.tsx`/`tradingPresentation.ts`, render messages of both
  kinds as a compact one-line card (cause, market, mark, strategy version,
  pending-event count) with the JSON behind an expander. No coalescing logic;
  the volume fix is the floor and watch semantics, not throttling.
- **Expected:** a mission thread reads as a sequence of legible events, and
  the raw payload is still one click away.
- **Verify:** presentation unit test for the card derivation; visual check on
  a testnet mission thread.

---

## Step 7 — UI: small, clearly valuable

### 7.1 Fix `useMissionControls` error handling

- **Where:** `apps/web/src/components/trading/useMissionControls.ts:43-46` —
  `void send()` swallows rejections; no `refreshTradingMissions()` after a
  command; `isBusy` in the memo deps (~:73).
- **Change:** surface a failed control command (inline error state on the
  control), call `refreshTradingMissions()` on success, drop `isBusy` from the
  memo deps. Add `useMissionControls.test.ts`.
- **Expected:** a failed pause/close/revoke is visible; a successful one
  reflects in ≪3 s.
- **Verify:** the new test file; manual click-through.

### 7.2 Staleness banner: show age, and show it in the thread

- **Where:** banner only in `TradingWorkspacePanel.tsx:234-243`;
  `MissionThreadPanel.tsx` position card has no staleness indication;
  `position.observedAt` is already in the projection.
- **Change:** banner text includes "last update Ns ago"; mount the same
  banner logic in the thread cards; on a failed poll
  (`tradingMissionsState.ts:62`), show the error state in the thread strip
  too, not only the workspace.
- **Expected:** stale or frozen data is visible wherever positions are shown.
- **Verify:** extend `tradingPresentation.test.ts`.

### 7.3 Cheap prototype ports

- **Where/Change:** from the prototype
  (`/Users/george/Downloads/T3 Trades execution prototype/public/index.html`),
  port only: fill-receipt slippage % (derive from `avgFillPrice` vs intent
  limit, `MissionThreadPanel.tsx:136-157`); paused-card stat line (exposure,
  unrealised, liquidation — all already in `mission.position`,
  `TradingWorkspacePanel.tsx:181-190`); an "Open on Hyperliquid" link
  (market + testnet detection already in `tradingPresentation.ts:263-268`);
  a mission phase breadcrumb derived purely from `mission.status`
  (~30 lines in `tradingPresentation.ts` + small component). Nothing else —
  charts, equity, approval gates, sidebar redesign are out of scope.
- **Expected:** four small additive improvements, no new backend data.
- **Verify:** derivations tested in `tradingPresentation.test.ts`.

### 7.4 Operator can see what build is running

- **Where:** server version renders only inside version-mismatch banners;
  no git SHA exists anywhere (`ServerEnvironment.ts:140`,
  `SettingsPanels.tsx:343`).
- **Change:** embed a build identifier (git SHA + dirty flag) in the server
  environment at startup, log it once at boot, and show server
  version + SHA as an always-visible row in Settings → About next to
  `APP_VERSION`.
- **Expected:** any execution discrepancy can be pinned to a build.
- **Verify:** boot log line; About panel shows both versions.

---

## Step 8 — simplification and consistency

### 8.1 One source of truth for the shared status sets

- **Where:** the position-increasing set is encoded four ways
  (`TradingExecutionGuard.ts:196`, `TradingControlService.ts:304`,
  `TradingEmergencyCloseService.ts:148`, contract `isPositionIncreasing`) and
  `isPermittedUnderExhaustion` (`TradingExecutionGuard.ts:164`,
  `TradingPreviewService.ts:325`) is a fifth that omits `modify_stop`, so
  under exhaustion the guard blocks a stop move the exhaustion gate would
  allow. The pending-execution status list is triplicated
  (`TradingMissionReactor.ts:894`, `HyperliquidReconciler.ts:420`,
  `TradingExecutionOutcome.ts:76-81`).
- **Change:** move both sets to `packages/trading-contracts` (extend the
  existing `isPositionIncreasing`; add `PENDING_EXECUTION_STATUSES` and
  `isPermittedUnderExhaustion`), use them everywhere, and make
  `modify_stop` permitted under exhaustion (a stop move reduces risk).
- **Expected:** the sets cannot drift; a stop move is never blocked by
  exhaustion.
- **Verify:** contract unit tests; grep confirms no remaining hand-written
  lists.

### 8.2 Dead code and the `completed` status

- **Where:** unused `HyperliquidInfoClient` import
  (`TradingMissionReactor.ts:61`); `isSuspended` re-export
  (`MissionTransitions.ts:126`) with no consumer; the `completed` status is in
  the contract and transition table but unreachable — nothing ever sets it.
- **Change:** delete the dead import and export. For `completed`: wire it —
  when a mission with a realized result ends via thread-settled with no
  position and no error, advance to `completed` instead of `revoked`, so the
  UI's completion summary and the binding query's terminal set become
  meaningful. If wiring it touches more than the settle path, delete the
  status instead; do not leave it dead.
- **Expected:** no unreachable statuses or unused exports in the trading dirs.
- **Verify:** `MissionTransitions.test.ts` updated; tsc clean.

### 8.3 Make the one-active-mission invariant real

- **Where:** `TradingMissionService.ts:277-284` `findActiveMission` has no
  `ORDER BY`; uniqueness is enforced only by a pre-insert check (~:336-343).
- **Change:** add a partial unique index on active statuses (SQLite:
  `CREATE UNIQUE INDEX ... WHERE status NOT IN (...)` over a constant `1`),
  and give the query a deterministic `ORDER BY created_at DESC LIMIT 1`.
- **Expected:** two active missions cannot exist; selection is deterministic.
- **Verify:** migration + service test attempting a second active insert.

---

## Final verification (after all steps)

1. Full suites green in `apps/server`, `packages/trading-contracts`,
   `packages/hyperliquid`, `apps/web`; re-run `TradingFillReconciler.test.ts`
   and `ExecutionReactorLoop.test.ts` explicitly (they pin the
   follow-retarget fix from `a50af0292`).
2. One complete testnet mission on 1m: auto-start → capital logged with
   source → candle analysis → publish (thesis from a sufficient candle set)
   → entry with stop → a `modify_stop` and a `reduce` both answered quickly
   and truthfully → close or stop-out → mission ends with the terminal status
   the UI shows. Agent chat, server log, `trading_get_mission`, and the
   Hyperliquid UI must tell the same story at every step.
3. External-action drills: hand-cancel the stop (re-placed + wake within
   seconds); hand-close the position (`external_close` wake); after mission
   end, market reads still work on the old thread and
   `trading_get_mission` reports the terminal state.
