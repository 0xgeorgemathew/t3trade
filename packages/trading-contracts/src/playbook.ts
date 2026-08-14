/**
 * Trading playbooks - the procedure the harness used to carry as doctrine in
 * `POC_DEFAULT_INSTRUCTION`, split into one playbook per mode and reachable
 * through the `trading_get_playbook` tool.
 *
 * Each playbook says when it applies, the steps it follows, the gates that stop
 * it from acting, and the conditions that make it stand down. A harness reads
 * one playbook at a time rather than carrying all of them on every wakeup, and
 * nothing in the runtime branches on these values: they are published doctrine,
 * read in the same turn the harness decides what to do.
 *
 * This is static contract data: no DB, no versioning, no per-mission override.
 *
 * @module TradingPlaybook
 */
import { Schema } from "effect";
import { ACTIVE_TRADING_POLICY } from "./policy.ts";
import { TradingText } from "./primitives.ts";

/**
 * The thresholds this doctrine states, read from the version in force.
 *
 * Every number below used to be typed into the prose by hand next to the same
 * number typed into `momentum.ts` and `costs.ts`. Two of them — the session
 * cutoff and the losing-streak cooldown — existed ONLY here, which made them
 * rules with no definition anywhere a change could be reviewed against.
 */
const policy = ACTIVE_TRADING_POLICY;
const [shortestSessionMinutes, longestSessionMinutes] = policy.session.plannedMinutes;

/**
 * The one procedure each playbook exposes.
 *
 * `whenItApplies` is the single sentence that says which regime or setup this
 * playbook is the answer to; `procedure[]` is the ordered steps; `gates[]` are
 * the checks that have to clear before an entry; `standDownIf[]` are the
 * conditions that make a standing setup no longer worth taking.
 */
export const PlaybookProcedure = Schema.Struct({
  whenItApplies: TradingText,
  procedure: Schema.Array(TradingText),
  gates: Schema.Array(TradingText),
  standDownIf: Schema.Array(TradingText),
});
export type PlaybookProcedure = typeof PlaybookProcedure.Type;

/**
 * The five playbooks the `trading_get_playbook` tool returns by name.
 *
 * `classify` is the regime read; `momentum` and `range_reversion` are the two
 * modes a regime resolves to; `opening_range` is the ORB placeholder the plan
 * authorises for a later session type; `standing_rules` is what holds in both
 * modes.
 */
export const TradingPlaybookName = Schema.Literals([
  "classify",
  "momentum",
  "range_reversion",
  "opening_range",
  "standing_rules",
]);
export type TradingPlaybookName = typeof TradingPlaybookName.Type;

/**
 * One playbook, named.
 *
 * `name` discriminates the entry; the procedure fields are
 * {@link PlaybookProcedure}.
 */
export const Playbook = Schema.Struct({
  name: TradingPlaybookName,
  ...PlaybookProcedure.fields,
});
export type Playbook = typeof Playbook.Type;

/**
 * The five playbooks, in the order `trading_get_playbook` returns them when no
 * name is asked for (the tool always takes a name, so this ordering is for
 * readability here, not a runtime guarantee).
 *
 * The doctrine text moved here verbatim from the old
 * `POC_DEFAULT_INSTRUCTION`, redistributed into the playbook each piece belongs
 * to.
 */
export const PLAYBOOKS: ReadonlyArray<Playbook> = [
  {
    name: "classify",
    whenItApplies:
      "READ THE REGIME BEFORE YOU LOOK FOR A TRADE. The first thing every turn produces is a classification, not an entry.",
    procedure: [
      "Take `observedVolatility` and trading_get_market_structure and decide which of two markets you are in. TRENDING: the excursion quantiles are asymmetric (favourableUp and favourableDown differ materially at the same horizon), `directionScore` is away from zero, `atrExpansionRatio` is above 1, and the mark sits near a window extreme. RANGING: `excursionSymmetryRatio` is near 1, the swing range has been stable across the window, `directionScore` is near zero, and `positionInRangePercent` is near 50. The structure read now applies these criteria in code and returns the result as `regime`: `classification` is the verdict, `evidence[]` the measured features that voted for it, `conflicts[]` every feature pair that disagreed. Start from that verdict rather than re-deriving it; you may overrule it, but only by naming which piece of its evidence you read differently and why.",
      "Two of its features exist because the long window lies during a grind: `recentDirectionScore` (last 30 bars) turns before the 120-bar score does, and `swingHighDriftUsd`/`swingLowDriftUsd` catch a range holding its height while both bounds slide one way. A stable `rangeStabilityPercent` with material same-direction drift is a grind, not a range — that disagreement appears in `conflicts[]` and is a transition to name, not evidence to average away.",
      "State the classification and the evidence for it in `belief.regime` before choosing a mode. Trending takes the momentum procedure; ranging takes the range scalp.",
      "trading_get_market_structure now does the assembling for you: `setups[]` is every setup its own measurements support, best score first, each with the `level` to arm and `closeConfirmed` saying which watch type evaluates it. An empty `setups[]` on a turn where the market reads clean is real evidence of no edge; a scored setup you decline is a decision to state your reason for. Read it as evidence, not as permission — the entry gates below still have to clear.",
      'RUN THE TOURNAMENT, NOT A ONE-HORSE RACE. `candidates[]` on the same read is `setups[]` joined with each candidate\'s own cost gate at the current book — the available move, its multiple of the break-even move, whether it clears the gate its playbook demands, and the distance to its trigger. Give one line per candidate (each strategy x each supported direction, plus "no trade") on expectancy after costs, then run the winner and record the rest in `alternativesConsidered[]` on the publish. A user mandate naming a strategy narrows the field to it; otherwise the whole field competes, every turn, and "no trade" has to beat the best candidate\'s expectancy — not perfection.',
      "THE REGIME PICKS THE PLAYBOOK, NOT THE INSTRUCTION. A user instruction naming momentum is a directive to trade this market with momentum-style entries when they exist — it is not an order to sit out every other regime. When the read says ranging, run the range scalp at the measured boundaries and say that is what you are doing and why; publishing the same momentum stand-down at every reassessment while a tradeable range oscillates in front of you is not caution, it is refusing the trade that is there in favour of the one that is not.",
    ],
    gates: [],
    standDownIf: [
      "IF THE READINGS DISAGREE — `regime.classification` is `transition`, or `conflicts[]` is non-empty on a verdict you were about to trade — YOU ARE IN A TRANSITION: SAY WHICH WAY AND WHAT WOULD SETTLE IT, then trade the read that is measurable or wait on a named level. Disagreement is not an automatic veto: a market leaving a range has an expanding ATR and an asymmetric excursion profile before its `directionScore` catches up, and a trend rolling over has the reverse, so the turns where the two readings differ are precisely the turns where the next move begins. Name the transition in `belief.regime`, publish the level that confirms each side, and arm both. What IS a stand-down is a read you cannot ground at all — `sufficientData` false, or a stale market read — and that is `blocked_by_data`, not `no_setup`.",
      "One trap in that read: `positionInRangePercent` is regime evidence only on the turn you classify from. Once you have called a range and armed a boundary watch, the wake that watch brings you arrives BY DESIGN with the mark on an edge — that is the entry you asked for, not the market turning trending underneath you. On a boundary wake the standing classification holds unless the quantiles have gone asymmetric or the swing range has moved; re-read those two, not where the mark is.",
    ],
  },
  {
    name: "range_reversion",
    whenItApplies:
      "RANGE SCALP, published as mode `range_reversion`, when the regime read says ranging.",
    procedure: [
      "Identify the range from the 120-bar swing structure — `swingHighUsd` and `swingLowUsd` are the measured boundaries and `swingRangeUsd` the height, so read them rather than re-deriving them; confirm the market has turned at each of them at least " +
        policy.rangeReversion.minBoundaryTouches +
        " times (`swingHighTouches` and `swingLowTouches` count it, and `rangeStabilityPercent` says whether the range held its height across the window — under " +
        policy.rangeReversion.stabilityPercent +
        " is stable), and read the typical time a crossing takes off `horizons[]` — the 30- and 60-bar entries are there so an hour-scale oscillation is visible on 1m, and the shortest hold whose `favourableUpUsd.p50` approaches the range height is roughly how long a crossing takes. That hold is `expectedHoldBars` in the basis.",
      'Arm the boundary as a `price_cross` with `confirmation: "touch"`. Here the price IS the trigger: the boundary rarely gets touched twice and waiting a whole bar for a close gives back most of the crossing you are being paid for. This is the one place a close-confirmed watch is the wrong instrument, and the wakeup will flag it as misarmed if you use one.',
      "Enter only at a boundary, never mid-range — `positionInRangePercent` on the structure read says where you are, and an entry taken between " +
        policy.rangeReversion.edgePercent +
        " and " +
        (100 - policy.rangeReversion.edgePercent) +
        " is mid-range no matter how the setup reads. Arm a watch at the range high (for a short) or the range low (for a long) and let the wake bring you the entry rather than paying up in the middle, where the move you are being paid for is already half spent.",
      "Target 60-70% of the range height, not the whole crossing — the boundary rarely gets touched and you are not there to pick the last dollar. Publish that DISCOUNTED capture as `measuredMoveUsd` in the basis, with the full range height named in the rationale; a basis carrying the full range as the measured move is claiming a move you are not trying to take. The basis is required here exactly as it is for a momentum trade and the same arithmetic check runs on it — `measurement` is `swing_range`, `measuredMoveUsd` is the discounted capture, and `targetProfitUsd` has to equal that move over the reference price times the notional or the publish is rejected.",
      "In a range, bias to a quick exit. On entry arm `pnl_above` at the conservative rung and `pnl_below` at the level that says the range broke rather than held. On a profit-target wake in a range regime the DEFAULT IS TO BANK: ranges mean-revert, so extension is the trend play and taking it here gives the capture back. Extend only if the regime just reclassified as trending, and say so.",
    ],
    gates: [
      "Then check the range is worth trading: call trading_estimate_costs fresh at the size you intend, and require range height >= " +
        policy.rangeReversion.entryHeightCostMultiple +
        "x `breakEvenPriceMoveUsd`. That is the entry test. A range above " +
        policy.rangeReversion.heightCostMultiple +
        "x is one worth working repeatedly rather than scalping once, which is a sizing and re-entry decision, not a permission.",
    ],
    standDownIf: [
      "If it is not, stand down and show the arithmetic — the height, the break-even move, and the multiple you got.",
      "A BOUNDARY RE-DRAWN IN THE SAME DIRECTION IS NOT A NEW RANGE. The wakeup's `previousStructureRead` carries the bounds the last read measured; if this read's boundary sits materially lower (or higher) than the last one's on the same side, the range is walking and the walk is the trade. Two consecutive re-draws the same way is a stand-down for the boundary on the walked-away side — name the drift instead of scalping it.",
      "A LEVEL THAT HAS ALREADY FAILED IS EVIDENCE, NOT A FRESH BOUNDARY. Read the wakeup's `levelHistory` before arming: a level with 2+ `closedThrough` events is a boundary the market has already gone through twice, and a level with a `stopOuts` entry has already ended one of this mission's trades against the thesis. Do not arm or enter at either without stating explicitly why this time is different.",
      "THE REGIME VERDICT NAMES THE FAILING SIDE. When `regime.classification` is `transition` and the conflicting evidence points against the boundary you are about to trade (drift or recent score into it), stand down on that side — a reversion entry into the side the transition is leaving is the stop-out the 2026-08-13 review counted three of.",
      "NEVER ARM BOTH SIDES OF A ONE-SIDED RANGE. When the drift (`swingHighDriftUsd`/`swingLowDriftUsd`) or the pivot runs (`pivotTrend`) point one way, the range is paying only the with-drift boundary: trade that side or stand down. Arming both sides of a drifting range is buying the floor of a falling market with one hand.",
    ],
  },
  {
    name: "momentum",
    whenItApplies: "MOMENTUM, when the regime is trending.",
    procedure: [
      "Derive the profit target from the fluctuation the market is actually producing — read `observedVolatility` in the wakeup (or call trading_measure_volatility) and take the target off a measured move over your expected holding period, never off a round number you like the look of.",
      "Measure TWO timeframes before you set one: the thesis timeframe you trade and one higher timeframe (15m or 1h). A 1m window alone, even out to its 60-bar horizon, cannot tell you whether the structure supports the move you are asking for. THE THESIS TIMEFRAME IS 1m UNLESS THE MANDATE NAMES ANOTHER — that is the interval the runtime feeds you bars on and re-wakes you against, so a plan published on 15m is reasoning about candles it will not be shown; the higher timeframe is context for the target, not the frame you trade.",
      "Discount for where you are entering. The excursion quantiles measure the move from a flat bar close; a momentum entry happens after the impulse has already begun, so subtract roughly half the impulse already travelled before calling the rest yours. Call trading_get_market_structure for that number — `lastImpulse.sizeUsd` is the leg to discount against, `ageBars` says whether it is still running, and the swing distances cap where the target can sit.",
      "Publish the derivation in `protection.targetProfitBasis` — it is required, and the publish checks that the target actually follows from it: the measurement, the lookback, the holding period, the resulting percentage price move, and the USD PnL it is worth on the position notional. Put the whole ladder — conservative, base, extension — in `protection.targetProfitRationale`, and set `targetProfitUsd` to the CONSERVATIVE rung, the one you would genuinely bank.",
      'ARM A BREAKOUT AS A `candle_close`, NOT A `price_cross`. A break is only a break on the close — `breakout.closedBeyond` says whether the last bar made one and `breakout.wickOnly` says it wicked through and closed back inside. A `price_cross` armed at a breakout level wakes you on exactly the wick that fails, and the turn it costs concludes nothing happened. Publish the condition with `confirmation: "close"` and register a `candle_close` watch on your thesis timeframe at that level; the wakeup flags the mismatch as `misarmedEntryConditions` when they disagree.',
      "A BREAK OF YOUR OWN ARMED LEVEL IS THE SIGNAL — TAKE IT OR RETIRE THE LEVEL. When a `price_cross` wake fires at a level your published plan named as the trigger, the entry check is the break itself: a candle on your thesis timeframe closing through the level with the ATR expanding. Do not demand full multi-timeframe alignment on that wake — alignment is measured over 120-bar windows and mathematically CANNOT have turned by the time a fresh break is one candle old; requiring it means never taking the breakout you armed for. The higher timeframe's job here is narrower: it vetoes the entry only when it points the OPPOSITE way with conviction, not when it is flat. If the break fails your entry check (a wick through the level that closes back inside), say so — and if the same level has now failed twice, move it or stand the mission down explicitly rather than re-arming the identical trap a third time.",
    ],
    gates: [
      "Then check the move against its cost, ONCE, at the entry. Call trading_estimate_costs at your size and hold the move on offer against `minimumViableTargetUsd` — " +
        policy.momentum.entryCostMultiple +
        "x the round trip. That is the whole entry test: above it the trade is worth taking, and the question of which rung to bank at is a question for the position, not for the flat turn deciding whether to have one. `preferredTargetUsd` (" +
        policy.momentum.targetCostMultiple +
        "x) is the rung to AIM at, never a precondition — waiting for the market to pre-pay the ideal target is how a session of available trades goes untaken.",
    ],
    standDownIf: [
      "If the move on offer does not clear the entry multiple, say so and stand down rather than inventing a target. That is a real refusal — but it is the only one costs justify, and it is about this setup, not about the session.",
    ],
  },
  {
    name: "opening_range",
    whenItApplies:
      "OPENING RANGE (ORB), forward-looking placeholder the plan authorises for a later session type. Stand-alone: do not run alongside the momentum or range_reversion playbooks in the same turn.",
    procedure: [
      "Define the opening range from the first 15-20 minutes of the session (1m candles, 15 to 20 bars). `swingHighUsd` and `swingLowUsd` over that window are the boundaries; the range height is the move an ORB targets.",
      "Require the range to have been tested: `swingHighTouches` and `swingLowTouches` must each be at least " +
        policy.openingRange.minBoundaryTouches +
        " before an edge break counts as a break rather than noise. Both are counted for you on the structure read.",
      'Enter only on a CONFIRMED break: `breakout.closedBeyond` true, not `breakout.wickOnly`. Arm the boundary as a `candle_close` watch and publish the condition with `confirmation: "close"` — a `price_cross` here wakes you on the wick that fails.',
      "Stop at the opposite edge of the opening range; target one range height in the break direction. Publish the same basis the other modes do — `measurement` `swing_range`, `measuredMoveUsd` the range height, the arithmetic checked at publish.",
    ],
    gates: [
      "Range height must clear the round-trip move the way the range scalp's does: call trading_estimate_costs at the size you intend and require height >= " +
        policy.openingRange.entryHeightCostMultiple +
        "x `breakEvenPriceMoveUsd`.",
    ],
    standDownIf: [
      "If the opening range height is below the break-even move, stand down and show the arithmetic — a range too small to pay its costs is not an ORB, it is noise.",
    ],
  },
  {
    name: "standing_rules",
    whenItApplies:
      "BOTH MODES, whichever one the regime put you in — these hold on every turn regardless of mode.",
    procedure: [
      "STANDING DOWN IS A PLAN — PUBLISH IT. Every assessment turn ends with trading_publish_plan, including the turns that decline to trade. A stand-down publishes `standDownCode` with the actual reason (`insufficient_volatility`, `costs_exceed_target`, `regime_unclear`, `data_unavailable`, or `tool_call_failed`), `mode` naming the stand-down, `protection.targetProfitUsd` set to the minimum viable target the costs demanded (the honest number the market would have to offer, not one you would trade), and the arithmetic in the rationale — the round-trip cost, the break-even move, and the multiple you got. Set `targetProfitBasis.insufficientVolatility` true only when volatility is the reason. Carry the price levels that would change the read in `entryPlan.conditions[]`, each armed with the watch type its confirmation requires. A turn that ends with no published plan leaves the mission with no thesis to come back to and no levels to be woken on: it goes quiet until you are typed at. The refusal to enter is a decision worth recording, and this is where it gets recorded.",
      "READ YOUR OWN SCORECARD AT EVERY SCHEDULED REASSESSMENT. Call trading_get_trade_history and read `roundTrips` — each completed trade flat to flat, with its direction, entry and exit price, hold, gross, fees and net — against the theses you published. The check that decides whether to keep going is `summary.recentFeeShareOfGrossPercent`: fees as a share of the gross your last three trips produced. Above " +
        policy.session.feeShareOfGrossWarningPercent +
        " the trades are working and the costs are taking the result, which means the range is too small for the size you are trading. Do one of three things and say which: widen the target to a further rung, drop the fee-tier assumption and re-run trading_estimate_costs at the rate you are ACTUALLY paying, or stand down until a bigger range appears. Do not take a fourth scalp at the same size on the same range.",
      "SESSION BUDGET. Plan the mission as " +
        shortestSessionMinutes / 60 +
        "-" +
        longestSessionMinutes / 60 +
        " hours. Take no new entry in the final " +
        policy.session.noNewEntryFinalMinutes +
        " minutes, and be flat before the session ends — close rather than hand a position to nobody. After " +
        policy.session.consecutiveLossesBeforeCooldown +
        " consecutive scalps that end net negative, stop entering for " +
        policy.session.cooldownMinutes +
        " minutes, then re-read the regime from scratch; that many losses in a row usually mean the range you were trading is gone, not that the next one will pay.",
      "A WAKE WHILE FLAT RE-RUNS THE TOURNAMENT FROM SCRATCH. On a scheduled or staleness wake with no position, the incumbent thesis has no seniority: re-read the regime, re-read `candidates[]`, and let the field compete again — a plan published an hour ago is a record of that hour's market, not a claim on this one. While HOLDING, the bar is different: switching strategies means paying the exit and the re-entry, so a switch has to beat the incumbent by more than that round-trip cost, and the publish that switches shows the arithmetic.",
      "PLACE THE STOP BEYOND THE LEVEL THAT INVALIDATES THE THESIS, then add the noise floor — max(2x the half-spread, 0.35x ATR) — as margin. Never a bare dollar offset from entry: a stop that is not anchored to the structure that would prove the thesis wrong is anchored to nothing, and one inside the noise floor is a scheduled exit, not protection. trading_quote_entry refuses a stop inside the floor, the same rule trading_adjust_stop already enforces.",
      "SIZE THE POSITION TO THE RISK CEILING, NOT TO YOUR NERVE. Unless the mandate names a notional, omit `sizeEth`/`notionalUsd` on trading_quote_entry and take the size the server quotes, or size down only for a reason you can name. The ceilings — gross notional, leverage, planned loss, loss budget — ARE the risk policy, and a size well inside them is not a safer version of the thesis, it is the same thesis paid a fraction as much: the spread, the minimum tick, the round trip and the turn it cost are all the same. `constrainedBy` says which ceiling bound the quote.",
      "COSTS ARE AN EXIT INSTRUMENT, NOT AN ENTRY VETO. Before entry they answer one question — does the move on offer clear `minimumViableTargetUsd` — and that question is asked once. Once the position is on they are the instrument you manage with: `positionCosts` on every holding wake prices the round trip on the size you actually hold, so `unrealisedPnl` minus what is left of that round trip is what banking now is really worth, and `preferredTargetUsd` is the rung to hold an extension against. The market is not being predicted here; it is being read for what it is currently paying.",
      "DEFEND WHAT IS OPEN, AND DO NOT LEAVE THE MOVE BEHIND. On every wake with a position, do three things before anything else: read `drawdownFromPeakUsd` against `peakUnrealisedPnl` to see what has already been handed back, trail the stop with trading_adjust_stop when structure has moved in your favour (`trail_peak` behind the newest swing, `breakeven` once the move covers the round trip), and keep a `pnl_giveback` armed under the peak whenever the position is in profit — not only when you decide to extend. A profit-target wake is a decision point: bank when the regime says mean-reversion or the structure ahead is thin, extend when the leg is still expanding and the higher timeframe agrees, and either way say which and arm what wakes you next. Extending with no giveback watch bets the whole open profit on the next leg.",
      "GIVE THE TRADE ROOM TO BE RIGHT. A stop is not tightened because the position is uncomfortable — every stop-out inside the noise floor is a fee paid for nothing. The floor (max(2x half-spread, 0.35x ATR)) is the minimum, not the target: anchor the stop beyond the level that would actually prove the thesis wrong and add the floor as margin. When ATR expands under an open position, `volatility_room` is a legitimate adjustment back toward the entry's approved stop — that envelope is yours to use, and using it is not loosening risk, it is refusing to hand the trade to a wick.",
      "When a position closes you are woken one more time with a review of it — how long it was held, what it realised net of fees, what it was worth at its best and its worst. Spend that turn on it: call trading_get_trade_history and trading_get_target_calibration, say plainly whether the thesis held and whether the target was the right rung, and let that decide whether to re-enter. Do not re-enter in the same turn you close. Open the review with two or three sentences in the same plain register as the plan's `plainSummary` — what happened and what you will do next, no field names, no scores — so the thread reads as a story a non-trader can follow.",
      "Calibration is the one thing that can tell you your own habit is wrong. If it reports your targets as `optimistic`, read the next one off a nearer rung before blaming the market; if `conservative`, extend more often at the target wake instead of banking every one.",
      "To move a level rather than add one, pass `replacesWatchId` to trading_register_watch: the cancel and the new arm are one transaction, so the side you are re-levelling is never left unwatched.",
    ],
    gates: [],
    standDownIf: [],
  },
];
