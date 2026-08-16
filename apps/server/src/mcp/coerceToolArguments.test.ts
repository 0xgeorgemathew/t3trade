import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { Tool } from "effect/unstable/ai";

import { coerceToolArguments } from "./coerceToolArguments.ts";
import { TradingToolkit } from "./toolkits/trading/tools.ts";

/**
 * The exact JSON-schema shape Effect emits for a `Schema.Number` field: an
 * `anyOf` whose first branch is `{type:"number"}` and whose second is the
 * Infinity/NaN string-enum. `coerceToolArguments` must walk that `anyOf` and
 * coerce a numeric string into the number branch.
 */
// The JSON-Schema document's `.properties` is typed loosely by Effect; these are
// test fixtures that read the real emitted shape, so extract via a permissive
// cast rather than fighting the document type.
const jsonProperties = (schema: ReturnType<typeof Schema.Struct>) =>
  (Tool.getJsonSchemaFromSchema(schema) as { properties: Record<string, object> }).properties;

const numberField = jsonProperties(Schema.Struct({ value: Schema.Number })).value;

const booleanField = jsonProperties(Schema.Struct({ value: Schema.Boolean })).value;

const nestedObjectField = jsonProperties(
  Schema.Struct({ intent: Schema.Struct({ limitPrice: Schema.Number }) }),
).intent;

const optionalNumberField = jsonProperties(
  Schema.Struct({ value: Schema.optional(Schema.Number) }),
).value;

/**
 * A representative trading-tool input: a `missionId`, a numeric
 * `expectedVersion` that must be >= 0, and a nested `intent.limitPrice`. This
 * is the shape that failed in the field — `expectedVersion: "0"` and
 * `intent.limitPrice: "1850.5"` both lost the whole call.
 */
const publishLikeSchema = Tool.getJsonSchema(
  Tool.make("trading_publish_like", {
    description: "d",
    parameters: Schema.Struct({
      missionId: Schema.String,
      expectedVersion: Schema.Number,
      intent: Schema.Struct({ limitPrice: Schema.Number }),
    }),
    success: Schema.String,
  }),
);

describe("coerceToolArguments", () => {
  it('coerces a numeric string into the declared number (maxBars: "100" -> 100)', () => {
    expect(
      coerceToolArguments(
        { type: "object", properties: { maxBars: numberField } },
        { maxBars: "100" },
      ),
    ).toEqual({ maxBars: 100 });
  });

  it('coerces "0" and "0.0" to 0 for a number field (the expectedVersion failure)', () => {
    expect(
      coerceToolArguments(
        { type: "object", properties: { expectedVersion: numberField } },
        { expectedVersion: "0" },
      ),
    ).toEqual({ expectedVersion: 0 });
    expect(
      coerceToolArguments(
        { type: "object", properties: { expectedVersion: numberField } },
        { expectedVersion: "0.0" },
      ),
    ).toEqual({ expectedVersion: 0 });
  });

  it('coerces a nested numeric string inside an object field (intent.limitPrice: "1850.5")', () => {
    expect(
      coerceToolArguments(
        { type: "object", properties: { intent: nestedObjectField } },
        { intent: { limitPrice: "1850.5" } },
      ),
    ).toEqual({ intent: { limitPrice: 1850.5 } });
  });

  it('coerces "true"/"false" into booleans', () => {
    expect(
      coerceToolArguments({ type: "object", properties: { flag: booleanField } }, { flag: "true" }),
    ).toEqual({ flag: true });
    expect(
      coerceToolArguments(
        { type: "object", properties: { flag: booleanField } },
        { flag: "false" },
      ),
    ).toEqual({ flag: false });
  });

  it("coerces a numeric string against a declared integer type", () => {
    expect(
      coerceToolArguments(
        { type: "object", properties: { count: { type: "integer" } } },
        { count: "42" },
      ),
    ).toEqual({ count: 42 });
  });

  it("coerces a JSON-stringified object/array into the declared shape", () => {
    const objectSchema = {
      type: "object",
      properties: { payload: { type: "object", properties: { a: { type: "number" } } } },
    } as const;
    expect(coerceToolArguments(objectSchema, { payload: '{"a": 1}' })).toEqual({
      payload: { a: 1 },
    });

    const arraySchema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "number" } } },
    } as const;
    expect(coerceToolArguments(arraySchema, { items: "[1, 2, 3]" })).toEqual({
      items: [1, 2, 3],
    });
  });

  it("leaves a non-numeric string untouched so validation produces its own error", () => {
    // "not-a-number" cannot satisfy `number`, so it stays a string and the
    // downstream decode fails with the normal parameter-validation error
    // rather than being silently dropped or coerced to NaN/0.
    expect(
      coerceToolArguments(
        { type: "object", properties: { expectedVersion: numberField } },
        { expectedVersion: "not-a-number" },
      ),
    ).toEqual({ expectedVersion: "not-a-number" });
  });

  it("leaves an empty/whitespace string untouched (no silent 0 coercion)", () => {
    expect(
      coerceToolArguments(
        { type: "object", properties: { expectedVersion: numberField } },
        { expectedVersion: "" },
      ),
    ).toEqual({ expectedVersion: "" });
    expect(
      coerceToolArguments(
        { type: "object", properties: { expectedVersion: numberField } },
        { expectedVersion: "   " },
      ),
    ).toEqual({ expectedVersion: "   " });
  });

  it("is byte-identical on an already-valid payload", () => {
    const valid = {
      missionId: "mission_1",
      expectedVersion: 0,
      intent: { limitPrice: 1850.5 },
    };
    expect(coerceToolArguments(publishLikeSchema, valid)).toEqual(valid);
  });

  it("coerces a numeric string against the full publish-like schema end to end", () => {
    // The exact observed failure: every numeric field arrived as a string.
    expect(
      coerceToolArguments(publishLikeSchema, {
        missionId: "mission_1",
        expectedVersion: "0",
        intent: { limitPrice: "1850.5" },
      }),
    ).toEqual({
      missionId: "mission_1",
      expectedVersion: 0,
      intent: { limitPrice: 1850.5 },
    });
  });

  it("coerces numeric strings inside an array of objects", () => {
    const schema = {
      type: "object",
      properties: {
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: { priceLevel: numberField },
          },
        },
      },
    } as const;
    expect(
      coerceToolArguments(schema, {
        conditions: [{ priceLevel: "3200" }, { priceLevel: "3300.5" }],
      }),
    ).toEqual({ conditions: [{ priceLevel: 3200 }, { priceLevel: 3300.5 }] });
  });

  it("preserves an optional numeric field that is null", () => {
    expect(
      coerceToolArguments(
        { type: "object", properties: { value: optionalNumberField } },
        { value: null },
      ),
    ).toEqual({ value: null });
  });

  it("returns the args unchanged when the schema is not an object document", () => {
    const args = { missionId: "x" };
    expect(coerceToolArguments(null, args)).toBe(args);
    expect(coerceToolArguments(undefined, args)).toBe(args);
    expect(coerceToolArguments("not-a-schema", args)).toBe(args);
  });

  /**
   * The fixtures above are hand-built shapes. These run against the schemas the
   * trading toolkit actually advertises, which is the only thing a provider
   * ever sees — and they are what the hand-built fixtures missed:
   *
   * - Every *constrained* number in the trading contracts is emitted as
   *   `{type:"number", allOf:[{minimum:0}]}`. A walker that reads `allOf`
   *   before the node's own `type` concludes "accepts nothing" and coerces no
   *   numeric string at all, on any real tool.
   * - A schema emitted more than once is hoisted into `$defs` and referenced by
   *   pointer (`entry.triggers.items` is `{"$ref": "#/$defs/Union_"}`), so a
   *   walker that does not resolve `$ref` never descends into it.
   */
  describe("against the real trading tool schemas", () => {
    const schemaFor = (name: string) => {
      const tool = Object.values(TradingToolkit.tools).find((t) => t.name === name);
      if (tool === undefined) throw new Error(`no such trading tool: ${name}`);
      return Tool.getJsonSchema(tool);
    };

    // The shapes below cost a `trading_publish_plan` round trip each on
    // 2026-08-14: literals came back as labelled records and lists as `{}`.
    // Ported to the eight-field plan: the labelled literal a trigger can carry
    // is its `timeframe`.
    it("unwraps a labelled timeframe record to the literal it carries", () => {
      const coerced = coerceToolArguments(schemaFor("trading_publish_plan"), {
        expectedVersion: 0,
        strategy: {
          entry: {
            triggers: [
              {
                description: "thesis",
                timeframe: { name: "5m", role: "thesis" },
                priceLevel: "1800",
              },
              { description: "confirm", timeframe: { name: "15m", role: "confirmation" } },
            ],
          },
        },
      }) as {
        strategy: { entry: { triggers: ReadonlyArray<Record<string, unknown>> } };
      };

      expect(coerced.strategy.entry.triggers).toEqual([
        { description: "thesis", timeframe: "5m", priceLevel: 1800 },
        { description: "confirm", timeframe: "15m" },
      ]);
    });

    it("leaves a wrapper whose value is not a declared literal alone", () => {
      const coerced = coerceToolArguments(schemaFor("trading_publish_plan"), {
        expectedVersion: 0,
        strategy: { entry: { triggers: [{ description: "x", timeframe: { name: "4h" } }] } },
      }) as {
        strategy: { entry: { triggers: ReadonlyArray<unknown> } };
      };

      expect(coerced.strategy.entry.triggers).toEqual([
        { description: "x", timeframe: { name: "4h" } },
      ]);
    });

    it('coerces maxBars: "100" on trading_get_market_history', () => {
      expect(
        coerceToolArguments(schemaFor("trading_get_market_history"), {
          market: "ETH",
          interval: "1m",
          maxBars: "100",
        }),
      ).toEqual({ market: "ETH", interval: "1m", maxBars: 100 });
    });

    it("coerces the numeric entry fields on trading_quote_entry", () => {
      // The sizing fields are nullable numbers, so each is an `anyOf` whose
      // number branch is itself an `anyOf` of the constrained number and the
      // Infinity/NaN enum. Coercion has to reach through both levels.
      expect(
        coerceToolArguments(schemaFor("trading_quote_entry"), {
          missionId: "mission_1",
          market: "ETH",
          side: "buy",
          stopPrice: "1800",
          sizeEth: "0.01",
          notionalUsd: "250.5",
          actionType: "open",
          urgency: "patient",
        }),
      ).toEqual({
        missionId: "mission_1",
        market: "ETH",
        side: "buy",
        stopPrice: 1800,
        sizeEth: 0.01,
        notionalUsd: 250.5,
        actionType: "open",
        urgency: "patient",
      });
    });

    it("leaves the quote-id shape of trading_execute untouched", () => {
      // `trading_execute` takes no numbers of its own since execution moved
      // behind a quote id — an already-valid payload must pass through as-is.
      expect(
        coerceToolArguments(schemaFor("trading_execute"), {
          missionId: "mission_1",
          quoteId: "quote_1",
        }),
      ).toEqual({ missionId: "mission_1", quoteId: "quote_1" });
    });

    it("coerces through a $ref'd trigger and leaves a prose trigger a string", () => {
      const coerced = coerceToolArguments(schemaFor("trading_publish_plan"), {
        expectedMissionVersion: "1",
        strategy: {
          stop: { method: "fixed", price: "1800" },
          target: { profitUsd: "25" },
          // `entry.triggers.items` is a `$ref` into `$defs`: the object branch
          // must still have its `priceLevel` coerced, and the prose branch must
          // survive untouched so the string-trigger input stays valid.
          entry: {
            triggers: [{ description: "back above the level", priceLevel: "1865.9" }, "bank it"],
          },
        },
      }) as {
        expectedMissionVersion: unknown;
        strategy: {
          stop: Record<string, unknown>;
          target: Record<string, unknown>;
          entry: { triggers: ReadonlyArray<unknown> };
        };
      };

      expect(coerced.expectedMissionVersion).toBe(1);
      expect(coerced.strategy.stop).toEqual({ method: "fixed", price: 1800 });
      expect(coerced.strategy.target).toEqual({ profitUsd: 25 });
      expect(coerced.strategy.entry.triggers).toEqual([
        { description: "back above the level", priceLevel: 1865.9 },
        "bank it",
      ]);
    });

    it('leaves the "Infinity" sentinel a string rather than coercing it', () => {
      // The number branch is emitted alongside a string enum of
      // `Infinity`/`-Infinity`/`NaN`. Those are the string branch's business.
      expect(
        coerceToolArguments(schemaFor("trading_get_market_history"), {
          market: "ETH",
          interval: "1m",
          maxBars: "Infinity",
        }),
      ).toEqual({ market: "ETH", interval: "1m", maxBars: "Infinity" });
    });
  });
});
