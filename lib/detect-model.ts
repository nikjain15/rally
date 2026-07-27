import { MODELS, callClaude, extractJson, hasModel } from './agent';
import { detectRecognitions, type DetectedRecognition } from './detect';

/**
 * The model layer over recognition detection. When ANTHROPIC_API_KEY is present it asks Claude
 * to read gratitude out of a message; on absence OR any failure/invalid output it falls back to
 * the deterministic `detectRecognitions`. So detection is always at least as good as the
 * baseline, never worse, and the model is invisible — remove it and detection still works.
 *
 * The model output is UNTRUSTED (it read attacker-controllable message text): it's schema-
 * validated here, run through a CONFIDENCE GATE (a low-confidence guess is dropped rather than
 * shown), and still only ever produces a *suggested* recognition that the helped peer must
 * confirm — inference never carries points.
 */

const KINDS = new Set(['answered', 'unblocked', 'reviewed', 'paired']);

/**
 * Below this the model is guessing, so we don't surface the suggestion — the abstention path the
 * quality envelope was missing. A wrong recognition erodes trust, so we bias toward silence.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/**
 * The extraction instruction, shared by both tiers so the cheap Brief pass and the Opus
 * escalation read the message under identical rules; only the model changes.
 */
const DETECT_SYSTEM =
  'You extract peer recognition from a chat message written by the HELPED person crediting ' +
  'someone. Return ONLY a JSON array of {"helperHandle": string (the @handle they credit, ' +
  'without the @), "kind": one of "answered"|"unblocked"|"reviewed"|"paired", "confidence": ' +
  'number 0..1 (how sure you are this genuinely credits that person for help RECEIVED — a ' +
  'request, sarcasm, or "thanks in advance" is low confidence)}. Empty array if the message ' +
  'does not credit anyone. Never infer that the AUTHOR helped someone.';

type RawDetection = { helperHandle: string; kind: string; confidence?: number };

function isDetections(v: unknown): v is RawDetection[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        x && typeof x === 'object' &&
        typeof (x as Record<string, unknown>).helperHandle === 'string' &&
        typeof (x as Record<string, unknown>).kind === 'string',
    )
  );
}

/**
 * Pure: normalise, drop unknown kinds, and apply the confidence gate. A detection with no
 * confidence field is treated as passing (baseline parity — the deterministic layer has no score),
 * but any detection the model explicitly marks below threshold is dropped. Exported for the eval.
 */
export function gateDetections(parsed: RawDetection[], threshold = CONFIDENCE_THRESHOLD): DetectedRecognition[] {
  return parsed
    .map((d) => ({
      helperHandle: d.helperHandle.replace(/^@/, '').toLowerCase(),
      kind: d.kind.toLowerCase(),
      confidence: typeof d.confidence === 'number' ? d.confidence : 1,
    }))
    .filter((d) => d.helperHandle && KINDS.has(d.kind) && d.confidence >= threshold)
    .map(({ helperHandle, kind }) => ({ helperHandle, kind }) as DetectedRecognition);
}

/**
 * Detection is the bulk, low-stakes classify that runs on every posted message, so it carries the
 * cost cascade end to end:
 *
 *  1. The bulk pass runs on the CHEAP tier (`MODELS.brief`, Haiku). Haiku accepts sampling params,
 *     so we pin `temperature: 0` for determinism.
 *  2. If that cheap pass returns any candidate BELOW `CONFIDENCE_THRESHOLD` (the ambiguous case
 *     the gate would otherwise silently drop), we auto-escalate that one message once to the strong
 *     tier (`MODELS.escalate`, Opus) for a better judgment before we decide. This is bounded (a
 *     single extra call) and metered through `callClaude`'s cost meter. Opus rejects sampling, so
 *     no temperature is sent.
 *  3. On absence of a key, or any failure/invalid output at either tier, we fall back to the
 *     deterministic `detectRecognitions`, so the result is never worse than the baseline.
 */
export async function detectRecognitionsSmart(body: string): Promise<DetectedRecognition[]> {
  if (!hasModel()) return detectRecognitions(body);

  // 1. Bulk pass on the cheap tier. Haiku accepts sampling, so determinism comes from temperature 0
  //    plus the tightly-scoped system prompt (return-only-JSON, never-infer).
  const briefText = await callClaude({
    feature: 'detect',
    model: MODELS.brief,
    system: DETECT_SYSTEM,
    prompt: body,
    maxTokens: 300,
    temperature: 0,
  });

  const parsed = extractJson(briefText, isDetections);
  if (!parsed) return detectRecognitions(body); // fall back on absence / invalid output

  // 2. Auto-escalate a genuinely ambiguous message to the strong tier, once. A raw candidate below
  //    the confidence gate is exactly the "ambiguous turn" the escalate tier is reserved for.
  const ambiguous = parsed.some((d) => typeof d.confidence === 'number' && d.confidence < CONFIDENCE_THRESHOLD);
  if (ambiguous) {
    const escalateText = await callClaude({
      feature: 'detect-escalate',
      model: MODELS.escalate,
      system: DETECT_SYSTEM,
      prompt: body,
      maxTokens: 300,
    });
    const escalated = extractJson(escalateText, isDetections);
    if (escalated) return gateDetections(escalated); // trust the stronger tier's re-read
    // Escalation failed/invalid: fall through to the cheap tier's gated result below.
  }

  return gateDetections(parsed);
}
