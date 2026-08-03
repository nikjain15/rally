import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { detectRecognitions } from '@/lib/detect';
import { detectRecognitionsSmart } from '@/lib/detect-model';
import { evaluate, parseLabeledJsonl, caseAgreement, kappaBand, NULL_MODELS } from '@/lib/eval-detect';

it('measure', async () => {
  const cases = parseLabeledJsonl(readFileSync('tests/evals/data/recognition.labeled.jsonl', 'utf8'));
  const m = await evaluate(cases, detectRecognitions);
  const a = await caseAgreement(cases, detectRecognitions);
  console.log('CASES', cases.length);
  console.log('BASELINE', JSON.stringify({p:+m.precision.toFixed(4),r:+m.recall.toFixed(4),f1:+m.f1.toFixed(4),fp:+m.falsePositiveRate.toFixed(4),counts:m.counts}));
  console.log('CASEAGREE', JSON.stringify({...a, agreement:+a.agreement.toFixed(4), baseRate:+a.baseRate.toFixed(4), majorityBaseline:+a.majorityBaseline.toFixed(4), kappa:+a.kappa.toFixed(4), trueFireRate:+a.trueFireRate.toFixed(4), trueSilentRate:+a.trueSilentRate.toFixed(4)}), kappaBand(a.kappa));
  for (const nm of NULL_MODELS) {
    const x = await evaluate(cases, nm.detect);
    const y = await caseAgreement(cases, nm.detect);
    console.log(`NULL ${nm.name}`, JSON.stringify({f1:+x.f1.toFixed(4),p:+x.precision.toFixed(4),r:+x.recall.toFixed(4),fpRate:+x.falsePositiveRate.toFixed(4),caseAgree:+y.agreement.toFixed(4),kappa:+y.kappa.toFixed(4)}));
  }
  const sm = await evaluate(cases, detectRecognitionsSmart);
  console.log('SMART', JSON.stringify({f1:+sm.f1.toFixed(4), fp:+sm.falsePositiveRate.toFixed(4)}));
});
