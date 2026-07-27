/**
 * The tool registry: the pure heart of @conduit/mcp.
 *
 * It holds a set of `ConduitTool`s and answers the two questions an MCP server
 * asks: "what tools exist" (`list`) and "run this tool with these arguments"
 * (`call`). It validates arguments against each tool's JSON Schema and returns
 * structured, non-throwing outcomes. It imports no transport and no SDK, so it
 * is fully unit testable on its own.
 */
import type {
  CallOutcome,
  ConduitTool,
  RegistryError,
  ToolDescriptor,
  ToolResult,
} from "./types";
import { validateArgs } from "./validate";

export class ToolRegistry {
  private readonly tools = new Map<string, ConduitTool>();

  constructor(tools: ConduitTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /** Register a tool. Throws only for programmer error (duplicate name). */
  register(tool: ConduitTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ConduitTool);
  }

  /** True when a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** The public descriptors for `tools/list`, sorted by name for stable output. */
  list(): ToolDescriptor[] {
    return [...this.tools.values()]
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Run a tool by name with raw arguments. Validates the arguments first and
   * returns a structured outcome. Expected failures (unknown tool, invalid
   * arguments, handler throw) are returned as `{ ok: false, error }`, never
   * thrown, so transports can map them to MCP error results uniformly.
   */
  async call(name: string, args: unknown): Promise<CallOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      const error: RegistryError = {
        code: "unknown_tool",
        message: `unknown tool: ${name}`,
      };
      return { ok: false, error };
    }

    const issues = validateArgs(args ?? {}, tool.inputSchema);
    if (issues.length > 0) {
      const error: RegistryError = {
        code: "invalid_arguments",
        message: `invalid arguments for tool ${name}`,
        issues,
      };
      return { ok: false, error };
    }

    try {
      const result: ToolResult = await tool.handler((args ?? {}) as Record<string, unknown>);
      return { ok: true, result };
    } catch (err) {
      const error: RegistryError = {
        code: "handler_error",
        message: err instanceof Error ? err.message : `tool ${name} handler failed`,
      };
      return { ok: false, error };
    }
  }
}
