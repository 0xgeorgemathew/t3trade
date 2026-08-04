import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { Tool } from "effect/unstable/ai";

import { coerceToolArguments } from "./coerceToolArguments.ts";

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
});
