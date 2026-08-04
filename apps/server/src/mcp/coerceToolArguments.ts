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
  readonly [key: string]: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The leaf types a schema node will accept, collected by flattening
 * `anyOf` / `oneOf` / `allOf` and reading `type` (which JSON Schema allows to
 * be an array). `type` is only meaningful at a leaf — composite nodes
 * (`object`/`array`) declare their own `type` and never need flattening for
 * coercion, so we stop descending at composites and let the structural walker
 * handle them.
 */
const acceptedLeafTypes = (node: JsonSchemaNode): ReadonlyArray<string> => {
  if (Array.isArray(node.anyOf)) return node.anyOf.flatMap(acceptedLeafTypes);
  if (Array.isArray(node.oneOf)) return node.oneOf.flatMap(acceptedLeafTypes);
  // `allOf` merges constraints rather than offering alternatives; a node that
  // is `allOf:[{type:number}]` accepts only number. Flatten to honor that.
  if (Array.isArray(node.allOf)) return node.allOf.flatMap(acceptedLeafTypes);
  const declared = node.type;
  if (declared === undefined) return [];
  if (typeof declared === "string") return [declared];
  return [...declared];
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

const coerceValue = (value: unknown, node: JsonSchemaNode): unknown => {
  if (value === null || value === undefined) return value;

  // A string value where the schema declares an object/array: some CLIs
  // stringify nested params. Try to JSON-parse it into the declared shape
  // before falling back to structural recursion or passthrough. Only coerce
  // when the parse honestly matches the declared type.
  if (typeof value === "string" && (node.type === "object" || node.type === "array")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (node.type === "object" && isPlainObject(parsed)) {
        return coerceValue(parsed, node);
      }
      if (node.type === "array" && Array.isArray(parsed)) {
        return coerceValue(parsed, node);
      }
    } catch {
      // Not JSON — fall through to passthrough below.
    }
    return value;
  }

  // Composite nodes recurse structurally; their `type` is structural guidance,
  // not a coercion target, so they never reach the leaf-type path.
  if (node.type === "object" || (isPlainObject(value) && node.properties)) {
    if (!isPlainObject(value)) return value;
    const props = node.properties ?? {};
    const coerced: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = props[key];
      coerced[key] = childSchema ? coerceValue(child, childSchema) : child;
    }
    return coerced;
  }

  if (node.type === "array" || (Array.isArray(value) && node.items)) {
    if (!Array.isArray(value)) return value;
    const itemSchema = Array.isArray(node.items) ? node.items[0] : node.items;
    if (itemSchema === undefined) return value;
    return value.map((item) => coerceValue(item, itemSchema));
  }

  // Union branches (anyOf/oneOf) at a leaf: try to coerce into whichever branch
  // the value can satisfy. For a non-string value, walk the branches and return
  // the first that structurally accepts it; for a string, defer to the leaf
  // coercion which already honors the declared types.
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const branches = (node.anyOf ?? node.oneOf) as ReadonlyArray<JsonSchemaNode>;
    if (typeof value === "string") {
      return coerceToStringCompatible(value, branches.flatMap(acceptedLeafTypes));
    }
    // A non-string value against a union: try each branch in order and return
    // the first coercion whose shape matches, else the original value.
    for (const branch of branches) {
      const candidate = coerceValue(value, branch);
      if (candidate !== value) return candidate;
    }
    return value;
  }

  if (typeof value === "string") {
    return coerceToStringCompatible(value, acceptedLeafTypes(node));
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
 */
export const coerceToolArguments = (jsonSchema: unknown, args: unknown): unknown => {
  if (!isPlainObject(jsonSchema) || !isPlainObject(args)) return args;
  return coerceValue(args, jsonSchema as JsonSchemaNode);
};
