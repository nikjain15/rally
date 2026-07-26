import Anthropic from '@anthropic-ai/sdk';

/**
 * Rally's server-side model access — one thin, degradable wrapper for all three intelligences.
 *
 * The invariant every intelligence rests on (tech-spec §1, §7): the model NEVER has authority.
 * It classifies, summarises, and drafts; it never writes a points-bearing row, and every call
 * degrades to a no-op (null) when ANTHROPIC_API_KEY is absent or the call fails. The callers
 * always have a deterministic fallback, so Rally works fully with the model switched off — that
 * is what makes the AI "invisible": remove it and nothing breaks, it just gets less clever.
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

export function hasModel(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Call Claude for a single-turn completion. Returns the text, or null on absence/any failure. */
export async function callClaude(opts: {
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
}): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      // Only pass a sampling param to models that accept one. The reasoning tiers (Sonnet 5, Opus
      // 4.8, ...) reject `temperature` with a 400; for those we omit it and lean on the grounded,
      // constraining system prompts for determinism instead.
      ...(supportsSampling(opts.model) ? { temperature: opts.temperature ?? 0 } : {}),
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });
    if (res.usage) {
      recordUsage(opts.feature ?? opts.model, opts.model, {
        inputTokens: res.usage.input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
      });
    }
    const block = res.content.find((b) => b.type === 'text');
    return block && block.type === 'text' ? block.text : null;
  } catch {
    // Rate limit, timeout, bad key, malformed response — all the same to the caller: degrade.
    return null;
  }
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
