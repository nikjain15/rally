import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectRecognitions } from '@/lib/detect';
import { detectRecognitionsSmart } from '@/lib/detect-model';
import { evaluate, parseLabeledJsonl, scoreCase, type Metrics } from '@/lib/eval-detect';

/**
 * The detection eval — the number the "never worse than baseline" contract in
 * `lib/detect-model.ts:8` was asserting without proof. Scores both the deterministic baseline
 * (`detectRecognitions`) and the model layer (`detectRecognitionsSmart`) against a committed
 * labeled set, reporting precision/recall/F1 and the false-positive rate named in docs/EVALS.md.
 *
 * Runs in the unit lane (no emulator, no network). When ANTHROPIC_API_KEY is absent — as in CI —
 * the model layer falls back to the baseline, so it is BY CONSTRUCTION never worse; when a key is
 * present this test genuinely measures whether the model beats regex, and the same assertion holds.
 */

const dataPath = fileURLToPath(new URL('./data/recognition.labeled.jsonl', import.meta.url));
const cases = parseLabeledJsonl(readFileSync(dataPath, 'utf8'));

function fmt(m: Metrics): string {
  return [
    `precision=${m.precision.toFixed(3)}`,
    `recall=${m.recall.toFixed(3)}`,
    `f1=${m.f1.toFixed(3)}`,
    `fpRate=${m.falsePositiveRate.toFixed(3)}`,
    `(tp=${m.counts.tp} fp=${m.counts.fp} fn=${m.counts.fn}, n=${m.cases})`,
  ].join(' ');
}

describe('detection eval scorer', () => {
  it('scores a perfect prediction as all true positives', () => {
    expect(scoreCase([{ helperHandle: 'a', kind: 'answered' }], [{ helperHandle: 'a', kind: 'answered' }])).toEqual({
      tp: 1,
      fp: 0,
      fn: 0,
    });
  });

  it('counts a wrong helper as both a false positive and a false negative', () => {
    expect(scoreCase([{ helperHandle: 'b', kind: 'answered' }], [{ helperHandle: 'a', kind: 'answered' }])).toEqual({
      tp: 0,
      fp: 1,
      fn: 1,
    });
  });

  it('counts a missed detection as a false negative', () => {
    expect(scoreCase([], [{ helperHandle: 'a', kind: 'answered' }])).toEqual({ tp: 0, fp: 0, fn: 1 });
  });

  it('counts a spurious detection as a false positive', () => {
    expect(scoreCase([{ helperHandle: 'a', kind: 'answered' }], [])).toEqual({ tp: 0, fp: 1, fn: 0 });
  });
});

describe('recognition detection quality', () => {
  it('loaded a non-trivial labeled set', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    // Must contain both positives and negatives, or precision/recall would be degenerate.
    expect(cases.some((c) => c.expected.length > 0)).toBe(true);
    expect(cases.some((c) => c.expected.length === 0)).toBe(true);
  });

  it('the deterministic baseline clears its quality floor', async () => {
    const m = await evaluate(cases, detectRecognitions);
    console.log(`[eval] baseline  ${fmt(m)}`);
    expect(m.precision).toBeGreaterThanOrEqual(0.7);
    expect(m.recall).toBeGreaterThanOrEqual(0.8);
    expect(m.f1).toBeGreaterThanOrEqual(0.75);
  });

  it('the model layer is never worse than the baseline (the contract in detect-model.ts)', async () => {
    const baseline = await evaluate(cases, detectRecognitions);
    const smart = await evaluate(cases, detectRecognitionsSmart);
    console.log(`[eval] smart     ${fmt(smart)}`);
    const eps = 1e-9;
    expect(smart.f1).toBeGreaterThanOrEqual(baseline.f1 - eps);
    // A false positive is the trust-eroding error: the model must not add any.
    expect(smart.falsePositiveRate).toBeLessThanOrEqual(baseline.falsePositiveRate + eps);
  });
});
