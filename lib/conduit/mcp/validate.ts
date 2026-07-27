/**
 * A small, dependency free JSON Schema validator for tool arguments.
 *
 * It supports the subset described by `JsonSchema`: type checks (including
 * integer and multi-type), required properties, nested object properties,
 * array items, enums, numeric bounds, string length, and
 * `additionalProperties`. It returns a list of structured issues rather than
 * throwing, so callers can turn failures into MCP error results.
 */
import type { JsonSchema, JsonSchemaType, ValidationIssue } from "./types";

function typeOf(value: unknown): JsonSchemaType | "undefined" {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  if (t === "string") return "string";
  if (t === "boolean") return "boolean";
  if (t === "object") return "object";
  return "null";
}

function matchesType(value: unknown, expected: JsonSchemaType): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function join(base: string, key: string | number): string {
  if (base === "") return String(key);
  return typeof key === "number" ? `${base}[${key}]` : `${base}.${key}`;
}

function validateNode(value: unknown, schema: JsonSchema, path: string, issues: ValidationIssue[]): void {
  // Type check.
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const okType = expected.some((t) => matchesType(value, t));
    if (!okType) {
      issues.push({
        path: path || "(root)",
        message: `expected type ${expected.join(" | ")}, got ${typeOf(value)}`,
      });
      // If the type is wrong there is little value in deeper checks.
      return;
    }
  }

  // Enum check.
  if (schema.enum !== undefined) {
    const inEnum = schema.enum.some((e) => e === value);
    if (!inEnum) {
      issues.push({
        path: path || "(root)",
        message: `value must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`,
      });
    }
  }

  const kind = typeOf(value);

  // Numeric bounds.
  if ((kind === "number" || kind === "integer") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path: path || "(root)", message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path: path || "(root)", message: `must be <= ${schema.maximum}` });
    }
  }

  // String length.
  if (kind === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path: path || "(root)", message: `must have length >= ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path: path || "(root)", message: `must have length <= ${schema.maxLength}` });
    }
  }

  // Object properties.
  if (kind === "object" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        issues.push({ path: join(path, key), message: "required property is missing" });
      }
    }

    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) {
        validateNode(obj[key], child, join(path, key), issues);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          issues.push({ path: join(path, key), message: "additional property is not allowed" });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          validateNode(obj[key], schema.additionalProperties, join(path, key), issues);
        }
      }
    }
  }

  // Array items.
  if (kind === "array" && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      validateNode(item, schema.items as JsonSchema, join(path, i), issues);
    });
  }
}

/**
 * Validate `args` against `schema`. Returns an empty array when valid and a
 * list of structured issues otherwise. Never throws for validation failures.
 */
export function validateArgs(args: unknown, schema: JsonSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateNode(args, schema, "", issues);
  return issues;
}
