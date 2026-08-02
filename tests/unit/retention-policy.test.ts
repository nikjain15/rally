import { afterEach, describe, expect, it } from 'vitest';
import { cutoffMs, isExpired, isTombstone, retentionSummary, RETENTION, ERASURE_LIMITS } from '@/lib/retention';
import { checkOpsSecret } from '@/lib/ops-auth';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-02T00:00:00Z');

describe('retention policy', () => {
  it('gives every data type a window and a defence of the number', () => {
    for (const [key, rule] of Object.entries(RETENTION)) {
      expect(rule.name, key).toBeTruthy();
      expect(rule.field, key).toBeTruthy();
      // A window is either a positive number of days or an explicit, argued indefinite.
      expect(rule.days === null || rule.days > 0, key).toBe(true);
      expect(rule.why.length, key).toBeGreaterThan(60);
    }
  });

  it('keeps the XP ledger and profiles indefinitely, and says so in the reason', () => {
    expect(RETENTION.xpEvents.days).toBeNull();
    expect(RETENTION.xpEvents.why).toContain('INDEFINITE');
    expect(RETENTION.profiles.days).toBeNull();
  });

  it('never lets a derived summary outlive the source it summarises', () => {
    // Assistant memory is built from assistant thread messages. Memory outliving the threads by a
    // lot would leave a summary of conversations that no longer exist.
    expect(RETENTION.assistantMemory.days!).toBeLessThanOrEqual(RETENTION.assistantMessages.days! * 2);
  });

  it('keeps the pair-award history barely longer than the cap window it enforces', () => {
    // PAIR_WINDOW_MS is 24h; anything much past that is a record of who thanked whom.
    expect(RETENTION.recognitionPairs.days!).toBeLessThanOrEqual(14);
    expect(RETENTION.recognitionPairs.days!).toBeGreaterThanOrEqual(2);
  });

  it('computes a cutoff, and none at all for an indefinite rule', () => {
    expect(cutoffMs(RETENTION.pulseEvents, NOW)).toBe(NOW - 180 * DAY);
    expect(cutoffMs(RETENTION.xpEvents, NOW)).toBeNull();
  });

  it('expires a document past its window and keeps one inside it', () => {
    expect(isExpired(RETENTION.pulseEvents, NOW - 181 * DAY, NOW)).toBe(true);
    expect(isExpired(RETENTION.pulseEvents, NOW - 179 * DAY, NOW)).toBe(false);
  });

  it('never expires anything under an indefinite rule, however old', () => {
    expect(isExpired(RETENTION.xpEvents, NOW - 10_000 * DAY, NOW)).toBe(false);
  });

  it('keeps a document with no readable timestamp rather than guessing it is old', () => {
    // A missing createdAt is a bug or a pending server timestamp, not evidence of age. Deleting on
    // "no timestamp" would delete the newest writes first, which is the worst possible failure.
    expect(isExpired(RETENTION.messages, null, NOW)).toBe(false);
  });

  it('publishes the policy as data so docs and code cannot drift', () => {
    const summary = retentionSummary();
    expect(summary).toHaveLength(Object.keys(RETENTION).length);
    expect(summary.find((s) => s.rule === 'XP ledger')?.window).toBe('indefinite');
    expect(summary.find((s) => s.rule === 'channel messages')?.window).toBe('400 days');
  });
});

describe('erasure honesty', () => {
  it("names what it cannot reach, including other members' words and the ledger", () => {
    const all = ERASURE_LIMITS.join(' ');
    expect(all).toContain('OTHER members');
    expect(all).toContain('xpEvents');
    expect(all).toContain('backups');
    expect(ERASURE_LIMITS.length).toBeGreaterThanOrEqual(4);
  });

  it('recognises a tombstone uid so nothing tries to render it as a person', () => {
    expect(isTombstone('erased_abc123')).toBe(true);
    expect(isTombstone('perf_u3')).toBe(false);
  });
});

describe('operator credential', () => {
  const original = process.env.RALLY_OPS_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.RALLY_OPS_SECRET;
    else process.env.RALLY_OPS_SECRET = original;
  });

  it('fails closed when no secret is configured', () => {
    delete process.env.RALLY_OPS_SECRET;
    expect(checkOpsSecret('anything')).toBe('not_configured');
    expect(checkOpsSecret(null)).toBe('not_configured');
  });

  it('accepts the exact secret and rejects everything else', () => {
    process.env.RALLY_OPS_SECRET = 'correct-horse-battery-staple';
    expect(checkOpsSecret('correct-horse-battery-staple')).toBe('ok');
    expect(checkOpsSecret('correct-horse-battery-stapl')).toBe('forbidden');
    expect(checkOpsSecret('correct-horse-battery-staplee')).toBe('forbidden');
    expect(checkOpsSecret('')).toBe('forbidden');
    expect(checkOpsSecret(null)).toBe('forbidden');
  });

  it('does not treat a prefix of the secret as a match', () => {
    process.env.RALLY_OPS_SECRET = 'abcdefgh';
    expect(checkOpsSecret('abcd')).toBe('forbidden');
  });
});
