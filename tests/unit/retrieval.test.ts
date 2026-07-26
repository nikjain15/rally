import { describe, expect, it } from 'vitest';
import { selectRelevant, tokenize, type RankableMessage } from '@/lib/retrieval';

const msgs: RankableMessage[] = [
  { author: 'ada', body: 'morning everyone, coffee first' },
  { author: 'bo', body: 'we decided to ship the deploy on Friday after the review' },
  { author: 'cy', body: 'anyone up for lunch at noon?' },
  { author: 'di', body: 'the deploy pipeline is green now, all checks passed' },
  { author: 'ed', body: 'reminder: standup moved to 10am' },
  { author: 'fi', body: 'lunch was great, thanks for organizing' },
];

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and drops stopwords/short tokens', () => {
    expect(tokenize('We decided to SHIP the deploy!')).toEqual(['decided', 'ship', 'deploy']);
  });
});

describe('selectRelevant — keyword mode', () => {
  it('ranks messages about the query above unrelated recent ones', () => {
    const { relevant, selected } = selectRelevant(msgs, 'when is the deploy', { topK: 2, window: 0 });
    expect(relevant).toBe(true);
    const bodies = selected.map((m) => m.body).join(' | ');
    expect(bodies).toContain('ship the deploy on Friday');
    expect(bodies).toContain('deploy pipeline is green');
    expect(bodies).not.toContain('lunch');
  });

  it('widens each anchor with neighbouring messages for context, in chronological order', () => {
    const { selected } = selectRelevant(msgs, 'deploy Friday', { topK: 1, window: 1 });
    // Anchor is the "ship the deploy on Friday" message (index 1); window 1 pulls its neighbours.
    expect(selected.map((m) => m.author)).toEqual(['ada', 'bo', 'cy']);
  });

  it('abstains when nothing matches the query (bad-retrieval failure mode)', () => {
    const { relevant, selected } = selectRelevant(msgs, 'quarterly budget forecast spreadsheet', {});
    expect(relevant).toBe(false);
    expect(selected).toEqual([]);
  });
});

describe('selectRelevant — recency mode (empty query)', () => {
  it('returns the most recent slice in order, and stays relevant', () => {
    const { relevant, selected } = selectRelevant(msgs, '   ', { topK: 3 });
    expect(relevant).toBe(true);
    expect(selected.map((m) => m.author)).toEqual(['di', 'ed', 'fi']); // last 3, chronological
  });

  it('handles an empty channel without throwing', () => {
    expect(selectRelevant([], 'anything', {})).toEqual({ relevant: false, selected: [] });
    expect(selectRelevant([], '', {})).toEqual({ relevant: true, selected: [] });
  });
});
