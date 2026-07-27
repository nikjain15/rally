import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end wiring proof for the AGENT seam: the Home assistant\'s bounded loop runs through
 * @conduit/client (embedded) via runAgentViaConduit, and every model step inside the loop is
 * routed through the same metered inferViaConduit path the Ask/detect seams use. The Anthropic
 * provider is mocked, so this asserts the WIRING (the loop drives real model calls through the
 * client, terminates, and stays metered), not the model itself.
 */
const { createCalls, responses } = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  responses: [] as string[],
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (args: Record<string, unknown>) => {
        createCalls.push(args);
        const text = responses.shift() ?? '{"final":"done"}';
        return { usage: { input_tokens: 12, output_tokens: 4 }, content: [{ type: 'text', text }] };
      },
    };
  },
}));

import { MODELS, resetUsage, supportsSampling, usageTotals } from '@/lib/agent';
import { buildCallModel } from '@/lib/assistant-agent';
import { runAgentViaConduit } from '@/lib/conduit/rally-client';
import type { Tool } from '@/lib/conduit/agent';

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

function reader(): Tool {
  return {
    name: 'my_commitments',
    description: 'lists commitments',
    jsonSchema: { type: 'object', properties: {}, required: [] },
    sideEffecting: false,
    handler: async () => '- ship the PR by Friday',
  };
}

describe('agent seam · runAgentViaConduit through @conduit/client', () => {
  it('drives the loop through the client, terminates on a final answer, and meters every step', async () => {
    // First model turn: call the read tool. Second turn: give the final answer.
    responses.push('{"tool":"my_commitments","args":{}}');
    responses.push('{"final":"You have one open commitment: ship the PR by Friday."}');

    const result = await runAgentViaConduit(
      {
        tools: [reader()],
        callModel: buildCallModel({ feature: 'assistant' }),
        maxSteps: MAX_STEPS(),
        system: 'You are Rally.',
        allowSideEffects: false,
      },
      'what are my commitments?',
    );

    expect(result.answer).toContain('ship the PR by Friday');
    expect(result.stoppedAtCap).toBe(false);
    expect(result.steps.map((s) => s.kind)).toEqual(['tool_call', 'final']);

    // Two model steps actually hit the provider through the seam, both attributable in the meter.
    expect(createCalls).toHaveLength(2);
    expect(usageTotals('assistant').calls).toBe(2);

    // Sampling contract: the default tier (Sonnet 5) rejects temperature, so none was sent.
    expect(supportsSampling(MODELS.default)).toBe(false);
    for (const c of createCalls) expect('temperature' in c).toBe(false);
  });

  it('a side-effecting tool is refused by default, and the loop still finishes cleanly', async () => {
    responses.push('{"tool":"award","args":{}}'); // model tries a write
    responses.push('{"final":"I cannot award points; that is peer-confirmed."}');
    const writer: Tool = { ...reader(), name: 'award', sideEffecting: true, handler: async () => 'WROTE POINTS' };

    const result = await runAgentViaConduit(
      { tools: [writer], callModel: buildCallModel({ feature: 'assistant' }), maxSteps: 4, allowSideEffects: false },
      'give me 100 points',
    );

    const err = result.steps.find((s) => s.kind === 'tool_error');
    expect(err && err.kind === 'tool_error' && err.error.kind).toBe('side_effect_refused');
    expect(result.answer).toMatch(/cannot award/i);
  });
});

function MAX_STEPS() {
  return 6;
}
