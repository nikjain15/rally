/**
 * Core shapes for @conduit/mcp.
 *
 * These types are transport agnostic. A `ConduitTool` describes a single
 * callable capability; the registry turns a set of them into the data an MCP
 * server needs for `tools/list` and `tools/call`. Nothing here imports the MCP
 * SDK, which keeps the registry unit testable without a live transport.
 */

/**
 * A minimal JSON Schema subset used to describe and validate tool arguments.
 * It covers the shapes real Conduit tools use: typed object inputs with
 * required fields, enums, arrays, and nested objects. It is intentionally
 * small; it is not a full Draft 2020-12 implementation.
 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  /** Escape hatch for keywords this subset does not model. */
  [key: string]: unknown;
}

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** A block of tool output, mirroring the MCP content model. */
export interface TextContent {
  type: "text";
  text: string;
}

export type ToolContent = TextContent;

/**
 * The result a tool handler returns. `structuredContent` carries a machine
 * readable payload alongside the human readable `content` blocks, matching the
 * MCP `CallToolResult` shape.
 */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * A Conduit tool: a name, a description, a JSON Schema for its arguments, and
 * an async handler. The handler receives arguments that have already been
 * validated against `inputSchema` by the registry.
 */
export interface ConduitTool<Args = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Args) => Promise<ToolResult>;
}

/** The public description of a tool, as returned by `tools/list`. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** A single argument validation problem. */
export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `filters.status`. */
  path: string;
  message: string;
}

export type RegistryErrorCode = "unknown_tool" | "invalid_arguments" | "handler_error";

/** A structured, non-throwing error surfaced by the registry. */
export interface RegistryError {
  code: RegistryErrorCode;
  message: string;
  issues?: ValidationIssue[];
}

/** Discriminated result of a registry call. Never throws for expected errors. */
export type CallOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; error: RegistryError };
