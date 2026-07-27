/**
 * runAgent, a bounded reason-act loop.
 *
 * On each step the injected `callModel` sees the system prompt (base + any matched
 * skill instructions), the running transcript, and the advertised tool specs, and
 * proposes EITHER a tool call OR a final answer. A proposed tool call is validated
 * against the tool's input schema and, if side-effecting, gated by the no-authority
 * invariant; the result (or a structured error) becomes an observation appended to
 * the transcript, and the loop iterates. The loop is pure with respect to IO: every
 * external effect flows through `callModel` and the tool handlers the caller injects.
 *
 * No-authority invariant: a tool with `sideEffecting: true` is REFUSED unless the
 * run is invoked with `allowSideEffects: true`. Default deny. A refusal is fed back
 * as an observation (the model can pick a read-only path) and is NOT an exception.
 *
 * Termination: the loop returns when the model gives a final answer, or when
 * `maxSteps` model turns have been taken (a never-finishing model stops at the cap).
 */
import type { ChatMessage } from "./core";
import { validate, type ValidationError } from "./schema";
import { selectSkills, type Skill, type SkillContext } from "./skill";
import { toToolSpec, type Tool, type ToolSpec } from "./tool";

/** What the model proposes on a turn: exactly one of a tool call or a final answer. */
export interface ModelTurn {
  toolCall?: { name: string; args: unknown };
  finalAnswer?: string;
}

/**
 * Injected model-call function. The shape mirrors the inference core's resolve call
 * (system + messages), extended with the advertised tools. Tests mock this.
 */
export type CallModel = (input: {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
}) => Promise<ModelTurn>;

/** One recorded step of the run, for the returned trace. */
export type StepRecord =
  | { kind: "tool_call"; tool: string; args: unknown; ok: true; result: unknown }
  | { kind: "tool_error"; tool: string; args: unknown; ok: false; error: AgentError }
  | { kind: "final"; answer: string }
  | { kind: "no_action"; note: string };

export type AgentErrorKind =
  | "unknown_tool"
  | "invalid_args"
  | "side_effect_refused"
  | "handler_error";

export interface AgentError {
  kind: AgentErrorKind;
  message: string;
  /** Present for invalid_args: the schema validation failures. */
  validation?: ValidationError[];
}

export interface RunAgentInput {
  goal: string;
  tools: readonly Tool[];
  skills?: readonly Skill[];
  callModel: CallModel;
  maxSteps: number;
  /** Extra run context passed to skill intent predicates. */
  context?: string;
  /** Base system prompt; skill instructions are appended. A sensible default is used. */
  system?: string;
  /** No-authority override: side-effecting tools only run when this is true. */
  allowSideEffects?: boolean;
}

export interface RunAgentResult {
  /** The model's final answer, or undefined if the loop hit maxSteps first. */
  answer?: string;
  /** Ordered trace of every step taken. */
  steps: StepRecord[];
  /** True when the loop stopped because it reached maxSteps without a final answer. */
  stoppedAtCap: boolean;
  /** The ids of the skills whose instructions were injected this run. */
  loadedSkills: string[];
}

const DEFAULT_SYSTEM =
  "You are a Conduit agent. Work toward the goal step by step. On each turn either " +
  "call one tool to gather information or take an allowed action, or give a final " +
  "answer once you have enough. Do not invent tool results.";

function buildSystemPrompt(base: string, goal: string, skills: Skill[]): string {
  const parts = [base, `\nGoal: ${goal}`];
  if (skills.length > 0) {
    parts.push("\nActive skills:");
    for (const skill of skills) {
      parts.push(`\n[skill:${skill.id}]\n${skill.instructions}`);
    }
  }
  return parts.join("\n");
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const {
    goal,
    tools,
    skills = [],
    callModel,
    maxSteps,
    context,
    system = DEFAULT_SYSTEM,
    allowSideEffects = false,
  } = input;

  const skillCtx: SkillContext = { goal, context };
  const matchedSkills = selectSkills(skills, skillCtx);
  const systemPrompt = buildSystemPrompt(system, goal, matchedSkills);
  const toolSpecs = tools.map(toToolSpec);
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const messages: ChatMessage[] = [{ role: "user", content: goal }];
  const steps: StepRecord[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const turn = await callModel({ system: systemPrompt, messages, tools: toolSpecs });

    if (turn.finalAnswer !== undefined) {
      steps.push({ kind: "final", answer: turn.finalAnswer });
      messages.push({ role: "assistant", content: turn.finalAnswer });
      return { answer: turn.finalAnswer, steps, stoppedAtCap: false, loadedSkills: matchedSkills.map((s) => s.id) };
    }

    if (!turn.toolCall) {
      // The model neither answered nor acted; record it and nudge it to decide.
      const note = "model returned neither a tool call nor a final answer";
      steps.push({ kind: "no_action", note });
      messages.push({ role: "assistant", content: "(no action)" });
      messages.push({ role: "user", content: observation({ error: { kind: "handler_error", message: note } }) });
      continue;
    }

    const { name, args } = turn.toolCall;
    messages.push({ role: "assistant", content: `call ${name} ${safeJson(args)}` });

    const tool = toolByName.get(name);
    if (!tool) {
      const error: AgentError = { kind: "unknown_tool", message: `no tool named "${name}"` };
      steps.push({ kind: "tool_error", tool: name, args, ok: false, error });
      messages.push({ role: "user", content: observation({ error }) });
      continue;
    }

    // No-authority invariant: refuse side-effecting tools unless explicitly allowed.
    if (tool.sideEffecting && !allowSideEffects) {
      const error: AgentError = {
        kind: "side_effect_refused",
        message: `tool "${name}" is side-effecting and refused (allowSideEffects is not set)`,
      };
      steps.push({ kind: "tool_error", tool: name, args, ok: false, error });
      messages.push({ role: "user", content: observation({ error }) });
      continue;
    }

    // Validate arguments before touching the handler.
    const result = validate(args, tool.jsonSchema);
    if (!result.valid) {
      const error: AgentError = {
        kind: "invalid_args",
        message: `arguments for "${name}" failed schema validation`,
        validation: result.errors,
      };
      steps.push({ kind: "tool_error", tool: name, args, ok: false, error });
      messages.push({ role: "user", content: observation({ error }) });
      continue;
    }

    // Run the handler; a throw becomes a structured error observation, never a
    // loop-level exception.
    try {
      const output = await tool.handler(args as Record<string, unknown>);
      steps.push({ kind: "tool_call", tool: name, args, ok: true, result: output });
      messages.push({ role: "user", content: observation({ result: output }) });
    } catch (err) {
      const error: AgentError = {
        kind: "handler_error",
        message: err instanceof Error ? err.message : String(err),
      };
      steps.push({ kind: "tool_error", tool: name, args, ok: false, error });
      messages.push({ role: "user", content: observation({ error }) });
    }
  }

  // Reached the step cap without a final answer.
  return { answer: undefined, steps, stoppedAtCap: true, loadedSkills: matchedSkills.map((s) => s.id) };
}

/** Serialize an observation for the transcript. Structured so a model can parse it. */
function observation(payload: { result?: unknown } | { error: AgentError }): string {
  return `OBSERVATION ${safeJson(payload)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
