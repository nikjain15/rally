/**
 * Stdio transport entry, for local clients such as Claude Desktop.
 *
 * Kept intentionally thin: it builds the server from the shared factory and
 * connects it to the SDK stdio transport. All tool logic lives in the registry.
 */
import { createMcpServer, type CreateMcpServerOptions } from "./server";

/**
 * Start an MCP server over stdio and connect it. Resolves once connected; the
 * process then serves requests until the transport closes.
 */
export async function startStdioServer(options: CreateMcpServerOptions): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { server } = await createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
