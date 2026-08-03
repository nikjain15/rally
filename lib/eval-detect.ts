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
  /**
   * Optional group label, so a slice of the set can be asserted on its own terms rather than only
   * through an aggregate score. `injection` is the one that exists today: a handful of adversarial
   * cases whose whole point is that the aggregate F1 would hide them, because twelve messages out
   * of seventy-odd cannot move a precision figure enough to notice.
   */
  band?: string;
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

/* -------------------------------------------------------------------------- *
 * Is the number any good? Base rates, null models, and chance correction.
 *
 * WHY THIS SECTION EXISTS. Everything above reports precision, recall and F1
 * against absolute floors (`precision >= 0.7`), and an absolute floor cannot
 * say whether a score carries any signal. On a set where most messages credit
 * somebody, a detector that fires on every @handle scores well on recall and
 * looks competent; on a set that is mostly negatives, a detector that returns
 * nothing scores a perfect false-positive rate. Both are useless, and neither
 * is visible in a number reported on its own.
 *
 * So every score here is reported next to the number it has to beat: what a
 * trivial detector gets on the same set, and what agreement is left once
 * chance is taken out.
 *
 * Note what Rally is NOT doing, because docs/EVALS.md lists an LLM judge as a
 * roadmap item and it would be easy to read this as one. There is no judge.
 * The grader is `scoreCase`, exact set matching on (helperHandle, kind), which
 * is a code check with no model in it and no prompt to validate. That is the
 * stronger option rather than the cheaper one: an exact check cannot drift,
 * cannot be talked out of a verdict, and costs nothing to run on every commit.
 * What still has to be shown is that the LABELS are being beaten by more than
 * a trivial strategy would beat them, which is what follows.
 * -------------------------------------------------------------------------- */

/**
 * Case-level agreement: "does this message credit anyone at all?", yes or no,
 * per message.
 *
 * Deliberately coarser than the pair-level precision/recall above. The pair
 * scorer answers "did it credit the right person for the right thing", which
 * is the quality question. This answers "did it fire when it should have",
 * which is the question a base rate and a kappa can be computed against,
 * because it is a single binary decision per case.
 */
export type CaseAgreement = {
  n: number;
  /** Gold says a recognition is present, detector fired. */
  tp: number;
  /** Gold says present, detector stayed silent: a missed thank-you. */
  fn: number;
  /** Gold says absent, detector fired: the trust-eroding direction. */
  fp: number;
  /** Gold says absent, detector stayed silent. */
  tn: number;
  /** Share of cases the detector called correctly. Never read this alone. */
  agreement: number;
  /** Share of cases that genuinely contain a recognition. */
  baseRate: number;
  /**
   * What the best single-answer strategy scores: always-fire or always-silent,
   * whichever the set favours. This is the number `agreement` has to beat
   * before it means anything at all.
   */
  majorityBaseline: number;
  /**
   * Cohen's kappa against chance. 1 perfect, 0 chance level, negative worse
   * than chance. Returns 0 for a set with no class variation, which is a set
   * that cannot be measured rather than a perfect detector.
   */
  kappa: number;
  /** Of messages that DO credit someone, the share the detector caught. */
  trueFireRate: number;
  /** Of messages that credit nobody, the share it correctly left alone. */
  trueSilentRate: number;
};

const div = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** Score a detector's fire/stay-silent decision per case, with chance taken out. */
export async function caseAgreement(
  cases: LabeledCase[],
  detect: (text: string) => DetectedRecognition[] | Promise<DetectedRecognition[]>,
): Promise<CaseAgreement> {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;

  for (const c of cases) {
    const goldFires = c.expected.length > 0;
    const predFires = (await detect(c.text)).length > 0;
    if (goldFires && predFires) tp += 1;
    else if (goldFires && !predFires) fn += 1;
    else if (!goldFires && predFires) fp += 1;
    else tn += 1;
  }

  const n = cases.length;
  const po = div(tp + tn, n);
  const goldTrue = tp + fn;
  const goldFalse = fp + tn;
  const predTrue = tp + fp;
  const predFalse = fn + tn;
  const pe = n === 0 ? 0 : (goldTrue * predTrue + goldFalse * predFalse) / (n * n);
  const base = div(goldTrue, n);

  return {
    n,
    tp,
    fn,
    fp,
    tn,
    agreement: po,
    baseRate: base,
    majorityBaseline: Math.max(base, 1 - base),
    kappa: pe >= 1 ? 0 : div(po - pe, 1 - pe),
    trueFireRate: div(tp, goldTrue),
    trueSilentRate: div(tn, goldFalse),
  };
}

/** Landis and Koch bands, the convention kappa is normally read against. */
export function kappaBand(kappa: number): string {
  if (kappa < 0) return 'worse than chance';
  if (kappa < 0.21) return 'slight';
  if (kappa < 0.41) return 'fair';
  if (kappa < 0.61) return 'moderate';
  if (kappa < 0.81) return 'substantial';
  return 'almost perfect';
}

/**
 * The trivial strategies the shipped detector has to beat.
 *
 * These are not tests of the null models; they are the y-intercept. Reporting
 * `f1 = 0.86` means nothing until you know that crediting every @handle on the
 * same set scores, say, 0.61 and returning nothing scores 0. Committing them
 * as real functions rather than remembered figures means they are recomputed on
 * every run, so they cannot go stale when the labeled set grows.
 */
export const NULL_MODELS: { name: string; describe: string; detect: (text: string) => DetectedRecognition[] }[] = [
  {
    name: 'always-silent',
    describe: 'never proposes anything',
    detect: () => [],
  },
  {
    name: 'every-handle',
    describe: 'credits every @handle in the message as "answered", ignoring what the message says',
    detect: (text: string) => {
      const seen = new Set<string>();
      for (const m of text.matchAll(/@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})/gi)) {
        seen.add(m[1].toLowerCase());
      }
      return [...seen].map((h) => ({ helperHandle: h, kind: 'answered' as const }));
    },
  },
];

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
      const o = obj as { text?: unknown; expected?: unknown; band?: unknown };
      if (typeof o.text !== 'string' || !Array.isArray(o.expected)) {
        throw new Error(`eval dataset: line ${i + 1} missing text/expected`);
      }
      return {
        text: o.text,
        expected: o.expected as DetectedRecognition[],
        ...(typeof o.band === 'string' ? { band: o.band } : {}),
      };
    });
}
