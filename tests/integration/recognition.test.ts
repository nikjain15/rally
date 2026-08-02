/**
 * The recognition ledger against a real Firestore (Admin SDK on the emulator) — the whole
 * motivation engine's integrity, asserted. These are the tests that prove the game is fair:
 * XP is awarded only on the helped peer's confirm, exactly once, never to oneself, and the
 * total is a reduction over the append-only ledger — not a mutable counter anyone can bump.
 *
 * The last group is finding D-P0-3: the ledger being honest was never enough on its own, because
 * two people could take turns thanking each other and every message was a fresh award. Those
 * tests are the economy's boundary, and the ones above them are the genuine path that must keep
 * working through it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminDb } from '@/lib/admin';
import {
  PAIR_AWARD_CAP,
  PAIR_WINDOW_MS,
  confirmRecognition,
  declineRecognition,
  pointsFor,
  suggestRecognition,
} from '@/lib/recognition-admin';
import { clearFirestore } from './helpers';
import type { Firestore } from 'firebase-admin/firestore';

let db: Firestore;

beforeEach(async () => {
  const got = adminDb();
  if (!got) throw new Error('admin db unavailable — FIRESTORE_EMULATOR_HOST not set?');
  db = got;
  await clearFirestore();
});
afterEach(async () => {
  await clearFirestore();
});

const HELPER = 'uid_helper';
const HELPED = 'uid_helped';
const WITNESS = 'uid_witness';

async function xpTotal(uid: string): Promise<number> {
  const snap = await db.collection('xpEvents').where('profileUid', '==', uid).get();
  return snap.docs.reduce((s, d) => s + (d.data().points ?? 0), 0);
}

async function seedSuggestion(kind = 'unblocked', over: Record<string, string> = {}): Promise<string> {
  const id = await suggestRecognition(db, {
    helperUid: HELPER,
    helpedUid: HELPED,
    sourceMsgRef: 'channels/general/messages/m1',
    kind,
    ...over,
  });
  if (!id) throw new Error('suggestion not created');
  return id;
}

describe('confirm awards XP through the ledger', () => {
  it('the helped peer confirming awards the helper', async () => {
    const id = await seedSuggestion('unblocked');
    const res = await confirmRecognition(db, id, HELPED);
    expect(res).toMatchObject({ ok: true, awarded: 12, alreadyDone: false, capped: false });
    expect(await xpTotal(HELPER)).toBe(12);
    // …and nothing to the person who wrote the thanks, because writing it is not helping.
    expect(await xpTotal(HELPED)).toBe(0);

    // …and a pulse event announced it.
    const pulse = await db.collection('pulseEvents').get();
    expect(pulse.size).toBe(1);
    expect(pulse.docs[0].data()).toMatchObject({ actorUid: HELPER, verb: 'recognition_confirmed', points: 12 });
  });

  it('is idempotent — a double confirm awards exactly once', async () => {
    const id = await seedSuggestion('answered');
    await confirmRecognition(db, id, HELPED);
    const second = await confirmRecognition(db, id, HELPED);
    expect(second).toMatchObject({ ok: true, alreadyDone: true });
    expect(await xpTotal(HELPER)).toBe(8); // not 16
  });

  it('a retried confirm does not consume a second slot of the pair allowance', async () => {
    const id = await seedSuggestion('answered');
    await confirmRecognition(db, id, HELPED);
    await confirmRecognition(db, id, HELPED);
    await confirmRecognition(db, id, HELPED);
    const pair = await db.collection('recognitionPairs').get();
    expect(pair.size).toBe(1);
    expect(pair.docs[0].data().awardedAt).toHaveLength(1);
  });

  it('thanks the confirmer when someone ELSE wrote the message crediting the helper', async () => {
    // A witness posts "@helper unblocked @helped". Confirming is then a genuinely separate act
    // by a second person, so closing the loop is worth the small thank-you.
    const id = await seedSuggestion('unblocked', { authorUid: WITNESS });
    const res = await confirmRecognition(db, id, HELPED);
    expect(res).toMatchObject({ ok: true, awarded: 12 });
    expect(await xpTotal(HELPED)).toBe(2);
  });
});

describe('the game cannot be gamed', () => {
  it('the helper cannot confirm their own recognition (self-award)', async () => {
    const id = await seedSuggestion();
    const res = await confirmRecognition(db, id, HELPER);
    expect(res).toMatchObject({ ok: false, reason: 'not_helped_peer' });
    expect(await xpTotal(HELPER)).toBe(0);
  });

  it('a bystander cannot confirm a recognition that is not about them', async () => {
    const id = await seedSuggestion();
    const res = await confirmRecognition(db, id, 'uid_bystander');
    expect(res).toMatchObject({ ok: false, reason: 'not_helped_peer' });
    expect(await xpTotal(HELPER)).toBe(0);
  });

  it('you get no credit for helping yourself (suggestion refused)', async () => {
    const id = await suggestRecognition(db, {
      helperUid: HELPER,
      helpedUid: HELPER,
      sourceMsgRef: 'channels/general/messages/m2',
      kind: 'answered',
    });
    expect(id).toBeNull();
  });

  it('detection re-running on the same message does not duplicate the suggestion', async () => {
    const a = await seedSuggestion('answered');
    const b = await suggestRecognition(db, {
      helperUid: HELPER,
      helpedUid: HELPED,
      sourceMsgRef: 'channels/general/messages/m1',
      kind: 'answered',
    });
    expect(b).toBeNull(); // same (helper, helped, ref) → deduped
    expect(a).toBeTruthy();
  });
});

/* ==========================================================================
 * finding D-P0-3 — a cooperating pair cannot farm the ledger
 * ========================================================================== */
describe('the economy is bounded per pair, per window', () => {
  /** One round of the farm: a fresh message thanking the helper, confirmed by its own author. */
  async function farmOnce(n: number, now: number): Promise<number> {
    const id = await suggestRecognition(db, {
      helperUid: HELPER,
      helpedUid: HELPED,
      sourceMsgRef: `channels/general/messages/farm${n}`,
      kind: 'unblocked',
    });
    if (!id) throw new Error('suggestion not created');
    const res = await confirmRecognition(db, id, HELPED, now);
    return res.ok ? res.awarded : 0;
  }

  it('pays three genuine thank-yous a day between two people in full', async () => {
    expect(PAIR_AWARD_CAP).toBe(3); // the promise this test states, in the code
    const now = Date.now();
    expect(await farmOnce(0, now)).toBe(12);
    expect(await farmOnce(1, now + 1)).toBe(12);
    expect(await farmOnce(2, now + 2)).toBe(12);
    expect(await xpTotal(HELPER)).toBe(36);
  });

  it('writing a new message every time cannot mint unbounded points', async () => {
    const now = Date.now();
    for (let i = 0; i < 40; i++) await farmOnce(i, now + i);
    // Forty fresh messages, forty confirms, and the total stops at the day's allowance.
    expect(await xpTotal(HELPER)).toBe(PAIR_AWARD_CAP * pointsFor('unblocked'));
    expect(await xpTotal(HELPED)).toBe(0);
  });

  it('the thank-you still lands publicly after the points stop', async () => {
    const now = Date.now();
    for (let i = 0; i <= PAIR_AWARD_CAP; i++) await farmOnce(i, now + i);
    // Every confirm is recorded and announced; only the XP saturates.
    const recs = await db.collection('recognitions').where('status', '==', 'confirmed').get();
    expect(recs.size).toBe(PAIR_AWARD_CAP + 1);
    const pulse = await db.collection('pulseEvents').get();
    expect(pulse.size).toBe(PAIR_AWARD_CAP + 1);
    const capped = pulse.docs.filter((d) => d.data().points === 0);
    expect(capped).toHaveLength(1);
  });

  it('reports the capped award honestly rather than pretending it paid', async () => {
    const now = Date.now();
    for (let i = 0; i < PAIR_AWARD_CAP; i++) await farmOnce(i, now + i);
    const id = await suggestRecognition(db, {
      helperUid: HELPER,
      helpedUid: HELPED,
      sourceMsgRef: 'channels/general/messages/over',
      kind: 'unblocked',
    });
    const res = await confirmRecognition(db, id!, HELPED, now + 99);
    expect(res).toMatchObject({ ok: true, awarded: 0, capped: true });
    const xp = await db.collection('xpEvents').doc(`xp_help_${id}`).get();
    expect(xp.data()).toMatchObject({ points: 0, capped: true });
  });

  it('gives the pair their allowance back once the window has rolled over', async () => {
    const now = Date.now();
    for (let i = 0; i < PAIR_AWARD_CAP; i++) await farmOnce(i, now + i);
    expect(await farmOnce(90, now + 100)).toBe(0);
    // A day later, two people who really do keep helping each other are paid again.
    expect(await farmOnce(91, now + PAIR_WINDOW_MS + 1000)).toBe(pointsFor('unblocked'));
  });

  it('caps each direction of credit separately, so helping back is never punished', async () => {
    const now = Date.now();
    for (let i = 0; i < PAIR_AWARD_CAP + 1; i++) await farmOnce(i, now + i);
    // HELPED has exhausted what they can pay HELPER today. The reverse direction is untouched:
    // if HELPED genuinely unblocks HELPER, that recognition still pays in full.
    const back = await suggestRecognition(db, {
      helperUid: HELPED,
      helpedUid: HELPER,
      sourceMsgRef: 'channels/general/messages/back1',
      kind: 'unblocked',
    });
    const res = await confirmRecognition(db, back!, HELPER, now + 200);
    expect(res).toMatchObject({ ok: true, awarded: 12, capped: false });
  });

  it('bounds the whole reciprocal loop: two farmers cannot outrun the day', async () => {
    const now = Date.now();
    for (let i = 0; i < 25; i++) await farmOnce(i, now + i);
    for (let i = 0; i < 25; i++) {
      const id = await suggestRecognition(db, {
        helperUid: HELPED,
        helpedUid: HELPER,
        sourceMsgRef: `channels/general/messages/rev${i}`,
        kind: 'unblocked',
      });
      if (id) await confirmRecognition(db, id, HELPER, now + 500 + i);
    }
    const ceiling = PAIR_AWARD_CAP * pointsFor('unblocked');
    expect(await xpTotal(HELPER)).toBe(ceiling);
    expect(await xpTotal(HELPED)).toBe(ceiling);
  });
});

describe('decline closes quietly', () => {
  it('declining awards nothing and posts no pulse', async () => {
    const id = await seedSuggestion();
    const res = await declineRecognition(db, id, HELPED);
    expect(res).toMatchObject({ ok: true });
    expect(await xpTotal(HELPER)).toBe(0);
    expect((await db.collection('pulseEvents').get()).size).toBe(0);
    // A declined recognition can no longer be confirmed into points.
    const after = await confirmRecognition(db, id, HELPED);
    expect(after).toMatchObject({ ok: false, reason: 'declined' });
  });
});
