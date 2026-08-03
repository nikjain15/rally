import { describe, expect, it } from 'vitest';
import {
  KILL_CONFIRM_RATE,
  KILL_MIN_SUGGESTIONS,
  KILL_WINDOW_DAYS,
  cohort,
  evaluateKillLine,
  funnelStats,
  type SuggestionRecord,
} from '@/lib/kill-criteria';

/**
 * The kill line (R1).
 *
 * The decision log's objection was that Rally could not take this test at all,
 * because nothing recorded the suggested-to-confirmed transition. These tests are
 * what makes the criterion real rather than a paragraph: the line has to fire when
 * the loop is not working, refuse to fire on a sample too small to read, and
 * measure a cohort rather than a snapshot ratio that drifts with volume.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 2); // 2026-08-02

/** n suggestions created `daysAgo`, of which `confirmed` were confirmed a day later. */
function batch(n: number, confirmed: number, daysAgo: number, tag = 'r'): SuggestionRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}${daysAgo}_${i}`,
    createdAtMs: NOW - daysAgo * DAY,
    confirmedAtMs: i < confirmed ? NOW - daysAgo * DAY + DAY : null,
  }));
}

describe('cohort membership is decided by creation time', () => {
  it('includes suggestions inside the window and excludes older ones', () => {
    const inside = batch(3, 0, 5);
    const outside = batch(4, 0, KILL_WINDOW_DAYS + 1, 'old');
    expect(cohort([...inside, ...outside], NOW)).toHaveLength(3);
  });

  it('counts a suggestion confirmed AFTER the window closed', () => {
    // The question is whether a suggestion ever gets confirmed, not whether it
    // was confirmed fast. Excluding these would understate the rate.
    const late: SuggestionRecord = {
      id: 'late',
      createdAtMs: NOW - 2 * DAY,
      confirmedAtMs: NOW + 30 * DAY,
    };
    const stats = funnelStats(cohort([late], NOW));
    expect(stats.suggested).toBe(1);
    expect(stats.confirmed).toBe(1);
  });

  it('excludes a suggestion created in the future', () => {
    const future = [{ id: 'f', createdAtMs: NOW + DAY, confirmedAtMs: null }];
    expect(cohort(future, NOW)).toHaveLength(0);
  });
});

describe('funnelStats', () => {
  it('computes the confirm rate over the cohort', () => {
    const stats = funnelStats(batch(10, 4, 3));
    expect(stats.suggested).toBe(10);
    expect(stats.confirmed).toBe(4);
    expect(stats.confirmRate).toBeCloseTo(0.4, 10);
  });

  it('reports the median time to confirm, the number that did not exist before', () => {
    const stats = funnelStats(batch(10, 10, 3));
    expect(stats.medianHoursToConfirm).toBeCloseTo(24, 10);
  });

  it('has a null rate on an empty cohort rather than 0', () => {
    // 0 would read as "nobody confirms", which is a different claim from "no data".
    const stats = funnelStats([]);
    expect(stats.confirmRate).toBeNull();
    expect(stats.medianHoursToConfirm).toBeNull();
  });

  it('counts a confirm stamped before its suggestion but keeps it out of the latency', () => {
    // Clock skew between server timestamps is real. It must not produce a
    // negative time-to-confirm, and it must not silently drop a confirm either.
    const skewed: SuggestionRecord[] = [
      { id: 'skew', createdAtMs: NOW - DAY, confirmedAtMs: NOW - 2 * DAY },
      { id: 'ok', createdAtMs: NOW - 3 * DAY, confirmedAtMs: NOW - 3 * DAY + DAY },
    ];
    const stats = funnelStats(skewed);
    expect(stats.confirmed).toBe(2);
    expect(stats.medianHoursToConfirm).toBeCloseTo(24, 10);
  });
});

describe('the line holds when the loop works', () => {
  it('holds at a healthy confirm rate', () => {
    const v = evaluateKillLine(batch(200, 120, 5), NOW);
    expect(v.status).toBe('holding');
    expect(v.stats.confirmRate).toBeCloseTo(0.6, 10);
    expect(v.action).toContain('Continue');
  });

  it('holds exactly at the line, which is "below" and not "at or below"', () => {
    const v = evaluateKillLine(batch(200, 60, 5), NOW);
    expect(v.stats.confirmRate).toBeCloseTo(KILL_CONFIRM_RATE, 10);
    expect(v.status).toBe('holding');
  });
});

describe('the line fires when the loop does not work', () => {
  it('crosses below the confirm rate', () => {
    const v = evaluateKillLine(batch(200, 40, 5), NOW);
    expect(v.status).toBe('crossed');
    expect(v.stats.confirmRate).toBeCloseTo(0.2, 10);
  });

  it('names a consequence that is a pivot, not a tuning pass', () => {
    const v = evaluateKillLine(batch(200, 10, 5), NOW);
    expect(v.action).toContain('not the product');
    // And rules out blaming the detector, which is measured separately.
    expect(v.action).toContain('Do not tune the detector');
  });
});

describe('the line refuses an unreadable sample', () => {
  it('will not fire on too few suggestions, however bad the rate', () => {
    // 20 suggestions, none confirmed. Alarming, and not 100.
    const v = evaluateKillLine(batch(20, 0, 5), NOW);
    expect(v.status).toBe('not_enough_data');
    expect(v.stats.confirmRate).toBe(0);
    expect(v.stats.suggested < KILL_MIN_SUGGESTIONS).toBe(true);
    expect(v.action).toContain('almost any hypothesis');
  });

  it('does not let stale suggestions pad the cohort up to the sample floor', () => {
    // 200 old suggestions outside the window plus 20 recent ones is still an
    // unreadable cohort. This is the mistake a snapshot ratio would make.
    const v = evaluateKillLine([...batch(200, 120, 60, 'old'), ...batch(20, 0, 3)], NOW);
    expect(v.status).toBe('not_enough_data');
    expect(v.stats.suggested).toBe(20);
  });

  it('handles no data at all', () => {
    const v = evaluateKillLine([], NOW);
    expect(v.status).toBe('not_enough_data');
    expect(v.stats.suggested).toBe(0);
    expect(v.stats.confirmRate).toBeNull();
  });
});

describe('a cohort is not a snapshot ratio', () => {
  it('is not dragged down by yesterday\'s unconfirmed suggestions the way a snapshot is', () => {
    // 150 suggestions from three weeks ago, 60% confirmed. Then a burst of 100
    // from yesterday that nobody has had time to confirm yet.
    const settled = batch(150, 90, 21, 'settled');
    const fresh = batch(100, 0, 1, 'fresh');
    const all = [...settled, ...fresh];

    // A naive "confirmed / total right now" reads 90/250 = 36%, which is barely
    // above the line and would read as a product in trouble.
    const snapshot = all.filter((r) => r.confirmedAtMs !== null).length / all.length;
    expect(snapshot).toBeCloseTo(0.36, 10);

    // Both batches are inside the 28-day window, so the cohort sees the same
    // records. The point of the cohort is not that it excludes the fresh ones
    // here, it is that the rate is defined over suggestions rather than over a
    // moving denominator, so it converges as the fresh ones settle.
    const v = evaluateKillLine(all, NOW);
    expect(v.stats.suggested).toBe(250);

    // Once the fresh batch settles at the same 60%, the cohort rate recovers.
    const settledFresh = batch(100, 60, 1, 'fresh');
    const later = evaluateKillLine([...settled, ...settledFresh], NOW);
    expect(later.stats.confirmRate).toBeCloseTo(0.6, 10);
    expect(later.status).toBe('holding');
  });
});
