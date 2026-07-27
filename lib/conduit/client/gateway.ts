/**
 * Gateway transport: implements the unified client surface by calling the
 * conduit-gateway over HTTP against the fixed API contract.
 */
import { ConduitError } from "./error.ts";
import type {
  AgentResult,
  ConduitClient,
  EvaluateParams,
  EvaluateResult,
  FetchLike,
  GatewayConfig,
  InferParams,
  InferResult,
  ModelsParams,
  ModelsResult,
  ProfilesParams,
  ProfilesResult,
  ReportDecisionParams,
  ReportDecisionResult,
  RetrieveParams,
  RetrieveResult,
  RunAgentParams,
  SuqsParams,
  SuqsResult,
  UsageParams,
  UsageResult,
  UseCaseProfile,
} from "./types.ts";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createGatewayClient(config: GatewayConfig): ConduitClient {
  const base = trimSlash(config.baseUrl);
  const fetchImpl: FetchLike = config.fetch;

  const authHeader = `Bearer ${config.apiKey}`;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: authHeader };
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        try {
          parsed = await res.text();
        } catch {
          parsed = null;
        }
      }
      throw new ConduitError(
        `conduit-gateway ${method} ${path} failed with status ${res.status}`,
        res.status,
        parsed,
      );
    }
    return (await res.json()) as T;
  }

  return {
    mode: "gateway",

    infer(params: InferParams): Promise<InferResult> {
      return request<InferResult>("POST", "/v1/infer", params);
    },

    retrieve(params: RetrieveParams): Promise<RetrieveResult> {
      return request<RetrieveResult>("POST", "/v1/retrieve", params);
    },

    runAgent(params: RunAgentParams): Promise<AgentResult> {
      return request<AgentResult>("POST", "/v1/agent", params);
    },

    evaluate(params: EvaluateParams): Promise<EvaluateResult> {
      return request<EvaluateResult>("POST", "/v1/evals/run", params);
    },

    usage(params?: UsageParams): Promise<UsageResult> {
      const window = params?.window;
      const query = window ? `?window=${encodeURIComponent(window)}` : "";
      return request<UsageResult>("GET", `/v1/usage${query}`);
    },

    reportDecision(params: ReportDecisionParams): Promise<ReportDecisionResult> {
      return request<ReportDecisionResult>("POST", "/v1/decisions", params);
    },

    suqs(params?: SuqsParams): Promise<SuqsResult> {
      const window = params?.window;
      const query = window ? `?window=${encodeURIComponent(window)}` : "";
      return request<SuqsResult>("GET", `/v1/suqs${query}`);
    },

    models(params?: ModelsParams): Promise<ModelsResult> {
      const useCase = params?.useCase;
      const query = useCase ? `?useCase=${encodeURIComponent(useCase)}` : "";
      return request<ModelsResult>("GET", `/v1/models${query}`);
    },

    profiles(params?: ProfilesParams): Promise<ProfilesResult> {
      const useCase = params?.useCase;
      const query = useCase ? `?useCase=${encodeURIComponent(useCase)}` : "";
      return request<ProfilesResult>("GET", `/v1/profiles${query}`);
    },

    updateProfile(profile: UseCaseProfile): Promise<UseCaseProfile> {
      return request<UseCaseProfile>("PUT", `/v1/profiles/${encodeURIComponent(profile.id)}`, profile);
    },
  };
}
