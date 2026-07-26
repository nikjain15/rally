import type { DetectedRecognition } from './detect';

/**
 * Detection-eval scorer — the measurement the "never worse than baseline" contract in
 * `lib/detect-model.ts` was missing. Pure and dependency-free so it runs in the unit lane
 * (no emulator, no network): given a labeled set it turns a detector into precision / recall /
 * F1 / false-positive-rate, the metrics named in `docs/EVALS.md`.
 *
 * A detection is scored as a (helperHandle, kind) pair — crediting the right person AND reading
 * the right verb both matter, since the wrong-person case is the trust-eroding error we most want
 * to catch. Order-independent, multiplicity-aware set matching.
 */

export type LabeledCase = {
  /** The message body fed to the detector. */
  text: string;
  /** The recognitions a correct detector should emit. Empty for true negatives. */
  expected: DetectedRecognition[];
};

export type Counts = { tp: number; fp: number; fn: number };

export type Metrics = {
  precision: number;
  recall: number;
  f1: number;
  /** FP / (all messages). The costly error: a wrong suggestion erodes trust, so it is tracked alone. */
  falsePositiveRate: number;
  counts: Counts;
  /** Number of labeled cases scored — so a metric is never reported over an empty set. */
  cases: number;
};

function key(d: DetectedRecognition): string {
  return `${d.helperHandle.toLowerCase()}::${d.kind}`;
}

/** Multiplicity-aware set overlap: how many predicted pairs match an expected pair, each once. */
export function scoreCase(predicted: DetectedRecognition[], expected: DetectedRecognition[]): Counts {
  const remaining = new Map<string, number>();
  for (const e of expected) remaining.set(key(e), (remaining.get(key(e)) ?? 0) + 1);

  let tp = 0;
  for (const p of predicted) {
    const k = key(p);
    const n = remaining.get(k) ?? 0;
    if (n > 0) {
      tp += 1;
      remaining.set(k, n - 1);
    }
  }
  const fp = predicted.length - tp;
  const fn = expected.length - tp;
  return { tp, fp, fn };
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/**
 * Score a detector over a labeled set. `detect` may be sync (baseline) or async (model layer);
 * both are awaited. Returns aggregate precision/recall/F1/FP-rate.
 */
export async function evaluate(
  cases: LabeledCase[],
  detect: (text: string) => DetectedRecognition[] | Promise<DetectedRecognition[]>,
): Promise<Metrics> {
  const total: Counts = { tp: 0, fp: 0, fn: 0 };
  for (const c of cases) {
    const predicted = await detect(c.text);
    const s = scoreCase(predicted, c.expected);
    total.tp += s.tp;
    total.fp += s.fp;
    total.fn += s.fn;
  }
  const precision = total.tp + total.fp === 0 ? 1 : total.tp / (total.tp + total.fp);
  const recall = total.tp + total.fn === 0 ? 1 : total.tp / (total.tp + total.fn);
  return {
    precision,
    recall,
    f1: f1(precision, recall),
    falsePositiveRate: cases.length === 0 ? 0 : total.fp / cases.length,
    counts: total,
    cases: cases.length,
  };
}

/** Parse the labeled JSONL fixture. One JSON object per non-blank line. */
export function parseLabeledJsonl(raw: string): LabeledCase[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l, i) => {
      let obj: unknown;
      try {
        obj = JSON.parse(l);
      } catch {
        throw new Error(`eval dataset: line ${i + 1} is not valid JSON`);
      }
      const o = obj as { text?: unknown; expected?: unknown };
      if (typeof o.text !== 'string' || !Array.isArray(o.expected)) {
        throw new Error(`eval dataset: line ${i + 1} missing text/expected`);
      }
      return { text: o.text, expected: o.expected as DetectedRecognition[] };
    });
}
