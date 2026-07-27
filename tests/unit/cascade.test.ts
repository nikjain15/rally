import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cost cascade, exercised end to end with a mocked Anthropic SDK so we can assert WHICH model
 * id each tier is actually called with. The contract:
 *   1. the bulk detection extract runs on the cheap Brief tier (Haiku);
 *   2. a below-CONFIDENCE_THRESHOLD candidate auto-escalates that one message to the Opus tier;
 *   3. the sampling contract holds on the live path (temperature to Haiku, none to Opus);
 *   4. with no key, detection degrades to the deterministic baseline and calls no model.
 */

const { createCalls, responses } = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  responses: [] as Array<{ text: string }>,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (args: Record<string, unknown>) => {
        createCalls.push(args);
        const next = responses.shift() ?? { text: '[]' };
        return {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: next.text }],
        };
      },
    };
  },
}));

import { MODELS, resetUsage, usageTotals } from '@/lib/agent';
import { detectRecognitionsSmart } from '@/lib/detect-model';

const OLD_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  createCalls.length = 0;
  responses.length = 0;
  resetUsage();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = OLD_KEY;
});

describe('model cost cascade', () => {
  it('routes the bulk detection extract to the cheap Haiku tier', async () => {
    responses.push({ text: '[{"helperHandle":"alice","kind":"answered","confidence":0.9}]' });

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(createCalls).toHaveLength(1); // confident result: no escalation
    expect(createCalls[0].model).toBe(MODELS.brief);
    expect(MODELS.brief).toBe('claude-haiku-4-5');
    expect(out).toEqual([{ helperHandle: 'alice', kind: 'answered' }]);
  });

  it('auto-escalates a below-threshold candidate to the Opus tier and trusts its re-read', async () => {
    responses.push({ text: '[{"helperHandle":"bob","kind":"answered","confidence":0.3}]' }); // Haiku: ambiguous
    responses.push({ text: '[{"helperHandle":"bob","kind":"answered","confidence":0.95}]' }); // Opus: confident

    const out = await detectRecognitionsSmart('cheers @bob i guess that maybe helped?');

    expect(createCalls).toHaveLength(2);
    expect(createCalls[0].model).toBe(MODELS.brief); // claude-haiku-4-5
    expect(createCalls[1].model).toBe(MODELS.escalate); // claude-opus-4-8
    expect(MODELS.escalate).toBe('claude-opus-4-8');
    // The Opus re-read is confident, so the suggestion is surfaced rather than dropped.
    expect(out).toEqual([{ helperHandle: 'bob', kind: 'answered' }]);
    // The escalation call is metered on its own feature line.
    expect(usageTotals('detect-escalate').calls).toBe(1);
    expect(usageTotals('detect').calls).toBe(1);
  });

  it('honours the sampling contract on the live cascade (temperature to Haiku, none to Opus)', async () => {
    responses.push({ text: '[{"helperHandle":"carol","kind":"reviewed","confidence":0.2}]' });
    responses.push({ text: '[]' });

    await detectRecognitionsSmart('maybe @carol looked at it?');

    expect(createCalls).toHaveLength(2);
    // Haiku accepts sampling: temperature is sent (pinned to 0 for determinism).
    expect(createCalls[0]).toHaveProperty('temperature', 0);
    // Opus 4.8 rejects sampling with a 400, so the param must be omitted entirely.
    expect(createCalls[1]).not.toHaveProperty('temperature');
  });

  it('does not escalate when the cheap tier is confident', async () => {
    responses.push({ text: '[{"helperHandle":"dana","kind":"paired","confidence":0.8}]' });

    await detectRecognitionsSmart('huge thanks @dana for pairing');

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].model).toBe(MODELS.brief);
  });

  it('falls back to the deterministic baseline with no key and calls no model', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(createCalls).toHaveLength(0);
    expect(out).toEqual([{ helperHandle: 'alice', kind: 'answered' }]);
  });
});
