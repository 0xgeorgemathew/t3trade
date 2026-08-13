# Plan 27 — Execution plan

Fixes from the 2026-08-13 stop-out review plus the follow-up requirements:
tournament over all strategies bidirectionally, novice-readable plans, avoidable
stop-outs, post-settle history retention, and the quick-trades objective.
Ground rules kept throughout: deterministic arithmetic only (no indicators, no ML),
judgment stays in the harness, verdicts are evidence not permission, every threshold
change ships through replay + policy version bump.

## Working conventions (set up 2026-08-13, before this plan runs)

- **Tests:** iterate with `vp run test:fork` (~1.7k tests, trading packages plus
  `apps/server/src/mcp` and `src/provider`). Every path this plan edits is
  fork-owned, so CI scopes these PRs the same way — see `scripts/test-scope.ts`.
  Touching anything outside it drops CI back to the full suite; that is the
  signal to check whether the change really belongs there.
- **Any new test directory** must be added to `scripts/test-scope.ts` and the
  matching `test:fork` script together, or it silently stops running in CI.
- **Live testnet runs** arm from one file: `~/.t3trade/secrets/hyperliquid-interim-signer-key.bin`
  (`T3_TRADES_INTERIM_SIGNER_KEY` still overrides). Under vitest the file source
  is ignored, so a test can never ambiently spend testnet capital — D3's soak is
  a real server run, not a test run.
- **Migrations:** B1 is the only one. It needs a `Migrations.ts` registry entry,
  a documented ledger seam.

## Phase A — See the trend earlier (stateless features, `packages/trading-contracts/src/momentum.ts`)

- [x] **A1.** Add `recentDirectionScore` (last 30 bars) to `MomentumTimeframeContext`;
      `direction` stays 120-bar.
- [x] **A2.** Add `pivotTrend: { consecutiveLowerHighs, consecutiveHigherLows,
consecutiveLowerLows, consecutiveHigherHighs }` from the existing `findPivots` output.
- [x] **A3.** Add `swingHighDriftUsd` / `swingLowDriftUsd`: swing bounds of the window's
      two halves compared, alongside `rangeStabilityPercent`.
- [x] **A4.** Add computed `regime` to `MarketStructure`: `{ classification: "trending" |
"ranging" | "transition", evidence: string[], conflicts: string[] }`, applying the
      classify playbook's criteria in code, including excursion symmetry. `conflicts[]`
      names every disagreeing feature pair. Model may overrule.
- [x] **A5.** Tests (momentum.test.ts) + description updates (`trading_get_market_structure`
      in tools.ts, classify playbook text pointing at verdict/conflicts).
- [x] **A6.** New setup kind `trend_continuation`: scored from A2 pivot sequence + A1
      recent score + shallow pullback toward a failing level, in the drift's direction.
      Entry style `candle_close` back through the pullback extreme — never a boundary touch.

## Phase B — Remember across wakes

- [x] **B1.** Level event history persistence: per mission, per price level (ATR-scaled
      tolerance), record armed / touched / wick-rejected / closed-through / entered-at /
      stopped-out-at, written from the WatchEvaluator + TradingFillReconciler seams.
      Surface as bounded `levelHistory[]` on the wakeup. (Only schema migration in the plan.)
- [x] **B2.** Prior-read echo on the wakeup: `previousRegime`, previous swing bounds per
      primary timeframe, read age.
- [x] **B3.** Extend `range_reversion.standDownIf` (playbook.ts): boundary re-drawn same
      direction on consecutive reads (B2); boundary with ≥2 close-throughs or a prior
      stop-out (B1); regime verdict `transition` naming the traded side (A4). Plus the
      one-sided-range rule: when drift/pivot evidence points one way, trade only the
      with-drift boundary or stand down — never arm both sides.

## Phase C — Govern the entry

- [x] **C1.** On quote/execute, snapshot `setupScoreAtEntry` / `setupKindAtEntry` (or null)
      into the execution record. No gate — measurement first.
- [x] **C2.** Wakeup flags `enteredWithoutScoredSetup` on open positions; funnel counts
      wins/losses split by scored-setup-behind-it yes/no.
- [x] **C3.** Extend the funnel beyond stand-downs: attribute losses to the regime read
      in force at entry (`assessEnrichment` sibling in policy.ts).

## Phase E — Strategy tournament: all strategies, both directions

- [x] **E1.** `candidates` view on the structure result (or `trading_compare_strategies`
      read tool): every scored setup × direction joined with its playbook's gates — cost
      multiple at current book, distance to trigger — as one table.
- [x] **E2.** Rewrite DECISION_CONTRACT step 2 (TradingSessionProfile.ts) + classify
      playbook: classify → enumerate every candidate (each playbook × each supported
      direction, plus "no trade") → one line per candidate on expectancy after costs →
      run the winner. A user mandate naming a strategy narrows the field; otherwise the
      whole field, every turn.
- [x] **E3.** `trading_publish_plan` gains `alternativesConsidered[]`:
      `{ strategy, direction, verdict, reason }` per candidate.
- [x] **E4.** standing_rules: a scheduled/staleness wake while FLAT re-runs the tournament
      from scratch — incumbent thesis has no seniority. While holding, switching must beat
      exit+entry round-trip cost, arithmetic shown.

## Phase F — Novice-readable plans in the UI

- [x] **F1.** Required `plainSummary` field on `tradingPlanAuthoredFields` (strategy.ts):
      2–4 sentences, no tool/field names, no scores; must answer: what is the market doing,
      what am I planning and in which direction, what triggers it, roughly what I risk vs
      expect. Constraints stated in the tool description.
- [x] **F2.** Render `plainSummary` as the headline (tradingPresentation.ts + mission
      panel); technical belief/basis prose behind a "details" disclosure.
      `alternativesConsidered[]` renders as a plain list.
- [x] **F3.** Closed-trade review turn restates outcome in the same plain register, so the
      timeline reads as a story a non-trader can follow.

## Phase G — Stops that don't die to noise

- [x] **G1.** Measure first: extend `TradingClosedTradeReview` + calibration with stop
      distance at entry (ATR multiples and noise-floor multiples) and whether price
      re-crossed entry / reached target within N bars after the stop. Aggregates:
      `stopsInsideNoiseFloorPercent`, `avoidableStopPercent`. (Requires Phase H — today
      the closed-trade rows are deleted at settle.)
- [x] **G2.** `trading_quote_entry` enforces the same noise floor `trading_adjust_stop`
      already does: closer stops refused with the floor named. The rule is already
      pure and shared — `STOP_ADJUSTMENT_LIMITS.noiseFloor*Multiple` and the
      `max(2×halfSpread, 0.35×ATR)` check at `packages/trading-contracts/src/stopAdjustment.ts:195`.
      Extract it as its own exported function and call it from both paths; do not
      restate the arithmetic at the entry site. (`tools.ts:432` is only the
      adjust-stop tool's description text — update it to match.)
- [x] **G3.** Playbook doctrine: stop lives beyond the level that invalidates the thesis
      by a noise-floor margin — never a bare dollar offset from entry.
- [x] **G4.** While a position is open with a resting stop, auto-arm the `pnl_below`
      decision wake at ~70% of the way to the stop, not AT it. Wake asks: thesis broken, or
      noise? Answers: hold / tighten legally / exit better than stop. Exchange stop stays
      as backstop.
- [x] **G5.** Any widening of stops ships as TRADING_POLICY_V2 through D2 replay with
      adverse-excursion comparison. If G1 says stops were mostly right, leave placement
      alone (G4 still ships).

## Phase H — Keep history after settle (new, 2026-08-13)

Today settling destroys everything: `TradingMissionReactor.deleteWhenTerminalAndFlat`
(TradingMissionReactor.ts:357) hard-deletes the mission and ALL children — fills,
closed trades, position snapshots — and `TradingMissionSweep` purges survivors at
boot. The settled thread then renders no trading UI at all. This also deletes the
data G1/C2/C3 need to measure anything across missions.

- [x] **H1.** Stop deleting terminal missions. Remove the `deleteWhenTerminalAndFlat`
      delete (TradingMissionReactor.ts:349, deletes at :357; called from :332 and :582)
      and drop `'revoked','completed'` from `listDeletableMissions`
      (TradingMissionService.ts:624); the sweep keeps only its orphaned-thread purge
      (mission whose thread no longer exists). Terminal missions stay in
      `projection_trading_missions` with their fills/closed-trades/snapshots intact.
- [x] **H2.** Settled thread keeps its trading surfaces. With the row surviving,
      `boundMission` resolves again; verify MissionThreadCards (result card, fills,
      review chart) render on a settled thread and MissionLivePanel's `complete` one-line
      state shows. Fix any gate that assumed the row disappears (MissionLivePanel.tsx:16
      "until the row is deleted").
- [x] **H3.** Mission history list: a Trading history surface (Trading Settings page or
      a panel tab) listing past missions — market, direction(s) traded, net PnL, fees,
      duration, settled date — each opening its thread. The "wall of dead rows" that
      motivated deletion is solved by presentation (collapsed, paginated), not data loss.
- [x] **H4.** Cross-mission ledger: closed trades queryable across missions per account
      (feeds G1 aggregates and the calibration tool), so per-mission `insufficient_sample`
      at n=1 stops being permanent.

## Phase I — Quick-trades objective (new, 2026-08-13)

Mission intent: not the perfect position — find any positive-expectancy approach,
trade it quickly, take small profits, repeat. Test wallets hold ~$1000 tradable.

- [x] **I1.** Doctrine: default mission objective stated in POC_STANDING_INSTRUCTION +
      DECISION_CONTRACT — many small trades beat one perfect one; the tournament (E2)
      picks the BEST AVAILABLE candidate, and "no trade" must be justified against the
      best candidate's expectancy, not against perfection. Standing down repeatedly with
      a tradeable field is itself a reportable failure mode.
- [x] **I2.** Shorten the flat-reassessment cadence: while flat, the staleness floor /
      scheduled reassessment wake comes sooner (policy constant, replay-gated), so missed
      entries are re-evaluated in minutes, not hours.
- [x] **I3.** Funnel metrics for activity: `tradesPerSession`, `timeInMarketPercent`,
      `standDownsWithViableCandidate` — so "sat out all day" is measurable, not anecdotal.
- [x] **I4.** Sizing sanity for the $1000 wallet: verify policy sizing produces
      fee-viable small trades at that equity (cost multiple gates already exist); adjust
      minimum-size / target-multiple constants only through D2 replay if fees dominate.

## Phase D — Evidence loop (gates thresholds above)

- [x] **D1.** Replay fixtures from the 2026-08-13 window: ETH 1m/5m/15m/1h,
      ~06:00–12:00 UTC — the grind, three boundary failures, the breakdown.
      History/forward split per replay.ts contract.
- [x] **D2.** Replay TRADING_POLICY_V1 vs V2 (Phase A features + candidate thresholds)
      on the same fixtures; ship only what replay supports; report net expectancy,
      drawdown, fee share.
- [ ] **D3.** Testnet soak with A+B+H live and C+I measuring. Success: next grind-down
      produces a transition/trending verdict within ~30 bars; no entry at a level with a
      recorded stop-out without explicit override; funnel shows the C2 and I3 splits.

## Sequencing

1. **H first** — it is small, unblocks G1/C3/I3 measurement, and is a visible UX fix.
2. **A** (pure functions + tests) in parallel; **B1** is the only migration.
3. Doctrine/schema edits (E2/E4, F1–F3, G2/G3, I1) can land with A. E1/E3 follow A6.
4. G1 + I3 land early so data accumulates; G4 is a watch-coverage change; I2 is a
   policy constant.
5. **D1/D2** immediately after A; all threshold changes (G5, I2, I4, B3 numbers) wait
   for D. Nothing relaxes a risk gate — G2 adds one.
