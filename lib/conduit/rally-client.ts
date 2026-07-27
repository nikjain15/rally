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
    runAgent: async () => {
      throw new Error('conduit.runAgent is not enabled in Rally embedded mode');
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
