import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectCacheKey,
  getCachedDetections,
  setCachedDetections,
  detectCacheStats,
  resetDetectCache,
  CACHE_MAX_ENTRIES,
} from '../../lib/detect-cache';

/**
 * The cache in front of the detection model layer. docs/COST.md.
 *
 * Two things are being defended here, and only one of them is about money.
 *
 * The cost claim is that a repeated message costs nothing the second time. That is the easy
 * half and the tests below check it directly.
 *
 * The correctness claim is the one worth the tests: a cache key narrower than the inputs that
 * decide the answer is a CORRECTNESS bug that presents as a cost win. If a prompt edit or a
 * model swap kept serving entries computed under the old prompt, detection would quietly
 * regress and the meter would show it as an improvement.
 */

const base = {
  body: 'thanks @rita for unblocking me on the deploy',
  briefModel: 'claude-haiku-4-5',
  escalateModel: 'claude-opus-4-8',
  system: 'SYSTEM PROMPT v1',
  threshold: 0.6,
};

beforeEach(() => resetDetectCache());

describe('detectCacheKey · every input that changes the answer is in the key', () => {
  it('gives the same key for the same inputs', () => {
    expect(detectCacheKey(base)).toBe(detectCacheKey({ ...base }));
  });

  it('changes when the message body changes', () => {
    expect(detectCacheKey({ ...base, body: 'thanks @sam' })).not.toBe(detectCacheKey(base));
  });

  it('changes when the SYSTEM PROMPT changes, so a prompt edit cannot serve stale readings', () => {
    // This is the important one. Edit the extraction instruction and every entry must miss.
    expect(detectCacheKey({ ...base, system: 'SYSTEM PROMPT v2' })).not.toBe(detectCacheKey(base));
  });

  it('changes when either model changes, including the escalation tier', () => {
    expect(detectCacheKey({ ...base, briefModel: 'claude-haiku-9' })).not.toBe(detectCacheKey(base));
    // The escalate model matters even though most messages never reach it: the cached value is
    // the FINAL answer, and for an ambiguous message that answer came from the strong tier.
    expect(detectCacheKey({ ...base, escalateModel: 'claude-opus-9' })).not.toBe(detectCacheKey(base));
  });

  it('changes when the confidence threshold changes', () => {
    expect(detectCacheKey({ ...base, threshold: 0.8 })).not.toBe(detectCacheKey(base));
  });

  it('does not collide across bodies that differ only by whitespace or case', () => {
    const keys = new Set(
      ['thanks @rita', 'Thanks @rita', 'thanks  @rita', 'thanks @rita '].map((body) =>
        detectCacheKey({ ...base, body })
      )
    );
    expect(keys.size).toBe(4);
  });
});

describe('the cache itself', () => {
  it('misses on an unseen key and hits on a stored one', () => {
    const k = detectCacheKey(base);
    expect(getCachedDetections(k)).toBeNull();

    setCachedDetections(k, [{ helperHandle: 'rita', kind: 'unblocked' }] as never);
    expect(getCachedDetections(k)).toEqual([{ helperHandle: 'rita', kind: 'unblocked' }]);

    const s = detectCacheStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe(0.5);
  });

  it('caches an empty reading, because "nobody was credited" is an answer worth not paying for twice', () => {
    // Most chat messages credit nobody. If empty results were not cached, the most common
    // case in the product would be the one case that never benefits.
    const k = detectCacheKey({ ...base, body: 'deploy is green' });
    setCachedDetections(k, []);
    expect(getCachedDetections(k)).toEqual([]);
    expect(detectCacheStats().hits).toBe(1);
  });

  it('hands out copies, so a caller mutating its result cannot poison later hits', () => {
    const k = detectCacheKey(base);
    setCachedDetections(k, [{ helperHandle: 'rita', kind: 'unblocked' }] as never);

    const first = getCachedDetections(k)!;
    first.length = 0; // a caller sorting or splicing in place

    expect(getCachedDetections(k)).toEqual([{ helperHandle: 'rita', kind: 'unblocked' }]);
  });

  it('copies on the way in too, so mutating the source afterwards does not change the entry', () => {
    const k = detectCacheKey(base);
    const source = [{ helperHandle: 'rita', kind: 'unblocked' }] as never[];
    setCachedDetections(k, source);
    (source as unknown[]).length = 0;
    expect(getCachedDetections(k)).toHaveLength(1);
  });

  it('stays bounded, evicting the oldest entry rather than growing without limit', () => {
    for (let i = 0; i < CACHE_MAX_ENTRIES + 50; i++) {
      setCachedDetections(detectCacheKey({ ...base, body: `msg ${i}` }), []);
    }
    expect(detectCacheStats().entries).toBe(CACHE_MAX_ENTRIES);

    // The first ones written are gone; the most recent survive.
    expect(getCachedDetections(detectCacheKey({ ...base, body: 'msg 0' }))).toBeNull();
    expect(getCachedDetections(detectCacheKey({ ...base, body: `msg ${CACHE_MAX_ENTRIES + 49}` }))).toEqual([]);
  });

  it('treats a read as recent, so a repeatedly-asked message survives eviction', () => {
    const hot = detectCacheKey({ ...base, body: 'hot message' });
    setCachedDetections(hot, []);

    for (let i = 0; i < CACHE_MAX_ENTRIES - 1; i++) {
      setCachedDetections(detectCacheKey({ ...base, body: `filler ${i}` }), []);
      if (i % 100 === 0) getCachedDetections(hot); // keep asking for it
    }
    setCachedDetections(detectCacheKey({ ...base, body: 'one more' }), []);

    expect(getCachedDetections(hot)).toEqual([]);
  });

  it('reports a zero hit rate before anything is asked, rather than dividing by zero', () => {
    expect(detectCacheStats()).toEqual({ hits: 0, misses: 0, entries: 0, hitRate: 0 });
  });
});
