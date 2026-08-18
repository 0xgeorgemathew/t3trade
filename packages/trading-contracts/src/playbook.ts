/**
 * Trading playbooks - the procedure the harness used to carry as doctrine in
 * `POC_DEFAULT_INSTRUCTION`, split into one playbook per mode and reachable
 * through the `trading_strategy` tool.
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
 * number typed into `marketStructure.ts` and `costs.ts`. Two of them — the session
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
 * The playbooks the `trading_strategy` tool returns by name.
 *
 * `classify` is the regime read; `momentum` and `range_reversion` are the two
 * modes a regime resolves to; `opening_range` is the ORB placeholder the plan
 * authorises for a later session type; `ema_cross` and `rsi_reversion` are the
 * two strategies whose evidence is a single indicator reading rather than a
 * structural level, each standalone rather than a filter on the structural
 * ones; `standing_rules` is what holds in every mode.
 *
 * The indicator is never the strategy. An EMA crossing and an RSI at 72 are
 * measurements; the playbook around them — which boundary to enter at, which
 * gates to clear, when to stand down — is what makes either a decision.
 */
export const TradingPlaybookName = Schema.Literals([
  "classify",
  "momentum",
  "range_reversion",
  "opening_range",
  "ema_cross",
  "rsi_reversion",
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
 * The playbooks, in the order `trading_strategy` returns them when no
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
      "The regime read — how to tell trending from ranging off the structure measurement, for the turns whose decision rests on it.",
    procedure: [
      "Take `observedVolatility` and trading_look and decide which of two markets you are in. TRENDING: the excursion quantiles are asymmetric (favourableUp and favourableDown differ materially at the same horizon), `directionScore` is away from zero, `atrExpansionRatio` is above 1, and the mark sits near a window extreme. RANGING: `excursionSymmetryRatio` is near 1, the swing range has been stable across the window, `directionScore` is near zero, and `positionInRangePercent` is near 50. The structure read now applies these criteria in code and returns the result as `regime`: `classification` is the verdict, `evidence[]` the measured features that voted for it, `conflicts[]` every feature pair that disagreed. Start from that verdict rather than re-deriving it; you may overrule it, but only by naming which piece of its evidence you read differently and why.",
      "Two of its features exist because the long window lies during a grind: `recentDirectionScore` (last 30 bars) turns before the 120-bar score does, and `swingHighDriftUsd`/`swingLowDriftUsd` catch a range holding its height while both bounds slide one way. A stable `rangeStabilityPercent` with material same-direction drift is a grind, not a range — that disagreement appears in `conflicts[]` and is a transition to name, not evidence to average away.",
      "Trending takes the momentum procedure; ranging takes the range scalp. State the classification and the evidence for it in the plan's `because` when the turn's decision rests on it.",
      "trading_look now does the assembling for you: `setups[]` is every setup its own measurements support, best score first, each with the `level` to arm and `closeConfirmed` saying which watch type evaluates it. An empty `setups[]` on a turn where the market reads clean is real evidence of no edge; a scored setup you decline is a decision to state your reason for. Read it as evidence, not as permission — the playbook procedures below still decide how an entry is taken.",
      "`candidates[]` on the same read is `setups[]` joined with what each candidate costs to take at the current book — the available move, its multiple of the break-even move, and the distance to its trigger. No-trade is one of the options, every turn.",
    ],
    gates: [],
    standDownIf: [
      "IF THE READINGS DISAGREE — `regime.classification` is `transition`, or `conflicts[]` is non-empty on a verdict you were about to trade — YOU ARE IN A TRANSITION: SAY WHICH WAY AND WHAT WOULD SETTLE IT, then trade the read that is measurable or wait on a named level. Disagreement is not an automatic veto: a market leaving a range has an expanding ATR and an asymmetric excursion profile before its `directionScore` catches up, and a trend rolling over has the reverse, so the turns where the two readings differ are precisely the turns where the next move begins. Name the transition in the plan's `because`, publish the level that confirms each side, and arm both. What IS a stand-down is a read you cannot ground at all — `sufficientData` false, or a stale market read — and that is `blocked_by_data`, not `no_setup`.",
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
        " is stable), and read the typical time a crossing takes off `horizons[]` — the 30- and 60-bar entries are there so an hour-scale oscillation is visible on 1m, and the shortest hold whose `favourableUpUsd.p50` approaches the range height is roughly how long a crossing takes. That hold is the one to size the target and the stop over.",
      'Arm the boundary with trading_watch as a `price` condition on touch — the default — and publish it with `confirmation: "touch"`. Here the price IS the trigger: the boundary rarely gets touched twice and waiting a whole bar for a close gives back most of the crossing you are being paid for. This is the one place a close-confirmed watch is the wrong instrument, and the wakeup will flag it as misarmed if you use one.',
      "Enter only at a boundary, never mid-range — `positionInRangePercent` on the structure read says where you are, and an entry taken between " +
        policy.rangeReversion.edgePercent +
        " and " +
        (100 - policy.rangeReversion.edgePercent) +
        " is mid-range no matter how the setup reads. Arm a watch at the range high (for a short) or the range low (for a long) and let the wake bring you the entry rather than paying up in the middle, where the move you are being paid for is already half spent.",
      "Target 60-70% of the range height, not the whole crossing — the boundary rarely gets touched and you are not there to pick the last dollar. Size `target.profitUsd` off that DISCOUNTED capture, name the full range height in `because`, and publish `target.price` at the boundary the capture reaches; a target claiming the whole crossing is claiming a move you are not trying to take.",
      "In a range, bias to a quick exit. On entry arm a `pnl` condition `above` at the conservative rung and one `below` at the level that says the range broke rather than held. On a profit-target wake in a range regime the DEFAULT IS TO BANK: ranges mean-revert, so extension is the trend play and taking it here gives the capture back. Extend only if the regime just reclassified as trending, and say so.",
    ],
    gates: [
      "Then ask the one question costs answer: is the height you can capture bigger than the round trip? Call trading_look fresh at the size you intend and hold the capture (60-70% of the height) against `roundTripUsd`. A range whose height is above " +
        policy.rangeReversion.heightCostMultiple +
        "x the round trip is one worth working repeatedly rather than scalping once, which is a sizing and re-entry decision, not a permission.",
    ],
    standDownIf: [
      "If the capture cannot pay the round trip, stand down and show the arithmetic — the height, the round trip, and the multiple you got.",
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
      "Derive the profit target from the fluctuation the market is actually producing — read `observedVolatility` in the wakeup (or call trading_look) and take the target off a measured move over your expected holding period, never off a round number you like the look of.",
      "Measure TWO timeframes before you set one: the thesis timeframe you trade and one higher timeframe (15m or 1h). A 1m window alone, even out to its 60-bar horizon, cannot tell you whether the structure supports the move you are asking for. THE THESIS TIMEFRAME IS 1m UNLESS THE MANDATE NAMES ANOTHER — that is the interval the runtime feeds you bars on and re-wakes you against, so a plan published on 15m is reasoning about candles it will not be shown; the higher timeframe is context for the target, not the frame you trade.",
      "Discount for where you are entering. The excursion quantiles measure the move from a flat bar close; a momentum entry happens after the impulse has already begun, so subtract roughly half the impulse already travelled before calling the rest yours. Call trading_look for that number — `lastImpulse.sizeUsd` is the leg to discount against, `ageBars` says whether it is still running, and the swing distances cap where the target can sit.",
      "Show the derivation in `because` — the measurement, the lookback, the holding period, and the whole ladder (conservative, base, extension) — and set `target.profitUsd` to the CONSERVATIVE rung, the one you would genuinely bank. Publish `target.price` when the plan names the level it is aiming at; that is the price the server rests the take-profit at.",
      'ARM A BREAKOUT ON THE CLOSE, NOT THE TOUCH. A break is only a break on the close — `breakout.closedBeyond` says whether the last bar made one and `breakout.wickOnly` says it wicked through and closed back inside. A level armed on touch wakes you on exactly the wick that fails, and the turn it costs concludes nothing happened. Publish the condition with `confirmation: "close"` and arm a `price` condition with `confirm: "close"` and the `interval` of your thesis timeframe at that level; the wakeup flags the mismatch as `misarmedEntryConditions` when they disagree.',
      "A BREAK OF YOUR OWN ARMED LEVEL IS THE SIGNAL — TAKE IT OR RETIRE THE LEVEL. When a level wake fires at a level your published plan named as the trigger, the entry check is the break itself: a candle on your thesis timeframe closing through the level with the ATR expanding. Do not demand full multi-timeframe alignment on that wake — alignment is measured over 120-bar windows and mathematically CANNOT have turned by the time a fresh break is one candle old; requiring it means never taking the breakout you armed for. The higher timeframe's job here is narrower: it vetoes the entry only when it points the OPPOSITE way with conviction, not when it is flat. If the break fails your entry check (a wick through the level that closes back inside), say so — and if the same level has now failed twice, move it or stand the mission down explicitly rather than re-arming the identical trap a third time.",
    ],
    gates: [
      "Then ask the one question costs answer, ONCE, at the entry: call trading_look and hold the move on offer against the `cost` line it returns — is the expected move over your intended hold bigger than the round trip is worth? If it is, the trade is worth taking, and the question of which rung to bank at is a question for the position, not for the flat turn deciding whether to have one. The rung to AIM at (" +
        policy.readings.targetCostMultiple +
        "x the round trip) is never a precondition — waiting for the market to pre-pay the ideal target is how a session of available trades goes untaken. Once the position is on, `positionCosts.preferredTargetUsd` states that rung on the size you actually hold.",
    ],
    standDownIf: [
      "If the move on offer cannot pay the round trip, say so and stand down rather than inventing a target. That is a real refusal — but it is the only one costs justify, and it is about this setup, not about the session.",
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
      'Enter only on a CONFIRMED break: `breakout.closedBeyond` true, not `breakout.wickOnly`. Arm the boundary as a `price` condition with `confirm: "close"` and its `interval`, and publish the condition with `confirmation: "close"` — arming it on touch wakes you on the wick that fails.',
      "Stop at the opposite edge of the opening range; target one range height in the break direction, sized off that height in `target.profitUsd` with `target.price` at the level it reaches.",
    ],
    gates: [
      "The range height has to pay for the break the way the range scalp's capture does: call trading_look at the size you intend and weigh the height against the round trip it reports.",
    ],
    standDownIf: [
      "If the opening range height is below the round trip, stand down and show the arithmetic — a range too small to pay its costs is not an ORB, it is noise.",
    ],
  },
  {
    name: "ema_cross",
    whenItApplies:
      "EMA CROSS, the simplest directional strategy there is: the 9-period EMA crossing the 21-period one on the thesis timeframe. A STANDALONE strategy, not a filter on the others — 'the cross says up and the structure says nothing' is a candidate to price, not a signal with nowhere to go.",
    procedure: [
      "Read `ema` on the thesis timeframe of trading_look. `spreadUsd` is fast minus slow — its SIGN is the bias, its size is how separated the two are — and `barsSinceCross` is how long ago that sign last flipped. A cross older than " +
        policy.emaCross.maxCrossAgeBars +
        " bars is not a signal, it is a description of where price has already been. Nothing scores this for you: `ema` carries the bias as `direction`, the separation as `separationAtr`, and the age as `barsSinceCross`, and the judgement is yours.",
      "Require the two averages to be genuinely apart: |spreadUsd| at least " +
        policy.emaCross.minSpreadAtrRatio +
        "x the frame's ATR. Two averages grazing each other in chop cross constantly, and every one of those crossings is a round trip paid for nothing.",
      'ARM THE FAST EMA ON THE CLOSE, NOT THE TOUCH. Price oscillates around its own average all day; only a bar CLOSING beyond the fast EMA says the cross is being traded. Publish the condition with `confirmation: "close"` and arm a `price` condition at `ema.fastUsd` with `confirm: "close"` and the `interval` of the thesis timeframe.',
      "Derive the target the way every other mode does — off measured volatility over the expected hold, published as the conservative rung. A cross has no range height and no impulse of its own to be paid out of, so the move it is played for is " +
        policy.emaCross.targetAtrMultiple +
        "x ATR. This playbook does not appear in `candidates[]` — price the round trip against that move yourself, from `cost`. Measure it rather than assume it: if the ATR says the move is smaller than that, the smaller number is the one to publish.",
      "Stop beyond the SLOW EMA, plus the noise floor. That is the level that says the cross was wrong — not a dollar offset, and not the fast EMA, which price is expected to trade back through while the bias holds.",
      "The cross is also the exit thesis: a close back through the fast EMA against the bias is the first warning, and a re-cross of the pair is the thesis over. Publish both as exit conditions rather than holding on the target alone.",
    ],
    gates: [
      "Call trading_look fresh at the size you intend and weigh the expected move (" +
        policy.emaCross.targetAtrMultiple +
        "x ATR) against the round trip in `cost`. No row is precomputed for this one — the arithmetic is the entry decision, so do it and show it.",
    ],
    standDownIf: [
      "If the expected move cannot pay the round trip, stand down on THIS candidate and show the arithmetic — a cross that cannot pay its costs says nothing about the range boundary two dollars away.",
      "A CROSS INSIDE A RANGE IS NOISE. When `regime.classification` is `ranging` and the swing range has held its height, the pair will cross at every oscillation and each crossing is the middle of the range — the worst entry the range offers. Trade the boundary instead, and say that is what you are doing.",
    ],
  },
  {
    name: "rsi_reversion",
    whenItApplies:
      "RSI BAND REVERSION: Wilder's RSI(14) at an extreme, faded back toward the middle. The other strategy that reads a single indicator rather than a structural level, standalone beside the EMA cross — it weighs one oscillator against fixed bands and needs no structural range at all. The oscillator is the evidence; this procedure is the strategy.",
    procedure: [
      "Read `rsi` on the thesis timeframe. `condition` applies the bands (" +
        "overbought at 70, oversold at 30) so two turns cannot pick two different ones, and `barsSinceEnteringExtreme` is how long the extreme has held.",
      "Fade the extreme: overbought is a short, oversold is a long. Enter at the boundary the extreme was MADE at — `swingHighPrice` for a short, `swingLowPrice` for a long — not wherever price has drifted to since, and arm it as a `price` condition on touch — the default — with " +
        '`confirmation: "touch"` published alongside it. Like the range boundary, the price IS the trigger here: waiting a whole bar for a close gives back most of the snap-back you are being paid for.',
      "Play it for " +
        policy.rsiReversion.targetSwingFraction * 100 +
        "% of the swing range — the move back toward the middle, not a reversal. Size `target.profitUsd` off that partial capture, and say in `because` that the full height is not what is being claimed.",
      "Stop beyond the extreme itself plus the noise floor: the thesis is that price is stretched, and a new extreme is that thesis failing.",
      "Bank at the conservative rung. A reversion that reaches the middle has delivered exactly what it promised; holding it for a reversal is trading a different strategy with this one's stop.",
    ],
    gates: [
      "Weigh the capture against the round trip at the size you intend — `candidates[]` carries the same row as `costMultiple`.",
      "Require the extreme to be FRESH: no more than " +
        policy.rsiReversion.maxExtremeAgeBars +
        " bars old. An oscillator that has been pinned at 75 for forty bars is measuring a trend, not a stretch.",
    ],
    standDownIf: [
      "NEVER FADE A MARKET STILL DRIVING INTO THE BAND. When the recent 30-bar directional score points into the extreme with conviction, this is a leg being ridden and selling it is the losing half of this strategy's reputation. The structure read applies that veto in code and simply does not score the candidate; do not overrule it without naming what has turned.",
      "If the swing range cannot be measured at all, there is no move to target and no stop to anchor — that is `blocked_by_data`, not a trade at the current price.",
    ],
  },
  {
    name: "standing_rules",
    whenItApplies:
      "BOTH MODES, whichever one the regime put you in — these hold on every turn regardless of mode.",
    procedure: [
      "Publish a plan when you have one; revise it when it changes. A stand-down publishes once and does not re-publish unchanged.",
      "READ YOUR OWN SCORECARD AT EVERY SCHEDULED REASSESSMENT. Call trading_look and read `roundTrips` — each completed trade flat to flat, with its direction, entry and exit price, hold, gross, fees and net — against the theses you published. The check that decides whether to keep going is `summary.recentFeeShareOfGrossPercent`: fees as a share of the gross your last three trips produced. Above " +
        policy.session.feeShareOfGrossWarningPercent +
        " the trades are working and the costs are taking the result, which means the range is too small for the size you are trading. Do one of three things and say which: widen the target to a further rung, drop the fee-tier assumption and re-run trading_look at the rate you are ACTUALLY paying, or stand down until a bigger range appears. Do not take a fourth scalp at the same size on the same range.",
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
      "WHILE HOLDING, A SWITCH PAYS ITS OWN ROUND TRIP. Switching strategies means paying the exit and the re-entry, so a switch has to beat the incumbent by more than that round-trip cost, and the publish that switches shows the arithmetic.",
      "PLACE THE STOP BEYOND THE LEVEL THAT INVALIDATES THE THESIS, then add the noise floor — max(2x the half-spread, 0.35x ATR) — as margin. Never a bare dollar offset from entry: a stop that is not anchored to the structure that would prove the thesis wrong is anchored to nothing, and one inside the noise floor is a scheduled exit, not protection. trading_enter refuses a stop inside the floor, the same rule trading_exit's move_stop already enforces.",
      "SIZE THE POSITION TO THE RISK CEILING, NOT TO YOUR NERVE. Unless the mandate names a notional, omit `sizeEth`/`notionalUsd` on trading_enter and take the size the server derives, or size down only for a reason you can name. The ceilings — gross notional, leverage, planned loss, loss budget — ARE the risk policy, and a size well inside them is not a safer version of the thesis, it is the same thesis paid a fraction as much: the spread, the minimum tick, the round trip and the turn it cost are all the same. `constrainedBy` on the result says which ceiling bound it.",
      'SIZE THE NOTIONAL TO THE TARGET, NOT THE TARGET TO THE NOTIONAL. The target is a USD figure, the move is a percentage, and the round trip is also a percentage of notional — so the notional is what converts one into the other: notional x (expected move % - round trip %) = the target. Sizing DOWN does not make a target cheaper to reach, it makes it arithmetically unreachable, because the costs shrink with the position and the target does not. trading_enter does this for you: it reads the published target and the level it aims at, works out the notional that pays the target after costs at the current book, and lifts a too-small request up to it — bounded by every risk ceiling, which still bind. `constrainedBy: "target_notional"` is the server saying it did so. When `notes` says the ceilings could not fund the target, that is a target to re-cut off the move the market is actually producing, or a trade to take for a nearer rung — it is NOT a reason to decline a setup whose move pays the round trip.',
      "COSTS ARE CONTEXT BEFORE THE ENTRY AND AN INSTRUMENT AFTER IT. Before entry they answer one question — is the expected move over your intended hold bigger than the round trip — and that question is asked once. Once the position is on they are the instrument you manage with: `positionCosts` on every holding wake prices the round trip on the size you actually hold, so `unrealisedPnl` minus what is left of that round trip is what banking now is really worth, and `preferredTargetUsd` is the rung to hold an extension against. The market is not being predicted here; it is being read for what it is currently paying.",
      "DEFEND WHAT IS OPEN, AND DO NOT LEAVE THE MOVE BEHIND. On every wake with a position, do three things before anything else: read `drawdownFromPeakUsd` against `peakUnrealisedPnl` to see what has already been handed back, trail the stop with trading_exit's move_stop when structure has moved in your favour (`trail_peak` behind the newest swing, `breakeven` once the move covers the round trip), and keep a `giveback` condition armed under the peak whenever the position is in profit — not only when you decide to extend. A profit-target wake is a decision point: bank when the regime says mean-reversion or the structure ahead is thin, extend when the leg is still expanding and the higher timeframe agrees, and either way say which and arm what wakes you next. Extending with no giveback watch bets the whole open profit on the next leg.",
      "GIVE THE TRADE ROOM TO BE RIGHT. A stop is not tightened because the position is uncomfortable — every stop-out inside the noise floor is a fee paid for nothing. The floor (max(2x half-spread, 0.35x ATR)) is the minimum, not the target: anchor the stop beyond the level that would actually prove the thesis wrong and add the floor as margin. When ATR expands under an open position, `volatility_room` is a legitimate adjustment back toward the entry's approved stop — that envelope is yours to use, and using it is not loosening risk, it is refusing to hand the trade to a wick.",
      "When a position closes you are woken one more time with a review of it — how long it was held, what it realised net of fees, what it was worth at its best and its worst. Spend that turn on it: call trading_look with the `retrospect` scope and read its `mission.targetCalibration`, say plainly whether the thesis held and whether the target was the right rung, and let that decide whether to re-enter. Do not re-enter in the same turn you close. Open the review with two or three sentences in the same plain register as the plan's `because` — what happened and what you will do next, no field names, no scores — so the thread reads as a story a non-trader can follow.",
      "Calibration is the one thing that can tell you your own habit is wrong. If it reports your targets as `optimistic`, read the next one off a nearer rung before blaming the market; if `conservative`, extend more often at the target wake instead of banking every one.",
      "To move a level rather than add one, pass `replacesWatchId` to trading_watch: the cancel and the new arm are one transaction, so the side you are re-levelling is never left unwatched.",
      "AN ENTRY TRIGGER IS A LEVEL THE MARKET MUST TRAVEL TO REACH. A level armed above the current price and another armed below it are not two triggers — one of them fires on the very next bar whichever way the market goes, and every firing costs a whole turn to reconclude what the indicators already said. Arm the level your thesis turns on. A stand-aside plan states its entry conditions in `because` and arms NO price level at the current price: what a stand-aside arms is the reassessment, and the runtime already guarantees you one. trading_watch refuses the mirrored arm and names the watch already holding that level.",
    ],
    gates: [],
    standDownIf: [],
  },
];
