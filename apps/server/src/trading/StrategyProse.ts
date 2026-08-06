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

type Condition = PublishTradingPlanBody["exitConditions"][number];

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

  const clipCondition = (condition: Condition, path: string): Condition => ({
    ...condition,
    description: clip(condition.description, `${path}.description`),
    ...(condition.invalidatedBy === undefined
      ? {}
      : { invalidatedBy: clip(condition.invalidatedBy, `${path}.invalidatedBy`) }),
  });

  const clipConditions = (
    conditions: ReadonlyArray<Condition>,
    path: string,
  ): ReadonlyArray<Condition> => conditions.map((c, i) => clipCondition(c, `${path}[${i}]`));

  const bounded: PublishTradingPlanBody = {
    ...strategy,
    name: clip(strategy.name, "name"),
    mode: clip(strategy.mode, "mode"),
    explanation: clip(strategy.explanation, "explanation"),
    belief: {
      ...strategy.belief,
      summary: clip(strategy.belief.summary, "belief.summary"),
      regime: clip(strategy.belief.regime, "belief.regime"),
      evidence: strategy.belief.evidence.map((e, i) => clip(e, `belief.evidence[${i}]`)),
    },
    entryPlan: {
      ...strategy.entryPlan,
      explanation: clip(strategy.entryPlan.explanation, "entryPlan.explanation"),
      conditions: clipConditions(strategy.entryPlan.conditions, "entryPlan.conditions"),
    },
    positionManagement: {
      ...strategy.positionManagement,
      scaleInConditions: clipConditions(
        strategy.positionManagement.scaleInConditions,
        "positionManagement.scaleInConditions",
      ),
      ...(strategy.positionManagement.trailingMethod === undefined
        ? {}
        : {
            trailingMethod: clip(
              strategy.positionManagement.trailingMethod,
              "positionManagement.trailingMethod",
            ),
          }),
    },
    protection: {
      ...strategy.protection,
      stopMethod: clip(strategy.protection.stopMethod, "protection.stopMethod"),
      ...(strategy.protection.takeProfitMethod === undefined
        ? {}
        : {
            takeProfitMethod: clip(
              strategy.protection.takeProfitMethod,
              "protection.takeProfitMethod",
            ),
          }),
      ...(strategy.protection.targetProfitRationale === undefined
        ? {}
        : {
            targetProfitRationale: clip(
              strategy.protection.targetProfitRationale,
              "protection.targetProfitRationale",
            ),
          }),
      ...(strategy.protection.targetProfitBasis === undefined
        ? {}
        : {
            targetProfitBasis: {
              ...strategy.protection.targetProfitBasis,
              rationale: clip(
                strategy.protection.targetProfitBasis.rationale,
                "protection.targetProfitBasis.rationale",
              ),
            },
          }),
    },
    exitConditions: clipConditions(strategy.exitConditions, "exitConditions"),
    abandonmentConditions: clipConditions(strategy.abandonmentConditions, "abandonmentConditions"),
    reentryConditions: clipConditions(strategy.reentryConditions, "reentryConditions"),
  };

  return { strategy: bounded, truncatedFields };
};

/**
 * Fill in the two prose keys the harness has been observed omitting.
 *
 * Both are now optional in the schema (a missing `explanation` used to make the
 * Effect toolkit reject the whole `trading_publish_plan` call, costing a turn
 * and surfacing as an ERROR). A plan that omits its top-level explanation is
 * saying the same thing its belief summary already says, so that is what it
 * gets; an entry plan with no explanation borrows the same line.
 */
export const fillOmittedProse = (strategy: PublishTradingPlanBody): PublishTradingPlanBody => {
  const explanation =
    strategy.explanation.trim() === "" ? strategy.belief.summary : strategy.explanation;
  return {
    ...strategy,
    explanation,
    entryPlan: {
      ...strategy.entryPlan,
      explanation:
        strategy.entryPlan.explanation.trim() === "" ? explanation : strategy.entryPlan.explanation,
    },
  };
};
