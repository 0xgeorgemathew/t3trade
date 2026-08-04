# T3 Trade — Execution Handoff (2026-08-04)

Sequential execution only. No subagents, no parallel tasks. Every decision in this
document is final — do not re-open alternatives. Execute tasks in order; each task
ends with its own verification so a failure is caught before the next task builds
on it.

## Commands

- Typecheck: `pnpm tc` (repo root)
- All tests: `pnpm test`; scoped: `vp run --filter t3 test` (server),
  `vp run --filter @t3tools/trading-contracts test`, `vp run --filter @t3tools/web test`
- Lint: `pnpm lint`

## Root causes (established by code inspection — do not re-diagnose)

1. **Non-Codex providers fail tool calls.** All five adapters inject the _same_
   first-party HTTP MCP server (key `t3-code`): [ClaudeAdapter.ts:3552](apps/server/src/provider/Layers/ClaudeAdapter.ts),
   [CodexAdapter.ts:1422](apps/server/src/provider/Layers/CodexAdapter.ts),
   [CursorAdapter.ts:547](apps/server/src/provider/Layers/CursorAdapter.ts),
   [GrokAdapter.ts:585](apps/server/src/provider/Layers/GrokAdapter.ts),
   [OpenCodeAdapter.ts:1221](apps/server/src/provider/Layers/OpenCodeAdapter.ts).
   Tool inputs are decoded with strict Effect Schema
   (`Schema.decodeUnknownEffect` in effect 4.0.0-beta.102 `unstable/ai/Toolkit.js` line 26;
   the "Invalid parameters for tool" string is `AiError.js:871`). OpenAI/Codex emits
   exact JSON types; Claude/Cursor/Grok/OpenCode emit `"100"`, `"0"`, `"0.0"` for
   numbers and prose strings where objects are expected. The fix is server-side
   lenient decoding — never per-provider configuration.
2. **`trading_register_watch` / `trading_list_watches` result-encode failures and the
   "could not announce a registered watch" WARN.** A watch registered before the first
   strategy publish inherits `strategy_version = 0`
   ([TradingWatchService.ts:147](apps/server/src/trading/TradingWatchService.ts)), but
   `PersistedWatch.strategyVersion` requires `>= 1`
   ([watch.ts:82](packages/trading-contracts/src/watch.ts)). Result encoding and the
   orchestration announce both fail on the same schema.
3. **10-minute blind spot on a 1m strategy.** The only time-based backstop is
   `WATCH_COVERAGE_FLOOR_MILLIS = 10 min` ([watch.ts:103](packages/trading-contracts/src/watch.ts)),
   applied in `ensureNotDeaf` ([TradingTurnCoordinator.ts:302](apps/server/src/trading/TradingTurnCoordinator.ts)).
   It is not scaled by timeframe or position state. `protection.takeProfitPrice` is
   prose — nothing arms or executes it.
4. **"No provider available" after trading begins.** A live mission locks the composer
   to the mission's harness provider ([ChatView.tsx:1866-1878](apps/web/src/components/ChatView.tsx)).
   When no _selectable_ instance of that driver kind exists (disabled in Settings, or
   probe status `error` after a dead run), the composer falls back to
   `NO_PROVIDER_MODEL_SELECTION` and shows the generic strings at
   [ChatComposer.tsx:2787, 3013, 3082](apps/web/src/components/chat/ChatComposer.tsx)
   with no hint that the mission lock is the cause.
5. **Stopping a run surfaces a "Runtime error" card.** The card is the generic render
   of a `runtime.error` provider event
   ([ProviderRuntimeIngestion.ts:375-390](apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)).
   The OpenCode adapter's `session.error` handler (around
   [OpenCodeAdapter.ts:1080-1115](apps/server/src/provider/Layers/OpenCodeAdapter.ts)) sets the
   provider session to `error` and emits `runtime.error` without checking the session's
   `stopped` ref — unlike the event pump right below it (line 1158) which guards. A
   session left in `error` combines with root cause 4 to brick the composer.

## Out of scope — do not do

- No per-provider MCP wiring changes, no second transport.
- No product rebrand: `t3-code-relay` audiences, mobile slug `t3-code`,
  `T3CodeDev` Xcode names, `t3-code-git-text` / `t3-code-provider-probe` /
  ACP `clientInfo` names all stay unchanged.
- The server never auto-places take-profit orders on the exchange. Profit-target
  handling is wake-and-decide (Task 5); the agent may still place its own TP order
  via `trading_request_entry` if it judges one right.
- Ignore cosmetic improvements not listed here.

---

## Task 1 — Rename the MCP server key `t3-code` → `t3-trade`

The server key is the tool-name prefix every provider sees (`mcp__t3-trade__trading_*`
and every other first-party tool). Rename exactly these:

1. Injection sites (the string that names the MCP server):
   - [ClaudeAdapter.ts:3552](apps/server/src/provider/Layers/ClaudeAdapter.ts) — `mcpServers` key.
   - [CodexAdapter.ts:1422 and 1424](apps/server/src/provider/Layers/CodexAdapter.ts) — both
     `mcp_servers.t3-code.*` config args.
   - [CursorAdapter.ts:547](apps/server/src/provider/Layers/CursorAdapter.ts) — the MCP server
     entry `name` (NOT the `clientInfo` at line 541).
   - [GrokAdapter.ts:585](apps/server/src/provider/Layers/GrokAdapter.ts) — the MCP server entry
     `name` (NOT the `clientInfo` at line 579).
   - [OpenCodeAdapter.ts:1221](apps/server/src/provider/Layers/OpenCodeAdapter.ts) — `mcp.add({ name })`.
2. Server display name: [McpHttpServer.ts:226](apps/server/src/mcp/McpHttpServer.ts)
   `name: "T3 Code"` → `"T3 Trade"`.
3. Instruction text: [CodexDeveloperInstructions.ts:7](apps/server/src/provider/CodexDeveloperInstructions.ts)
   — change the backticked `` `t3-code` `` server reference to `` `t3-trade` ``. Leave the
   surrounding "T3 Code" product-name prose unchanged.
4. Comments that name the key: [tools.ts:6](apps/server/src/mcp/toolkits/trading/tools.ts),
   [McpHttpServer.ts:81](apps/server/src/mcp/McpHttpServer.ts),
   [handlers.test.ts:6](apps/server/src/mcp/toolkits/trading/handlers.test.ts).
5. Tests asserting the key:
   - [CodexAdapter.test.ts:579, 596, 604](apps/server/src/provider/Layers/CodexAdapter.test.ts)
   - [CodexSessionRuntime.test.ts:302, 315, 333, 342](apps/server/src/provider/Layers/CodexSessionRuntime.test.ts)
   - [session-logic.test.ts:940-986](apps/web/src/session-logic.test.ts) (tool-title rendering
     `t3-code · preview_status` etc.)

Persisted sessions that carry old `mcp__t3-code__*` tool names in history are
acceptable stale data; new sessions pick up the new key from injection. No migration.

**Verify:** `git grep -n "t3-code" -- apps/server/src apps/web/src` returns only the
allowed leftovers (`t3-code-relay`, `t3-code-git-text`, `t3-code-provider-probe`,
clientInfo names). Then `pnpm tc` and `vp run --filter t3 test`,
`vp run --filter @t3tools/web test`.

---

## Task 2 — Allow `strategyVersion 0` on persisted watches

1. [watch.ts:82](packages/trading-contracts/src/watch.ts): change
   `strategyVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))` to
   `isGreaterThanOrEqualTo(0)`. Update the doc comment: version 0 means "armed before
   the first publish; superseded by publish v1 like any other watch."
   `MomentumStrategyState.version` at [strategy.ts:146](packages/trading-contracts/src/strategy.ts)
   stays `>= 1` — do not touch it.
2. Add a regression test in
   [handlers.test.ts](apps/server/src/mcp/toolkits/trading/handlers.test.ts): register a
   watch on a mission with no published strategy → the tool result encodes successfully
   with `strategyVersion: 0`, `trading_list_watches` returns it, and no
   "could not announce a registered watch" warning path is hit (the announce dispatch
   succeeds).

**Verify:** `vp run --filter @t3tools/trading-contracts test` and
`vp run --filter t3 test`.

---

## Task 3 — Lenient tool-argument decoding at the MCP boundary

Keep the advertised JSON schemas strict (that is what makes Codex reliable). Coerce
incoming arguments _before_ decode, driven by each tool's own JSON schema.

1. Create `apps/server/src/mcp/coerceToolArguments.ts` exporting a pure function
   `coerceToolArguments(jsonSchema: unknown, args: unknown): unknown`:
   - Walk the JSON schema (`type: "object"` → recurse `properties`; `type: "array"` →
     recurse `items`; `anyOf`/`oneOf` → try each branch, return the first coercion whose
     shape matches, else the original value).
   - Where the schema expects `number`/`integer` and the value is a string that
     `Number(value)` parses to a finite number → replace with the number (covers
     `"100"`, `"0"`, `"0.0"`).
   - Where the schema expects `boolean` and the value is `"true"`/`"false"` → coerce.
   - Where the schema expects `object`/`array` and the value is a string that
     `JSON.parse`s to that shape → coerce (some CLIs stringify nested params).
   - Everything else passes through untouched. Never invent or drop keys.
2. In [McpHttpServer.ts](apps/server/src/mcp/McpHttpServer.ts), replace
   `TradingToolkitRegistrationLive = McpServer.toolkit(TradingToolkit)` (line 221) with a
   local `registerToolkitLenient(TradingToolkit)` that is a copy of effect's
   `registerToolkit` (see
   `node_modules/.pnpm/effect@4.0.0-beta.102*/node_modules/effect/dist/unstable/ai/McpServer.js`
   lines 548-596 — the file already copies this pattern for `registerPreviewSnapshot` at
   lines 132-206) with one change: inside `handle(payload)`, call
   `built.handle(tool.name, coerceToolArguments(Tool.getJsonSchema(tool), payload))`.
   Reproduce the existing failure mapping exactly (declared-failure message passthrough,
   `ToolParameterValidationError` message passthrough, generic internal error otherwise).
   Apply the same lenient registration to the preview standard toolkit registration only
   if it requires no extra structural change; otherwise leave preview as-is — trading is
   the scope.
3. Unit tests for `coerceToolArguments` (new `coerceToolArguments.test.ts`): the exact
   observed failures — `maxBars: "100"` → 100; `expectedVersion: "0"` and `"0.0"` → 0;
   a nested `intent.limitPrice: "1850.5"` → number; a non-numeric string stays a string
   and still produces the normal validation error through the boundary; an already-valid
   payload is byte-identical.

**Verify:** `pnpm tc`, `vp run --filter t3 test`.

---

## Task 4 — Schema-level input tolerance (conditions as prose, optional missionId)

1. **Condition entries accept plain strings.** In
   [strategy.ts](packages/trading-contracts/src/strategy.ts), define
   `AgentConditionInput = Schema.Union([AgentConditionDescription, <string → {description}>])`
   where the string branch decodes a non-empty `TradingText` into
   `{ description: <the string> }` (use the same `Schema.decodeTo` + `SchemaTransformation`
   pattern as `TrimmedString` in
   [primitives.ts:14-22](packages/trading-contracts/src/primitives.ts)). Use
   `AgentConditionInput` for every authored condition array: `entryPlan.conditions`,
   `positionManagement.scaleInConditions`, `exitConditions`, `abandonmentConditions`,
   `reentryConditions`. The persisted/encoded form remains the object shape.
   This makes `exitConditions: ["Exit if a finalized 1m candle closes back above 1865.9."]`
   valid input.
2. **`missionId` optional, resolved from the thread binding.** The credential already
   determines the mission ([handlers.ts:66-103](apps/server/src/mcp/toolkits/trading/handlers.ts)
   checks the argument _against_ the binding, it never trusts it). Change every trading
   tool input in [tools.ts (contracts)](packages/trading-contracts/src/tools.ts) to
   `missionId: Schema.optional(TradingId)` (the shared `missionBound` object and
   `TradingGetMissionInput`). In
   [handlers.ts](apps/server/src/mcp/toolkits/trading/handlers.ts):
   - `resolveBoundCall(missionId: string | undefined)`: when `undefined`, use the bound
     mission (`bound.value`); when present, keep the exact mismatch rejection.
   - `resolveReadCall`: unchanged logic, parameter becomes optional.
   - `trading_get_mission` with omitted `missionId`: bound thread → `readMission`;
     unbound thread → `readUnboundMission`.
   - Every handler that used `input.missionId` afterward uses the resolved mission's id.
3. Update the affected tool descriptions in
   [tools.ts (toolkit)](apps/server/src/mcp/toolkits/trading/tools.ts): "`missionId` is
   optional — omit it and the call acts on the mission this session is bound to."
4. Tests: in [handlers.test.ts](apps/server/src/mcp/toolkits/trading/handlers.test.ts),
   add cases — omitted `missionId` resolves to the bound mission for one read and one
   write tool; a _wrong_ `missionId` still rejects `mission_not_bound_to_thread`; a
   prose-string exit condition decodes to `{description}` and round-trips through
   `trading_get_mission` as the object shape.

**Verify:** `vp run --filter @t3tools/trading-contracts test`,
`vp run --filter t3 test`, `pnpm tc`.

---

## Task 5 — Profit target: declared in the strategy, armed as a watch, wake-and-decide

1. **Contract.** In [strategy.ts](packages/trading-contracts/src/strategy.ts) add to
   `MomentumProtection`:
   - `targetProfitUsd: PositiveUsdAmount` (required) — "the unrealised PnL, in USD, at
     which this position should be closed or re-justified."
   - `targetProfitRationale: Schema.optional(TradingText)`.
     Update every strategy fixture in
     [contracts.test.ts](packages/trading-contracts/src/contracts.test.ts),
     [TradingStrategyService.test.ts](apps/server/src/trading/TradingStrategyService.test.ts),
     and any other fixture the typecheck flags.
2. **New watch type.** In [watch.ts](packages/trading-contracts/src/watch.ts):
   - Add to the `MarketWatch` union:
     `{ type: "pnl_above", market: TradingMarket, valueUsd: PositiveUsdAmount }` —
     fires when the mission's reconciled unrealised PnL for `market` is ≥ `valueUsd`.
   - Extend `WatchArmedReason` to `["staleness_floor", "profit_target"]`.
3. **Evaluation.** In [WatchEvaluator.ts](apps/server/src/trading/WatchEvaluator.ts),
   extend the 2-second sweep: for each mission with an active `pnl_above` watch, read the
   position via `gateway.getPosition(masterAddress, market)` (resolve the master address
   the same way the composer does,
   [TradingWakeupComposer.ts:130-132](apps/server/src/trading/TradingWakeupComposer.ts));
   fire when `unrealisedPnl >= valueUsd` and `size !== 0`. A flat position never fires
   the watch and leaves it active (strategy publish supersedes it like any other watch).
   Reuse the existing markTriggered → inbox → announce path; summary text:
   `"unrealised PnL $X reached target $Y"`.
4. **Auto-arm.** In `ensureNotDeaf`
   ([TradingTurnCoordinator.ts:302](apps/server/src/trading/TradingTurnCoordinator.ts)):
   when the mission holds a position, the current strategy exists, and no active
   `pnl_above` watch is registered → `watches.registerWatch` a `pnl_above` at
   `strategy.protection.targetProfitUsd` with `armedReason: "profit_target"`. This runs
   in addition to the existing coverage logic, before it.
5. **Instructions.** Update tool descriptions in
   [tools.ts (toolkit)](apps/server/src/mcp/toolkits/trading/tools.ts):
   - `trading_publish_momentum_strategy`: "`protection.targetProfitUsd` is REQUIRED: the
     unrealised-PnL level, in USD, that makes this position a win worth banking. It is
     shown to the user and the runtime arms a `pnl_above` watch at it while you hold a
     position. When that watch wakes you, the default action is to close (or reduce) and
     reassess; you may instead republish with a higher target if the move is genuinely
     extending — say why. You may additionally place your own resting take-profit order
     via trading_request_entry if you judge one right; the target watch still stands."
   - `trading_register_watch`: document the `pnl_above` type and the
     `profit_target` armed reason alongside the existing prose.
   - `POC_DEFAULT_INSTRUCTION` ([strategy.ts:40](packages/trading-contracts/src/strategy.ts)):
     append: "State a concrete profit target in USD for every position and manage the
     position against it: bank it, or justify raising it."
6. **UI.** Where the workspace renders `protection` (grep `takeProfit` /
   `stopMethod` in [apps/web/src/components/trading/](apps/web/src/components/trading/)),
   render `targetProfitUsd` as "Target +$X" alongside the stop display. Display only —
   no new controls.
7. Tests: evaluator fires `pnl_above` at ≥ target with an open position and does not
   fire flat (extend [WatchEvaluator.test.ts](apps/server/src/trading/WatchEvaluator.test.ts));
   `ensureNotDeaf` arms the target watch exactly once
   (extend [TradingTurnCoordinator tests](apps/server/src/trading/ExecutionReactorLoop.test.ts)
   or the coordinator's own test file).

**Verify:** `vp run --filter @t3tools/trading-contracts test`,
`vp run --filter t3 test`, `pnpm tc`.

---

## Task 6 — Timeframe-scaled re-evaluation cadence

1. In [watch.ts](packages/trading-contracts/src/watch.ts) replace the fixed
   `WATCH_COVERAGE_FLOOR_MILLIS` with:
   ```ts
   export function watchCoverageFloorMillis(input: {
     readonly timeframe: TradingTimeframe;
     readonly holdingPosition: boolean;
   }): number;
   ```
   Bar lengths: 1m=60s, 3m=180s, 5m=300s, 15m=900s, 1h=3600s. Holding a position:
   `3 bars`, clamped to [2 min, 15 min]. Flat with a published thesis: `10 bars`,
   clamped to [5 min, 30 min]. (1m holding → 3 min; 1m flat → 10 min; 5m holding →
   15 min; 1h holding → 15 min cap.) Keep `WATCH_COVERAGE_FLOOR_MILLIS` exported as the
   flat-1m value only if call sites outside the coordinator still need a constant;
   otherwise delete it.
2. The cadence-driving timeframe is `strategy.timeframes[0]`, falling back to
   `POC_DEFAULT_TIMEFRAME`. Enforce non-empty `timeframes` on publish: in
   [strategy.ts](packages/trading-contracts/src/strategy.ts) change
   `timeframes: Schema.Array(TradingTimeframe)` to add a min-length-1 check, and state in
   the publish tool description that `timeframes[0]` is the primary timeframe that drives
   the monitoring cadence.
3. Update call sites: `hasReassessmentWithin` / `readWatchCoverage` `floorMillis`
   callers, and `ensureNotDeaf` + `armStalenessFloor`
   ([TradingTurnCoordinator.ts:261-334](apps/server/src/trading/TradingTurnCoordinator.ts))
   compute the floor from the current strategy's primary timeframe and whether a
   position is open.
4. Update the "ten minutes" prose in the `trading_register_watch` description
   ([tools.ts:223](apps/server/src/mcp/toolkits/trading/tools.ts)) to describe the
   scaled floor: "a reassessment is auto-armed a few bars out — 3 bars of your primary
   timeframe while holding, 10 bars while flat (clamped 2m-30m)."
5. Update [TradingWatchCoverageFloor.test.ts](apps/server/src/trading/TradingWatchCoverageFloor.test.ts)
   and [watch.test.ts](packages/trading-contracts/src/watch.test.ts) for the new function;
   add cases for the four boundary examples in step 1.

**Verify:** `vp run --filter @t3tools/trading-contracts test`,
`vp run --filter t3 test`.

---

## Task 7 — Wakeup carries position and recent candles

Goal: a woken agent should not need boilerplate `trading_get_position` +
`trading_get_market_history` calls before it can think, and must never be flooded —
20 bars, not 500.

1. In [wakeup.ts](packages/trading-contracts/src/wakeup.ts) add to `TradingHarnessWakeup`:
   - `position: AgentNetPosition` — always present; flat is `size: 0` (the contract
     already models flat as a valid state).
   - `recentCandles: MarketHistory` — the last **20 bars** of the primary timeframe
     (`activeStrategy.timeframes[0]` fallback `defaultTimeframe`).
2. In [TradingWakeupComposer.ts:137-140](apps/server/src/trading/TradingWakeupComposer.ts)
   extend the `Effect.all` to also fetch `gateway.getPosition(mission.market ...)` and
   `gateway.getMarketHistory({ market, interval: primaryTimeframe, maxBars: 20 })`, and
   thread both into the wakeup struct. A history-read failure fails compose the same way
   a snapshot failure does today.
3. Update the wakeup schema doc comment: the bounded snapshot now answers "what do I
   hold, what did price just do" without tool calls; deeper history stays behind
   `trading_get_market_history`.
4. Update [wakeup.test.ts](packages/trading-contracts/src/wakeup.test.ts) and any
   composer test fixtures the typecheck flags.

**Verify:** `vp run --filter @t3tools/trading-contracts test`,
`vp run --filter t3 test`, `pnpm tc`.

---

## Task 8 — Composer message when the mission lock has no enabled provider

Keep the §10.2 lock. Fix the messaging only.

1. [ChatView.tsx:1866-1878](apps/web/src/components/ChatView.tsx) already computes
   `missionHarnessProvider`. Pass it into `ChatComposer` as a new prop
   `missionLockedProvider: ProviderDriverKind | null`.
2. In [ChatComposer.tsx](apps/web/src/components/chat/ChatComposer.tsx), when
   `noProviderAvailable && missionLockedProvider !== null`, replace the three generic
   strings (lines 2787, 3013, 3082) with:
   placeholder `"Enable <DisplayName> in Settings"`, tooltip/banner
   `"This trading mission is bound to <DisplayName>. Enable it in Settings, or end the
mission to use another provider."` (`<DisplayName>` via `PROVIDER_DISPLAY_NAMES`
   from `@t3tools/contracts`.)
3. Add a test beside the existing composer logic tests (see
   [ComposerPrimaryActions.test.ts](apps/web/src/components/chat/ComposerPrimaryActions.test.ts)
   pattern) asserting the mission-specific message is chosen when the lock is a mission
   lock and no instance of that driver is selectable.

**Verify:** `vp run --filter @t3tools/web test`, `pnpm tc`.

---

## Task 9 — Stopping a run is clean: no `runtime.error`, no session stuck in `error`

Rule: user-initiated stop must end the turn as `interrupted`, leave the provider
session out of `error` status, and emit no `runtime.error` event.

1. **OpenCodeAdapter** ([OpenCodeAdapter.ts:1080-1115](apps/server/src/provider/Layers/OpenCodeAdapter.ts)):
   in the `session.error` event handler, first check `yield* Ref.get(context.stopped)`
   (the same guard the event pump uses at line 1158) — if stopped, return without
   setting session status `error` and without emitting `runtime.error`.
2. **Audit the same pattern in the other adapters.** In
   [ClaudeAdapter.ts](apps/server/src/provider/Layers/ClaudeAdapter.ts) the stream-exit
   path is already guarded (`handleStreamExit`, lines 2996-3027) — leave it. In
   [CursorAdapter.ts](apps/server/src/provider/Layers/CursorAdapter.ts) and
   [GrokAdapter.ts](apps/server/src/provider/Layers/GrokAdapter.ts), find every
   `runtime.error` emission and every provider-session `status: "error"` write reachable
   from the stop path and add the equivalent stopped-guard. (Search each file for
   `runtime.error` and `"error"` session updates; the guard is a boolean/Ref check that
   already exists in each adapter's session context.)
3. **Run settlement.** No change to
   [TradingTurnCoordinator.isTurnEndFor](apps/server/src/trading/TradingTurnCoordinator.ts)
   is needed once the adapters stop reporting a user stop as session `error`: the
   turn-end event then arrives with a non-error status and the run settles `completed`.
4. Tests: extend each touched adapter's test file with "stopSession during an active
   turn emits `turn.completed` interrupted and no `runtime.error`" (the OpenCode one is
   mandatory; Cursor/Grok only where step 2 changed code).

**Verify:** `vp run --filter t3 test`, `pnpm tc`.

---

## Task 10 — End-to-end acceptance (manual, testnet)

Run the full loop twice — once with **Claude**, once with **OpenCode** (the agreed
verification providers; Codex is the regression control if time permits). Use the
Hyperliquid testnet account already configured. For each provider:

1. Create a mission from the trading panel. Confirm the bootstrap turn can:
   `trading_get_mission` (omitting `missionId`), read history with `maxBars` sent as a
   string (observe in logs that it coerced, not errored), and publish a strategy whose
   `exitConditions` include at least one plain prose string and whose
   `protection.targetProfitUsd` is set. Zero `Invalid parameters` /
   `Failed to encode result` lines in the server log.
2. Register a watch _before_ the first publish on a fresh mission once — result returns
   `strategyVersion: 0`, no announce WARN.
3. Open a small position with a stop. Confirm within one coordinator settlement:
   a `pnl_above` watch armed at the strategy target (`armedReason: "profit_target"`),
   and a staleness reassessment due within 3 bars of the primary timeframe.
4. Let the target fire (or lower the target and republish to force it): the wake fires,
   and the agent closes/reduces or republishes with a raised target.
5. Stop a running turn from the UI: no "Runtime error" card, composer remains usable.
   Disable the mission's provider in Settings: composer shows the mission-bound message
   from Task 8, not "No provider available".
6. Confirm tool names now read `mcp__t3-trade__…` in the session log.

Record outcomes (pass/fail per step per provider) in
`artifacts/reports/trading-t3trade-acceptance-2026-08-04.md`.

Finish with the full gate: `pnpm tc && pnpm lint && pnpm test`.
