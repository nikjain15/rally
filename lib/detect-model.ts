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

export async function detectRecognitionsSmart(body: string): Promise<DetectedRecognition[]> {
  if (!hasModel()) return detectRecognitions(body);

  const text = await callClaude({
    feature: 'detect',
    model: MODELS.default,
    // Extraction is a grounded classify. MODELS.default rejects sampling params, so determinism
    // comes from the tightly-scoped system prompt (return-only-JSON, never-infer) rather than temperature.
    system:
      'You extract peer recognition from a chat message written by the HELPED person crediting ' +
      'someone. Return ONLY a JSON array of {"helperHandle": string (the @handle they credit, ' +
      'without the @), "kind": one of "answered"|"unblocked"|"reviewed"|"paired", "confidence": ' +
      'number 0..1 (how sure you are this genuinely credits that person for help RECEIVED — a ' +
      'request, sarcasm, or "thanks in advance" is low confidence)}. Empty array if the message ' +
      'does not credit anyone. Never infer that the AUTHOR helped someone.',
    prompt: body,
    maxTokens: 300,
  });

  const parsed = extractJson(text, isDetections);
  if (!parsed) return detectRecognitions(body); // fall back on absence / invalid output

  return gateDetections(parsed);
}
