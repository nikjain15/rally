import { describe, expect, it } from 'vitest';
import { MODELS, supportsSampling } from '@/lib/agent';

/**
 * Contract guard. The current reasoning tiers reject `temperature`/`top_p`/`top_k` with an HTTP 400,
 * so any code path that targets them must NOT send a sampling param. These tests pin that contract
 * so a future edit can't silently reintroduce a 400 on every live model call.
 */
describe('sampling-param safety', () => {
  it('treats the reasoning tiers Rally routes to as no-sampling', () => {
    // The three configured tiers: brief (Haiku 4.5) samples; default/escalate (Sonnet 5 / Opus 4.8) do not.
    expect(supportsSampling(MODELS.default)).toBe(false);
    expect(supportsSampling(MODELS.escalate)).toBe(false);
    expect(supportsSampling(MODELS.brief)).toBe(true);
  });

  it('rejects the specific reasoning models that 400 on sampling params', () => {
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5']) {
      expect(supportsSampling(m), `${m} must be treated as no-sampling`).toBe(false);
    }
  });

  it('allows sampling on tiers that accept it', () => {
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']) {
      expect(supportsSampling(m), `${m} should accept sampling`).toBe(true);
    }
  });

  it('uses only valid, dated-suffix-free model ids (no invalid "claude-haiku-5")', () => {
    const configured = [MODELS.brief, MODELS.default, MODELS.escalate];
    expect(configured).not.toContain('claude-haiku-5');
    // Every configured id is one we know the API accepts.
    const KNOWN = new Set(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8']);
    for (const m of configured) expect(KNOWN.has(m), `${m} is not a known valid model id`).toBe(true);
  });
});
