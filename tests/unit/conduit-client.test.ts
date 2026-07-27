import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end wiring proof for the Conduit seam.
 *
 * Rally's real answer paths (the Ask channel summary and the recognition-detect
 * classify) now flow through @conduit/client in EMBEDDED mode:
 *   caller → inferViaConduit → createClient({mode:"embedded"}) → Rally's injected
 *   core (callClaudeDetailed) → the Anthropic provider.
 * The provider is mocked, so this asserts the WIRING and the metered record, not
 * the model. We also assert the unified client surface directly (`mode`, `infer`,
 * `retrieve` routed to Rally's BM25 retrieval), and that a REAL path
 * (detectRecognitionsSmart) goes through the seam and stays metered.
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
        const next = responses.shift() ?? { text: 'ok' };
        return {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text: next.text }],
        };
      },
    };
  },
}));

import { MODELS, resetUsage, usageTotals } from '@/lib/agent';
import { createRallyClient, inferViaConduit } from '@/lib/conduit/rally-client';
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
  vi.restoreAllMocks();
});

describe('conduit client · embedded seam', () => {
  it('exposes the unified embedded surface', () => {
    const client = createRallyClient();
    expect(client.mode).toBe('embedded');
    expect(typeof client.infer).toBe('function');
    expect(typeof client.retrieve).toBe('function');
  });

  it('infer flows caller → @conduit/client (embedded) → Rally model, returning a metered record', async () => {
    responses.push({ text: 'a grounded summary' });

    const { text, record } = await inferViaConduit({
      feature: 'ask',
      model: MODELS.default,
      system: 'sys',
      prompt: 'summarise this channel',
      maxTokens: 700,
    });

    // The answer came back through the client.
    expect(text).toBe('a grounded summary');
    // The metered record is real: provider, resolved model, and a non-zero cost from the price table.
    expect(record.provider).toBe('anthropic');
    expect(record.model).toBe(MODELS.default);
    expect(record.costUsd).toBeGreaterThan(0);
    // The provider was actually invoked once with the resolved tier.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].model).toBe(MODELS.default);
    // The call is attributable in the in-process meter under its feature.
    expect(usageTotals('ask').calls).toBe(1);
  });

  it('retrieve routes Rally BM25 retrieval through the client', async () => {
    const candidates = [
      { author: 'alice', body: 'we decided to ship the ledger on friday' },
      { author: 'bob', body: 'lunch options for today' },
      { author: 'carol', body: 'the ledger migration is append-only' },
    ];
    const client = createRallyClient({ candidates });
    const { chunks, grounded } = await client.retrieve({ query: 'ledger decision', topK: 5 });
    expect(grounded).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.text.includes('ledger'))).toBe(true);
  });

  it('a REAL path (detect classify) routes through the seam and stays metered', async () => {
    responses.push({ text: '[{"helperHandle":"alice","kind":"answered","confidence":0.9}]' });

    const out = await detectRecognitionsSmart('thanks @alice for the help!');

    expect(out).toEqual([{ helperHandle: 'alice', kind: 'answered' }]);
    // It went through the embedded seam on the cheap tier, and the call is metered.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].model).toBe(MODELS.brief);
    expect(usageTotals('detect').calls).toBe(1);
  });

  it('degrades to null text (no throw) when the model is off, preserving the caller fallback', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { text, record } = await inferViaConduit({
      feature: 'ask',
      model: MODELS.default,
      system: 'sys',
      prompt: 'summarise',
    });
    expect(text).toBeNull();
    expect(record.costUsd).toBe(0);
    expect(createCalls).toHaveLength(0);
  });
});
