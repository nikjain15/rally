import { createClient } from './client';
import type {
  ConduitClient,
  EmbeddedCore,
  InferResult,
  RetrieveParams,
  RetrieveResult,
} from './client';
import { callClaudeDetailed, type CallClaudeOpts } from '@/lib/agent';
import { selectRelevant, type RankableMessage } from '@/lib/retrieval';
import { reportDecision } from './reporter';
import { runAgent } from './agent';
import type { CallModel, RunAgentResult, Skill, Tool } from './agent';

/**
 * The Rally-side binding the embedded `runAgent` needs. The vendored loop is pure with respect to
 * IO: the caller injects the model call and every tool handler, so the bind carries exactly those
 * plus the run shape. `allowSideEffects` defaults to false (the no-authority invariant), and no
 * tool in Rally's set is side-effecting, so a write can never execute through this seam.
 */
export interface RallyAgentBind {
  tools: readonly Tool[];
  skills?: readonly Skill[];
  callModel: CallModel;
  maxSteps: number;
  system?: string;
  context?: string;
  allowSideEffects?: boolean;
  /** Captures the full loop trace (answer, steps, cap, loaded skills) the thin client return drops. */
  onResult?: (result: RunAgentResult) => void;
}

/**
 * The Conduit seam (docs/MCP.md, VENDOR.md).
 *
 * Rally keeps its own metered model path (`callClaudeDetailed`), its own tier
 * routing (lib/agent MODELS brief/default/escalate), and its own BM25 retrieval
 * (`selectRelevant`). This module wraps them as a Conduit EMBEDDED core so the
 * app's real answer paths (the Ask channel summary and the recognition-detect
 * classify) flow through the same unified `@conduit/client` surface an app
 * would use in gateway mode, with no network hop and no change to cost
 * accounting. The transport is swapped; the behaviour is identical.
 *
 * Embedded mode is designed for exactly this: the caller binds the runtime
 * context (the resolved model tier, the system prompt, the sampling dial and the
 * meter feature) before injection, which is why the real Rally call options are
 * threaded in through `bind` rather than reconstructed from the wire params.
 *
 * The invariant Rally rests on is preserved: the model classifies/summarises/
 * drafts and NEVER writes a points-bearing row. This seam only reads text back
 * and mirrors a metered record; it carries no authority over the ledger.
 */
const TENANT = 'rally';
const PROVIDER = 'anthropic'; // callClaude is Anthropic-only (lib/agent.ts).

/** The Rally call the embedded `resolve` should run, bound before injection. */
export type RallyResolveBind = Omit<CallClaudeOpts, 'prompt'> & { prompt: string };

interface ClientBind {
  /** Bound model call for `resolve`. */
  call?: RallyResolveBind;
  /** Candidate messages for `retrieve` (a channel window the caller already read). */
  candidates?: RankableMessage[];
  /** Captures the full metered record `resolve` produced. */
  onResult?: (result: InferResult) => void;
  /** The bounded agent loop binding, when this client is used to run `runAgent`. */
  agent?: RallyAgentBind;
}

/**
 * Rally BM25 retrieval, exposed through Conduit's unified `retrieve`. Read-only
 * over the candidate window the caller supplies (messages it could already read),
 * so retrieval honours the same membership boundary the Ask route enforces.
 */
function rallyRetrieve(candidates: RankableMessage[]): EmbeddedCore['retrieve'] {
  return async (params: RetrieveParams): Promise<RetrieveResult> => {
    const { relevant, selected } = selectRelevant(candidates, params.query, {
      topK: params.topK ?? 12,
    });
    const chunks = selected.map((m, i) => ({
      id: String(i),
      score: relevant ? 1 : 0,
      text: `${m.author}: ${m.body}`,
    }));
    return { chunks, grounded: relevant && chunks.length > 0 };
  };
}

/** Build an embedded ConduitClient backed by Rally's own model + retrieval. */
export function createRallyClient(bind: ClientBind = {}): ConduitClient {
  const core: EmbeddedCore = {
    resolve: async (task) => {
      // The injected call carries the resolved tier, prompt, sampling dial and
      // meter feature (bound before injection). If none was bound, reconstruct a
      // minimal call from the wire task so the client is still usable directly.
      const call: RallyResolveBind =
        bind.call ??
        ({
          model: task.pinModel?.model ?? 'claude-sonnet-5',
          system: task.system ?? '',
          prompt: task.messages.map((m) => m.content).join('\n\n'),
          maxTokens: task.maxTokens,
          feature: task.useCase,
        } as RallyResolveBind);

      const detailed = await callClaudeDetailed(call);
      if (!detailed) {
        // Model off or failed: surface an empty text with a zero-cost record so
        // the caller's existing null/degrade path still triggers (text === '').
        return {
          text: '',
          model: { provider: PROVIDER, model: call.model },
          providerModel: call.model,
          costUsd: 0,
          latencyMs: 0,
        };
      }
      return {
        text: detailed.text ?? '',
        model: { provider: PROVIDER, model: detailed.model },
        providerModel: detailed.model,
        costUsd: detailed.costUsd,
        latencyMs: detailed.latencyMs,
      };
    },
    retrieve: rallyRetrieve(bind.candidates ?? []),
    runAgent: async (params) => {
      // The bounded reason-act loop, wired for real. The Rally agent binding (tools, skills, the
      // metered model-call adapter) is injected before use; without it the client is not an agent
      // runner, so we say so plainly rather than pretend. `allowSideEffects` defaults false: the
      // no-authority invariant means a side-effecting tool is refused, never executed.
      const agent = bind.agent;
      if (!agent) {
        throw new Error('conduit.runAgent needs a Rally agent binding (tools + callModel) to run');
      }
      const result = await runAgent({
        goal: params.goal,
        tools: agent.tools,
        skills: agent.skills,
        callModel: agent.callModel,
        maxSteps: params.maxSteps ?? agent.maxSteps,
        system: agent.system,
        context: agent.context,
        allowSideEffects: agent.allowSideEffects ?? false,
      });
      agent.onResult?.(result);
      return { answer: result.answer ?? '', steps: result.steps };
    },
    evaluate: async () => {
      throw new Error('conduit.evaluate is not enabled in Rally embedded mode');
    },
    usage: async () => ({ totalCostUsd: 0, byApp: [] }),
  };
  return createClient({ mode: 'embedded', core, tenantId: TENANT });
}

/** The text + metered record a Conduit-routed Rally call returns. */
export type InferViaConduitResult = {
  /** null exactly when the underlying model call produced no text (absence/failure). */
  text: string | null;
  record: InferResult;
};

/**
 * THE seam the Ask summary and the detect classify use: run one Rally model call
 * through `@conduit/client` (embedded) and return the text plus the metered
 * record. The client's `infer` is what actually drives the call, so the answer
 * genuinely flows through Conduit's unified interface. The tier routing lives in
 * the caller (it picks `call.model`), so the cost cascade is untouched.
 *
 * Fires the live-usage tap: mirror the metered record to the Conduit gateway
 * when it is configured. Fire-and-forget and pre-caught, so it can never block
 * or fail the answer, and a NO-OP when the gateway env vars are unset.
 */
export async function inferViaConduit(call: RallyResolveBind): Promise<InferViaConduitResult> {
  const client = createRallyClient({ call });
  const record = await client.infer({
    useCase: call.feature ?? call.model,
    system: call.system,
    messages: [{ role: 'user', content: call.prompt }],
    maxTokens: call.maxTokens,
    pinModel: { provider: PROVIDER, model: call.model },
  });

  void reportDecision({
    useCase: call.feature ?? call.model,
    model: record.model,
    provider: record.provider,
    costUsd: record.costUsd,
    latencyMs: record.latencyMs,
  });

  // record.output is '' only when the model was off/failed (resolve degraded).
  const text = record.output === '' ? null : record.output;
  return { text, record };
}

/**
 * THE seam the Home assistant uses: run the bounded reason-act loop through `@conduit/client`
 * (embedded), so the agent path flows through Conduit's unified interface exactly as the Ask and
 * detect paths do. Every model step inside the loop is itself routed through `inferViaConduit`
 * (via the injected `callModel`), so each step stays metered and gateway-reported. Returns the full
 * loop trace (answer, steps, cap, loaded skills), which the thin client `AgentResult` drops.
 */
export async function runAgentViaConduit(agent: RallyAgentBind, goal: string): Promise<RunAgentResult> {
  let captured: RunAgentResult | undefined;
  const client = createRallyClient({ agent: { ...agent, onResult: (r) => (captured = r) } });
  await client.runAgent({ goal, maxSteps: agent.maxSteps });
  // `captured` is always set: onResult fires synchronously inside the awaited runAgent.
  return captured as RunAgentResult;
}
