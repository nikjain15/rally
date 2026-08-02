/**
 * Performance at cohort scale (Testing regime D). Seeds SYNTHETIC data only — ~65 users,
 * three channels, a few thousand messages, a ledger — then measures the operations that run on
 * a real page load: the open-channel message query, the Brief gather, and the leaderboard
 * compute. Bounds are generous (emulator, cold) and exist to catch a regression into
 * accidental O(n²) or an unindexed scan, not to benchmark hardware. Measured ms are logged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '@/lib/admin';
import { gatherBriefInput } from '@/lib/brief-admin';
import {
  computeLeaderboard,
  LEADERBOARD_BUDGET_LEDGER_EVENTS,
  LEADERBOARD_P95_BUDGET_MS,
} from '@/lib/leaderboard-admin';
import { clearFirestore } from './helpers';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

let db: Firestore;
const USERS = 65;
const MESSAGES_PER_CHANNEL = 700; // ~2,100 total across 3 channels
const CHANNELS = ['general', 'help', 'wins'];

function uid(i: number): string {
  return `perf_u${i}`;
}

beforeAll(async () => {
  const got = adminDb();
  if (!got) throw new Error('admin db unavailable');
  db = got;
  await clearFirestore();

  const members = Array.from({ length: USERS }, (_, i) => uid(i));

  // Profiles.
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0) await batch.commit();
    batch = db.batch();
    ops = 0;
  };
  const add = async (ref: FirebaseFirestore.DocumentReference, data: Record<string, unknown>) => {
    batch.set(ref, data);
    if (++ops >= 400) await flush();
  };

  for (let i = 0; i < USERS; i++) {
    await add(db.collection('profiles').doc(uid(i)), {
      uid: uid(i), handle: `gh_${i}`, displayName: `Member ${i}`, avatarUrl: null,
      githubLogin: `gh_${i}`, createdAt: FieldValue.serverTimestamp(),
    });
  }
  // Channels — everyone a member.
  for (const slug of CHANNELS) {
    await add(db.collection('channels').doc(slug), {
      slug, name: slug, kind: 'channel', isPrivate: false, creatorUid: uid(0),
      memberUids: members, createdAt: FieldValue.serverTimestamp(),
    });
  }
  // Messages.
  for (const slug of CHANNELS) {
    for (let m = 0; m < MESSAGES_PER_CHANNEL; m++) {
      await add(db.collection('channels').doc(slug).collection('messages').doc(), {
        authorUid: uid(m % USERS), body: `msg ${m} in ${slug}`, parentId: null,
        createdAt: FieldValue.serverTimestamp(), editedAt: null,
      });
    }
  }
  // Ledger — a spread of XP so the leaderboard has real ranking work.
  for (let i = 0; i < USERS; i++) {
    for (let e = 0; e < 3; e++) {
      await add(db.collection('xpEvents').doc(`perf_xp_${i}_${e}`), {
        profileUid: uid(i), source: 'test', refId: `r${e}`, points: (i % 7) + 1,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }
  await flush();
}, 120_000);

afterAll(async () => {
  await clearFirestore();
});

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const out = await fn();
  return [out, Date.now() - start];
}

/** Nearest-rank p95 over a sorted sample. A single timing is weather; p95 is the budget. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

describe('cohort-scale performance (synthetic data)', () => {
  it('loads the open channel (latest 200 messages) quickly', async () => {
    const [snap, ms] = await timed(() =>
      db.collection('channels').doc('general').collection('messages')
        .orderBy('createdAt', 'desc').limit(200).get(),
    );
    console.log(`[perf] channel load (200 of ${MESSAGES_PER_CHANNEL}): ${ms}ms, ${snap.size} docs`);
    expect(snap.size).toBe(200);
    expect(ms).toBeLessThan(3000);
  });

  it('builds a Brief across 3 busy channels quickly', async () => {
    const [input, ms] = await timed(() => gatherBriefInput(db, uid(5), Date.now()));
    console.log(`[perf] brief gather: ${ms}ms, unread=${JSON.stringify(input.unreadChannels)}`);
    expect(ms).toBeLessThan(6000);
  });

  it('computes the neighbors leaderboard over 65 members quickly', async () => {
    const [board, ms] = await timed(() => computeLeaderboard(db, uid(30)));
    console.log(`[perf] leaderboard compute (${board.participants} members): ${ms}ms, teamTotal=${board.teamTotal}`);
    expect(board.participants).toBe(USERS);
    expect(board.neighbors.length).toBeLessThanOrEqual(5);
    expect(ms).toBeLessThan(3000);
  });
});

/**
 * The stated p95 budget for the full-ledger scan (finding GEN1).
 *
 * DL-2 defended the scan and AS-3 admitted it is O(all events ever), but neither wrote a number
 * down, which made the admission unfalsifiable: no run could violate it. This block is the
 * enforcer. It grows the ledger to LEADERBOARD_BUDGET_LEDGER_EVENTS, the size the budget is
 * claimed to hold at, and measures p95 across repeated calls rather than trusting one timing.
 *
 * Deliberately measured at the CLAIMED ceiling, not at today's 195 events. A budget verified only
 * at the scale that hides the problem is the exact failure AS-3 names, and re-running it there
 * would be theatre.
 */
describe('leaderboard p95 budget at the claimed ledger ceiling', () => {
  const RUNS = 12;

  beforeAll(async () => {
    const existing = (await db.collection('xpEvents').count().get()).data().count;
    let batch = db.batch();
    let ops = 0;
    for (let i = existing; i < LEADERBOARD_BUDGET_LEDGER_EVENTS; i++) {
      batch.set(db.collection('xpEvents').doc(`budget_xp_${i}`), {
        profileUid: uid(i % USERS), source: 'test', refId: `b${i}`, points: (i % 5) + 1,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (++ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  }, 300_000);

  it(`holds p95 under ${LEADERBOARD_P95_BUDGET_MS}ms with ${LEADERBOARD_BUDGET_LEDGER_EVENTS} ledger events`, async () => {
    const size = (await db.collection('xpEvents').count().get()).data().count;
    expect(size).toBeGreaterThanOrEqual(LEADERBOARD_BUDGET_LEDGER_EVENTS);

    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const [, ms] = await timed(() => computeLeaderboard(db, uid(30)));
      samples.push(ms);
    }
    const worst = Math.max(...samples);
    console.log(
      `[perf] leaderboard over ${size} events, ${RUNS} runs: p95=${p95(samples)}ms max=${worst}ms budget=${LEADERBOARD_P95_BUDGET_MS}ms ` +
        `(${((p95(samples) / size) * 1000).toFixed(3)}ms per 1k events)`,
    );
    // When this fails, the scan has outgrown its defence and the materialised rollup described in
    // lib/leaderboard-admin.ts is the work. That is the whole purpose of putting a number here.
    expect(p95(samples)).toBeLessThan(LEADERBOARD_P95_BUDGET_MS);
  }, 180_000);

  it('still returns the right answer at that scale, not just the right latency', async () => {
    // A budget test that only timed things would pass on a scan that had quietly stopped summing.
    const board = await computeLeaderboard(db, uid(30), { includeTop: true });
    expect(board.participants).toBe(USERS);
    expect(board.teamTotal).toBeGreaterThan(LEADERBOARD_BUDGET_LEDGER_EVENTS); // >=1 point per event
    expect(board.me).not.toBeNull();
    expect(board.leaders!.length).toBeLessThanOrEqual(5);
    // The kindness rule still holds at scale: the full ordering never leaves the server.
    expect(board.neighbors.length).toBeLessThanOrEqual(5);
  }, 60_000);
});
