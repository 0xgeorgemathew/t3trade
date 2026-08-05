T3 Trade — Momentum Loop Analysis & Execution Plan (2026-08-05)
Analysis only: no code changed, no orders/watches/strategies touched. The prior HTML report was used only as a hypothesis source; every load-bearing claim was re-verified against source at commit 384015fa4.

1. Confirmed: the complete profit-target computation path
   Measurement — measureVolatility (volatility.ts:207-245). Pure arithmetic over exchange candles. All outputs are USD of price (per ETH), never position PnL: atrUsd (14-bar), realizedVolatilityPercentPerBar, swingRangeUsd, and horizons[] (:170-197) — for each hold length (default 3/5/10/20 bars, :44) the p25/p50/p75 of the maximum favourable excursion from every bar close over the next N bars.
   Delivery — every wakeup carries observedVolatility on the strategy's primary timeframe only, 120 bars (TradingWakeupComposer.ts:144-174). Default timeframe is 1m, and the default instruction tells the agent to trade 1m and derive the target from this measurement (strategy.ts:35-51).
   The prescribed recipe — the publish-tool description (tools.ts:105) says: take favourableUpUsd.p50 → % of mark → × notional. Dimensionally this is correct (% × notional ≡ moveUsd × size; leverage cancels exactly as it should).
   Publication — protection.targetProfitUsd is required (strategy.ts:236): "the unrealised PnL at which this position should be closed or re-justified." targetProfitBasis is optional and never validated — publishMomentumStrategy (TradingStrategyService.ts:117-210) checks only version staleness and mission-active. ⚠️ The claim at wakeup.ts:148-150 that a target without a basis "is rejected" is false — no such check exists.
   Arming — ensureProfitTargetArmed (TradingTurnCoordinator.ts:329-357) arms a pnl_above watch at the target while a position is held.
   Firing — evaluatePnlAbove (WatchEvaluator.ts:445-473), swept every 2s, fires once when the exchange-reported unrealised PnL (mark-based, gross of fees and funding) reaches the value.
   Wake semantics — descriptions tell the agent "the default action is to close (or reduce)."
   So targetProfitUsd is simultaneously the agent's expectation, the wake trigger, and the de-facto profit cap, because the sanctioned default on the wake is to close.

2. Numerical audit of the $1.70
   Position: ≈1.06 ETH @ ≈$1,870 → notional ≈ $1,982, margin ≈$100 → ≈20x (matches testnetAuthorityDefaults, authority.ts:152-162).

The prior report's recorded measurement is genuine measureVolatility output — its ratios reproduce the code's arithmetic exactly (0.8571/1873.70 = 0.04575% ✓; 7.30/1873.70 = 0.38960% ✓): ATR(14) $0.8571; 2-hour swing $7.30; 10-min favourable-up p50 ≈$1.10, p75 ≈$1.60–2.00.

Reconstruction: $1.60 (10-min p75 favourable-up move) × 1.068 ETH = $1.71 — equivalently 0.0854% of mark × $2,000 notional. That is the prescribed recipe applied to the 10-bar horizon of a quiet 1m window.

Verdict: mathematically correct under the documented recipe, but built on poor assumptions. It is not a unit error, margin/notional confusion, a hard-coded cap, rounding, or staleness. It is the compound of five design choices:

Single timeframe, short horizon menu — the loop only ever measures 1m, horizons max out at 20 minutes; nothing shows what 15m/1h structure supports.
Historical max-favourable-excursion from flat bar closes treated as the remaining move — momentum entries happen after the impulse begins; entry location is an input nowhere.
No cost model in the target. Round-trip taker at the modeled 5 bps/side (authority.ts:80) on $1,982 = $1.78–$1.98 before spread/slippage. A $1.70 gross target is at or below break-even net. Fees are modeled carefully in loss accounting and preview (TradingPreviewService.ts:439-445) but exposed to the agent nowhere — no tool output carries a fee rate, spread cost, or net-PnL estimate.
Wake-and-close semantics make the estimate a cap — fire-once, default-close, and there is no pnl_below, no peak tracking, no giveback/trailing watch to make holding past the target safe.
No enforcement — the basis is optional and unvalidated, so nothing catches a below-cost target.
Remaining unknowns: the actual published strategy row (live DB not read); whether the agent used p50 or p75 ($1.70 best matches p75-up); the account's real userFees; a fresh live re-measurement (shell tooling was unavailable this session — worth re-running trading_measure_volatility on 1m/15m/1h to confirm current magnitudes).

3. Tool-by-tool evaluation
   Tool Classification
   trading_get_mission Sufficient as designed
   trading_publish_momentum_strategy Needs schema/behavior change — require + validate targetProfitBasis; support a target ladder; the excellent description currently carries the whole methodology unenforced
   trading_resolve_market, trading_get_account_state, trading_get_open_orders, trading_get_order_book, trading_schedule_reassessment, trading_list_watches, trading_cancel_watch Sufficient as designed
   trading_get_market_snapshot Needs additional output fields — no fee rate / spread-cost
   trading_get_market_history Sufficient but poorly orchestrated — multi-timeframe context is left to agent discipline, which demonstrably fails
   trading_measure_volatility Needs additional output fields — one interval per call; the adverse excursion of a long over the hold is not published, so reward-to-risk math from one call is impossible; no entry-location conditioning
   trading_get_position Needs additional output fields — no peak-unrealized-PnL / drawdown-from-peak
   trading_register_watch Needs schema change — missing pnl_below, giveback type, replace/amend
   trading_request_entry Misleading name / overloaded — six action types behind "entry"; rename to trading_execute with an alias (low urgency; behavior itself — server-priced IOC, mandatory stop, 17-item preview, awaited outcome — is sound)
   (missing) No trade-history tool: fills and realized results exist in the projection (TradingMissionProjection.ts:442-500) but are UI-only — the agent cannot read its own completed trades
   Watch subsystem confirmed gaps: exactly six types (watch.ts:20-53); no pnl_below/trailing/regime watch; fire-once + superseded-on-publish (a publish momentarily de-arms everything); the coverage floor arms reassessments only, never levels.

4. Proposed capabilities (prioritized)
   4.1 trading_estimate_costs (read-only, P1): inputs market, sizeEth/notionalUsd, optional side → takerFeeBpsPerSide, entry/exit fee USD, halfSpreadUsd, book-walk expectedSlippageUsd, funding per 8h, roundTripUsd, breakEvenPriceMoveUsd (per ETH), freshness stamp (explicit stale flag, never silent zeros). MCP tool + internal service; publish validation reuses it. Existing tools can't: the fee rate is server-side and the netting must agree with loss accounting.
   4.2 Publish-time validation (state-changing, P1): make targetProfitBasis required; check |targetProfitUsd − (measuredMoveUsd/referencePrice)×notional| ≤ 5%; cost floor targetProfitUsd ≥ 2× roundTripUsd (in-band warning first, hard reject after a testnet soak). Fix the false wakeup.ts doc claim.
   4.3 New watch types (state-changing, P1): pnl_below (mirror of pnl_above); pnl_giveback (fires on drawdown from peak unrealised PnL — needs a durable peak_unrealised_pnl column on trading_position_snapshots updated by the reconciler). Runtime policy: when a profit-target wake results in "hold and extend," auto-arm a giveback beneath the peak — "never round-trip a winner" becomes structural. Still wake-and-decide; no auto-execution.
   4.4 trading_get_momentum_context (read-only, P2): per timeframe (1m/5m/15m/1h) direction score, ATR expansion ratio, last impulse size/age, pullback depth, distance to swing high/low, composite alignment. Deterministic arithmetic — consistent with the codebase's measured-not-modeled stance.
   4.5 trading_get_trade_history (read-only, P2): completed orders, realized PnL, fees, duration, plus the strategy version/basis active at entry and exit. Pure read-join over existing tables.
   4.6 Wakeup enrichment (P2): costs for the open position, peak PnL/drawdown, second-timeframe volatility (15m).
   4.7 replacesWatchId atomic watch replacement (P3). 4.8 rename to trading_execute with alias (P3).
   Not recommended: an analyze-and-decide mega-tool (judgment belongs in the harness); server-side auto-take-profit orders (wake-and-decide is deliberate — fix the decision's inputs); auto-extending targets on profitability.

5. Recommended profit-target model
   A published ladder, measured, netted, entry-conditioned:

H = expectedHoldBars on the thesis TF Q = horizons[H] (thesis TF + one higher TF)
C = round-trip cost estimate E = entry-location discount ≈ 0.5 × impulse-so-far
S = distance to nearest structure
conservative = max(0, Q.p50 − E) base = max(0, Q.p75 − E, higherTF.p50 − E)
extension = min(S, higherTF.p75 − E)
per rung: targetPrice, priceMoveUsd (per ETH), priceMovePercent,
grossPnlUsd = move × size, netPnlUsd = gross − C,
returnOnMargin, rewardToRisk = net / (stopDistance × size + exit costs),
historicalHitRatePercent (50 for p50, 25 for p75 — attainability, not a promise)
gates: net(conservative) < 2×C → stand down
RR(base) < 1.5 → setup doesn't pay for its stop
insufficient data / weak alignment → research, don't trade
Runtime mapping: arm pnl_above at conservative (gross); on that wake, bank — or republish to base with a fresh basis and arm pnl_giveback beneath the peak; extension only via explicit republish. Leverage appears only in margin-return and liquidation distance, never in the move math.

6. Decision loop
   States: flat_researching, waiting_for_long_trigger, waiting_for_short_trigger, entry_in_flight, position_open, reducing, closing, cooldown_or_reassessment (harness-level, overlaying the mission statuses preview item 1 already gates).

Cross-cutting: every turn starts with trading_get_mission; carry just-read versions into every execution (preview items 3–4 enforce); never submit while pendingExecutions[] is non-empty (item 16 backstops); on contradictory data trust the direct read and prefer reducing risk; never end a turn holding a position without the conservative pnl_above, an invalidation-side level watch, and one bounded reassessment (the 3-bar floor backstops).

State Reads Decides Arms →
flat*researching mission, snapshot, history ≥60 bars × 2 TFs, volatility × 2 TFs, book, account, costs long/short now, wait, or stand down (§5 gates) staleness floor if standing down waiting*_ or entry*in_flight
waiting_for*_ wake payload + volatility trigger valid? invalidated? thesis stale (strategyAgeMillis)? breakout cross, invalidation cross, reassessment ≤10 bars entry_in_flight / flat_researching
entry_in_flight awaited result; on submitted: position + orders nothing order_update if resting position_open / flat_researching
position_open wakeup; on profit/giveback wakes: book + costs hold / extend (republish + fresh basis) / tighten stop / reduce / close target, invalidation, giveback after first target wake, reassessment ≤3 bars reducing / closing
reducing remainingSize re-derive ladder for remaining size (mind min notional) re-arm at new size position_open / closing
closing result — — cooldown
cooldown trade history (until 4.5: record self-review in published explanation) score thesis vs outcome, MFE/MAE, rule adherence cooldown reassessment — no instant re-entry flat_researching
Profit-target wake pseudocode:

if wakeReason == "profit_target":
costs = estimate_costs(position)
if momentum weakening or net(pnl, costs) fair → close | reduce half # bank
else → publish(v+1, base rung, fresh basis); arm pnl_giveback(≈0.4 × pnl)
elif wakeReason == "staleness_floor": the thesis is the suspect — re-level, republish, or exit
elif invalidation fired: close — never widen risk to save a thesis
always: both-side coverage + one reassessment before ending the turn 7. Phased execution plan (for an implementing agent)
Phase 0 — orchestration only (~1 session, no schema changes)

Rewrite target guidance in the publish/measure tool descriptions and default instruction: cost floor (2× round-trip, spelling out the 5 bps/side arithmetic until 4.1 ships), two-timeframe measurement requirement, entry-location discount, ladder in targetProfitRationale with targetProfitUsd = conservative rung. Fix or implement the wakeup.ts:148 claim. Accept: description tests updated; a supervised testnet mission publishes a target ≥ 2× costs.
Replace "default is close" with the §6 hold-vs-bank procedure in the profit-target wake guidance.
Phase 1 — cost awareness + downside-of-a-win coverage (1–2 sessions) 3. trading_estimate_costs: contract, tool, handler, internal TradingCostEstimator reusing gateway BBO/book and the preview's fee resolution. Tests: book-walk slippage, stale flag, fee fallback. 4. pnl_below watch (mirror evaluatePnlAbove). 5. Peak PnL + pnl_giveback: migration adding peak_unrealised_pnl; reconciler updates; evaluator fires on peak−current ≥ drawdown; surface peak/drawdown on position tool + wakeup. Tests: peak survives restart, resets on flat. 6. Publish validation per §4.2 (decode stays tolerant for legacy rows — pattern already in TradingMissionProjection.readStrategy).

Phase 2 — research & memory (2 sessions) 7. trading_get_momentum_context as a pure, property-testable module in trading-contracts (like volatility.ts) + gateway-fed handler. 8. trading_get_trade_history: extract/share the fill-aggregation SQL from readExecutionSurfaces; join strategy versions. 9. Wakeup enrichment: costs, peak PnL, second-timeframe volatility. 10. Closing-turn self-review: on close fill, queue one final wake summarizing entry/exit/MFE/MAE/fees/duration.

Phase 3 — ergonomics & learning 11. Atomic watch replacement; 12. trading_execute rename with alias; 13. strategy/target history via trading_get_mission; 14. calibration read (published-target hit rate vs historicalHitRatePercent) to tune the rung choice and the 2× floor.

Verification, every phase: package tests + one supervised testnet mission. Success metric = net realized PnL after fees per completed trade and rule adherence — not win rate, not trade count. Watch for: target ≥ 2× costs, both-side coverage after every turn, at least one justified target extension, one giveback bank.

Bottom line: the $1.70 was not a bug in arithmetic — it was the system working exactly as prescribed on the wrong inputs: a single quiet 1m window, a ≤20-minute horizon menu, no cost model anywhere the agent can see one, and a fire-once "wake at target, default close" mechanism that turns a conservative estimate into a hard cap below round-trip fees. Phase 0 (pure prompt/description changes) fixes most of the expected-value damage immediately; Phase 1 (cost estimator + giveback watches + publish validation) makes it structural.
