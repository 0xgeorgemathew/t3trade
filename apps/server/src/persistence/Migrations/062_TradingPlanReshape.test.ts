import { Schema } from "effect";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingPlanState } from "@t3tools/trading-contracts/strategy";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0062, { reshapePlanDocument } from "./062_TradingPlanReshape.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/** String → unknown, the repo's own escape hatch around raw JSON.parse. */
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
/** unknown → JSON string, for seeding rows. */
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
/** String → decoded plan: a reshaped row must survive this unchanged. */
const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(TradingPlanState));

/** A full twenty-field document as Phase 3 wrote it. */
const legacyRow = {
  version: 4,
  name: "ETH 5m breakout continuation",
  market: "ETH",
  mode: "breakout_continuation",
  direction: "long",
  timeframes: ["5m", "15m"],
  belief: {
    summary: "Breakout confirmed on 1.6x relative volume.",
    regime: "trending",
    confidence: 0.7,
    evidence: ["5m close 3748.9", "relative volume 1.6x"],
  },
  entryPlan: {
    explanation: "Enter on a retest that holds.",
    initialNotionalUsd: 1_115,
    maximumIntendedNotionalUsd: 3_000,
    orderPreference: "post_only",
    conditions: [
      { description: "Retest of 3,718 holds", timeframe: "5m", priceLevel: 3_718.4 },
      "Reclaim on rising volume",
    ],
  },
  positionManagement: {
    scaleInAllowed: true,
    scaleInConditions: [{ description: "New 5m high on rising volume" }],
    partialReductionAllowed: true,
    trailingMethod: "fixed stop for the POC",
  },
  protection: {
    stopMethod: "Below the last accepted swing low",
    stopPrice: 3_652,
    takeProfitMethod: "prior range high",
    takeProfitPrice: 3_810,
    targetProfitUsd: 25,
    targetProfitRationale: "Conservative rung net of the round trip.",
    maximumPlannedLossUsd: 19.9,
  },
  exitConditions: [{ description: "5m close under 3,690" }],
  abandonmentConditions: [{ description: "Regime flips to mean-reverting" }, "Breakout level lost"],
  reentryConditions: [{ description: "Fresh breakout above 3,760" }],
  currentAction: "holding",
  explanation: "Long 0.30 ETH, protected at 3,652.",
  plainSummary: "ETH broke above a level it kept failing at; long a small position.",
  updatedAt: 1_753_000_000_000,
};

const reshaped = (overrides: Record<string, unknown>): TradingPlanState => {
  const json = reshapePlanDocument(encodeJson({ ...legacyRow, ...overrides }));
  assert(json !== null);
  return decodePlan(json);
};

describe("reshapePlanDocument", () => {
  it("rewrites a Phase-3 row into a document the new schema decodes", () => {
    const plan = reshaped({});

    expect(plan.market).toBe("ETH");
    expect(plan.intent).toBe("long");
    expect(plan.entry.triggers).toEqual([
      { description: "Retest of 3,718 holds", timeframe: "5m", priceLevel: 3_718.4 },
      { description: "Reclaim on rising volume" },
    ]);
    // The stored preference was post-only: urgency is the vocabulary now.
    expect(plan.entry.urgency).toBe("patient");
    expect(plan.entry.initialNotionalUsd).toBe(1_115);
    expect(plan.stop).toEqual({
      method: "Below the last accepted swing low",
      price: 3_652,
      maximumPlannedLossUsd: 19.9,
    });
    expect(plan.target).toEqual({
      profitUsd: 25,
      price: 3_810,
      method: "prior range high",
    });
    expect(plan.invalidation).toEqual(["Regime flips to mean-reverting", "Breakout level lost"]);
    expect(plan.reassess.afterMinutes).toBe(90);
    expect(plan.updatedAt).toBe(1_753_000_000_000);
    // The narrative absorbed the old prose fields, and the strategy identity
    // (name, mode, direction, timeframes) survives as prose.
    expect(plan.because).toContain("Breakout confirmed on 1.6x relative volume.");
    expect(plan.because).toContain("breakout_continuation");
    expect(plan.because).toContain("long");
    expect(plan.because).toContain("5m, 15m");
    expect(plan.because).toContain("Conservative rung net of the round trip.");
    // A marketable-IOC row maps to the crossing urgency.
    expect(
      reshaped({ entryPlan: { ...legacyRow.entryPlan, orderPreference: "marketable_ioc" } }).entry
        .urgency,
    ).toBe("now");
  });

  it("maps a stand-down row to the stand-aside intent", () => {
    const plan = reshaped({ standDownCode: "costs_exceed_target" });
    expect(plan.intent).toBe("stand_aside");
    expect(plan.because).toContain("stood down: costs_exceed_target");
  });

  it("maps both and conditional to stand_aside with the direction kept in prose", () => {
    // A directionless plan cannot honor a resting reduce-only take-profit, so
    // it lands on the intent whose behaviors skip one — and the journal keeps
    // what the plan actually said.
    for (const direction of ["both", "conditional"]) {
      const plan = reshaped({ direction });
      expect(plan.intent).toBe("stand_aside");
      expect(plan.because).toContain(`"${direction}"`);
    }
  });

  it("keeps a stand-aside row's target rung when it published one", () => {
    const plan = reshaped({
      direction: "short",
      standDownCode: "regime_unclear",
      protection: { stopMethod: "n/a", targetProfitUsd: 5 },
    });
    expect(plan.intent).toBe("stand_aside");
    expect(plan.target.profitUsd).toBe(5);
  });

  it("leaves already-reshaped and unparseable rows alone", () => {
    const fresh = reshapePlanDocument(
      encodeJson({
        market: "ETH",
        intent: "long",
        entry: { triggers: [], urgency: "now" },
        stop: { method: "swing low" },
        target: {},
        invalidation: [],
        reassess: { afterMinutes: 30 },
        because: "because",
        updatedAt: 1,
      }),
    );
    expect(fresh).toBeNull();
    expect(reshapePlanDocument("not json")).toBeNull();
    expect(reshapePlanDocument("[1,2,3]")).toBeNull();
  });
});

layer("062_TradingPlanReshape", (it) => {
  it.effect("rewrites every stored strategy_json row in place", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });

      const legacyJson = encodeJson(legacyRow);
      const standAsideJson = encodeJson({ ...legacyRow, standDownCode: "regime_unclear" });
      yield* sql`
        INSERT INTO momentum_strategy_versions (mission_id, version, strategy_json, created_at)
        VALUES
          ('mission-a', 1, ${legacyJson}, 1_000),
          ('mission-a', 2, ${standAsideJson}, 2_000),
          ('mission-b', 1, 'not json', 3_000)
      `;

      yield* Migration0062;

      const rows = yield* sql<{ readonly mission_id: string; readonly strategy_json: string }>`
        SELECT mission_id, strategy_json FROM momentum_strategy_versions
        ORDER BY mission_id, version
      `;

      expect(rows).toHaveLength(3);
      // Every decodable row now decodes under the new schema.
      expect(decodePlan(rows[0]?.strategy_json ?? "").intent).toBe("long");
      expect(decodePlan(rows[1]?.strategy_json ?? "").intent).toBe("stand_aside");
      // The unparseable row is left exactly as it was.
      expect(rows[2]?.strategy_json).toBe("not json");

      // Re-running the migration is a no-op: every decodable row now carries
      // an intent and is skipped.
      yield* Migration0062;
      const again = yield* sql<{ readonly strategy_json: string }>`
        SELECT strategy_json FROM momentum_strategy_versions
        WHERE mission_id = 'mission-a' AND version = 1
      `;
      expect(again[0]?.strategy_json).toBe(rows[0]?.strategy_json);
    }),
  );
});
