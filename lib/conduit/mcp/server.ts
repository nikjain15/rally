/**
 * Wiring a `ToolRegistry` onto an MCP server.
 *
 * `buildMcpServer` registers the `tools/list` and `tools/call` request handlers
 * on any object that looks like the SDK `Server` (see `McpServerLike`). It holds
 * no transport, so it can be tested with a fake server that captures handlers.
 *
 * `createMcpServer` is the thin runtime factory: it imports the real SDK,
 * constructs a `Server`, and delegates to `buildMcpServer`. It is the only piece
 * that needs the SDK present at runtime.
 */
import type { CallOutcome, ConduitTool, RegistryError, ToolResult } from "./types";
import { ToolRegistry } from "./registry";

/** The slice of the SDK `Server` this package depends on. */
export interface McpServerLike {
  setRequestHandler(
    schema: unknown,
    handler: (request: McpRequest) => Promise<unknown> | unknown,
  ): void;
}

/** The shape of an incoming MCP request the handlers read. */
export interface McpRequest {
  params?: {
    name?: string;
    arguments?: unknown;
  };
}

export interface CreateMcpServerOptions {
  name: string;
  version: string;
  tools: ConduitTool[];
}

/** Turn a registry error into an MCP `CallToolResult` flagged as an error. */
function errorToResult(error: RegistryError): ToolResult {
  const detail =
    error.issues && error.issues.length > 0
      ? "\n" + error.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")
      : "";
  return {
    isError: true,
    content: [{ type: "text", text: `${error.code}: ${error.message}${detail}` }],
    structuredContent: { error },
  };
}

/** Map any registry outcome to the MCP `CallToolResult` shape. */
export function outcomeToCallResult(outcome: CallOutcome): ToolResult {
  return outcome.ok ? outcome.result : errorToResult(outcome.error);
}

/**
 * Register `tools/list` and `tools/call` handlers on `server`, backed by
 * `registry`. Returns the schema objects imported from the SDK so callers can
 * assert wiring if needed. Pure with respect to transports.
 */
export function buildMcpServer(
  server: McpServerLike,
  registry: ToolRegistry,
  schemas: { listSchema: unknown; callSchema: unknown },
): void {
  server.setRequestHandler(schemas.listSchema, async () => ({
    tools: registry.list(),
  }));

  server.setRequestHandler(schemas.callSchema, async (request: McpRequest) => {
    const name = request.params?.name ?? "";
    const args = request.params?.arguments;
    const outcome = await registry.call(name, args);
    return outcomeToCallResult(outcome);
  });
}

/**
 * Build a live MCP server exposing `tools`. Imports the real MCP SDK at call
 * time so the pure registry above stays importable without the SDK installed.
 * The returned object is the SDK `Server`; connect it to a transport (see
 * `startStdioServer` / `createSseHandler`).
 */
export async function createMcpServer(
  options: CreateMcpServerOptions,
): Promise<{ server: import("@modelcontextprotocol/sdk/server/index.js").Server; registry: ToolRegistry }> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const registry = new ToolRegistry(options.tools);
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );

  buildMcpServer(server as unknown as McpServerLike, registry, {
    listSchema: ListToolsRequestSchema,
    callSchema: CallToolRequestSchema,
  });

  return { server, registry };
}
