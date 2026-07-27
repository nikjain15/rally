import { describe, expect, it, vi } from 'vitest';
import { runAgent, selectSkills, type CallModel, type Skill, type Tool } from '@/lib/conduit/agent';
import {
  ASSISTANT_SKILLS,
  MAX_AGENT_STEPS,
  buildAssistantTools,
  buildCallModel,
} from '@/lib/assistant-agent';
import type { Proposal } from '@/lib/assistant';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * The bounded agent loop and its Rally wiring. These are real assertions on the reason-act loop
 * (@conduit/agent runAgent), on the runtime skills selected by intent, and on the no-authority
 * invariant: no side-effecting tool is exposed, and one would be refused by default.
 */

/** A read tool that just echoes, for driving the loop without a DB or a live model. */
function echoTool(name = 'reader'): Tool {
  return {
    name,
    description: 'echoes its note',
    jsonSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    sideEffecting: false,
    handler: async (args) => `echo:${(args as { note: string }).note}`,
  };
}

/** A model that emits a fixed script of turns, then always finalises. */
function scriptedModel(turns: Array<{ toolCall?: { name: string; args: unknown }; finalAnswer?: string }>): CallModel {
  let i = 0;
  return async () => turns[i++] ?? { finalAnswer: 'fallback final' };
}

describe('agent loop · termination and step cap', () => {
  it('terminates on a final answer and reports the trace', async () => {
    const res = await runAgent({
      goal: 'hi',
      tools: [echoTool()],
      callModel: scriptedModel([
        { toolCall: { name: 'reader', args: { note: 'x' } } },
        { finalAnswer: 'all done' },
      ]),
      maxSteps: 5,
    });
    expect(res.answer).toBe('all done');
    expect(res.stoppedAtCap).toBe(false);
    expect(res.steps.map((s) => s.kind)).toEqual(['tool_call', 'final']);
  });

  it('respects the step cap when the model never finalises', async () => {
    const callModel = vi.fn<CallModel>(async () => ({ toolCall: { name: 'reader', args: { note: 'x' } } }));
    const res = await runAgent({ goal: 'loop forever', tools: [echoTool()], callModel, maxSteps: 3 });
    expect(res.answer).toBeUndefined();
    expect(res.stoppedAtCap).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(3); // exactly the cap, no more.
  });
});

describe('agent loop · structured observations, never a throw', () => {
  it('turns invalid tool args into an invalid_args observation, not an exception', async () => {
    const res = await runAgent({
      goal: 'bad args',
      tools: [echoTool()],
      callModel: scriptedModel([
        { toolCall: { name: 'reader', args: { note: 123 } } }, // note must be a string
        { finalAnswer: 'recovered' },
      ]),
      maxSteps: 5,
    });
    expect(res.answer).toBe('recovered');
    const err = res.steps.find((s) => s.kind === 'tool_error');
    expect(err && err.kind === 'tool_error' && err.error.kind).toBe('invalid_args');
  });

  it('turns a handler throw into a structured handler_error observation', async () => {
    const thrower: Tool = { ...echoTool('boom'), handler: async () => { throw new Error('kaboom'); } };
    const res = await runAgent({
      goal: 'throw',
      tools: [thrower],
      callModel: scriptedModel([
        { toolCall: { name: 'boom', args: { note: 'x' } } },
        { finalAnswer: 'ok' },
      ]),
      maxSteps: 5,
    });
    const err = res.steps.find((s) => s.kind === 'tool_error');
    expect(err && err.kind === 'tool_error' && err.error.kind).toBe('handler_error');
    expect(res.answer).toBe('ok'); // the loop survived and finished.
  });
});

describe('agent loop · no-authority invariant', () => {
  it('refuses a side-effecting tool by default (allowSideEffects unset)', async () => {
    const writer: Tool = { ...echoTool('writer'), sideEffecting: true };
    const res = await runAgent({
      goal: 'try to write',
      tools: [writer],
      callModel: scriptedModel([
        { toolCall: { name: 'writer', args: { note: 'award points' } } },
        { finalAnswer: 'gave up on writing' },
      ]),
      maxSteps: 5,
      // allowSideEffects omitted → defaults to false.
    });
    const err = res.steps.find((s) => s.kind === 'tool_error');
    expect(err && err.kind === 'tool_error' && err.error.kind).toBe('side_effect_refused');
    expect(res.answer).toBe('gave up on writing');
  });
});

describe('Rally skills · selected by intent at runtime', () => {
  it('a matching intent injects exactly the matching skill\'s instructions', () => {
    const caught = selectSkills(ASSISTANT_SKILLS, { goal: 'what did I miss today?' });
    expect(caught.map((s) => s.id)).toEqual(['catch-up-summary']);

    const thanks = selectSkills(ASSISTANT_SKILLS, { goal: 'I want to thank Lin who unblocked my build' });
    expect(thanks.map((s) => s.id)).toEqual(['recognition-draft']);

    const ask = selectSkills(ASSISTANT_SKILLS, { goal: 'what did we decide in #general' });
    expect(ask.map((s) => s.id)).toEqual(['ask-answer']);
  });

  it('a non-matching intent injects no skill', () => {
    expect(selectSkills(ASSISTANT_SKILLS, { goal: 'zxcvbnm qwerty' })).toEqual([]);
  });

  it('runAgent injects a matched skill\'s instructions into the system prompt it hands the model', async () => {
    const seen: string[] = [];
    const spy: CallModel = async ({ system }) => {
      seen.push(system);
      return { finalAnswer: 'ok' };
    };
    const skill: Skill = { id: 'catch-up-summary', whenIntent: () => true, instructions: 'CATCHUP_MARKER' };
    const res = await runAgent({ goal: 'what did I miss', tools: [], skills: [skill], callModel: spy, maxSteps: 2 });
    expect(res.loadedSkills).toEqual(['catch-up-summary']);
    expect(seen[0]).toContain('CATCHUP_MARKER');

    // And a non-matching skill is NOT injected.
    const seen2: string[] = [];
    const spy2: CallModel = async ({ system }) => { seen2.push(system); return { finalAnswer: 'ok' }; };
    const noMatch: Skill = { id: 'nope', whenIntent: () => false, instructions: 'SHOULD_NOT_APPEAR' };
    await runAgent({ goal: 'anything', tools: [], skills: [noMatch], callModel: spy2, maxSteps: 2 });
    expect(seen2[0]).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('Rally agent tool surface · read-only, no authority', () => {
  const deps = {
    db: {} as Firestore,
    uid: 'u1',
    nowMs: 1,
    handle: null,
    proposals: [] as Proposal[],
  };

  it('exposes NO side-effecting tool and no points/write tool', () => {
    const tools = buildAssistantTools(deps);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.sideEffecting === true).toBe(false);
    // The one SAFE tool that writes external state (remember) is deliberately not exposed.
    expect(tools.map((t) => t.name)).not.toContain('remember');
    // No tool can award points / write a points-bearing row.
    for (const t of tools) {
      expect(/award|grant|points|xp|ledger|recognit.*confirm/i.test(t.name)).toBe(false);
    }
  });

  it('a propose-tool DRAFTS a proposal and never confirms it (no points granted)', async () => {
    const proposals: Proposal[] = [];
    const tools = buildAssistantTools({ ...deps, proposals });
    const draft = tools.find((t) => t.name === 'propose_recognition')!;
    const out = await draft.handler({ teammate: 'Lin', note: 'unblocked my build' });
    expect(proposals).toEqual([{ kind: 'recognition', teammate: 'Lin', note: 'unblocked my build' }]);
    expect(String(out)).toMatch(/cannot confirm it yourself/i);
  });
});

describe('callModel adapter · JSON protocol through the conduit seam', () => {
  const stubInfer = (text: string | null) =>
    (async () => ({ text, record: {} as never })) as unknown as typeof import('@/lib/conduit/rally-client').inferViaConduit;

  it('parses a tool decision into a toolCall turn', async () => {
    const call = buildCallModel({ infer: stubInfer('{"tool":"summarize_channel","args":{"channel":"general"}}') });
    const turn = await call({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(turn.toolCall).toEqual({ name: 'summarize_channel', args: { channel: 'general' } });
    expect(turn.finalAnswer).toBeUndefined();
  });

  it('parses a final decision into a finalAnswer turn', async () => {
    const call = buildCallModel({ infer: stubInfer('{"final":"here is your summary"}') });
    const turn = await call({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(turn.finalAnswer).toBe('here is your summary');
  });

  it('degrades safely when the model is off (null text) → no action, no throw', async () => {
    const call = buildCallModel({ infer: stubInfer(null) });
    const turn = await call({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(turn.toolCall).toBeUndefined();
    expect(turn.finalAnswer).toBeUndefined();
  });
});

describe('bounded step cap constant', () => {
  it('is a small, finite cap', () => {
    expect(MAX_AGENT_STEPS).toBeGreaterThan(0);
    expect(MAX_AGENT_STEPS).toBeLessThanOrEqual(10);
  });
});
