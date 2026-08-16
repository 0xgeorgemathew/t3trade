/**
 * The journal note an operator's drag leaves behind (plan 29 step 8.4).
 *
 * The operator drags a level and says nothing. The note still has to be a fact
 * about what happened rather than a caption, because it is read back into the
 * model's context on its next wake — so the server composes it by diffing the
 * plan that was accepted against the one it replaced, and the client supplies
 * no text at all. A client-supplied caption would be a way for the panel to
 * put words in the operator's mouth, and a way for a future bug to journal a
 * change that did not happen.
 *
 * @module TradingPlanRevisionNote
 */
import type { TradingPlanState } from "@t3tools/trading-contracts/strategy";

/** A price as the panel shows it: grouped, and no more precision than it has. */
const formatPrice = (price: number): string =>
  price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const describeLevel = (label: string, before: number | undefined, after: number | undefined) => {
  if (before === after) return null;
  if (after === undefined) return `${label} removed`;
  if (before === undefined) return `${label} set to ${formatPrice(after)}`;
  return `${label} moved to ${formatPrice(after)}`;
};

/**
 * One sentence naming every leaf the revision actually moved.
 *
 * Returns `null` when the two plans state the same levels — a publish that
 * changed nothing draggable is not worth a journal line, and journaling one
 * would teach the model that the operator intervened when they did not.
 */
export function composePlanRevisionNote(
  previous: TradingPlanState | null,
  next: TradingPlanState,
): string | null {
  const changes: Array<string> = [];

  const stop = describeLevel("stop", previous?.stop.price, next.stop.price);
  if (stop !== null) changes.push(stop);

  const target = describeLevel("target", previous?.target.price, next.target.price);
  if (target !== null) changes.push(target);

  // Triggers are compared by position, which is what a drag moves: the panel
  // replaces one leaf of one trigger and republishes the array in its order.
  // A revision that added or removed a trigger is not a drag, and the count
  // change is the honest thing to say about it.
  const previousTriggers = previous?.entry.triggers ?? [];
  const nextTriggers = next.entry.triggers;
  if (previousTriggers.length !== nextTriggers.length) {
    changes.push(
      `entry triggers changed from ${previousTriggers.length} to ${nextTriggers.length}`,
    );
  } else {
    nextTriggers.forEach((trigger, index) => {
      const moved = describeLevel(
        `entry trigger ${index + 1}`,
        previousTriggers[index]?.priceLevel,
        trigger.priceLevel,
      );
      if (moved !== null) changes.push(moved);
    });
  }

  if (previous !== null && previous.reassess.afterMinutes !== next.reassess.afterMinutes) {
    changes.push(`reassessment moved to ${next.reassess.afterMinutes} minutes after this revision`);
  }

  if (changes.length === 0) return null;
  // "the operator" rather than "the user": the model reads this beside its own
  // notes, and it has to be unambiguous that a person did this, not a tool.
  return `the operator revised the plan from the chart — ${changes.join("; ")}`;
}
