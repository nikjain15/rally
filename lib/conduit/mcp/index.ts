/**
 * @conduit/mcp public surface.
 *
 * Turn a set of Conduit tools into a Model Context Protocol server. The tool
 * registry, argument validation, and error handling are pure and importable
 * without the MCP SDK. Transports (stdio, HTTP/SSE) are thin wrappers that
 * import the SDK at call time.
 */
export type {
  ConduitTool,
  ToolDescriptor,
  ToolResult,
  ToolContent,
  TextContent,
  JsonSchema,
  JsonSchemaType,
  ValidationIssue,
  RegistryError,
  RegistryErrorCode,
  CallOutcome,
} from "./types";

export { ToolRegistry } from "./registry";
export { validateArgs } from "./validate";

export {
  buildMcpServer,
  createMcpServer,
  outcomeToCallResult,
  type McpServerLike,
  type McpRequest,
  type CreateMcpServerOptions,
} from "./server";

export { startStdioServer } from "./stdio";
export { createSseHandler, type SseHandler } from "./http";
