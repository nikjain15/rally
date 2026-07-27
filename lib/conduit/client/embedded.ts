/**
 * Embedded transport: implements the unified client surface by calling injected
 * core functions in-process. No network hop. The caller wires up the real
 * `resolve` / retrieval / agent / eval implementations (with their runtime
 * context already bound) and passes them as `core`.
 */
import type {
  AgentResult,
  ConduitClient,
  EmbeddedConfig,
  EvaluateParams,
  EvaluateResult,
  InferParams,
  InferResult,
  RetrieveParams,
  RetrieveResult,
  RunAgentParams,
  UsageParams,
  UsageResult,
} from "./types.ts";

const DEFAULT_TENANT = "org:example";
const DEFAULT_MAX_TOKENS = 1024;

export function createEmbeddedClient(config: EmbeddedConfig): ConduitClient {
  const { core } = config;
  const tenantId = config.tenantId ?? DEFAULT_TENANT;
  const defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    mode: "embedded",

    async infer(params: InferParams): Promise<InferResult> {
      const result = await core.resolve({
        useCase: params.useCase,
        tenantId,
        system: params.system,
        messages: params.messages,
        maxTokens: params.maxTokens ?? defaultMaxTokens,
        pinModel: params.pinModel,
      });
      return {
        output: result.text,
        model: result.providerModel ?? result.model.model,
        provider: result.model.provider,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        decisionId: result.decisionId,
      };
    },

    retrieve(params: RetrieveParams): Promise<RetrieveResult> {
      return core.retrieve(params);
    },

    runAgent(params: RunAgentParams): Promise<AgentResult> {
      return core.runAgent(params);
    },

    evaluate(params: EvaluateParams): Promise<EvaluateResult> {
      return core.evaluate(params);
    },

    usage(params?: UsageParams): Promise<UsageResult> {
      return core.usage(params ?? {});
    },
  };
}
