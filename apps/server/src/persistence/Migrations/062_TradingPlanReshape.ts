import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEFAULT_REASSESS_AFTER_MINUTES } from "@t3tools/trading-contracts/strategy";

/**
 * Plan 29 step 4.1: rewrite every stored plan document into the
 * position-centric eight-field shape.
 *
 * Existing `momentum_strategy_versions.strategy_json` rows carry the
 * twenty-field document; the new schema rejects them (missing `intent`,
 * `entry`, `stop`, `target`, `invalidation`, `reassess`, `because`), which
 * would cost every mission its current plan. This rewrites the JSON in place —
 * the table, its columns, and the mission's `strategy_version` pointers are
 * untouched (steps 4.2+ own those).
 *
 * Mapping decisions, documented once here:
 * - `intent`: a present `standDownCode` wins (`stand_aside`); `long`/`short`
 *   pass through; `both`/`conditional` map to `stand_aside` — those plans
 *   committed to no side, and the behaviors keyed on `stand_aside` (skip the
 *   entry-sizing lift, skip the resting take-profit) are exactly the ones a
 *   directionless plan could not honor anyway: a reduce-only take-profit needs
 *   a side. The original direction is recorded in `because` so the journal
 *   loses nothing.
 * - `because`: the non-empty narrative parts of the old document (strategy
 *   name, mode, direction, timeframes, belief summary/regime/evidence,
 *   explanations, target rationale, stand-down reason) joined with " — ".
 * - `entry.triggers`: the old `entryPlan.conditions`, strings normalised to
 *   `{description}` objects; hints carried through untouched.
 * - `entry.urgency`: reverse-mapped from the stored `orderPreference`
 *   (`post_only` ⇒ `patient`, anything else ⇒ `now`). The plan never names an
 *   order preference again.
 * - `stop`/`target`: the old `protection` struct split in two, renamed.
 * - `invalidation`: the old `abandonmentConditions`, as prose strings.
 * - `reassess.afterMinutes`: the decode default (90) — the old document had no
 *   freshness field to carry.
 *
 * Rows that already carry `intent` (re-runs, or rows written after the
 * reshape) and rows that are not JSON objects are left untouched.
 */

/** One condition row of the old document: an object or a bare prose string. */
type LegacyCondition = { readonly description?: unknown } | string | unknown;

const conditionDescription = (condition: LegacyCondition): string | null => {
  if (typeof condition === "string") return condition.trim() === "" ? null : condition;
  if (typeof condition !== "object" || condition === null) return null;
  const description = (condition as { readonly description?: unknown }).description;
  return typeof description === "string" && description.trim() !== "" ? description : null;
};

/** Non-empty prose parts of the old document, in the order they read best. */
const legacyBecauseParts = (legacy: Record<string, unknown>): ReadonlyArray<string> => {
  const belief = (legacy["belief"] ?? {}) as Record<string, unknown>;
  const entryPlan = (legacy["entryPlan"] ?? {}) as Record<string, unknown>;
  const protection = (legacy["protection"] ?? {}) as Record<string, unknown>;

  const parts: Array<string> = [];

  const name = legacy["name"];
  const mode = legacy["mode"];
  const direction = legacy["direction"];
  const timeframes = legacy["timeframes"];
  const headline = [name, mode].filter((v) => typeof v === "string" && v !== "").join(" · ");
  const directionNote =
    direction === "both" || direction === "conditional"
      ? `direction was published as "${direction}" — either side, on its trigger`
      : typeof direction === "string" && direction !== ""
        ? direction
        : null;
  const timeframeNote =
    Array.isArray(timeframes) && timeframes.length > 0
      ? `timeframes ${timeframes.join(", ")}`
      : null;
  const header = [headline, directionNote, timeframeNote].filter((v): v is string => v !== null);
  if (header.length > 0) parts.push(header.join(" — "));

  for (const key of ["summary", "regime"] as const) {
    const value = belief[key];
    if (typeof value === "string" && value.trim() !== "") parts.push(value);
  }
  const evidence = belief["evidence"];
  if (Array.isArray(evidence)) {
    for (const line of evidence) {
      if (typeof line === "string" && line.trim() !== "") parts.push(line);
    }
  }

  for (const key of ["explanation", "plainSummary"] as const) {
    const value = legacy[key];
    if (typeof value === "string" && value.trim() !== "") parts.push(value);
  }

  const entryExplanation = entryPlan["explanation"];
  if (typeof entryExplanation === "string" && entryExplanation.trim() !== "") {
    parts.push(entryExplanation);
  }

  const rationale = protection["targetProfitRationale"];
  if (typeof rationale === "string" && rationale.trim() !== "") parts.push(rationale);

  const standDownCode = legacy["standDownCode"];
  if (typeof standDownCode === "string" && standDownCode !== "") {
    parts.push(`stood down: ${standDownCode}`);
  }

  return parts;
};

/**
 * Rewrite one stored plan document into the eight-field shape, or return null
 * when the row needs no rewrite (already reshaped, or not a JSON object).
 *
 * Pure and defensive: every read is structural, so a row with an odd field
 * still produces a document the new schema accepts.
 */
export const reshapePlanDocument = (json: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const legacy = parsed as Record<string, unknown>;

  // Already the new shape — nothing to do.
  if (
    legacy["intent"] === "long" ||
    legacy["intent"] === "short" ||
    legacy["intent"] === "stand_aside"
  ) {
    return null;
  }

  const entryPlan = (legacy["entryPlan"] ?? {}) as Record<string, unknown>;
  const protection = (legacy["protection"] ?? {}) as Record<string, unknown>;

  const legacyDirection = legacy["direction"];
  const standDownCode = legacy["standDownCode"];
  const intent: "long" | "short" | "stand_aside" =
    typeof standDownCode === "string" && standDownCode !== ""
      ? "stand_aside"
      : legacyDirection === "long" || legacyDirection === "short"
        ? legacyDirection
        : "stand_aside";

  const triggers = (Array.isArray(entryPlan["conditions"]) ? entryPlan["conditions"] : []).map(
    (condition) =>
      typeof condition === "string" ? { description: condition } : (condition as object),
  );

  const orderPreference = entryPlan["orderPreference"];
  const urgency: "now" | "patient" = orderPreference === "post_only" ? "patient" : "now";

  const optionalNumber = (value: unknown, key: string): Record<string, unknown> =>
    typeof value === "number" ? { [key]: value } : {};

  const stop = {
    method:
      typeof protection["stopMethod"] === "string" && protection["stopMethod"] !== ""
        ? protection["stopMethod"]
        : "(stop method not stated)",
    ...optionalNumber(protection["stopPrice"], "price"),
    ...optionalNumber(protection["maximumPlannedLossUsd"], "maximumPlannedLossUsd"),
  };

  const target = {
    ...optionalNumber(protection["targetProfitUsd"], "profitUsd"),
    ...optionalNumber(protection["takeProfitPrice"], "price"),
    ...(typeof protection["takeProfitMethod"] === "string" && protection["takeProfitMethod"] !== ""
      ? { method: protection["takeProfitMethod"] }
      : {}),
  };

  const abandonment = legacy["abandonmentConditions"];
  const invalidation = (Array.isArray(abandonment) ? abandonment : [])
    .map(conditionDescription)
    .filter((value): value is string => value !== null);

  const because = legacyBecauseParts(legacy).join(" — ");

  const market = legacy["market"];
  const document = {
    market: market === "BTC" ? "BTC" : "ETH",
    intent,
    entry: {
      triggers,
      urgency,
      ...optionalNumber(entryPlan["initialNotionalUsd"], "initialNotionalUsd"),
      ...optionalNumber(entryPlan["maximumIntendedNotionalUsd"], "maximumIntendedNotionalUsd"),
    },
    stop,
    target,
    invalidation,
    reassess: { afterMinutes: DEFAULT_REASSESS_AFTER_MINUTES },
    because,
    updatedAt: typeof legacy["updatedAt"] === "number" ? legacy["updatedAt"] : 0,
  };

  return JSON.stringify(document);
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{
    readonly mission_id: string;
    readonly version: number;
    readonly strategy_json: string;
  }>`
    SELECT mission_id, version, strategy_json FROM momentum_strategy_versions
    WHERE strategy_json IS NOT NULL
  `;

  let rewritten = 0;
  for (const row of rows) {
    const reshaped = reshapePlanDocument(row.strategy_json);
    if (reshaped === null) continue;
    yield* sql`
      UPDATE momentum_strategy_versions
      SET strategy_json = ${reshaped}
      WHERE mission_id = ${row.mission_id} AND version = ${row.version}
    `;
    rewritten += 1;
  }

  if (rewritten > 0) {
    yield* Effect.logInfo("062_TradingPlanReshape: rewrote stored plan documents", {
      rewritten,
      total: rows.length,
    });
  }
});
