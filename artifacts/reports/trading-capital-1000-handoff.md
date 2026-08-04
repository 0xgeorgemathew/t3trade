# T3 Trade — resolve mission capital from the live account, not a hardcoded default

You are working in `/Users/george/Workspace/t3trade` (fork of T3 Code; LLM harness trades
ETH perps on **Hyperliquid testnet only**). The operator keeps **1,000 USDC (perps)** in
the testnet account, and that number may change — nothing about it should be hardcoded.

**Design intent, stated by the operator — follow it, do not "improve" it:**

- The agent should _know_ what balance is actually available and manage risk itself.
- The available balance is **information, not a gate**. Do not add balance checks that
  refuse or clamp position opening. Risk management is deferred to the agent, bounded
  only by the mandate rails that already exist — which the operator adjusts explicitly
  (env knobs) when they want different bounds.
- Capital must be **dynamically resolved** from the account. An explicitly specified
  value (env var, form input) always wins, verbatim — no clamping against the balance.

## What already works (verified in code — do not rebuild)

Agent awareness of the balance already exists end-to-end:

- Every wakeup carries a fresh `accountSnapshot` — `accountValue`, `marginUsed`,
  `withdrawable` — read live from the exchange
  ([TradingWakeupComposer.ts](../../apps/server/src/trading/TradingWakeupComposer.ts) ~line 134).
- The agent can re-read it any time via the `trading_get_account` MCP tool
  ([handlers.ts](../../apps/server/src/mcp/toolkits/trading/handlers.ts) ~line 377).
- `HyperliquidGateway.getAccountSnapshot(masterAddress)` is the single read behind both
  ([Gateway.ts](../../packages/hyperliquid/src/Gateway.ts) ~line 361).

## The actual problem

`allocatedCapitalUsd` — the number the whole mandate scales from — is hardcoded:

- Auto-missions: `AUTO_MISSION_DEFAULT_CAPITAL_USD = 50` in
  [AutoMissionConfig.ts](../../apps/server/src/trading/AutoMissionConfig.ts), used
  whenever `T3_TRADES_AUTO_MISSION_CAPITAL_USD` is unset.
- Manual missions: `DEFAULT_CAPITAL_USD = 50` in
  [NewMissionForm.tsx](../../apps/web/src/components/trading/NewMissionForm.tsx).

`createMission` ([TradingMissionService.ts](../../apps/server/src/trading/TradingMissionService.ts)
~line 347) feeds it to `resolveTestnetAuthority` →
`testnetAuthorityDefaults(C)` ([authority.ts](../../packages/trading-contracts/src/authority.ts)):
leverage ≤ 20, gross notional ≤ 8×C, cumulative loss ≤ 0.35×C, per-position risk
≤ 0.07×C. With the $50 default against a $1,000 account, the agent is boxed into a
$400 notional cap and a $17.50 loss budget by a stale constant — deterministic rails
overriding agent judgment for no reason the operator chose.

## Work items, in order

### 1. Default mission capital to the live account value

At mission creation, when no capital was explicitly specified:

- Read `getAccountSnapshot(masterAddress)` (master address via
  `TradingMissionService.getMasterWalletAddress`; the reactor already has the gateway
  in scope — prefer wiring there over adding a gateway dependency to
  `TradingMissionService` if that keeps the layering cleaner).
- Use `accountValue` as `allocatedCapitalUsd`, and log what was resolved.
- If the snapshot is unreadable, fall back to the existing default with a clear
  warning log — **do not block mission creation**. A dead info endpoint should not
  stop a testnet lab from starting; the warning is the operator's cue.

Precedence, explicitly:

1. `T3_TRADES_AUTO_MISSION_CAPITAL_USD` set (or a form-entered value) → use verbatim.
   No clamping against the balance in either direction — an operator who declares
   5,000 against a 1,000 account gets 5,000, because explicit means explicit.
2. Otherwise → live `accountValue` at creation time.
3. Otherwise (snapshot unreadable) → the current default constant, with a warning.

Resolution happens once, at creation. The mandate does not silently re-scale mid-
mission when the balance moves — the agent sees balance changes through the wakeup
`accountSnapshot` and adapts its own sizing; the mandate is the operator's grant.

### 2. Prefill the New Mission form from the live balance

Replace the meaning of `DEFAULT_CAPITAL_USD = 50`: prefill the capital field from the
account balance (via an existing account/status read if the web app has one, or a thin
endpoint), keep the field fully editable, and make an empty field mean "resolve from
the account at creation" (item 1's path) rather than silently submitting 50. Show
which happened — "using account balance" vs the entered number — so the operator can
tell an explicit grant from a resolved one.

### 3. Make sure the agent can tell mandate from balance

The wakeup already contains both `authority` (the mandate) and `accountSnapshot` (the
live balance). Check the harness-facing descriptions (`trading_get_mission`,
`trading_get_account`, and the wakeup composer's instruction text if it explains
sizing) and make the distinction explicit where it isn't: the mandate numbers are the
operator's hard rails; `accountSnapshot.withdrawable` is what is actually free right
now; sizing decisions inside the rails belong to the agent. One or two sentences —
this is a description-layer change, not new machinery.

### 4. Tests

- `AutoMissionConfig` / creation-path tests: explicit env value used verbatim (even
  when larger than the stubbed balance); unset → stubbed `accountValue`; unreadable
  snapshot → default + warning, creation still succeeds.
- Pin `testnetAuthorityDefaults(1000)` derived values in `authority.test.ts`
  (gross $8,000, cumulative loss $350, per-position risk $70) so the scaling at the
  current funding level is a conscious, visible number.
- Existing recording-gateway patterns in `HyperliquidReconciler.test.ts` show how to
  stub `getAccountSnapshot`.

## Verification expectations

- `cd apps/server && npx vitest run` (root `--project` does not resolve workspaces).
  Baseline as of 2026-08-03: 227 files, 2015 passed / 10 skipped, 0 failed. Run
  `packages/trading-contracts` tests too after touching authority tests.
- Manual: with no capital env set and the funded account, create a mission and
  confirm the mission card shows capital ≈ 1,000 and a $350 loss budget; set
  `T3_TRADES_AUTO_MISSION_CAPITAL_USD=200` and confirm 200 is used verbatim.

## Boundaries

- Testnet only; never widen the signer/arming model.
- **No new hard gates.** This work changes where the capital _number_ comes from and
  what the agent is told — it must not add balance-based refusals, clamps, or margin
  pre-checks to preview or submit.
- Do not weaken the mandatory-stop gate, the §16.2 loss-budget equations, or the
  §16.4 blocked-mission no-auto-resume rule. The mandate ratios in
  `testnetAuthorityDefaults` stay as they are; the operator changes bounds via the
  `T3_TRADES_AUTHORITY_MAX_*` env knobs, not by editing ratios here.
- The working tree carries uncommitted fixes (execution lifecycle, protection,
  watches, testnet authority preset). Build on top; do not revert.
- Related but separately scoped (do not bundle): remaining items in
  `artifacts/reports/trading-execution-lock-fix-prompt.md`.
