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
import { TradingText } from "./primitives.ts";

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
      "Take `observedVolatility` and trading_get_market_structure and decide which of two markets you are in. TRENDING: the excursion quantiles are asymmetric (favourableUp and favourableDown differ materially at the same horizon), `directionScore` is away from zero, `atrExpansionRatio` is above 1, and the mark sits near a window extreme. RANGING: `excursionSymmetryRatio` is near 1, the swing range has been stable across the window, `directionScore` is near zero, and `positionInRangePercent` is near 50.",
      "State the classification and the evidence for it in `belief.regime` before choosing a mode. Trending takes the momentum procedure; ranging takes the range scalp.",
    ],
    gates: [],
    standDownIf: [
      "If the two readings disagree, you are not in a regime you can trade — say so and wait.",
      "One trap in that read: `positionInRangePercent` is regime evidence only on the turn you classify from. Once you have called a range and armed a boundary watch, the wake that watch brings you arrives BY DESIGN with the mark on an edge — that is the entry you asked for, not the market turning trending underneath you. On a boundary wake the standing classification holds unless the quantiles have gone asymmetric or the swing range has moved; re-read those two, not where the mark is.",
    ],
  },
  {
    name: "range_reversion",
    whenItApplies:
      "RANGE SCALP, published as mode `range_reversion`, when the regime read says ranging.",
    procedure: [
      "Identify the range from the 120-bar swing structure — `swingHighUsd` and `swingLowUsd` are the measured boundaries and `swingRangeUsd` the height, so read them rather than re-deriving them; confirm the market has turned at each of them more than once, and read the typical time a crossing takes off `horizons[]` — the 30- and 60-bar entries are there so an hour-scale oscillation is visible on 1m, and the shortest hold whose `favourableUpUsd.p50` approaches the range height is roughly how long a crossing takes. That hold is `expectedHoldBars` in the basis.",
      "Enter only at a boundary, never mid-range — `positionInRangePercent` says where you are, and an entry taken between 20 and 80 is mid-range no matter how the setup reads. Arm a watch at the range high (for a short) or the range low (for a long) and let the wake bring you the entry rather than paying up in the middle, where the move you are being paid for is already half spent.",
      "Target 60-70% of the range height, not the whole crossing — the boundary rarely gets touched and you are not there to pick the last dollar. Publish that DISCOUNTED capture as `measuredMoveUsd` in the basis, with the full range height named in the rationale; a basis carrying the full range as the measured move is claiming a move you are not trying to take. The basis is required here exactly as it is for a momentum trade and the same arithmetic check runs on it — `measurement` is `swing_range`, `measuredMoveUsd` is the discounted capture, and `targetProfitUsd` has to equal that move over the reference price times the notional or the publish is rejected.",
      "In a range, bias to a quick exit. On entry arm `pnl_above` at the conservative rung and `pnl_below` at the level that says the range broke rather than held. On a profit-target wake in a range regime the DEFAULT IS TO BANK: ranges mean-revert, so extension is the trend play and taking it here gives the capture back. Extend only if the regime just reclassified as trending, and say so.",
    ],
    gates: [
      "Then check the range is worth trading: call trading_estimate_costs fresh at the size you intend, and require range height >= 2.2x `breakEvenPriceMoveUsd`.",
    ],
    standDownIf: [
      "If it is not, stand down and show the arithmetic — the height, the break-even move, and the multiple you got.",
    ],
  },
  {
    name: "momentum",
    whenItApplies: "MOMENTUM, when the regime is trending.",
    procedure: [
      "Derive the profit target from the fluctuation the market is actually producing — read `observedVolatility` in the wakeup (or call trading_measure_volatility) and take the target off a measured move over your expected holding period, never off a round number you like the look of.",
      "Measure TWO timeframes before you set one: the thesis timeframe you trade and one higher timeframe (15m or 1h). A 1m window alone, even out to its 60-bar horizon, cannot tell you whether the structure supports the move you are asking for.",
      "Discount for where you are entering. The excursion quantiles measure the move from a flat bar close; a momentum entry happens after the impulse has already begun, so subtract roughly half the impulse already travelled before calling the rest yours. Call trading_get_market_structure for that number — `lastImpulse.sizeUsd` is the leg to discount against, `ageBars` says whether it is still running, and the swing distances cap where the target can sit.",
      "Publish the derivation in `protection.targetProfitBasis` — it is required, and the publish checks that the target actually follows from it: the measurement, the lookback, the holding period, the resulting percentage price move, and the USD PnL it is worth on the position notional. Put the whole ladder — conservative, base, extension — in `protection.targetProfitRationale`, and set `targetProfitUsd` to the CONSERVATIVE rung, the one you would genuinely bank.",
    ],
    gates: [
      "Then check the target against its cost. Call trading_estimate_costs at your size — it prices the round trip from the fee rate this wallet pays and the live book — and hold the target against the `minimumViableTargetUsd` it reports. A target that does not clear TWICE the round-trip cost is not a trade; it is a fee donation with variance.",
    ],
    standDownIf: [
      "If the observed fluctuation does not support a target worth taking after costs, say so and stand down rather than inventing one.",
    ],
  },
  {
    name: "opening_range",
    whenItApplies:
      "OPENING RANGE (ORB), forward-looking placeholder the plan authorises for a later session type. Stand-alone: do not run alongside the momentum or range_reversion playbooks in the same turn.",
    procedure: [
      "Define the opening range from the first 15-20 minutes of the session (1m candles, 15 to 20 bars). `swingHighUsd` and `swingLowUsd` over that window are the boundaries; the range height is the move an ORB targets.",
      "Require the range to have been tested: at least two touches of each boundary inside the formation window before an edge break counts as a break rather than noise.",
      "Enter only on a CONFIRMED break: a 1m candle must CLOSE beyond a boundary, not merely trade through it. A wick that prints back inside the range by the close is not a break.",
      "Stop at the opposite edge of the opening range; target one range height in the break direction. Publish the same basis the other modes do — `measurement` `swing_range`, `measuredMoveUsd` the range height, the arithmetic checked at publish.",
    ],
    gates: [
      "Range height must clear the round-trip move the way the range scalp's does: call trading_estimate_costs at the size you intend and require height >= 2.2x `breakEvenPriceMoveUsd`.",
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
      "READ YOUR OWN SCORECARD AT EVERY SCHEDULED REASSESSMENT. Call trading_get_trade_history and read `roundTrips` — each completed trade flat to flat, with its direction, entry and exit price, hold, gross, fees and net — against the theses you published. The check that decides whether to keep going is `summary.recentFeeShareOfGrossPercent`: fees as a share of the gross your last three trips produced. Above 50 the trades are working and the costs are taking the result, which means the range is too small for the size you are trading. Do one of three things and say which: widen the target to a further rung, drop the fee-tier assumption and re-run trading_estimate_costs at the rate you are ACTUALLY paying, or stand down until a bigger range appears. Do not take a fourth scalp at the same size on the same range.",
      "SESSION BUDGET. Plan the mission as 1-2 hours. Take no new entry in the final 15 minutes, and be flat before the session ends — close rather than hand a position to nobody. After three consecutive scalps that end net negative, stop entering for 30 minutes, then re-read the regime from scratch; three losses in a row usually mean the range you were trading is gone, not that the next one will pay.",
      "When a profit-target wake decides to extend rather than bank, arm a `pnl_giveback` watch beneath the peak before ending the turn. Extending without one bets the whole open profit on the next leg.",
      "When a position closes you are woken one more time with a review of it — how long it was held, what it realised net of fees, what it was worth at its best and its worst. Spend that turn on it: call trading_get_trade_history and trading_get_target_calibration, say plainly whether the thesis held and whether the target was the right rung, and let that decide whether to re-enter. Do not re-enter in the same turn you close.",
      "Calibration is the one thing that can tell you your own habit is wrong. If it reports your targets as `optimistic`, read the next one off a nearer rung before blaming the market; if `conservative`, extend more often at the target wake instead of banking every one.",
      "To move a level rather than add one, pass `replacesWatchId` to trading_register_watch: the cancel and the new arm are one transaction, so the side you are re-levelling is never left unwatched.",
    ],
    gates: [],
    standDownIf: [],
  },
];
