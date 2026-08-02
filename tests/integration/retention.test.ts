import { beforeEach, describe, expect, it } from 'vitest';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/admin';
import { confirmRecognition, suggestRecognition } from '@/lib/recognition-admin';
import { eraseMember, isTombstone, RETENTION, sweepRetention } from '@/lib/retention';
import { computeLeaderboard } from '@/lib/leaderboard-admin';
import { clearFirestore } from './helpers';

/**
 * Retention and erasure against the real emulator (finding SH9).
 *
 * The point of these tests is that the policy in lib/retention.ts is ENFORCED, not written down.
 * Each one seeds documents on both sides of a window and asserts the sweep took exactly the old
 * ones, and the erasure tests assert both what disappears and what deliberately survives: the
 * append-only ledger keeps its arithmetic while losing the person.
 */

let db: Firestore;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-02T00:00:00Z');

function ago(days: number): Timestamp {
  return Timestamp.fromMillis(NOW - days * DAY);
}

beforeEach(async () => {
  const got = adminDb();
  if (!got) throw new Error('admin db unavailable');
  db = got;
  await clearFirestore();
});

describe('retention sweep', () => {
  it('deletes channel messages past the window and keeps the ones inside it', async () => {
    const ch = db.collection('channels').doc('general');
    await ch.set({ slug: 'general', name: 'general', kind: 'channel', isPrivate: false, memberUids: ['a'] });
    const old = RETENTION.messages.days! + 5;
    await ch.collection('messages').doc('old').set({ authorUid: 'a', body: 'ancient', createdAt: ago(old) });
    await ch.collection('messages').doc('recent').set({ authorUid: 'a', body: 'fresh', createdAt: ago(1) });

    const report = await sweepRetention(db, NOW);

    expect(report.deleted.messages).toBe(1);
    expect((await ch.collection('messages').doc('old').get()).exists).toBe(false);
    expect((await ch.collection('messages').doc('recent').get()).exists).toBe(true);
  });

  it('ages out pulse events and stale pair-award history', async () => {
    await db.collection('pulseEvents').doc('old').set({ actorUid: 'a', verb: 'x', createdAt: ago(200) });
    await db.collection('pulseEvents').doc('new').set({ actorUid: 'a', verb: 'x', createdAt: ago(2) });
    await db.collection('recognitionPairs').doc('a__b').set({ helperUid: 'a', helpedUid: 'b', awardedAt: [], updatedAt: ago(30) });
    await db.collection('recognitionPairs').doc('c__d').set({ helperUid: 'c', helpedUid: 'd', awardedAt: [], updatedAt: ago(1) });

    const report = await sweepRetention(db, NOW);

    expect(report.deleted.pulseEvents).toBe(1);
    expect(report.deleted.recognitionPairs).toBe(1);
    expect((await db.collection('recognitionPairs').doc('c__d').get()).exists).toBe(true);
  });

  it('expires an unconfirmed suggestion but never a confirmed one', async () => {
    // A confirmed recognition is the provenance of a ledger row. Deleting it would leave XP that
    // nothing explains, which is exactly the audit trail the anti-gaming design rests on.
    const old = RETENTION.recognitionsUnresolved.days! + 5;
    await db.collection('recognitions').doc('stale').set({ helperUid: 'h', helpedUid: 'p', status: 'suggested', kind: 'answered', points: 8, createdAt: ago(old) });
    await db.collection('recognitions').doc('refused').set({ helperUid: 'h', helpedUid: 'p', status: 'declined', kind: 'answered', points: 8, createdAt: ago(old) });
    await db.collection('recognitions').doc('done').set({ helperUid: 'h', helpedUid: 'p', status: 'confirmed', kind: 'answered', points: 8, createdAt: ago(old) });

    await sweepRetention(db, NOW);

    expect((await db.collection('recognitions').doc('stale').get()).exists).toBe(false);
    expect((await db.collection('recognitions').doc('refused').get()).exists).toBe(false);
    expect((await db.collection('recognitions').doc('done').get()).exists).toBe(true);
  });

  it('NEVER deletes from the append-only XP ledger, however old the row', async () => {
    await db.collection('xpEvents').doc('ancient').set({ profileUid: 'a', source: 'test', points: 10, createdAt: ago(5000) });

    const report = await sweepRetention(db, NOW);

    expect(report.deleted.xpEvents).toBeUndefined();
    expect((await db.collection('xpEvents').doc('ancient').get()).exists).toBe(true);
  });

  it('ages out assistant threads and memory, the most personal store Rally has', async () => {
    const thread = db.collection('assistantThreads').doc('u1');
    await thread.set({ uid: 'u1' });
    await thread.collection('messages').doc('old').set({ role: 'user', body: 'private', createdAt: ago(200) });
    await thread.collection('messages').doc('new').set({ role: 'user', body: 'recent', createdAt: ago(3) });
    await db.collection('assistantMemory').doc('u1').set({ facts: ['x'], updatedAt: ago(400) });

    const report = await sweepRetention(db, NOW);

    expect(report.deleted.assistantMessages).toBe(1);
    expect(report.deleted.assistantMemory).toBe(1);
    expect((await thread.collection('messages').doc('new').get()).exists).toBe(true);
  });

  it('is idempotent: a second sweep over swept data deletes nothing', async () => {
    await db.collection('pulseEvents').doc('old').set({ actorUid: 'a', verb: 'x', createdAt: ago(200) });
    await sweepRetention(db, NOW);
    const second = await sweepRetention(db, NOW);
    expect(second.total).toBe(0);
  });

  it('stops at its per-run budget and reports the run as truncated', async () => {
    const batch = db.batch();
    for (let i = 0; i < 6; i++) {
      batch.set(db.collection('pulseEvents').doc(`p${i}`), { actorUid: 'a', verb: 'x', createdAt: ago(200) });
    }
    await batch.commit();

    const report = await sweepRetention(db, NOW, 3);

    expect(report.total).toBe(3);
    expect(report.truncated).toBe(true);
    expect((await db.collection('pulseEvents').get()).size).toBe(3);
  });
});

describe('member erasure', () => {
  it('removes the member’s identity, own messages, reads, commitments, quests and assistant data', async () => {
    const ch = db.collection('channels').doc('general');
    await ch.set({ slug: 'general', name: 'general', kind: 'channel', isPrivate: false, memberUids: ['gone', 'stays'] });
    await ch.collection('messages').doc('mine').set({ authorUid: 'gone', body: 'my words', createdAt: ago(1) });
    await ch.collection('messages').doc('theirs').set({ authorUid: 'stays', body: 'thanks @gone', createdAt: ago(1) });
    await ch.collection('reads').doc('gone').set({ lastReadAt: ago(1) });
    await db.collection('profiles').doc('gone').set({ uid: 'gone', handle: 'gone', displayName: 'Gone' });
    await db.collection('commitments').doc('c1').set({ authorUid: 'gone', title: 'x', createdAt: ago(1) });
    await db.collection('quests').doc('q1').set({ profileUid: 'gone', kind: 'recognize' });
    await db.collection('assistantMemory').doc('gone').set({ facts: ['personal'], updatedAt: ago(1) });
    await db.collection('assistantThreads').doc('gone').collection('messages').doc('m').set({ role: 'user', body: 'private', createdAt: ago(1) });

    const report = await eraseMember(db, 'gone');

    expect((await db.collection('profiles').doc('gone').get()).exists).toBe(false);
    expect((await ch.collection('messages').doc('mine').get()).exists).toBe(false);
    expect((await ch.collection('reads').doc('gone').get()).exists).toBe(false);
    expect((await db.collection('commitments').doc('c1').get()).exists).toBe(false);
    expect((await db.collection('quests').doc('q1').get()).exists).toBe(false);
    expect((await db.collection('assistantMemory').doc('gone').get()).exists).toBe(false);
    expect((await db.collection('assistantThreads').doc('gone').collection('messages').get()).size).toBe(0);
    expect(report.deleted.messages).toBe(1);
  });

  it("does NOT rewrite another member's sentence that names the erased person", async () => {
    // The documented limit, asserted rather than asserted-in-prose. Ana's message is Ana's.
    const ch = db.collection('channels').doc('general');
    await ch.set({ slug: 'general', name: 'general', kind: 'channel', isPrivate: false, memberUids: ['gone', 'stays'] });
    await ch.collection('messages').doc('theirs').set({ authorUid: 'stays', body: 'thanks @gone for the review', createdAt: ago(1) });

    const report = await eraseMember(db, 'gone');

    const kept = await ch.collection('messages').doc('theirs').get();
    expect(kept.exists).toBe(true);
    expect(kept.data()!.body).toBe('thanks @gone for the review');
    expect(report.limits.join(' ')).toContain('OTHER members');
  });

  it("strips the erased member's reactions from other people's messages, leaving the message intact", async () => {
    const ch = db.collection('channels').doc('general');
    await ch.set({ slug: 'general', name: 'general', kind: 'channel', isPrivate: false, memberUids: ['gone', 'stays'] });
    await ch.collection('messages').doc('theirs').set({
      authorUid: 'stays', body: 'shipped it', createdAt: ago(1),
      reactions: { gone: '🎉', stays: '🚀' },
    });

    const report = await eraseMember(db, 'gone');

    const after = (await ch.collection('messages').doc('theirs').get()).data()!;
    expect(after.reactions).toEqual({ stays: '🚀' });
    expect(after.body).toBe('shipped it');
    expect(report.deleted.reactions).toBe(1);
  });

  it('keeps the ledger rows but re-keys them to an unlinkable tombstone', async () => {
    await db.collection('xpEvents').doc('x1').set({ profileUid: 'gone', source: 'recognition', points: 12, createdAt: ago(1) });
    await db.collection('pulseEvents').doc('p1').set({ actorUid: 'gone', verb: 'recognition_confirmed', object: 'stays', points: 12, createdAt: ago(1) });

    const report = await eraseMember(db, 'gone');

    const xp = (await db.collection('xpEvents').doc('x1').get()).data()!;
    expect(xp.points).toBe(12); // the arithmetic survives
    expect(xp.profileUid).not.toBe('gone'); // the person does not
    expect(isTombstone(xp.profileUid)).toBe(true);
    expect(xp.profileUid).toBe(report.tombstone);
    expect((await db.collection('pulseEvents').doc('p1').get()).data()!.actorUid).toBe(report.tombstone);
    expect(report.rekeyed.xpEvents).toBe(1);
  });

  it('mints a fresh tombstone per erasure, so two erased members are not linkable to each other', async () => {
    await db.collection('xpEvents').doc('a').set({ profileUid: 'ua', source: 't', points: 1, createdAt: ago(1) });
    await db.collection('xpEvents').doc('b').set({ profileUid: 'ub', source: 't', points: 1, createdAt: ago(1) });

    const first = await eraseMember(db, 'ua');
    const second = await eraseMember(db, 'ub');

    expect(first.tombstone).not.toBe(second.tombstone);
  });

  it('leaves the team total unchanged, which is the reason the ledger is re-keyed and not deleted', async () => {
    await db.collection('xpEvents').doc('x1').set({ profileUid: 'gone', source: 't', points: 12, createdAt: ago(1) });
    await db.collection('xpEvents').doc('x2').set({ profileUid: 'stays', source: 't', points: 8, createdAt: ago(1) });

    const before = await computeLeaderboard(db, 'stays');
    await eraseMember(db, 'gone');
    const after = await computeLeaderboard(db, 'stays');

    expect(after.teamTotal).toBe(before.teamTotal);
    expect(after.participants).toBe(before.participants);
    // And the honest cost of that choice, asserted: a participant nobody can name.
    expect(after.neighbors.some((n) => isTombstone(n.uid))).toBe(true);
  });

  it('removes recognitions from every side that could name the person', async () => {
    await db.collection('recognitions').doc('r1').set({ helperUid: 'gone', helpedUid: 'other', authorUid: 'other', status: 'confirmed', kind: 'answered', points: 8, createdAt: ago(1) });
    await db.collection('recognitions').doc('r2').set({ helperUid: 'other', helpedUid: 'gone', authorUid: 'gone', status: 'suggested', kind: 'answered', points: 8, createdAt: ago(1) });
    await db.collection('recognitionPairs').doc('gone__other').set({ helperUid: 'gone', helpedUid: 'other', awardedAt: [NOW], updatedAt: ago(0) });

    await eraseMember(db, 'gone');

    expect((await db.collection('recognitions').get()).size).toBe(0);
    expect((await db.collection('recognitionPairs').get()).size).toBe(0);
  });

  it('is idempotent: erasing twice is safe and the second run finds nothing', async () => {
    await db.collection('profiles').doc('gone').set({ uid: 'gone', handle: 'gone', displayName: 'Gone' });
    await eraseMember(db, 'gone');
    const second = await eraseMember(db, 'gone');
    expect(Object.values(second.deleted).reduce((a, b) => a + b, 0)).toBe(0);
    expect(Object.values(second.rekeyed).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('does not touch anyone else while erasing one member', async () => {
    const ch = db.collection('channels').doc('general');
    await ch.set({ slug: 'general', name: 'general', kind: 'channel', isPrivate: false, memberUids: ['gone', 'stays'] });
    await ch.collection('messages').doc('theirs').set({ authorUid: 'stays', body: 'hi', createdAt: ago(1) });
    await ch.collection('reads').doc('stays').set({ lastReadAt: ago(1) });
    await db.collection('profiles').doc('stays').set({ uid: 'stays', handle: 'stays', displayName: 'Stays' });
    await db.collection('commitments').doc('c2').set({ authorUid: 'stays', title: 'y', createdAt: ago(1) });

    await eraseMember(db, 'gone');

    expect((await db.collection('profiles').doc('stays').get()).exists).toBe(true);
    expect((await ch.collection('messages').doc('theirs').get()).exists).toBe(true);
    expect((await ch.collection('reads').doc('stays').get()).exists).toBe(true);
    expect((await db.collection('commitments').doc('c2').get()).exists).toBe(true);
  });

  it('erases a member whose data was created by the real recognition path, not a fixture', async () => {
    // End to end through the code that actually writes points, so the erasure is proven against
    // the shape confirmRecognition produces rather than a hand-built approximation of it.
    const id = await suggestRecognition(db, {
      helperUid: 'helper', helpedUid: 'gone', authorUid: 'gone', sourceMsgRef: 'general/m1', kind: 'unblocked',
    });
    expect(id).toBeTruthy();
    const res = await confirmRecognition(db, id!, 'gone', NOW);
    expect(res.ok).toBe(true);

    await eraseMember(db, 'gone');

    expect((await db.collection('recognitions').get()).size).toBe(0);
    expect((await db.collection('recognitionPairs').get()).size).toBe(0);
    // The helper's earned XP survives: it is their record, not the erased member's.
    const xp = await db.collection('xpEvents').get();
    expect(xp.size).toBe(1);
    expect(xp.docs[0].data().profileUid).toBe('helper');
  });
});
