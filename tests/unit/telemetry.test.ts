import { beforeEach, describe, expect, it } from 'vitest';
import {
  MODELS,
  MODEL_PRICING,
  estimateCostUsd,
  getRecentUsage,
  recordUsage,
  resetUsage,
  usageTotals,
} from '@/lib/agent';
import { CONFIDENCE_THRESHOLD, gateDetections } from '@/lib/detect-model';

describe('per-call cost telemetry', () => {
  beforeEach(() => resetUsage());

  it('estimates cost from the model price table', () => {
    // 1M input + 1M output on sonnet = $3 + $15.
    expect(estimateCostUsd('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6);
  });

  it('prices the Brief tier below the escalate tier (the cascade is actually cheaper)', () => {
    const load = { inputTokens: 100_000, outputTokens: 20_000 };
    expect(estimateCostUsd(MODELS.brief, load)).toBeLessThan(estimateCostUsd(MODELS.escalate, load));
  });

  it('falls back to the default tier price for an unknown model rather than zero', () => {
    const unknown = estimateCostUsd('some-future-model', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(unknown).toBeCloseTo(MODEL_PRICING[MODELS.default].inputPerMTok, 6);
  });

  it('records and aggregates usage per feature', () => {
    recordUsage('detect', MODELS.default, { inputTokens: 100, outputTokens: 50 }, 1);
    recordUsage('ask', MODELS.default, { inputTokens: 800, outputTokens: 200 }, 2);
    recordUsage('detect', MODELS.default, { inputTokens: 100, outputTokens: 50 }, 3);

    expect(getRecentUsage()).toHaveLength(3);
    expect(usageTotals().calls).toBe(3);
    expect(usageTotals('detect').calls).toBe(2);
    expect(usageTotals('detect').inputTokens).toBe(200);
    expect(usageTotals('ask').outputTokens).toBe(200);
    expect(usageTotals().costUsd).toBeGreaterThan(0);
  });
});

describe('detection confidence gate', () => {
  it('keeps confident, valid detections', () => {
    expect(gateDetections([{ helperHandle: '@Alice', kind: 'Answered', confidence: 0.9 }])).toEqual([
      { helperHandle: 'alice', kind: 'answered' },
    ]);
  });

  it('drops a detection the model marks below threshold (abstains rather than guessing)', () => {
    expect(gateDetections([{ helperHandle: 'bob', kind: 'answered', confidence: 0.2 }])).toEqual([]);
  });

  it('treats a missing confidence as passing (baseline parity — the regex layer has no score)', () => {
    expect(gateDetections([{ helperHandle: 'carol', kind: 'reviewed' }])).toEqual([
      { helperHandle: 'carol', kind: 'reviewed' },
    ]);
  });

  it('still drops unknown kinds regardless of confidence', () => {
    expect(gateDetections([{ helperHandle: 'dave', kind: 'nonsense', confidence: 1 }])).toEqual([]);
  });

  it('the threshold sits strictly between 0 and 1', () => {
    expect(CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});
