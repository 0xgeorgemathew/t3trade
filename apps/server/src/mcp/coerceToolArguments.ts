/**
 * Lenient tool-argument coercion at the MCP boundary.
 *
 * The advertised JSON schemas stay strict — that strictness is what makes the
 * Codex provider reliable. But the other providers (Claude, Cursor, Grok,
 * OpenCode) routinely emit `"100"` where the schema asks for a number, `"true"`
 * where it asks for a boolean, and a JSON string where it asks for an object.
 * Effect's toolkit decodes with `Schema.decodeUnknownEffect`, so those reach
 * the agent as `Invalid parameters for tool` and the whole call is lost.
 *
 * `coerceToolArguments` walks the tool's own JSON schema and rewrites the
 * incoming payload to match the declared types *before* decode — so the
 * validation that follows is unchanged and still rejects values that are
 * genuinely wrong (a non-numeric string where a number is required stays a
 * string and produces the normal validation error through the boundary).
 *
 * @module coerceToolArguments
 */

/**
 * A JSON Schema node, loosely typed. We only ever read well-known keys from it
 * (`type`, `properties`, `items`, `anyOf`, `oneOf`, `allOf`, `enum`), so a
 * permissive structural type keeps the walker readable without dragging in a
 * full JSON-Schema type library.
 */
type JsonSchemaNode = {
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode | ReadonlyArray<JsonSchemaNode>;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly oneOf?: ReadonlyArray<JsonSchemaNode>;
  readonly allOf?: ReadonlyArray<JsonSchemaNode>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly $ref?: string;
  readonly [key: string]: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follow a local JSON pointer (`#/$defs/Name`) into the schema document. */
const lookupPointer = (root: JsonSchemaNode, ref: string): JsonSchemaNode | undefined => {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return isPlainObject(node) ? (node as JsonSchemaNode) : undefined;
};

/**
 * Resolve a `$ref` node against the document it came from.
 *
 * Effect hoists a schema it emits more than once into `$defs` and refers to it
 * by pointer — `exitConditions.items` is `{"$ref": "#/$defs/Union_"}`. Without
 * this the walker sees a node with no `type` and no `properties` and coerces
 * nothing inside it. The hop limit is a cycle guard for a self-referential
 * definition; an unresolvable ref falls back to the node as written.
 */
const resolveNode = (node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode => {
  let current = node;
  for (let hops = 0; typeof current.$ref === "string" && hops < 10; hops += 1) {
    const target = lookupPointer(root, current.$ref);
    if (target === undefined) return current;
    current = target;
  }
  return current;
};

/**
 * The leaf types a schema node will accept.
 *
 * A node that declares its own `type` is a leaf, full stop. Effect emits a
 * constrained number as `{type:"number", allOf:[{minimum:0}]}` — the `allOf`
 * there *refines* the declared type rather than offering an alternative to it,
 * so reading `allOf` first would answer "accepts nothing" for every bounded
 * number in the trading contracts. Only a node with no `type` of its own is a
 * composite worth flattening.
 */
const acceptedLeafTypes = (
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  depth = 0,
): ReadonlyArray<string> => {
  if (depth > 8) return [];
  const resolved = resolveNode(node, root);
  const declared = resolved.type;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared)) return [...declared];

  const branches = resolved.anyOf ?? resolved.oneOf ?? resolved.allOf;
  if (!Array.isArray(branches)) return [];
  return branches.flatMap((branch) => acceptedLeafTypes(branch, root, depth + 1));
};

const coerceToStringCompatible = (value: string, types: ReadonlyArray<string>): unknown => {
  // Apply the first declared type the value can honestly satisfy. The order
  // mirrors the schema's own branch order, which already lists the preferred
  // (non-string) shape first — so a `"100"` against `[number, string]` becomes
  // the number, while a genuinely textual value falls through to `string`.
  for (const type of types) {
    if (type === "number" || type === "integer") {
      // `Number("")` is 0 and `Number(" ")` is 0; both are misleading. Require
      // at least one digit and a finite result so prose never silently coerces.
      if (value.trim() !== "" && Number.isFinite(Number(value))) {
        const numeric = Number(value);
        return type === "integer" ? Math.trunc(numeric) : numeric;
      }
    } else if (type === "boolean") {
      if (value === "true") return true;
      if (value === "false") return false;
    } else if (type === "object" || type === "array") {
      // Some CLIs stringify nested params. Only coerce when the string actually
      // parses to the declared shape, otherwise leave it and let validation
      // produce its own error.
      try {
        const parsed: unknown = JSON.parse(value);
        if (type === "object" && isPlainObject(parsed)) return parsed;
        if (type === "array" && Array.isArray(parsed)) return parsed;
      } catch {
        // Not JSON — leave the value untouched.
      }
    }
  }
  return value;
};

/**
 * The keys a model wraps a scalar in when it answers a list-of-literals with a
 * list of records. `timeframes: [{name:"15m", role:"thesis"}]` against
 * `["1m"|"3m"|...]` is the observed shape — the value is right there, labelled,
 * and the whole publish was lost for the wrapper around it.
 */
const SCALAR_WRAPPER_KEYS = ["name", "value", "interval", "timeframe"] as const;

/**
 * Unwrap `{name:"15m"}` to `"15m"` where the schema declares a string.
 *
 * Only ever unwraps to a string the schema would already accept: when the node
 * declares an `enum`, a value outside it is left alone and fails validation as
 * before. Returns `undefined` when there is nothing safe to unwrap.
 */
const unwrapScalarObject = (
  value: Record<string, unknown>,
  schema: JsonSchemaNode,
): string | undefined => {
  if (schema.type !== "string") return undefined;
  for (const key of SCALAR_WRAPPER_KEYS) {
    const inner = value[key];
    if (typeof inner !== "string") continue;
    if (Array.isArray(schema.enum) && !schema.enum.includes(inner)) continue;
    return inner;
  }
  return undefined;
};

const coerceValue = (value: unknown, node: JsonSchemaNode, root: JsonSchemaNode): unknown => {
  if (value === null || value === undefined) return value;

  const schema = resolveNode(node, root);

  // An empty object where the schema declares an array. Models emit `{}` for
  // "nothing here" against `scaleInConditions: []`, and the two carry the same
  // meaning; a non-empty object is a real mistake and still fails.
  if (schema.type === "array" && isPlainObject(value) && Object.keys(value).length === 0) {
    return [];
  }

  if (isPlainObject(value)) {
    const unwrapped = unwrapScalarObject(value, schema);
    if (unwrapped !== undefined) return unwrapped;
  }

  // A string value where the schema declares an object/array: some CLIs
  // stringify nested params. Try to JSON-parse it into the declared shape
  // before falling back to structural recursion or passthrough. Only coerce
  // when the parse honestly matches the declared type.
  if (typeof value === "string" && (schema.type === "object" || schema.type === "array")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (schema.type === "object" && isPlainObject(parsed)) {
        return coerceValue(parsed, schema, root);
      }
      if (schema.type === "array" && Array.isArray(parsed)) {
        return coerceValue(parsed, schema, root);
      }
    } catch {
      // Not JSON — fall through to passthrough below.
    }
    return value;
  }

  // Composite nodes recurse structurally; their `type` is structural guidance,
  // not a coercion target, so they never reach the leaf-type path.
  if (schema.type === "object" || (isPlainObject(value) && schema.properties)) {
    if (!isPlainObject(value)) return value;
    const props = schema.properties ?? {};
    const coerced: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = props[key];
      coerced[key] = childSchema ? coerceValue(child, childSchema, root) : child;
    }
    return coerced;
  }

  if (schema.type === "array" || (Array.isArray(value) && schema.items)) {
    if (!Array.isArray(value)) return value;
    const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    if (itemSchema === undefined) return value;
    return value.map((item) => coerceValue(item, itemSchema, root));
  }

  // Union branches (anyOf/oneOf) at a leaf: try to coerce into whichever branch
  // the value can satisfy. For a non-string value, walk the branches and return
  // the first that structurally accepts it; for a string, defer to the leaf
  // coercion which already honors the declared types.
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (schema.anyOf ?? schema.oneOf) as ReadonlyArray<JsonSchemaNode>;
    if (typeof value === "string") {
      return coerceToStringCompatible(
        value,
        branches.flatMap((branch) => acceptedLeafTypes(branch, root)),
      );
    }
    // A non-string value against a union: try each branch in order and return
    // the first coercion whose shape matches, else the original value.
    for (const branch of branches) {
      const candidate = coerceValue(value, branch, root);
      if (candidate !== value) return candidate;
    }
    return value;
  }

  if (typeof value === "string") {
    return coerceToStringCompatible(value, acceptedLeafTypes(schema, root));
  }

  return value;
};

/**
 * Coerce incoming MCP tool arguments to match a tool's JSON schema, in place
 * where safe. Pure: returns a new value, never mutates the input.
 *
 * The schema is whatever `Tool.getJsonSchema(tool)` produced (a JSON Schema
 * document). The arguments are the raw `params.arguments` object the provider
 * sent. Values that already match the declared type pass through untouched, so
 * an already-valid payload is byte-identical.
 *
 * The document doubles as the resolution root for any `$ref` the walker meets
 * on the way down, so hoisted `$defs` are coerced like inline shapes.
 */
export const coerceToolArguments = (jsonSchema: unknown, args: unknown): unknown => {
  if (!isPlainObject(jsonSchema) || !isPlainObject(args)) return args;
  const root = jsonSchema as JsonSchemaNode;
  return coerceValue(args, root, root);
};
