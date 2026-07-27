/**
 * Minimal ambient declarations for the parts of `@modelcontextprotocol/sdk`
 * that the transport wiring uses. These mirror the SDK's documented API so the
 * transport code can `import` the real module specifiers and still typecheck in
 * an offline workspace where the SDK is not yet installed.
 *
 * When `@modelcontextprotocol/sdk` is installed, its own bundled types apply.
 * These declarations are a compile time fallback only; they are deliberately
 * narrow and cover just what this package calls. Keep them in sync with the
 * SDK's public API.
 */

declare module "@modelcontextprotocol/sdk/server/index.js" {
  export interface ServerInfo {
    name: string;
    version: string;
  }
  export interface ServerOptions {
    capabilities?: Record<string, unknown>;
  }
  /** Mirrors the SDK `Server` class (subset). */
  export class Server {
    constructor(info: ServerInfo, options?: ServerOptions);
    setRequestHandler(
      schema: unknown,
      handler: (request: any) => Promise<unknown> | unknown,
    ): void;
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  /** Mirrors the SDK `StdioServerTransport` class (subset). */
  export class StdioServerTransport {
    constructor();
  }
}

declare module "@modelcontextprotocol/sdk/server/sse.js" {
  /** Mirrors the SDK `SSEServerTransport` class (subset). */
  export class SSEServerTransport {
    constructor(endpoint: string, res: unknown);
    handlePostMessage(req: unknown, res: unknown, body?: unknown): Promise<void>;
    readonly sessionId: string;
  }
}

declare module "@modelcontextprotocol/sdk/types.js" {
  /** Request schema objects the SDK exposes for handler registration. */
  export const ListToolsRequestSchema: unknown;
  export const CallToolRequestSchema: unknown;
}
