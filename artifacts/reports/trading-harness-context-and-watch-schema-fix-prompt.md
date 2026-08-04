# Handoff: mission threads losing trading context, pre-trade shell exploration, and the candle-close watch rejection

Date: 2026-08-03. Repo: `t3trade` @ `15f568c6e` (main). Observed on a live testnet run of the T3 Trades harness (codex provider, mission instruction "Trade ETH momentum on testnet using 1m candles…").

Three related problems were observed in one evening session. Fix all three; they share the same root theme — the provider session's context is not guaranteed to match what the trading runtime assumes it has.

---

## Problem 1 — a mission thread answered user messages with "no trading tools are connected"

### What happened (Chat Log 1, ~11:18 PM, mission `11881ea6-bc72-4195-b3f6-00135610dcbb`)

The `mission_created` bootstrap wakeup was delivered to the thread. The user then typed three chat messages ("each trade must be of at least $100 value", "Okay", "Proceed"). The agent replied like a generic coding agent with no trading capability:

> "The workspace currently contains no trading code or configuration to modify."
> "I'm ready to proceed, but no testnet wallet, market-data, or trading execution tools are connected in this workspace. I can't place trades yet."

It never called a single `trading_*` tool, never published a strategy, and the mission sat in `analysing` until the auto-mission reactor later revoked it (`slot_taken_by_new_thread`, server log 23:23:28) when a fresh thread took the slot after a server restart. The fresh thread (Chat Log 2) **did** have the tools and worked, so the toolkit wiring itself is fine — the binding of mission → thread → provider session with tools attached is what failed.

### Where to look

- `apps/server/src/trading/TradingTurnCoordinator.ts` — `wakeProvider` (dispatches `thread.turn.start` on the bound thread) and `requestUserMessageRun` (routes operator chat through the wake path; note the "ordinary turn path" fallback at the bottom — in Chat Log 1 the user messages plainly reached a session that had no trading toolkit at all, so routing wasn't the issue; the session's tool surface was).
- `apps/server/src/mcp/McpHttpServer.ts` — the trading toolkit is registered here (`TradingToolkitRegistrationLive`) and the server authenticates requests. Server log at boot shows `Authentication required. Open T3 Trade using the pairing URL` and `agent activity publishing standby; waiting for T3 Connect link reconciliation` — a strong hint that a provider session created **before** pairing/link reconciliation completes can come up without the `t3-code` MCP server connected, and the mission gets bound to it anyway.
- `apps/server/src/trading/TradingMissionReactor.ts` and `AutoMissionConfig.ts` — auto-mission picks a thread and binds it. There is no check that the chosen thread's provider session actually has the trading toolkit reachable.
- §12.3 pre-run checks in `TradingTurnCoordinator.requestRun` — check 2 only verifies `mission.harness.threadId` is non-empty and check 3 only reads a status field. Neither verifies the session can see the trading tools.

### What to build

1. **Diagnose first**: reproduce or trace how the Chat Log 1 session came up without the trading MCP tools (session created pre-pairing? MCP connection dropped and never re-established? thread bound before the provider session finished MCP handshake?). Confirm the actual mechanism before fixing — the fix differs by cause.
2. **Gate the binding**: a mission must not be created on / bound to a thread whose provider session cannot reach the trading toolkit. Whatever "can the session see `trading_*` tools" signal exists (or needs to exist), check it at mission creation and in the §12.3 pre-run checks, and block with a legible reason (`trading_toolkit_unreachable` or similar) instead of dispatching a wakeup the agent cannot act on.
3. **Detect the dead run**: a bootstrap run that ends with no strategy published and zero trading tool calls should not leave the mission silently parked in `analysing`. Surface it — fail the run, log at warn/error with the mission id, and let the reactor retry or mark the harness unavailable.

---

## Problem 2 — the agent shell-explores the workspace before touching trading tools

### What happened (Chat Log 2, mission `97c14c9a-0c4a-4b35-b05a-c426e0ddcdfd`)

On wakeup the agent said "I'm checking the local trading harness and available testnet controls…" and ran multiple shell commands (`pwd`, repeated `rg --files`, greps for "candle|watch|testnet|…") over the T3 workspace before making any trading tool call. At a 1-minute candle cadence this burns a large fraction of every run on pointless repo exploration — the workspace contents are irrelevant to the mission; everything the agent needs arrives in the wakeup JSON and via the `trading_*` MCP tools.

### Why it happens

The codex developer instructions are generic coding-agent modes. `apps/server/src/provider/CodexDeveloperInstructions.ts` — both Plan and Default modes; Plan mode literally says "Begin by grounding yourself in the actual environment… search relevant files, inspect likely entrypoints/configs". Nothing anywhere tells a mission-bound session that it is a trading harness, that the workspace is not the object of the task, or that shell exploration is wasted. The wakeup itself (`TradingTurnCoordinator.wakeProvider`, `TradingWakeupComposer`) is bare JSON with no operating guidance.

### What to build

Add a trading-mission operating preamble for mission-bound threads. Two candidate injection points — pick whichever fits the provider architecture (likely both, one authoritative and one reinforcing):

- A trading `<collaboration_mode>` developer-instructions block (alongside the existing ones in `CodexDeveloperInstructions.ts`) applied when the thread is bound to a mission, saying roughly: _you are the decision harness for a live trading mission; all market/account/strategy state arrives in the wakeup message and through the `trading\__` MCP tools; do not explore or modify the workspace, do not run shell commands to "find the trading code" — there is none to find; act on the snapshot, use the tools, keep runs short.\*
- A short fixed prose preamble prepended to (or wrapping) the serialized wakeup text in `wakeProvider`, restating the same contract, since a direct message is weighted more heavily than mode instructions (the codebase already relies on this — see the comment on `POC_DEFAULT_INSTRUCTION` in `packages/trading-contracts/src/strategy.ts:30`).

Acceptance: a wakeup run on a mission thread makes trading tool calls (or a chat reply) without any workspace shell commands.

---

## Problem 3 — `trading_register_watch` rejects the candle-close watch the instruction asks for

### The error (server log 23:24:11)

```
AiError: Toolkit.trading_register_watch.handle: Invalid parameters for tool 'trading_register_watch':
  Expected "price_cross", got "candle_close"   at ["watch"]["type"]
  Expected a value greater than 0, got 0       at ["watch"]["price"]
  Expected "position_update", got "candle_close" at ["watch"]["type"]
```

### Diagnosis (confirmed in code — this is not "candle_close is unsupported")

`candle_close` **is** a member of the `MarketWatch` union (`packages/trading-contracts/src/watch.ts`), but that variant requires `direction` and `price` with `Price > 0`. The agent sent `type: "candle_close"` with `price: 0` — i.e. it tried to express _"wake me on every finalized 1m candle close, unconditionally"_. No union branch can express that, so the Effect Schema union error dumps a confusing per-branch mismatch list ("Expected price_cross… Expected position_update…") that masks the real problem.

The agent was set up to make exactly this mistake: the mission instruction (`POC_DEFAULT_INSTRUCTION`, `packages/trading-contracts/src/strategy.ts:40`) says _"Arm candle-close watches on the 1m interval so each run wakes within a minute"_ — which reads as an unconditional every-candle wake — while the schema only supports _level-crossing_ candle-close watches. In Chat Log 2 the agent recovered by inventing a level (close above 1868.5), which is a directional bet the instruction never asked for, and means the mission does **not** reliably wake each minute (a quiet candle that crosses nothing leaves only the 10-minute staleness floor, `WATCH_COVERAGE_FLOOR_MILLIS` in `watch.ts`).

### What to build

Decide and implement ONE of these, consistently across contract → evaluator → tool → instruction text:

- **Option A (recommended): add an unconditional candle-close variant.** New union member, e.g. `{ type: "candle_timer", market, interval }` (or `candle_close` with `direction`/`price` made optional — prefer the new variant; keeping variants total-and-explicit is cleaner than optionality inside one). Touch points:
  - `packages/trading-contracts/src/watch.ts` (union, coverage semantics — an every-candle watch covers both sides for the coverage floor),
  - `packages/trading-contracts/src/wakeup.ts` (`describeArmedWatch` — no level, no distance),
  - `apps/server/src/trading/WatchEvaluator.ts` (fire once per finalized candle; remember it is fire-once/terminal like every watch, so the agent re-arms each run — the tool description in `apps/server/src/mcp/toolkits/trading/tools.ts:217` already teaches re-arming),
  - tool description update in `tools.ts` so the agent knows the unconditional form exists,
  - tests mirroring `WatchEvaluator.test.ts` / `contracts.test.ts` patterns.
- **Option B: keep the schema as-is and fix the words.** Rewrite `POC_DEFAULT_INSTRUCTION` and the `trading_register_watch` description to say candle-close watches require a direction and a level, and that a guaranteed once-a-minute wake is achieved with `trading_schedule_reassessment` re-armed each run. Cheaper, but a per-minute reassessment loop is what the scheduled-reassessment tool doc calls a smell, and every run must remember to re-schedule.

Additionally, regardless of option: improve the parameter-rejection surface. The raw Effect union dump above went to the server error log and (worse) back to the agent as a wall of contradictory "Expected X, got Y" lines. Intercept validation failures for `trading_register_watch` and return a short actionable message (e.g. _"candle_close watches require direction and a price level > 0; for an unconditional per-candle wake use …"_) so the agent self-corrects in one step instead of guessing.

---

## Verification

- `pnpm test` for the touched packages (`trading-contracts`, `apps/server` trading + mcp suites).
- Typecheck: keep runtime behavior aligned with declared types (project convention).
- Live check: start the dev server (`pnpm dev`), let auto-mission create a mission, and confirm: (1) the bootstrap run publishes a strategy and arms a per-minute wake without any shell exploration; (2) killing/starting the server mid-mission never leaves a bound thread answering "no tools connected"; (3) no `AiError` from `trading_register_watch` in the log across several candle cycles.

## Constraints

- Testnet only; the funded Gate-0 master address is `0xb2b6b516df4b159c0e4eb1d6d7d65a5f2f04c30e` (`local-hyperliquid-testnet`).
- Follow the repo's spec-section comment convention (§ references) and the existing fire-once/terminal watch semantics — do not introduce auto-re-arming watches.
- User-stated trading rule that must keep working once the context fix lands: operator chat like "each trade must be at least $100" must reach a tool-capable session and influence the strategy (that message was completely lost in Chat Log 1).
