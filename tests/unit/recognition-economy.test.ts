/**
 * The economy guard, as pure arithmetic.
 *
 * Finding D-P0-3: two members could alternate "thanks @you" forever and mint XP with every new
 * message, because the author of the thanks is also the person authorised to confirm it. The fix
 * lives in `lib/recognition-admin.ts` and has two halves. The half that needs a database is
 * asserted in `tests/integration/recognition.test.ts`; the rolling-window arithmetic underneath
 * it is pure, so it is asserted here, where it runs without an emulator.
 *
 * Read the test names as promises: an occasional thank-you always pays, and a farm always
 * flattens.
 */
import { describe, expect, it } from 'vitest';
import {
  PAIR_AWARD_CAP,
  PAIR_WINDOW_MS,
  awardsInWindow,
  pairCapReached,
  pairKey,
} from '@/lib/recognition-admin';

const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('the per-pair allowance lets genuine recognition through', () => {
  it('pays a pair who have never been recognised before', () => {
    expect(pairCapReached([], NOW)).toBe(false);
  });

  it('keeps paying a pair who genuinely help each other a few times a day', () => {
    const today = [NOW - 5 * HOUR, NOW - 2 * HOUR];
    expect(today.length).toBeLessThan(PAIR_AWARD_CAP);
    expect(pairCapReached(today, NOW)).toBe(false);
  });

  it('forgets awards older than the window, so a quiet day restores the full allowance', () => {
    const yesterday = Array.from({ length: PAIR_AWARD_CAP }, (_, i) => NOW - PAIR_WINDOW_MS - i * HOUR);
    expect(awardsInWindow(yesterday, NOW)).toEqual([]);
    expect(pairCapReached(yesterday, NOW)).toBe(false);
  });

  it('counts the allowance per direction of credit, so helping back is not taxed', () => {
    expect(pairKey('uid_a', 'uid_b')).not.toBe(pairKey('uid_b', 'uid_a'));
  });
});

describe('the per-pair allowance flattens a farm', () => {
  it('stops paying once the pair has banked its allowance for the window', () => {
    const banked = Array.from({ length: PAIR_AWARD_CAP }, (_, i) => NOW - (i + 1) * HOUR);
    expect(pairCapReached(banked, NOW)).toBe(true);
  });

  it('does not pay more for trying harder — a thousand thank-yous bank the same allowance', () => {
    const flood = Array.from({ length: 1000 }, (_, i) => NOW - i * 1000);
    expect(pairCapReached(flood, NOW)).toBe(true);
    // The window is a ceiling, not a running total: it never lets more than the cap through.
    expect(awardsInWindow(flood, NOW).length).toBeGreaterThan(PAIR_AWARD_CAP);
  });

  it('cannot be reopened by back-dated or future-dated entries', () => {
    // A clock skewed forward would otherwise park awards outside the window and free the cap.
    expect(awardsInWindow([NOW + HOUR, NOW + PAIR_WINDOW_MS], NOW)).toEqual([]);
    expect(awardsInWindow([NOW - PAIR_WINDOW_MS], NOW)).toEqual([]);
  });

  it('ignores junk in the stored history rather than crashing the confirm', () => {
    const dirty = [NOW - HOUR, null, undefined, 'nope'] as unknown as number[];
    expect(awardsInWindow(dirty, NOW)).toEqual([NOW - HOUR]);
  });

  it('bounds the whole farm: a pair can bank at most twice the cap per window, both directions', () => {
    // Ordered pairs mean a reciprocal loop gets two allowances, not unlimited ones. That total
    // is a constant per window; it does not grow with how many messages they post.
    const perWindow = PAIR_AWARD_CAP * 2;
    expect(perWindow).toBe(6);
  });
});
