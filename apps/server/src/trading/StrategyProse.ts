/**
 * StrategyProse - bounding the free text a published plan carries.
 *
 * Every prose field on `TradingPlanState` is an unbounded string: the harness
 * writes a thesis in whatever length it likes, and the server persists it
 * verbatim. That was fine until the plan started riding on every wake — one
 * verbose publish then made every subsequent wakeup for that mission's life
 * exceed the context budget.
 *
 * Two callers, two limits, one traversal:
 * - `TradingStrategyService` bounds the text at publish time, so the persisted
 *   row can never grow past a readable paragraph per field.
 * - `TradingWakeupComposer` bounds it much harder for the wakeup projection,
 *   which is a snapshot the run can expand with `trading_get_mission`.
 *
 * Truncation is reported, never silent: the publish path returns the bounded
 * fields as in-band warnings so the harness learns its prose was clipped.
 *
 * @module StrategyProse
 */
import type { PublishTradingPlanBody } from "@t3tools/trading-contracts/tools";

/** What the publish path persists: long enough for a paragraph per field. */
export const PUBLISHED_PROSE_CHARS = 600;

export interface BoundedProse {
  readonly strategy: PublishTradingPlanBody;
  /** Dotted paths of the fields that were clipped, for warnings and logs. */
  readonly truncatedFields: ReadonlyArray<string>;
}

type Trigger = PublishTradingPlanBody["entry"]["triggers"][number];

/**
 * Truncate every prose field on a published plan to `limit` characters.
 *
 * The ellipsis is what tells a reader — the harness on the next wake, or the
 * user in the UI — that there was more. Fields already inside the limit come
 * back identical, so an ordinary plan is untouched.
 */
export const boundStrategyProse = (
  strategy: PublishTradingPlanBody,
  limit: number,
): BoundedProse => {
  const truncatedFields: Array<string> = [];

  const clip = (value: string, path: string): string => {
    if (value.length <= limit) return value;
    truncatedFields.push(path);
    return `${value.slice(0, limit)}…`;
  };

  const clipTrigger = (trigger: Trigger, path: string): Trigger => ({
    ...trigger,
    description: clip(trigger.description, `${path}.description`),
    ...(trigger.invalidatedBy === undefined
      ? {}
      : { invalidatedBy: clip(trigger.invalidatedBy, `${path}.invalidatedBy`) }),
  });

  const bounded: PublishTradingPlanBody = {
    ...strategy,
    entry: {
      ...strategy.entry,
      triggers: strategy.entry.triggers.map((trigger, i) =>
        clipTrigger(trigger, `entry.triggers[${i}]`),
      ),
    },
    stop: {
      ...strategy.stop,
      method: clip(strategy.stop.method, "stop.method"),
    },
    ...(strategy.target.method === undefined
      ? {}
      : {
          target: {
            ...strategy.target,
            method: clip(strategy.target.method, "target.method"),
          },
        }),
    invalidation: strategy.invalidation.map((line, i) => clip(line, `invalidation[${i}]`)),
    because: clip(strategy.because, "because"),
  };

  return { strategy: bounded, truncatedFields };
};
