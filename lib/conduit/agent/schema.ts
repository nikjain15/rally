/**
 * A small, dependency-free JSON Schema validator covering the subset a tool input
 * schema realistically uses: object/array/string/number/integer/boolean/null,
 * `required`, `properties`, `items`, `enum`, and numeric/length bounds. It is
 * deliberately not a full Draft-2020 implementation: the loop only needs to reject
 * malformed tool arguments before a handler runs, and to turn a rejection into a
 * structured observation (never a throw). Unknown keywords are ignored rather than
 * treated as errors so a richer schema still validates its known parts.
 */

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function typeOf(value: unknown): JsonSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  return "object";
}

function typeMatches(value: unknown, expected: JsonSchemaType): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

/**
 * Validate `value` against `schema`. Pure: returns the collected errors instead of
 * throwing, so the caller decides how to surface them (the loop turns a non-empty
 * error list into an error observation).
 */
export function validate(value: unknown, schema: JsonSchema, path = "$"): ValidationResult {
  const errors: ValidationError[] = [];
  validateInto(value, schema, path, errors);
  return { valid: errors.length === 0, errors };
}

function validateInto(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push({ path, message: `value not in enum ${JSON.stringify(schema.enum)}` });
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(value, t))) {
      errors.push({ path, message: `expected type ${expected.join("|")}, got ${typeOf(value)}` });
      return; // a wrong base type makes deeper checks meaningless.
    }
  }

  const kind = typeOf(value);

  if (kind === "string") {
    const str = value as string;
    if (schema.minLength !== undefined && str.length < schema.minLength) {
      errors.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && str.length > schema.maxLength) {
      errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
  }

  if (kind === "number" || kind === "integer") {
    const num = value as number;
    if (schema.minimum !== undefined && num < schema.minimum) {
      errors.push({ path, message: `number below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && num > schema.maximum) {
      errors.push({ path, message: `number above maximum ${schema.maximum}` });
    }
  }

  if (kind === "array") {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
      errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.items) {
      arr.forEach((item, i) => validateInto(item, schema.items as JsonSchema, `${path}[${i}]`, errors));
    }
  }

  if (kind === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: "missing required property" });
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) validateInto(obj[key], sub, `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({ path: `${path}.${key}`, message: "additional property not allowed" });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
          validateInto(obj[key], schema.additionalProperties as JsonSchema, `${path}.${key}`, errors);
        }
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}
