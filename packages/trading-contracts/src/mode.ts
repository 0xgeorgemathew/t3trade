/**
 * Mission mode — plan 29 phase 9.
 *
 * Two modes, and discretionary is the default. In discretionary mode the
 * playbooks are reference: the model reads the market, decides, and states why.
 * In execute mode one named playbook IS the decision procedure, and the model's
 * job changes from _decide_ to _execute faithfully and report deviations_.
 *
 * **The mode is derived from the mandate, not stored beside it.** A column
 * would be a second copy of a fact the instruction already states, written
 * once at mission creation and free to disagree with the words the operator
 * actually typed — and the instruction is what the model reads. Deriving it
 * keeps one source, costs no migration, and makes the rule inspectable: the
 * mandate that produced the mode is right there in the same read.
 *
 * @module TradingMissionMode
 */
import * as Schema from "effect/Schema";

import { TradingPlaybookName } from "./playbook.ts";
import { TradingText } from "./primitives.ts";

/**
 * The playbooks a mission may be told to execute.
 *
 * `classify` and `standing_rules` are deliberately absent: the first is how to
 * read the regime and the second is what is true in every mode, so neither is
 * a procedure a mission could be pointed at as its whole job.
 */
export const EXECUTABLE_STRATEGIES: ReadonlyArray<TradingPlaybookName> = [
  "momentum",
  "range_reversion",
  "opening_range",
  "ema_cross",
  "rsi_reversion",
];

export const TradingMissionModeState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("discretionary") }),
  Schema.Struct({
    kind: Schema.Literal("execute_strategy"),
    strategy: TradingPlaybookName,
    /** What executing rather than deciding means, in the model's own read. */
    doctrine: TradingText,
  }),
]);
export type TradingMissionModeState = typeof TradingMissionModeState.Type;

/**
 * What a mission in execute mode is told, every turn, through `trading_look`.
 *
 * It says three things and no fourth: the playbook is the procedure, deviation
 * is allowed but must be named, and no mode can authorise what the authority
 * refuses. That last sentence is not decoration — a playbook read as a
 * standing order is exactly the context in which a model talks itself past a
 * size ceiling, and the gates that refuse it are the same ones either way.
 */
export const strategyModeDoctrine = (strategy: TradingPlaybookName): string =>
  `This mission is in execute mode: the ${strategy} playbook is the decision ` +
  `procedure, not a reference. Read it with trading_strategy and work its steps in ` +
  `order. Your job is faithful execution and honest reporting, not finding a better ` +
  `trade — when its conditions are not met, stand aside and say which step failed. ` +
  `You may depart from it, but never silently: say so in the plan's \`because\` and ` +
  `in the journal, naming the step you left and why. Every risk gate still applies; ` +
  `a playbook cannot authorise what the authority refuses.`;

/**
 * The forms of "run this strategy" the mandate is read for.
 *
 * Deliberately narrow. A mandate that merely mentions momentum ("momentum has
 * been working") must not silently become a standing order to trade it, so the
 * verb has to be there and the name has to follow it.
 *
 * Global, and every match is tried, because an operator writes more than one
 * clause: "Trade ETH on the 1m. Execute the momentum playbook" puts a verb in
 * front of "ETH" before it puts one in front of the name, and reading only the
 * first match would drop the mission back to discretionary without saying so.
 *
 * `.` is not in the name class for the same reason — with it the capture runs
 * straight through a full stop and swallows the next sentence's verb.
 *
 * `trade` is deliberately not a verb here. In a trading product "trade
 * momentum on ETH" is how someone says _lean momentum, use your judgement_,
 * and reading it as a standing order turns a discretionary session into one
 * that stands aside from every non-momentum setup. "Execute", "run" and
 * "follow" are what an operator writes when they mean a procedure.
 */
const MODE_PATTERN = /\b(?:execute|run|follow)\s+(?:the\s+)?([a-z][a-z _-]{2,40})/gi;

/**
 * Words that turn a match into its own refusal.
 *
 * "Do not run momentum today" contains "run momentum" and means the opposite,
 * so the short run of text before the verb is checked for a negation and the
 * match is skipped when one is there.
 */
const NEGATION_PATTERN = /\b(?:not|n't|never|avoid|except|without|no)\b/i;

/** How far back of the verb is read for a negation. */
const NEGATION_LOOKBEHIND_CHARS = 20;

/**
 * A negation only negates its own clause.
 *
 * `no` has to be in the list — "no need to run momentum" is a refusal and
 * carries no other negation word — and `no` is common enough that twenty bare
 * characters of lookbehind reach into the sentence before. "There is no edge in
 * chop; run the range_reversion playbook" is an INSTRUCTION to execute, and
 * reading its `no` would quietly drop the mission back to discretionary. So the
 * lookbehind stops at the nearest clause boundary: the negation has to be in
 * the same breath as the verb it cancels.
 */
const CLAUSE_BOUNDARY_PATTERN = /[.;,:\n]/g;

/** The tail of the lookbehind window after the LAST boundary in it. */
const currentClause = (window: string): string => {
  let start = 0;
  for (const boundary of window.matchAll(CLAUSE_BOUNDARY_PATTERN)) {
    start = boundary.index + 1;
  }
  return window.slice(start);
};

const isNegated = (instruction: string, matchIndex: number): boolean =>
  NEGATION_PATTERN.test(
    currentClause(
      instruction.slice(Math.max(0, matchIndex - NEGATION_LOOKBEHIND_CHARS), matchIndex),
    ),
  );

/** `strategy: momentum` — the explicit form, for a mandate written by a tool. */
const EXPLICIT_PATTERN = /\bstrategy\s*[:=]\s*([a-z][a-z _-]{2,24})\b/gi;

const normalise = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replaceAll(/[ .-]+/g, "_");

/**
 * The candidate names inside a captured phrase, longest first.
 *
 * A strategy name can be two words in prose ("opening range") and one word
 * underscored in the schema, so the phrase after the verb is tried at three
 * words, then two, then one. Longest first matters: "opening range" must not
 * lose to a hypothetical "opening".
 */
const candidateNames = (phrase: string): ReadonlyArray<string> => {
  const words = phrase.trim().split(/\s+/).slice(0, 3);
  const names: Array<string> = [];
  for (let length = words.length; length > 0; length -= 1) {
    names.push(normalise(words.slice(0, length).join(" ")));
  }
  return names;
};

/**
 * Which mode a mandate puts the mission in.
 *
 * Unrecognised names fall back to discretionary rather than failing: "run the
 * usual" is a mandate, not a mode declaration, and a mission that refused to
 * start over a phrase it could not parse would be worse than one that thinks
 * for itself.
 */
export function readMissionMode(instruction: string): TradingMissionModeState {
  for (const pattern of [EXPLICIT_PATTERN, MODE_PATTERN]) {
    // `matchAll` iterates a copy, so the module-level patterns keep no
    // `lastIndex` between calls.
    for (const match of instruction.matchAll(pattern)) {
      if (isNegated(instruction, match.index)) continue;
      for (const name of candidateNames(match[1] ?? "")) {
        const strategy = EXECUTABLE_STRATEGIES.find((candidate) => candidate === name);
        if (strategy !== undefined) {
          return { kind: "execute_strategy", strategy, doctrine: strategyModeDoctrine(strategy) };
        }
      }
    }
  }
  return { kind: "discretionary" };
}
