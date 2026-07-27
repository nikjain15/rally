/**
 * HTTP/SSE transport entry, for hosted distribution.
 *
 * The MCP SSE transport uses two endpoints: a long lived `GET` that opens the
 * event stream, and a `POST` that carries client messages back, correlated by
 * session id. This module keeps a session map and exposes two thin handlers so
 * the surrounding HTTP framework (Express, a Worker, etc.) stays the caller's
 * choice. All tool logic lives in the shared registry.
 */
import { createMcpServer, type CreateMcpServerOptions } from "./server";

/** A live SSE session: its transport plus the server bound to it. */
interface SseSession {
  transport: import("@modelcontextprotocol/sdk/server/sse.js").SSEServerTransport;
  server: import("@modelcontextprotocol/sdk/server/index.js").Server;
}

export interface SseHandler {
  /** Handle the SSE stream open request (`GET /sse`). */
  handleSse(req: unknown, res: unknown): Promise<void>;
  /** Handle a client message (`POST /messages?sessionId=...`). */
  handleMessage(sessionId: string, req: unknown, res: unknown): Promise<void>;
  /** Number of currently open sessions. */
  sessionCount(): number;
}

/**
 * Create a pair of SSE handlers backed by a fresh server per session. Pass the
 * POST endpoint path the client should send messages to (for example
 * `/messages`); the SDK advertises it to the client on connect.
 */
export async function createSseHandler(
  options: CreateMcpServerOptions,
  messageEndpoint = "/messages",
): Promise<SseHandler> {
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const sessions = new Map<string, SseSession>();

  return {
    async handleSse(_req: unknown, res: unknown): Promise<void> {
      const transport = new SSEServerTransport(messageEndpoint, res);
      const { server } = await createMcpServer(options);
      sessions.set(transport.sessionId, { transport, server });
      await server.connect(transport);
    },

    async handleMessage(sessionId: string, req: unknown, res: unknown): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`unknown SSE session: ${sessionId}`);
      }
      await session.transport.handlePostMessage(req, res);
    },

    sessionCount(): number {
      return sessions.size;
    },
  };
}
