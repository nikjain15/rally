/**
 * Quests + the neighbors-only leaderboard against a real Firestore (Admin SDK on the emulator).
 * Proves quests award once and idempotently, and that the leaderboard is a ±2 neighbor window
 * with a cooperative team goal — never a full public ranking (guardrail #5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminDb } from '@/lib/admin';
import { completeQuest, seedQuests } from '@/lib/quest-admin';
import { computeLeaderboard } from '@/lib/leaderboard-admin';
import { clearFirestore } from './helpers';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

let db: Firestore;

beforeEach(async () => {
  const got = adminDb();
  if (!got) throw new Error('admin db unavailable');
  db = got;
  await clearFirestore();
});
afterEach(async () => {
  await clearFirestore();
});

async function xpTotal(uid: string): Promise<number> {
  const snap = await db.collection('xpEvents').where('profileUid', '==', uid).get();
  return snap.docs.reduce((s, d) => s + (d.data().points ?? 0), 0);
}

/** Give a uid a fixed XP total via ledger rows (as the server would). */
async function grant(uid: string, points: number): Promise<void> {
  await db.collection('xpEvents').doc(`seed_${uid}`).set({
    profileUid: uid,
    source: 'test',
    refId: 'seed',
    points,
    createdAt: FieldValue.serverTimestamp(),
  });
}

describe('quests', () => {
  it('seeds starter quests idempotently and awards a completion once', async () => {
    await seedQuests(db, 'u1');
    await seedQuests(db, 'u1'); // re-seed is a no-op
    const open = await db.collection('quests').where('profileUid', '==', 'u1').get();
    expect(open.size).toBe(2);

    expect(await completeQuest(db, 'u1', 'recognize')).toBe(true);
    expect(await completeQuest(db, 'u1', 'recognize')).toBe(false); // already done
    expect(await xpTotal('u1')).toBe(5);
  });

  it('completing an unseeded quest is a harmless no-op', async () => {
    expect(await completeQuest(db, 'ghost', 'commit')).toBe(false);
    expect(await xpTotal('ghost')).toBe(0);
  });
});

describe('neighbors-only leaderboard', () => {
  it('returns a ±2 window around the caller with correct ranks, plus the team total', async () => {
    // 7 people, descending XP: a=70 … g=10.
    const people: [string, number][] = [
      ['a', 70], ['b', 60], ['c', 50], ['d', 40], ['e', 30], ['f', 20], ['g', 10],
    ];
    for (const [u, p] of people) await grant(u, p);

    const board = await computeLeaderboard(db, 'd'); // rank 4 (middle)
    expect(board.me).toMatchObject({ uid: 'd', rank: 4, total: 40 });
    // ±2 → ranks 2..6 → b,c,d,e,f
    expect(board.neighbors.map((r) => r.uid)).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(board.participants).toBe(7);
    expect(board.teamTotal).toBe(280);
    // Cooperative goal scales with participants.
    expect(board.teamGoal.target).toBe(7 * 50);
    expect(board.teamGoal.current).toBe(280);
  });

  it('clamps the window at the top of the board (no negative slice)', async () => {
    for (const [u, p] of [['a', 30], ['b', 20], ['c', 10]] as [string, number][]) await grant(u, p);
    const board = await computeLeaderboard(db, 'a'); // rank 1
    expect(board.neighbors.map((r) => r.uid)).toEqual(['a', 'b', 'c']);
    expect(board.me?.rank).toBe(1);
  });

  it('a caller with no XP still gets an on-ramp (bottom of the board), not an empty panel', async () => {
    for (const [u, p] of [['a', 30], ['b', 20]] as [string, number][]) await grant(u, p);
    const board = await computeLeaderboard(db, 'newcomer');
    expect(board.me).toBeNull();
    expect(board.neighbors.length).toBeGreaterThan(0);
  });

  it('omits leaders by default, and the opt-in returns ONLY the celebratory top (never the bottom)', async () => {
    const people: [string, number][] = [
      ['a', 70], ['b', 60], ['c', 50], ['d', 40], ['e', 30], ['f', 20], ['g', 10],
    ];
    for (const [u, p] of people) await grant(u, p);

    // Default: no full-board data leaks.
    const neighborsOnly = await computeLeaderboard(db, 'g');
    expect(neighborsOnly.leaders).toBeUndefined();

    // Opt-in: the top 5 only — the lowest-ranked members (f, g) are never listed.
    const withTop = await computeLeaderboard(db, 'g', { includeTop: true });
    expect(withTop.leaders?.map((r) => r.uid)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(withTop.leaders?.some((r) => r.uid === 'g')).toBe(false);
  });
});
