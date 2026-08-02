import { beforeEach, describe, expect, it } from 'vitest';
import {
  MODELS,
  getRecentOutcomes,
  recordOutcome,
  recordUsage,
  resetOutcomes,
  resetUsage,
  type OutcomeReason,
  type OutcomeRecord,
  type UsageRecord,
} from '@/lib/agent';
import { SLO, currentSlo, evaluateSlo } from '@/lib/slo';

/**
 * The thresholds are the whole point of SH3, so they are tested at the boundary: just under does
 * not breach, just over does. A threshold nobody has tested on both sides is a number in a comment.
 */

const NOW = Date.parse('2026-08-02T12:00:00Z');
const MIN = 60_000;

function outcomes(spec: Partial<Record<OutcomeReason, number>>, atMs = NOW - MIN): OutcomeRecord[] {
  const out: OutcomeRecord[] = [];
  for (const [reason, n] of Object.entries(spec)) {
    for (let i = 0; i < (n ?? 0); i++) {
      out.push({ feature: 'detect', model: MODELS.brief, reason: reason as OutcomeReason, atMs });
    }
  }
  return out;
}

function usd(costUsd: number, atMs = NOW - MIN): UsageRecord {
  return { feature: 'detect', model: MODELS.brief, inputTokens: 0, outputTokens: 0, costUsd, atMs };
}

function report(o: OutcomeRecord[], u: UsageRecord[] = []) {
  return evaluateSlo({ outcomes: o, usage: u, nowMs: NOW });
}

function indicator(o: OutcomeRecord[], name: string, u: UsageRecord[] = []) {
  return report(o, u).indicators.find((i) => i.name === name)!;
}

describe('degrade rate threshold', () => {
  it('is quiet when every call succeeds', () => {
    const r = report(outcomes({ ok: 100 }));
    expect(r.breaching).toBe(false);
    expect(indicator(outcomes({ ok: 100 }), 'model_degrade_rate').value).toBe(0);
  });

  it('does not breach just under the threshold', () => {
    // 19 of 100 = 0.19 < 0.20.
    expect(indicator(outcomes({ ok: 81, exhausted: 19 }), 'model_degrade_rate').breaching).toBe(false);
  });

  it('breaches just over the threshold', () => {
    // 21 of 100 = 0.21 > 0.20.
    const i = indicator(outcomes({ ok: 79, exhausted: 21 }), 'model_degrade_rate');
    expect(i.breaching).toBe(true);
    expect(i.value).toBeCloseTo(0.21, 6);
  });

  it('counts an invalid-output degrade toward the degrade rate as well as its own', () => {
    const o = outcomes({ ok: 70, invalid_output: 30 });
    expect(indicator(o, 'model_degrade_rate').breaching).toBe(true);
    expect(indicator(o, 'model_invalid_output_rate').breaching).toBe(true);
  });

  it('EXCLUDES no_key entirely: a switched-off model is a configuration, not an outage', () => {
    // The whole local-dev and CI case. Counting it would make every run look broken.
    const r = report(outcomes({ no_key: 500 }));
    expect(r.breaching).toBe(false);
    expect(indicator(outcomes({ no_key: 500 }), 'model_degrade_rate').samples).toBe(0);
  });

  it('will not declare a breach on too few samples', () => {
    // 4 of 4 failed is 100% and means nothing. Firing here trains people to ignore the signal.
    const i = indicator(outcomes({ exhausted: 4 }), 'model_degrade_rate');
    expect(i.value).toBe(1);
    expect(i.breaching).toBe(false);
    expect(i.samples).toBeLessThan(SLO.minSamples);
  });

  it('declares the breach as soon as there are enough samples', () => {
    const i = indicator(outcomes({ exhausted: SLO.minSamples }), 'model_degrade_rate');
    expect(i.breaching).toBe(true);
  });
});

describe('invalid-output rate threshold', () => {
  it('is held tighter than the degrade rate, because a blip cannot cause it', () => {
    expect(SLO.invalidOutputRate).toBeLessThan(SLO.degradeRate);
  });

  it('breaches on type-guard failures while the degrade rate is still fine', () => {
    // 8 of 100 invalid: under the 0.20 degrade bar, over the 0.05 invalid bar. This is the split
    // that tells "the provider is flaky" apart from "the prompt or the input changed".
    const o = outcomes({ ok: 92, invalid_output: 8 });
    expect(indicator(o, 'model_degrade_rate').breaching).toBe(false);
    expect(indicator(o, 'model_invalid_output_rate').breaching).toBe(true);
    expect(report(o).breaching).toBe(true);
  });
});

describe('spend rate threshold', () => {
  it('projects window spend to an hour', () => {
    // $1 over a 15-minute window is $4/hour: under the $5 bar.
    const i = indicator(outcomes({ ok: 30 }), 'model_spend_usd_per_hour', [usd(1)]);
    expect(i.value).toBeCloseTo(4, 6);
    expect(i.breaching).toBe(false);
  });

  it('breaches on a runaway loop', () => {
    const i = indicator(outcomes({ ok: 30 }), 'model_spend_usd_per_hour', [usd(2), usd(2)]);
    expect(i.value).toBeCloseTo(16, 6);
    expect(i.breaching).toBe(true);
  });

  it('needs no minimum sample count: one runaway call is the thing being caught', () => {
    expect(indicator([], 'model_spend_usd_per_hour', [usd(100)]).breaching).toBe(true);
  });
});

describe('the window', () => {
  it('ignores records older than the window', () => {
    const stale = outcomes({ exhausted: 100 }, NOW - SLO.windowMs - MIN);
    const fresh = outcomes({ ok: 50 });
    expect(report([...stale, ...fresh]).breaching).toBe(false);
  });

  it('ignores spend older than the window', () => {
    expect(indicator([], 'model_spend_usd_per_hour', [usd(100, NOW - SLO.windowMs - MIN)]).breaching).toBe(false);
  });
});

describe('honesty of the report', () => {
  it('says out loud that nothing notifies anyone', () => {
    const caveats = report(outcomes({ ok: 30 })).caveats.join(' ');
    expect(caveats).toContain('No notification channel is wired');
    expect(caveats).toContain('alerting is not');
  });

  it('says the numbers are per warm instance, the same limit rate-guard carries', () => {
    expect(report([]).caveats.join(' ')).toContain('ONE warm instance');
  });

  it('gives every indicator a threshold and a plain-language meaning', () => {
    for (const i of report(outcomes({ ok: 30 })).indicators) {
      expect(i.threshold).toBeGreaterThan(0);
      expect(i.meaning.length).toBeGreaterThan(60);
    }
  });
});

describe('wiring to the live meters', () => {
  beforeEach(() => {
    resetOutcomes();
    resetUsage();
  });

  it('reads the real in-process logs', () => {
    for (let i = 0; i < 30; i++) recordOutcome('detect', MODELS.brief, 'exhausted');
    recordUsage('detect', MODELS.brief, { inputTokens: 100, outputTokens: 50 });

    const r = currentSlo();
    expect(r.indicators.find((i) => i.name === 'model_degrade_rate')!.value).toBe(1);
    expect(r.breaching).toBe(true);
  });

  it('records an outcome per call and keeps the reason', () => {
    recordOutcome('ask', MODELS.default, 'ok');
    recordOutcome('detect', MODELS.brief, 'invalid_output');
    expect(getRecentOutcomes().map((o) => o.reason)).toEqual(['ok', 'invalid_output']);
  });

  it('reports clean on a fresh process rather than dividing by zero', () => {
    const r = currentSlo();
    expect(r.breaching).toBe(false);
    for (const i of r.indicators) expect(Number.isFinite(i.value)).toBe(true);
  });
});
