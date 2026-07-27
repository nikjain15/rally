/**
 * @conduit/client public surface.
 *
 * One thin SDK an app imports. The same method surface runs the core
 * in-process (`mode: "embedded"`) or calls the conduit-gateway over HTTP
 * (`mode: "gateway"`). Switching modes changes the transport, never the
 * methods. The SDK has no external dependencies: the caller injects `fetch`
 * (gateway) or the core functions (embedded).
 */
import { createEmbeddedClient } from "./embedded.ts";
import { createGatewayClient } from "./gateway.ts";
import type { ClientConfig, ConduitClient } from "./types.ts";

export function createClient(config: ClientConfig): ConduitClient {
  switch (config.mode) {
    case "embedded":
      return createEmbeddedClient(config);
    case "gateway":
      return createGatewayClient(config);
    default: {
      // Exhaustiveness guard: a config with an unknown mode is a hard error.
      const unknown = config as { mode?: string };
      throw new Error(`unknown client mode: ${String(unknown.mode)}`);
    }
  }
}

export { ConduitError } from "./error.ts";
export { APP_LABELS, appLabel } from "./apps.ts";
export type {
  App,
  AgentResult,
  CatalogModel,
  ChatMessage,
  ChatRole,
  ClientConfig,
  ClientMode,
  ConduitClient,
  EmbeddedConfig,
  EmbeddedCore,
  EmbeddedResolve,
  EmbeddedResolveResult,
  EmbeddedResolveTask,
  EmbeddedRetrieve,
  EmbeddedRunAgent,
  EmbeddedEvaluate,
  EmbeddedUsage,
  EvaluateParams,
  EvaluateResult,
  FetchInit,
  FetchLike,
  GatewayConfig,
  HttpResponseLike,
  InferParams,
  InferResult,
  ModelRef,
  ModelsParams,
  ModelsResult,
  ProfileAgent,
  ProfileEval,
  ProfileGuardrails,
  ProfilePrompt,
  ProfileRetrieval,
  ProfileRouting,
  ProfileSlo,
  ProfilesParams,
  ProfilesResult,
  ReportDecisionParams,
  ReportDecisionResult,
  RetrievedChunk,
  RetrieveParams,
  RetrieveResult,
  RunAgentParams,
  SloTarget,
  SuqsApp,
  SuqsParams,
  SuqsResult,
  SuqsRow,
  UsageApp,
  UsageParams,
  UsageResult,
  UsageUseCase,
  UseCaseProfile,
} from "./types.ts";
