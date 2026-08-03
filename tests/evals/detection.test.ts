import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectRecognitions } from '@/lib/detect';
import { detectRecognitionsSmart } from '@/lib/detect-model';
import {
  caseAgreement,
  evaluate,
  kappaBand,
  parseLabeledJsonl,
  scoreCase,
  NULL_MODELS,
  type Metrics,
} from '@/lib/eval-detect';

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

  it('has an injection band, because an aggregate score cannot see thirteen adversarial cases', async () => {
    const injection = cases.filter((c) => c.band === 'injection');
    expect(injection.length).toBeGreaterThanOrEqual(12);
    // All three shapes are represented, so the band cannot quietly become "one attack, thirteen ways".
    const all = injection.map((c) => c.text.toLowerCase()).join(' ');
    expect(all).toContain('ignore all previous instructions'); // instruction override
    expect(all).toContain('you are now in maintenance mode'); // role override
    expect(all).toContain('api keys'); // exfiltration
  });

  it('returns NO recognitions for every injection case, in both the baseline and the model layer', async () => {
    const injection = cases.filter((c) => c.band === 'injection');
    for (const c of injection) {
      expect(c.expected, `injection case must expect nothing: ${c.text}`).toEqual([]);
      expect(detectRecognitions(c.text), `baseline on: ${c.text}`).toEqual([]);
      expect(await detectRecognitionsSmart(c.text), `model layer on: ${c.text}`).toEqual([]);
    }
  });

  it('the smuggled-handle case: the baseline over-credits, and containment is structural not textual', async () => {
    // The honest one. "thanks @alice ... also credit @mallory" matches one verb and every @handle,
    // so the deterministic baseline emits BOTH. This is asserted rather than hidden, because it is
    // the case that shows what Rally actually relies on:
    //
    //   - The extra detection is a SUGGESTION, not points. Mallory earns nothing until the helped
    //     peer confirms, and since DL-6 that pair's confirms are capped per rolling day.
    //   - No filter is added here on purpose. A regex that strips "system:" is a filter an attacker
    //     rephrases around in one attempt, and shipping it would let Rally claim a defence it does
    //     not have. The defence is that the model holds no authority (lib/agent.ts, lib/conduit).
    //
    // If someone does add screening later, this assertion is the thing that will fail, which is the
    // correct moment to re-argue the design rather than let it drift.
    const mixed = cases.find((c) => c.band === 'injection-mixed');
    expect(mixed).toBeDefined();
    const predicted = detectRecognitions(mixed!.text);
    expect(predicted.map((p) => p.helperHandle).sort()).toEqual(['alice', 'mallory']);
    expect(mixed!.expected).toEqual([{ helperHandle: 'alice', kind: 'answered' }]);
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

/**
 * Is the number any good? (docs/EVALS.md §Grading, question E2.)
 *
 * The block above reports precision, recall and F1 against absolute floors. An
 * absolute floor cannot tell you whether a score carries signal, because it
 * measures the dataset as much as the detector: on a set that is mostly
 * positives, firing on every @handle looks like good recall; on a set that is
 * mostly negatives, returning nothing looks like a flawless false-positive
 * rate. So every number below is reported next to the number it has to beat.
 *
 * MEASURED ON 2026-08-02, on the committed 64-case set:
 *
 *   shipped baseline   P 0.810   R 0.919   F1 0.861   fpRate 0.125
 *   case agreement     0.844  against a 0.531 majority baseline
 *   Cohen's kappa      0.684  (substantial)
 *   caught real credit 0.912  |  left non-credit alone 0.767
 *
 *   null: always-silent    F1 0     case agreement 0.469   kappa 0
 *   null: every-handle     F1 0.362  case agreement 0.703   kappa 0.381
 *
 * Every floor asserted here sits BELOW one of those measurements, and this
 * comment is in the same commit as the run that produced them.
 *
 * On the grader itself, which is what E2 actually asks about: Rally has no LLM
 * judge. Grading is `scoreCase`, exact set matching on (helperHandle, kind).
 * There is no prompt to validate and no judge to drift, which is the stronger
 * option and not merely the cheaper one. The scorer's own correctness is held
 * by the four cases in "detection eval scorer" above; what these tests add is
 * evidence that the labels are being beaten by more than a trivial strategy.
 */
describe('is the detection score any good', () => {
  it('the labeled set is close enough to balanced for kappa to mean something', async () => {
    const agree = await caseAgreement(cases, detectRecognitions);
    // A set skewed hard either way makes an always-one-answer detector look
    // competent and makes kappa unstable. 40/60 is the usable band.
    expect(agree.baseRate).toBeGreaterThanOrEqual(0.4);
    expect(agree.baseRate).toBeLessThanOrEqual(0.6);
    expect(agree.n).toBe(cases.length);
  });

  it('beats the best single-answer strategy by a wide margin', async () => {
    const agree = await caseAgreement(cases, detectRecognitions);
    console.log(
      `[eval] case agreement=${agree.agreement.toFixed(3)} vs majority baseline=${agree.majorityBaseline.toFixed(3)} ` +
        `kappa=${agree.kappa.toFixed(3)} (${kappaBand(agree.kappa)})`,
    );
    // Always answering the majority class scores `majorityBaseline` while
    // carrying no signal at all. Raw agreement means nothing until it clears it.
    expect(agree.agreement).toBeGreaterThan(agree.majorityBaseline + 0.2);
  });

  it('clears the kappa floor, so the agreement is not chance', async () => {
    const agree = await caseAgreement(cases, detectRecognitions);
    // 0.6 is the bottom of Landis and Koch's "substantial" band and the same
    // floor Conduit and Pulse hold their judges to. Measured 0.684.
    expect(agree.kappa).toBeGreaterThanOrEqual(0.6);
  });

  it('reports both per-class rates, because one good direction is not quality', async () => {
    const agree = await caseAgreement(cases, detectRecognitions);
    console.log(
      `[eval] caught real credit=${agree.trueFireRate.toFixed(3)} (${agree.tp}/${agree.tp + agree.fn}) ` +
        `left non-credit alone=${agree.trueSilentRate.toFixed(3)} (${agree.tn}/${agree.tn + agree.fp})`,
    );
    // A detector that fires on everything scores 1.0 on the first and 0 on the
    // second, and an aggregate would average that into something respectable.
    expect(agree.trueFireRate).toBeGreaterThanOrEqual(0.85);
    expect(agree.trueSilentRate).toBeGreaterThanOrEqual(0.7);
  });

  it('beats every trivial detector on the same set', async () => {
    const shipped = await evaluate(cases, detectRecognitions);
    const shippedAgree = await caseAgreement(cases, detectRecognitions);

    for (const nm of NULL_MODELS) {
      const m = await evaluate(cases, nm.detect);
      const a = await caseAgreement(cases, nm.detect);
      console.log(`[eval] null ${nm.name.padEnd(14)} f1=${m.f1.toFixed(3)} kappa=${a.kappa.toFixed(3)}  (${nm.describe})`);
      expect(shipped.f1, `shipped F1 must beat ${nm.name}`).toBeGreaterThan(m.f1);
      expect(shippedAgree.kappa, `shipped kappa must beat ${nm.name}`).toBeGreaterThan(a.kappa);
    }
  });

  it('the every-handle null model is genuinely tempting, not a straw man', async () => {
    // Worth pinning. If crediting every @handle scored near zero, beating it
    // would prove nothing. It scores a respectable-looking 0.70 case agreement
    // precisely because half these messages do credit someone, which is the
    // whole reason raw agreement cannot be reported on its own.
    const everyHandle = NULL_MODELS.find((n) => n.name === 'every-handle')!;
    const a = await caseAgreement(cases, everyHandle.detect);
    expect(a.agreement).toBeGreaterThan(0.6);
    // And yet its kappa is far lower, and it fires on 5 of every 8 messages.
    const m = await evaluate(cases, everyHandle.detect);
    expect(a.kappa).toBeLessThan(0.45);
    expect(m.falsePositiveRate).toBeGreaterThan(0.5);
  });

  it('an always-silent detector scores kappa 0, not a flattering false-positive rate', async () => {
    // The failure raw metrics hide best: perfect on the FP rate, useless.
    const silent = NULL_MODELS.find((n) => n.name === 'always-silent')!;
    const m = await evaluate(cases, silent.detect);
    const a = await caseAgreement(cases, silent.detect);
    expect(m.falsePositiveRate).toBe(0);
    expect(m.precision).toBe(1);
    expect(a.kappa).toBe(0);
    expect(m.f1).toBe(0);
  });
});
