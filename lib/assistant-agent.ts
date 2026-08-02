/**
 * Rally's Home assistant, rebuilt as a genuine bounded reason-act loop on the vendored
 * `@conduit/agent` `runAgent`. This module is the Rally-specific wiring OUTSIDE the vendored
 * copy: it declares the READ-ONLY tools the loop may call, the runtime-loaded SKILLS selected
 * by intent, and the model-call adapter that routes every step through the embedded
 * `@conduit/client` seam (so the loop stays metered and gateway-reported, on the same tier
 * cascade the rest of Rally uses).
 *
 * The invariant Rally rests on is preserved verbatim: the model has NO authority. Every tool it
 * can call is read-only or produces a DRAFT the user confirms in the UI. No tool writes a
 * points-bearing row, and the loop runs with `allowSideEffects: false`, so a side-effecting tool
 * (were one ever added) is refused by default rather than executed. Drafting is not authority: a
 * recognition draft only lets the helped teammate confirm it later; the loop never awards points.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { runAgent, type Skill, type Tool } from '@/lib/conduit/agent';
import type { ChatMessage } from '@/lib/conduit/agent/core';
import type { ToolSpec } from '@/lib/conduit/agent';
import { MODELS } from '@/lib/agent';
import { extractJson } from '@/lib/agent';
import { ASSISTANT_TOOLS, isProposeTool, isSafeTool, toProposal, type Proposal } from '@/lib/assistant';
import { runSafeTool } from '@/lib/assistant-admin';
import { inferViaConduit } from '@/lib/conduit/rally-client';

/** Bounded step cap: a never-finishing model stops here rather than looping forever. */
export const MAX_AGENT_STEPS = 6;

/**
 * The read-only tools the loop exposes. We reuse Rally's existing assistant tool set, minus
 * `remember`: the memory write is the one SAFE tool that mutates external state, and exposing it
 * would put a write inside a loop we deliberately run with no authority. Reads run server-side and
 * feed their text back as an observation; propose-tools produce a Proposal object (a draft the user
 * confirms) and mutate nothing, so they are honestly non-side-effecting.
 *
 * `db`, `uid`, `nowMs`, `handle` bind the read handlers to the caller's own data (the loop reads
 * only what the caller could already read). Drafts are collected into `proposals` by reference.
 */
export function buildAssistantTools(deps: {
  db: Firestore;
  uid: string;
  nowMs: number;
  handle: string | null;
  proposals: Proposal[];
}): Tool[] {
  const tools: Tool[] = [];
  for (const spec of ASSISTANT_TOOLS) {
    if (spec.name === 'remember') continue; // the one write; kept out of the no-authority loop.
    const jsonSchema = spec.input_schema as unknown as Tool['jsonSchema'];
    if (isSafeTool(spec.name)) {
      tools.push({
        name: spec.name,
        description: spec.description,
        jsonSchema,
        sideEffecting: false,
        handler: async (args) =>
          runSafeTool(deps.db, deps.uid, spec.name, args as Record<string, unknown>, deps.nowMs, deps.handle),
      });
    } else if (isProposeTool(spec.name)) {
      tools.push({
        name: spec.name,
        description: spec.description,
        jsonSchema,
        sideEffecting: false, // a draft mutates nothing; it returns a proposal for the user to confirm.
        handler: async (args) => {
          const p = toProposal(spec.name, args as Record<string, unknown>);
          if (!p) return 'Could not draft that from those arguments.';
          deps.proposals.push(p);
          return `Drafted a ${p.kind} and shown to the user to confirm. You cannot confirm it yourself.`;
        },
      });
    }
  }
  return tools;
}

/**
 * Runtime-loaded skills, selected by intent. Each is a declarative module: when its `whenIntent`
 * predicate matches the run, the loop injects its `instructions` into the system prompt. Skills add
 * capability by shaping guidance at runtime, never by branching the loop. Non-matching intents
 * inject nothing.
 */
export const ASSISTANT_SKILLS: readonly Skill[] = [
  {
    id: 'catch-up-summary',
    whenIntent: ({ goal }) => /\b(catch|caught|miss(ed|ing)?|what'?s up|what is up|what happened|since|new|updates?)\b/i.test(goal),
    instructions:
      'The user wants to be caught up. Call catch_me_up first, then give ONE short, warm summary of what needs them: recognitions awaiting their confirm, commitments due, the busiest unread channel. Do not pad. If nothing needs them, say so kindly.',
  },
  {
    id: 'recognition-draft',
    whenIntent: ({ goal }) => /\b(thank|thanks|recogni[sz]e|recognition|shout ?out|kudos|credit|helped|unblocked|appreciate)\b/i.test(goal),
    instructions:
      'The user wants to recognize a teammate. If you are unsure who they mean, call find_teammate first. Then call propose_recognition to DRAFT it. Recognition is peer-confirmed: the drafted note only lets the helped teammate confirm it later, and points are awarded by the ledger, never by you. Tell the user the draft is waiting for their confirm.',
  },
  {
    id: 'ask-answer',
    whenIntent: ({ goal }) => /\b(decide|decided|summar|discuss|in #|channel|what did we|recap|going on in)\b/i.test(goal),
    instructions:
      'The user is asking about a channel. Call summarize_channel with the channel name (and their question if there is one). Ground your answer ONLY in what the tool returns. If the tool shows no relevant messages, say you could not find it rather than guessing.',
  },
];

/** Serialize the running transcript into a single prompt for Rally\'s single-turn model call. */
function renderTranscript(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
}

/** Describe the advertised tools (name, description, argument schema) for the protocol prompt. */
function renderTools(tools: ToolSpec[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description}\n  args schema: ${JSON.stringify(t.jsonSchema)}`)
    .join('\n');
}

/**
 * The @conduit/agent `CallModel` adapter. Rally\'s model access is single-turn text, so each loop
 * step is expressed as a strict JSON protocol: the model returns EITHER a tool call or a final
 * answer as one JSON object, which we parse into the `ModelTurn` the loop expects. The call is
 * routed through `inferViaConduit`, so it flows through the embedded @conduit/client seam and stays
 * metered + gateway-reported, on the configured tier. `infer` is injectable so the adapter is
 * testable without a live model.
 */
export function buildCallModel(deps: {
  feature?: string;
  model?: string;
  maxTokens?: number;
  infer?: typeof inferViaConduit;
}): (input: { system: string; messages: ChatMessage[]; tools?: ToolSpec[] }) => Promise<{ toolCall?: { name: string; args: unknown }; finalAnswer?: string }> {
  const infer = deps.infer ?? inferViaConduit;
  const model = deps.model ?? MODELS.default;
  return async ({ system, messages, tools = [] }) => {
    const protocol = [
      system,
      '',
      'You act as a bounded agent. On EACH turn respond with EXACTLY ONE JSON object and nothing else.',
      'To use a tool: {"tool":"<tool_name>","args":{ ... }}',
      'To give your final answer to the user: {"final":"<your reply text>"}',
      'Never invent a tool result. Prefer a tool over guessing. Once you have enough, give a final answer.',
      '',
      tools.length ? `Available tools:\n${renderTools(tools)}` : 'No tools are available; answer directly.',
    ].join('\n');

    const { text } = await infer({
      feature: deps.feature ?? 'assistant',
      model,
      system: protocol,
      prompt: renderTranscript(messages),
      maxTokens: deps.maxTokens ?? 1024,
      // Per-STEP budget, not per-turn. A user is waiting, but this call can happen up to
      // MAX_AGENT_STEPS times in one turn, so an interactive budget per step would compound into a
      // minutes-long turn. `agentStep` keeps one retry and a tight total so the whole loop stays
      // bounded; a step that still fails ends the loop in its existing safe fallback.
      retryProfile: 'agentStep',
    });

    const parsed = extractJson<{ tool?: unknown; args?: unknown; final?: unknown }>(
      text,
      (v): v is { tool?: unknown; args?: unknown; final?: unknown } => typeof v === 'object' && v !== null,
    );
    if (!parsed) {
      // Unparseable: if the model wrote prose, treat it as the final answer; otherwise no action.
      return text && text.trim() ? { finalAnswer: text.trim() } : {};
    }
    if (typeof parsed.final === 'string') return { finalAnswer: parsed.final };
    if (typeof parsed.tool === 'string') {
      return { toolCall: { name: parsed.tool, args: (parsed.args ?? {}) as unknown } };
    }
    return {};
  };
}

/** The base system prompt the loop starts from; `runAgent` appends the goal and matched skills. */
export function assistantSystemPrompt(memory: string[], history: ChatMessage[] = []): string {
  const base = [
    'You are Rally, a warm, concise assistant that lives inside the Rally cohort app.',
    'You help the user talk to their cohort, recognize teammates who help them, and keep the commitments they make.',
    '',
    'Rules you never break:',
    '- You are always "Rally". Never call yourself a model, a bot, or any brand.',
    '- You can READ what the user could already read, and DRAFT actions. You never award points, never post as the user, and never confirm a recognition. Those are proposals the user confirms with one tap.',
    '- Recognition is peer-confirmed: proposing it only lets the helped teammate confirm later. You cannot grant points.',
    '- Be kind. Never shame anyone. Missing a commitment is never punished.',
    '- Prefer calling a tool over guessing.',
  ];
  if (memory.length) {
    base.push('', 'What you remember about this user:', ...memory.map((n) => `- ${n}`));
  }
  if (history.length) {
    base.push('', 'Conversation so far (read-only context):', ...history.map((m) => `${m.role}: ${m.content}`));
  }
  return base.join('\n');
}

/** Re-export the loop so callers wire one runAgent import. */
export { runAgent };
