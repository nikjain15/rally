/**
 * A Tool is a named capability the agent loop can invoke. It carries its own input
 * JSON schema, an optional side-effecting flag (see the no-authority invariant in
 * loop.ts), and an async handler. The loop validates arguments against `jsonSchema`
 * BEFORE calling the handler; on invalid arguments or a handler throw it feeds a
 * structured error observation back into the conversation rather than throwing out
 * of the loop.
 */
import type { JsonSchema } from "./schema";

export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  /** Input schema. Arguments proposed by the model are validated against this. */
  jsonSchema: JsonSchema;
  /**
   * When true the tool mutates external state. Such tools are REFUSED by default and
   * only run when the loop is invoked with `allowSideEffects: true` (see loop.ts).
   */
  sideEffecting?: boolean;
  handler(args: Args): Promise<Result>;
}

/** The wire shape the loop advertises to the model (name, description, schema). */
export interface ToolSpec {
  name: string;
  description: string;
  jsonSchema: JsonSchema;
  sideEffecting: boolean;
}

export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    jsonSchema: tool.jsonSchema,
    sideEffecting: tool.sideEffecting === true,
  };
}
