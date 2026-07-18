import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, isProposeTool, isSafeTool, toProposal } from '@/lib/assistant';

describe('assistant tool classification — safe vs propose', () => {
  it('reads and personal memory are SAFE (run server-side)', () => {
    for (const t of ['catch_me_up', 'summarize_channel', 'my_commitments', 'find_teammate', 'remember']) {
      expect(isSafeTool(t)).toBe(true);
      expect(isProposeTool(t)).toBe(false);
    }
  });

  it('anything that writes points / posts / credits a peer is a PROPOSE tool', () => {
    for (const t of ['propose_commitment', 'propose_message', 'propose_recognition']) {
      expect(isProposeTool(t)).toBe(true);
      expect(isSafeTool(t)).toBe(false);
    }
  });

  it('unknown tools are neither', () => {
    expect(isSafeTool('drop_table')).toBe(false);
    expect(isProposeTool('drop_table')).toBe(false);
  });

  it('every declared tool is classified exactly once', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(isSafeTool(tool.name) !== isProposeTool(tool.name)).toBe(true);
    }
  });
});

describe('toProposal — typed drafts for confirmation', () => {
  it('builds a commitment proposal', () => {
    expect(toProposal('propose_commitment', { text: '  ship the PR by Fri  ' })).toEqual({ kind: 'commitment', text: 'ship the PR by Fri' });
  });

  it('strips a leading # from the channel', () => {
    expect(toProposal('propose_message', { channel: '#general', body: 'hi' })).toEqual({ kind: 'message', channel: 'general', body: 'hi' });
  });

  it('builds a recognition proposal', () => {
    expect(toProposal('propose_recognition', { teammate: 'Lin', note: 'unblocked my build' })).toEqual({ kind: 'recognition', teammate: 'Lin', note: 'unblocked my build' });
  });

  it('rejects malformed input (missing/empty fields)', () => {
    expect(toProposal('propose_commitment', { text: '   ' })).toBeNull();
    expect(toProposal('propose_message', { channel: 'x' })).toBeNull();
    expect(toProposal('propose_recognition', { teammate: 'Lin' })).toBeNull();
  });
});
