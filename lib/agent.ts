import Anthropic from '@anthropic-ai/sdk';
import {
  resolveRetryPolicy,
  withRetry,
  type RetryDeps,
  type RetryPolicy,
  type RetryProfileName,
} from './retry';

/**
 * Rally's server-side model access — one thin, degradable wrapper for all three intelligences.
 *
 * The invariant every intelligence rests on (tech-spec §1, §7): the model NEVER has authority.
 * It classifies, summarises, and drafts; it never writes a points-bearing row, and every call
 * degrades to a no-op (null) when ANTHROPIC_API_KEY is absent or the call fails. The callers
 * always have a deterministic fallback, so Rally works fully with the model switched off — that
 * is what makes the AI "invisible": remove it and nothing breaks, it just gets less clever.
 *
 * Degrading is the LAST rung, not the first. A transient 429 or a dropped socket is not the same
 * event as "the model is off", and treating them alike silently downgraded a user's answer for a
 * blip that a second call would have survived. `lib/retry.ts` sits in front of the degrade: bounded
 * retry with jittered backoff and a hard per-attempt timeout, on transient conditions only. When
 * that ladder is exhausted the behaviour below is exactly what it always was: return null and let
 * the caller's deterministic baseline answer.
 *
 * Model tiers form a cost-aware cascade: bulk, low-stakes classify (Brief) runs on the CHEAPEST
 * tier; the interactive default is a mid tier; `escalate` is reserved for the ambiguous, high-
 * stakes turn. Every call is metered (tokens + estimated USD) so "cost becomes real money" is a
 * number we can see, not a hope.
 */
export const MODELS = {
  // Brief is a bulk, low-stakes classify over many members — route it to the cheap tier, not the
  // priciest model. Escalation to a stronger tier is reserved for genuinely ambiguous input.
  brief: 'claude-haiku-4-5',
  default: 'claude-sonnet-5',
  escalate: 'claude-opus-4-8',
} as const;

/**
 * Whether a model accepts sampling params (`temperature`/`top_p`/`top_k`). The current-generation
 * reasoning models — Opus 5 / Opus 4.8 / Opus 4.7, Sonnet 5, Fable 5 — REJECT them with an HTTP 400,
 * so we must omit the param entirely for those and rely on prompt design for determinism. Haiku 4.5
 * (and older tiers) still accept it. Keep this a denylist of no-sampling prefixes so a new tier is
 * treated as sampling-capable only when we've confirmed it, but our known reasoning models are safe.
 */
export function supportsSampling(model: string): boolean {
  const NO_SAMPLING = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5'];
  return !NO_SAMPLING.some((m) => model.startsWith(m));
}

/**
 * Approximate list price per 1M tokens (USD), used only to ESTIMATE spend for telemetry — the
 * meter is for visibility and regression alarms, not billing. Unknown models fall back to the
 * default tier's price so an estimate is never silently zero.
 */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 75 },
};

export type Usage = { inputTokens: number; outputTokens: number };

export type UsageRecord = {
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  atMs: number;
};

/** Pure cost estimate for a call. Falls back to the default tier's price for unknown models. */
export function estimateCostUsd(model: string, usage: Usage): number {
  const price = MODEL_PRICING[model] ?? MODEL_PRICING[MODELS.default];
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

// In-process meter. Small ring buffer so a long-lived server never grows unbounded; enough to
// answer "what did the last N model calls cost, and by which feature". Reset in tests.
const USAGE_LOG: UsageRecord[] = [];
const USAGE_LOG_MAX = 500;

/** Record + log one model call's usage. Keyed by feature so per-feature spend is attributable. */
export function recordUsage(feature: string, model: string, usage: Usage, atMs = Date.now()): UsageRecord {
  const rec: UsageRecord = {
    feature,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: estimateCostUsd(model, usage),
    atMs,
  };
  USAGE_LOG.push(rec);
  if (USAGE_LOG.length > USAGE_LOG_MAX) USAGE_LOG.shift();
  // Structured, greppable telemetry line — the missing "cost meter" the routing story needed.
  console.info(
    `[usage] feature=${feature} model=${model} in=${usage.inputTokens} out=${usage.outputTokens} cost=$${rec.costUsd.toFixed(6)}`,
  );
  return rec;
}

/** The most recent usage records (oldest first), for a metering endpoint or a test assertion. */
export function getRecentUsage(): readonly UsageRecord[] {
  return USAGE_LOG;
}

/** Aggregate totals, optionally filtered to one feature. */
export function usageTotals(feature?: string): { calls: number; inputTokens: number; outputTokens: number; costUsd: number } {
  const rows = feature ? USAGE_LOG.filter((r) => r.feature === feature) : USAGE_LOG;
  return rows.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

/** Clear the meter — test hook only. */
export function resetUsage(): void {
  USAGE_LOG.length = 0;
}

/**
 * Why a logical model call ended the way it did (finding SH3).
 *
 * The cost meter above answers "what did we spend". It cannot answer "is it broken", because a
 * degrade is invisible to it: when the ladder is exhausted the call returns null, the caller's
 * deterministic baseline answers, the user sees something reasonable, and NO usage row is written.
 * A silent, successful-looking degrade is exactly the failure Rally is most likely to ship, so it
 * gets its own record.
 *
 *  - `ok`            the model answered.
 *  - `no_key`        ANTHROPIC_API_KEY is absent. The model is switched OFF, which is a
 *                    configuration state and deliberately NOT counted as a failure.
 *  - `exhausted`     retries, backoff and timeouts all ran out, or the error was permanent.
 *  - `invalid_output` the model answered with something that failed the type guard.
 */
export type OutcomeReason = 'ok' | 'no_key' | 'exhausted' | 'invalid_output';

export type OutcomeRecord = { feature: string; model: string; reason: OutcomeReason; atMs: number };

const OUTCOME_LOG: OutcomeRecord[] = [];
const OUTCOME_LOG_MAX = 500;

/** Record how one logical model call ended. Cheap enough to sit on every call path. */
export function recordOutcome(feature: string, model: string, reason: OutcomeReason, atMs = Date.now()): OutcomeRecord {
  const rec: OutcomeRecord = { feature, model, reason, atMs };
  OUTCOME_LOG.push(rec);
  if (OUTCOME_LOG.length > OUTCOME_LOG_MAX) OUTCOME_LOG.shift();
  // Only the interesting ones are logged: an `ok` line per call would drown the signal, and
  // `no_key` in local dev would print on every request for a state that is not a problem.
  if (reason === 'exhausted' || reason === 'invalid_output') {
    console.warn(`[degrade] feature=${feature} model=${model} reason=${reason}`);
  }
  return rec;
}

/** The most recent call outcomes (oldest first). Read by lib/slo.ts. */
export function getRecentOutcomes(): readonly OutcomeRecord[] {
  return OUTCOME_LOG;
}

/** Clear the outcome log. Test hook only. */
export function resetOutcomes(): void {
  OUTCOME_LOG.length = 0;
}

export function hasModel(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Options for a single-turn Claude completion, shared by the text and detailed entry points. */
export type CallClaudeOpts = {
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  /**
   * Explicit risk dial. Default 0: classify/extract/ground tasks want the most deterministic,
   * least-inventive output. Callers that want a touch of natural phrasing raise it deliberately.
   */
  temperature?: number;
  /** Label for cost attribution in the meter. Defaults to the model id. */
  feature?: string;
  /**
   * Which resilience budget this call site gets (`lib/retry.ts` RETRY_PROFILES). `interactive` is
   * the default because it assumes a human is waiting, so an unlabelled call site errs toward
   * answering sooner rather than hanging longer. Bulk/background work asks for `background`.
   */
  retryProfile?: RetryProfileName;
  /** Narrow overrides on the chosen profile, for a call site with a genuinely unusual budget. */
  retryOverrides?: Partial<RetryPolicy>;
  /** Injected clock/sleep/timer. Test hook only, so the retry ladder is asserted without real timers. */
  retryDeps?: RetryDeps;
};

/**
 * Some providers report usage on the ERROR of a call that still burned tokens (a response that
 * failed after generation, a mid-stream overload). The meter must see those: a retried call that
 * consumed tokens twice cost twice, and a cost meter that only counts successes quietly understates
 * spend exactly when spend is spiking. Returns null when the error carries no usage, which is the
 * common case.
 */
export function usageFromError(err: unknown): Usage | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): Usage | null => {
    if (!node || typeof node !== 'object' || depth > 3 || seen.has(node)) return null;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    const usage = rec.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === 'object') {
      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
      if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };
    }
    return visit(rec.error, depth + 1) ?? visit(rec.response, depth + 1) ?? visit(rec.body, depth + 1);
  };
  return visit(err, 0);
}

/**
 * The metered result of one call: the text (null when the model returned no text block) plus the
 * usage/cost/latency the Conduit seam surfaces as a metered decision. Cost reuses `estimateCostUsd`,
 * the exact same math the in-process meter uses, so the seam adds no second source of truth.
 */
export type CallClaudeResult = {
  text: string | null;
  model: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
};

/**
 * Call Claude and return the full metered record, or null on absence/any failure. This is the
 * single Anthropic entry point; `callClaude` is the thin text-only wrapper over it, so the meter
 * line, the sampling-contract gate, and the degrade-to-null behaviour are defined here once and
 * shared. The Conduit embedded core (lib/conduit/rally-client.ts) calls this so the answer flows
 * through Conduit's unified interface while cost accounting stays unchanged.
 */
export async function callClaudeDetailed(opts: CallClaudeOpts): Promise<CallClaudeResult | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  // No key: this is not a failure to retry, it is the model being switched off. Return before any
  // client is constructed, so with no key the provider is never contacted at all.
  if (!key) {
    recordOutcome(opts.feature ?? opts.model, opts.model, 'no_key');
    return null;
  }

  const policy = resolveRetryPolicy(opts.retryProfile, opts.retryOverrides);
  const feature = opts.feature ?? opts.model;
  const startedAt = Date.now();

  try {
    return await withRetry(
      async ({ signal }) => {
        // maxRetries: 0 is deliberate and load-bearing. The SDK retries twice by default; with our
        // own ladder in front that would be up to 9 provider calls for one logical request, on a
        // latency budget nobody chose. lib/retry.ts is the single retry authority; the SDK just
        // makes the call. The per-request `timeout` mirrors our attempt deadline so the socket is
        // released at the same moment we stop waiting on it.
        const client = new Anthropic({ apiKey: key, maxRetries: 0 });
        try {
          const res = await client.messages.create(
            {
              model: opts.model,
              max_tokens: opts.maxTokens ?? 1024,
              // Only pass a sampling param to models that accept one. The reasoning tiers (Sonnet 5,
              // Opus 4.8, ...) reject `temperature` with a 400; for those we omit it and lean on the
              // grounded, constraining system prompts for determinism instead. A 400 is also exactly
              // the class of error the retry layer refuses to repeat.
              ...(supportsSampling(opts.model) ? { temperature: opts.temperature ?? 0 } : {}),
              system: opts.system,
              messages: [{ role: 'user', content: opts.prompt }],
            },
            { signal, timeout: policy.attemptTimeoutMs },
          );
          const usage: Usage = {
            inputTokens: res.usage?.input_tokens ?? 0,
            outputTokens: res.usage?.output_tokens ?? 0,
          };
          if (res.usage) recordUsage(feature, opts.model, usage);
          const block = res.content.find((b) => b.type === 'text');
          const text = block && block.type === 'text' ? block.text : null;
          recordOutcome(feature, opts.model, 'ok');
          return {
            text,
            model: opts.model,
            usage,
            costUsd: estimateCostUsd(opts.model, usage),
            latencyMs: Date.now() - startedAt,
          };
        } catch (err) {
          // A failed attempt that still burned tokens is still spend. Meter it before the retry
          // layer decides what to do with the error, so the cost of resilience is visible.
          const spent = usageFromError(err);
          if (spent) recordUsage(feature, opts.model, spent);
          throw err;
        }
      },
      policy,
      opts.retryDeps,
    );
  } catch {
    // The ladder is exhausted (or the failure was permanent, e.g. a bad key or a bad request).
    // Same contract as always: degrade to null and let the caller's deterministic baseline answer.
    // Recorded, because this is the degrade that no other signal in Rally makes visible: the
    // caller's fallback answers, the request returns 200, and nothing else would ever say so.
    recordOutcome(feature, opts.model, 'exhausted');
    return null;
  }
}

/** Call Claude for a single-turn completion. Returns the text, or null on absence/any failure. */
export async function callClaude(opts: CallClaudeOpts): Promise<string | null> {
  const res = await callClaudeDetailed(opts);
  return res ? res.text : null;
}

/**
 * Parse a JSON object out of a model response, tolerating prose and ```json fences, and
 * validate it before trusting it. Pure — the untrusted-output backstop the routes rely on,
 * testable without a live model. Returns null on anything unparseable or invalid.
 */
export function extractJson<T>(text: string | null, validate: (v: unknown) => v is T): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const startArr = candidate.indexOf('[');
  const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (from === -1) return null;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (end === -1 || end < from) return null;
  try {
    const parsed = JSON.parse(candidate.slice(from, end + 1));
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
