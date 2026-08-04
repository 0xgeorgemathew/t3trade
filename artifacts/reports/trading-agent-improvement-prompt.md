# T3 Trade — trading subsystem: design assessment & improvement handoff

You are working in `/Users/george/Workspace/t3trade`, a fork of T3 Code whose trading
subsystem lets an LLM harness trade ETH perps on **Hyperliquid testnet only**. Your job is
to make the harness able to operate a full position lifecycle — enter, scale in, take
profit / scale out, exit, and switch strategies when a thesis fails or the market goes
stale — under the real operating parameters below. Everything outside
`apps/server/src/trading`, `apps/server/src/mcp/toolkits/trading`,
`packages/trading-contracts`, and `packages/hyperliquid` is upstream and out of scope.

## Operating parameters (from the operator)

- Testnet only. Live execution arms solely via the interim signer key (`InterimSignerConfig`);
  there is no second flag. Treat any armed server as placing real testnet orders.
- Each test account holds roughly **$100 USDC**.
- **Up to 20x leverage is acceptable** for testing.
- Market is ETH only for now (`TradingMarket` is a literal `"ETH"` in
  `packages/trading-contracts/src/primitives.ts`).

## Verified design map (read these before changing anything)

**Tool surface** — [`apps/server/src/mcp/toolkits/trading/tools.ts`](../../apps/server/src/mcp/toolkits/trading/tools.ts)
(declarations) and [`handlers.ts`](../../apps/server/src/mcp/toolkits/trading/handlers.ts)
(thin: capability check → `resolveBoundCall` thread↔mission binding → delegate).
Nine read tools, four watch/strategy tools, and exactly **one exchange-writing tool**:
`trading_request_entry`.

**The write path is wider than its name.** `TradingOrderIntent`
([`packages/trading-contracts/src/execution.ts`](../../packages/trading-contracts/src/execution.ts))
carries `actionType: open | scale_in | reduce | close | cancel` plus `reduceOnly`.
The reactor ([`TradingMissionReactor.ts:727`](../../apps/server/src/trading/TradingMissionReactor.ts))
routes `close` and `reduce+reduceOnly` through `TradingExecutionGuard.reduceOnlyClose`;
everything else goes through `HyperliquidExecutionService.submitOrder`. So exits ARE
agent-reachable today — but see gaps 1–3 below.

**Execution pipeline** (per `trading.execution.requested` event, in
`processExecutionRequested`): mission status `waiting|position_open → executing` →
reconcile `before_execution` → read taker fee + loss budget + order book → §16.4
exhaustion guard → preview checklist (`TradingPreviewService`, §16.3: authority version,
harness run lease, mandatory stop on increases, budget reservation, BBO freshness ≤2s) →
sign → submit → reconcile `after_submission` → confirm exchange-native reduce-only stop
against the _canonical_ position (`protectIncrease` → `TradingProtectionService`; failure
escalates to `TradingEmergencyCloseService` and blocks the mission) → re-evaluate budget →
`settleAfterExecution` reads the reconciled position to leave `executing`.

**Idempotency**: deterministic 16-byte cloid from
`(missionId, strategyVersion, executionSequence, actionType)`; execution record persisted
before signing; retries reuse cloid + idempotency key.

**Risk mandate** — [`packages/trading-contracts/src/authority.ts`](../../packages/trading-contracts/src/authority.ts).
`TradingAuthority` caps leverage, gross notional, cumulative loss, and per-position
planned risk; flags gate scale-in / partial reduction / re-entry / reversal (reversal off
by default). Loss accounting is the §16.2 six-equation budget; profits never expand the
budget; exhaustion blocks the mission (`blocked`/`cumulative_loss_limit`) and only an
explicit user resume clears it.

**Strategy & wake loop** — the harness publishes a versioned `MomentumStrategyState`
(`trading_publish_momentum_strategy`, optimistic `expectedVersion`; an accepted publish
supersedes the previous version's watches). It arms typed watches
(`price_cross`, `candle_close`, `order_update`, `position_update`,
`scheduled_reassessment`) which `WatchEvaluator.sweep` evaluates; a fired watch produces a
harness run composed by `TradingWakeupComposer`. Mission state machine is the §11.1
ten-status table in [`MissionTransitions.ts`](../../apps/server/src/trading/MissionTransitions.ts).
**Strategy switching already has a mechanism**: republish at v(n+1) with a different
`mode`/`direction`, watches re-armed — no code change needed for the mechanism itself,
only for the policy that triggers it (gap 6).

**User-side deterministic controls** (not agent tools, keep it that way) — seven controls
in [`TradingControlService.ts`](../../apps/server/src/trading/TradingControlService.ts):
pause/resume/cancel-entries/reduce-25-50-75-100/close/revoke/close+revoke, all runnable
with the provider dead.

**Auto-mission** — on an armed server every new thread gets a mission with POC authority
and the default 1m-candle ETH instruction
([`AutoMissionConfig.ts`](../../apps/server/src/trading/AutoMissionConfig.ts); capital
defaults to $50, env-overridable).

## Confirmed gaps — work items in priority order

### 1. Partial take-profit is silently a full close (correctness, do first)

`TradingExecutionGuard.reduceOnlyClose` ignores the intent's size: it always submits
`Math.abs(position.size)` as a reduce-only IOC ("Always submit the canonical position as
an IOC, regardless of caller input"). Since the reactor routes every `reduce+reduceOnly`
intent there, an agent asking to take 50% off gets flattened 100%. Scaling out is
therefore impossible today.
**Fix**: a sized reduce path — clamp requested size to `min(requested, |canonical|)`,
submit reduce-only IOC, reconcile, report remaining (the shape already exists as
`reduceBy` in `TradingControlService`). Keep `close` as the full-flatten. Add tests
mirroring `TradingControlService.test.ts`'s reduce coverage.

### 2. `reduce` with `reduceOnly:false` and `cancel` intents are hazards

A `reduce` intent with `reduceOnly:false` falls through to `submitOrder` as a plain order:
not reduce-only on the wire, no stop required (`isPositionIncreasing('reduce')` is false),
so an oversized "reduce" can cross through flat into an unprotected reversal — which
`allowDirectionReversal:false` is supposed to forbid. `actionType:"cancel"` is accepted by
the schema but has no meaningful path through `submitOrder`.
**Fix**: force `reduceOnly:true` on any `reduce` intent at the reactor (or reject
`reduceOnly:false` reduces at preview), and either wire `cancel` to
`execution.submitCancel` by cloid or reject it with a clear detail string.

### 3. Agent cannot cancel its own resting entry order

A `resting_limit` entry that goes stale can only be cancelled by the _user_ control
`cancel_entries`. The agent's only recourse is to leave it resting. This blocks the
"switch strategies if failed/stale" behaviour: superseding a strategy does NOT cancel
resting exchange orders placed under the old one (verify this — if a publish leaves old
entry orders live on-exchange, that is itself a finding).
**Fix**: an agent-reachable cancel (via gap 2's `cancel` actionType or a new
`trading_cancel_order` tool taking a cloid), going through §17.3
`cancelEntriesWithProtection` semantics when the parent is partially filled.

### 4. Authority defaults make $100 accounts nearly untradeable

`pocAuthorityDefaults`: 3x leverage, gross notional 3× capital, cumulative loss 10% of
capital, planned risk per position **2% of capital**. On $100 that is $2 planned risk per
position — after the 5 bps/side fee estimate and 25 bps stop-slippage reserve on the
notional, almost nothing remains for actual stop distance; entries will be refused as
unviable or forced into stops so tight they're noise.
**Fix**: a testnet authority preset (env-overridable like the other
`T3_TRADES_AUTO_MISSION_*` knobs) suited to $100/20x: `maximumLeverage: 20`,
`maximumGrossNotionalUsd` sized to isolated-margin reality (~$100 margin supports up to
$2000 notional at 20x, but pick something the loss budget can actually protect —
$500–$1000 is saner), `maximumCumulativeLossUsd` ~$30–50, and
`maximumPlannedRiskPerPositionUsd` ~$5–10. Confirm ETH testnet max leverage via
`trading_resolve_market` before hardcoding 20. Do the sizing math in the PR description.

### 5. No native take-profit; no way to move a stop

`OrderMapper` only emits `tpsl:"sl"`. `takeProfitPrice` and `trailingMethod` in the
strategy schema are prose — nothing places or maintains them. Take-profit today means:
arm a `price_cross` watch, wake, submit a reduce — workable and arguably the right
LLM-in-the-loop design, but only once gaps 1 and 6 are fixed. Moving a stop (trailing,
break-even) has **no path at all**: protection is placed once at entry.
**Fix (choose deliberately, in this order of preference)**:
(a) a stop-modify path — cancel-and-replace the protection order with the
`TradingProtectionService` confirm-against-canonical discipline, exposed as a small agent
tool; (b) optionally, a native `tpsl:"tp"` grouped child at entry when the strategy names
a takeProfitPrice. Keep the invariant: every increase carries a confirmed reduce-only
stop; a stop replacement must confirm the new stop before cancelling the old one.

### 6. Missions can go deaf while holding a position (the known design gap)

Nothing forces a run that ends with an open position to leave a watch that can actually
fire on the profitable side, nor any reassessment. Observed live: position open, only a
downside `candle_close` armed, price ran 25 points in favour, harness never woke. The
prior handoff deliberately left this as a policy call — **make the call now**:
enforce at run-settlement (turn coordinator or reactor) that a mission in `position_open`
has (a) at least one armed watch on each side of the current mark, OR (b) a
`scheduled_reassessment` within a floor (suggest 5–15 min on the 1m default timeframe).
If missing, auto-register the reassessment and log it — do not block the settlement.
This same floor is your staleness backstop: a reassessment wake where nothing has changed
is the harness's cue to republish (switch mode, widen levels, or abandon), which the
versioned-publish mechanism already supports.

### 7. Tool-description polish (cheap, do alongside the above)

- `trading_request_entry`'s name and description hide that it also expresses exits and
  scale-ins. After gaps 1–2, rewrite the description to enumerate the actionTypes and when
  each is legal; state plainly that reduce/close need no stop but increases always do.
- `trading_publish_momentum_strategy` was once rejected because the model omitted the
  required `description` on `entryPlan.conditions[]`
  ([`strategy.ts:52`](../../packages/trading-contracts/src/strategy.ts)). Name that
  requirement in the tool description rather than loosening the schema.
- Consider stating in `trading_register_watch`'s description that watches do NOT survive a
  strategy publish (superseded) — the agent must re-arm after switching.

## Verification expectations

- Every behavioural change lands with tests in the owning `*.test.ts`. Monorepo quirk:
  `cd` into the package (`apps/server`, `packages/trading-contracts`,
  `packages/hyperliquid`) and run `npx vitest run` — the root `--project` filter does not
  resolve these workspaces. Baseline at `fe092c004`: server 2000 passed / 9 skipped,
  contracts 95, hyperliquid 129 / 16 skipped. `tsc` clean except a pre-existing
  `HostPowerMonitor.ts:69` error, which is not yours.
- Reconciliation invariants are non-negotiable: DB records what we did, exchange is the
  authority on what is true; every acknowledged increase must have a confirmed
  exchange-native reduce-only stop sized to the canonical position; §18.2's eight
  reconcile triggers stay wired (two were reachable only through the follow loop fixed in
  `a50af0292` — re-verify after your changes).
- If you touch the reactor's execution path, re-run
  `TradingFillReconciler.test.ts` and `ExecutionReactorLoop.test.ts` and confirm the
  follow-retarget behaviour still passes — it pins the Bug-1 fix.
- For an end-to-end sanity pass on testnet: arm the interim signer, let auto-mission bind
  a fresh thread, and drive one full cycle — enter with stop, partial take-profit at a
  `price_cross` wake, trail or re-stop, close, republish a different mode, confirm the old
  watches read `superseded` and old resting orders are gone from
  `trading_get_open_orders`.

## Boundaries

- Do not give the agent the user's deterministic controls; the
  seven `TradingControlService` buttons must keep working with the provider dead.
- Do not weaken the mandatory-stop gate, the loss-budget equations, or the
  blocked-mission resume rule (§16.4: no auto-resume).
- Testnet only; never widen the signer/arming model.
- One exchange-writing surface: extend `trading_request_entry`'s intent handling (plus a
  narrow cancel/stop-modify) rather than sprouting parallel write tools.
