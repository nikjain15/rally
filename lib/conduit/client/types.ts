/**
 * Public wire and method types for @conduit/client.
 *
 * These types are intentionally self-contained. The client does not import the
 * other conduit packages at runtime: the caller injects the core functions
 * (embedded mode) or an HTTP `fetch` (gateway mode). Keeping the shapes local is
 * what lets the SDK ship with zero external dependencies and stay testable.
 */

/* ── Chat primitives ──────────────────────────────────────────────────────── */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ModelRef {
  provider: string;
  model: string;
}

/** An app: the product a use case belongs to. The gateway derives the calling
 *  app from the bearer token and groups usage and suqs by it. `label` is the
 *  human name shown in the console. */
export interface App {
  id: string;
  label: string;
}

/* ── Method params (identical in both modes) ──────────────────────────────── */

export interface InferParams {
  useCase: string;
  messages: ChatMessage[];
  system?: string;
  maxTokens?: number;
  pinModel?: ModelRef;
}

export interface RetrieveParams {
  query: string;
  topK?: number;
}

export interface RunAgentParams {
  goal: string;
  maxSteps?: number;
}

export interface EvaluateParams {
  datasetId: string;
}

export interface UsageParams {
  window?: string;
}

export interface ModelsParams {
  /** When set, the gateway also returns `recommended` refs for this use case. */
  useCase?: string;
}

export interface SuqsParams {
  window?: string;
}

/**
 * One metered decision reported to the gateway (POST /v1/decisions). The gateway
 * stamps the tenant from the API key, so no tenant field is sent here. `at`
 * defaults to the gateway clock when omitted.
 */
export interface ReportDecisionParams {
  useCase: string;
  model: string;
  provider?: string;
  costUsd: number;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  gateStatus?: "pass" | "block";
  at?: number;
}

export interface ReportDecisionResult {
  accepted: boolean;
  tenant: string;
}

/* ── Method results (identical in both modes) ─────────────────────────────── */

export interface InferResult {
  output: string;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  decisionId?: string;
}

export interface RetrievedChunk {
  id: string;
  score: number;
  text: string;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  grounded: boolean;
}

export interface AgentResult {
  answer: string;
  steps: unknown[];
}

export interface EvaluateResult {
  summary: string;
  metrics: Record<string, number>;
}

/** One use case's summed cost inside an app's usage rollup. */
export interface UsageUseCase {
  useCase: string;
  costUsd: number;
}

/** One app's usage rollup: its total spend and per-use-case breakdown. */
export interface UsageApp {
  app: string;
  appLabel: string;
  totalCostUsd: number;
  useCases: UsageUseCase[];
}

/**
 * Usage rollup grouped by app then use case. `totalCostUsd` is the tenant-wide
 * total; `byApp` has one entry per app with metered decisions. Empty when the
 * tenant has no records (`{ totalCostUsd: 0, byApp: [] }`), never fabricated.
 */
export interface UsageResult {
  totalCostUsd: number;
  byApp: UsageApp[];
}

/** A profile SLO target the SUQS view compares a measured value against. */
export interface SloTarget {
  p95LatencyMs?: number;
  costPerAnswerUsd?: number;
  gateBlockRate?: number;
}

/**
 * One computed SUQS row: real p95 latency, cost per answer, and gate block rate
 * for a use case, with the profile target when one is configured (else null).
 */
export interface SuqsRow {
  useCase: string;
  calls: number;
  p95LatencyMs: number;
  costPerAnswerUsd: number;
  gateBlockRate: number;
  target: SloTarget | null;
}

/** One app's SUQS rollup: its use case rows grouped under the app. */
export interface SuqsApp {
  app: string;
  appLabel: string;
  useCases: SuqsRow[];
}

/** GET /v1/suqs result, grouped by app then use case. `byApp` is empty when the
 *  tenant has no records. */
export interface SuqsResult {
  byApp: SuqsApp[];
}

/** One routable model in the gateway's normalized catalog shape. Kept local so
 *  the SDK stays dependency free; structurally matches @conduit/catalog. */
export interface CatalogModel {
  ref: string;
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  promptPerMTok: number;
  completionPerMTok: number;
  inputModalities: string[];
  outputModalities: string[];
  supportsSampling: boolean;
  supportsTools: boolean;
}

export interface ModelsResult {
  models: CatalogModel[];
  /** Present only when the request carried a useCase. */
  recommended?: string[];
}

/**
 * One use case profile in the gateway's config shape. Kept local so the SDK
 * stays dependency free; structurally matches `@conduit/profile` UseCaseProfile.
 * The profile is the single config object that makes routing, retrieval, agent,
 * prompt, guardrails, evals, and SLOs config driven per use case.
 */
export interface ProfileRouting {
  main: string;
  backup?: string;
  capUsd?: number;
  cache?: boolean;
}

export interface ProfileRetrieval {
  source: string;
  chunking?: { size: number; overlap: number };
  embedModel?: string;
  topK?: number;
  groundingThreshold?: number;
}

export interface ProfileAgent {
  mode: "single" | "loop";
  tools: string[];
  skills: string[];
  maxSteps?: number;
}

export interface ProfilePrompt {
  systemRef: string;
  templates?: Record<string, string>;
  variables?: Record<string, string>;
}

export interface ProfileGuardrails {
  pii?: boolean;
  /** On a PII hit: mask the matches ("redact") or refuse ("block"). */
  piiAction?: "redact" | "block";
  injectionGuard?: boolean;
  outputSchema?: unknown;
  hitlThreshold?: number;
  floors?: string[];
}

export interface ProfileEval {
  key: string;
  method: string;
  params?: Record<string, unknown>;
  threshold?: number | string;
  floor?: boolean;
  mandatory?: boolean;
  when: "inline" | "batch";
}

export interface ProfileSlo {
  p95LatencyMs?: number;
  costPerAnswerUsd?: number;
  gateBlockRate?: number;
}

export interface UseCaseProfile {
  id: string;
  name: string;
  tenant: string;
  routing: ProfileRouting;
  retrieval?: ProfileRetrieval | null;
  agent?: ProfileAgent;
  prompt?: ProfilePrompt;
  guardrails?: ProfileGuardrails;
  evals?: ProfileEval[];
  slo?: ProfileSlo;
}

export interface ProfilesParams {
  /** When set, return only the profile for this use case. */
  useCase?: string;
}

export interface ProfilesResult {
  profiles: UseCaseProfile[];
}

/* ── The unified client surface both modes implement ──────────────────────── */

export interface ConduitClient {
  readonly mode: ClientMode;
  infer(params: InferParams): Promise<InferResult>;
  retrieve(params: RetrieveParams): Promise<RetrieveResult>;
  runAgent(params: RunAgentParams): Promise<AgentResult>;
  evaluate(params: EvaluateParams): Promise<EvaluateResult>;
  usage(params?: UsageParams): Promise<UsageResult>;
  /** Report one metered decision. Optional: only gateway mode serves it. */
  reportDecision?(params: ReportDecisionParams): Promise<ReportDecisionResult>;
  /** Read computed SUQS metrics per use case. Optional: only gateway mode serves it. */
  suqs?(params?: SuqsParams): Promise<SuqsResult>;
  /** List the routable model catalog. Optional: only gateway mode serves it. */
  models?(params?: ModelsParams): Promise<ModelsResult>;
  /** List use case profiles. Optional: only gateway mode serves it. */
  profiles?(params?: ProfilesParams): Promise<ProfilesResult>;
  /** Persist an edited use case profile. Optional: only gateway mode serves it. */
  updateProfile?(profile: UseCaseProfile): Promise<UseCaseProfile>;
}

/* ── Injected HTTP transport (gateway mode) ───────────────────────────────── */

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A narrowed `fetch` signature. The global `fetch` (and any spec-compatible
 * mock) is assignable to this, so the caller can pass either.
 */
export type FetchLike = (
  url: string,
  init?: FetchInit,
) => Promise<HttpResponseLike>;

/* ── Injected core functions (embedded mode) ──────────────────────────────── */

/**
 * Result shape the injected `resolve` must return. This is a structural subset
 * of `@conduit/inference` ResolveResult, so a bound `resolve` from that package
 * satisfies it directly.
 */
export interface EmbeddedResolveResult {
  text: string;
  model: ModelRef;
  providerModel?: string;
  costUsd: number;
  latencyMs: number;
  decisionId?: string;
}

export interface EmbeddedResolveTask {
  useCase: string;
  tenantId: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  pinModel?: ModelRef;
}

export type EmbeddedResolve = (
  task: EmbeddedResolveTask,
) => Promise<EmbeddedResolveResult>;

export type EmbeddedRetrieve = (
  params: RetrieveParams,
) => Promise<RetrieveResult>;

export type EmbeddedRunAgent = (
  params: RunAgentParams,
) => Promise<AgentResult>;

export type EmbeddedEvaluate = (
  params: EvaluateParams,
) => Promise<EvaluateResult>;

export type EmbeddedUsage = (params: UsageParams) => Promise<UsageResult>;

/**
 * The core implementations the app injects for in-process execution. Each is a
 * thin async function; the caller is responsible for binding any runtime
 * context (transports, DB handles) before injection, which keeps this SDK
 * dependency-light.
 */
export interface EmbeddedCore {
  resolve: EmbeddedResolve;
  retrieve: EmbeddedRetrieve;
  runAgent: EmbeddedRunAgent;
  evaluate: EmbeddedEvaluate;
  usage: EmbeddedUsage;
}

/* ── Config ───────────────────────────────────────────────────────────────── */

export type ClientMode = "embedded" | "gateway";

export interface EmbeddedConfig {
  mode: "embedded";
  core: EmbeddedCore;
  /** Isolation key sent to resolve(). Defaults to "org:example". */
  tenantId?: string;
  /** maxTokens applied when infer() omits it. Defaults to 1024. */
  defaultMaxTokens?: number;
}

export interface GatewayConfig {
  mode: "gateway";
  apiKey: string;
  baseUrl: string;
  /** Injected HTTP transport. Pass the global `fetch` or a mock. */
  fetch: FetchLike;
}

export type ClientConfig = EmbeddedConfig | GatewayConfig;
