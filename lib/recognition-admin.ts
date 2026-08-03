import { FieldValue, type Firestore } from 'firebase-admin/firestore';

/**
 * The recognition ledger — Rally's motivation engine, server-side.
 *
 * The whole product promise ("the game lifts people, never punishes them; it can't be gamed")
 * lives or dies here. Rules make points client-unwritable; this module is the only thing that
 * legitimately writes them, and it does so ONLY when the *helped* peer confirms. Five
 * invariants it must never break:
 *   1. You cannot award yourself — a helper can't confirm their own recognition.
 *   2. Points are set by the server from the kind, never taken from client input.
 *   3. Confirm is idempotent — a double POST (two tabs, a retry) awards XP exactly once.
 *   4. Writing your own thanks earns you nothing. The author of the source message is the
 *      helped peer, so confirming your own "thanks @bob" is one person doing both halves of
 *      the loop; that act pays the confirmer zero (finding D-P0-3).
 *   5. One helper can earn points from the same helped peer at most PAIR_AWARD_CAP times per
 *      rolling PAIR_WINDOW_MS. Past that the recognition still lands — status, pulse, feed —
 *      it is simply worth zero. Gratitude is uncapped; the economy is not.
 * XP is written to the append-only `xpEvents` ledger; rank/reputation are computed from it,
 * never stored as a mutable total.
 */

export type RecognitionKind = 'answered' | 'unblocked' | 'reviewed' | 'paired';

/** Points per kind — the server's schedule, deliberately small and generosity-weighted. */
const POINTS: Record<RecognitionKind, number> = {
  answered: 8,
  unblocked: 12,
  reviewed: 10,
  paired: 10,
};

/**
 * A small thank-you to the person who confirmed — receiving help and closing the loop counts.
 * Paid ONLY when the confirmer did not write the message the recognition came from. Today the
 * detector makes the author the helped peer, so in practice this is zero: you are not paid for
 * typing "thanks @bob" and then clicking confirm on your own sentence. It stays in the schedule
 * for the flow where someone else credits you (a third party writing "@bob unblocked @ana"),
 * where closing the loop really is a separate act.
 */
const CONFIRM_THANKS = 2;

/**
 * The economy guard. One helper can bank points from the same helped peer this many times per
 * rolling window; beyond that the recognition still confirms and still posts to the pulse feed,
 * it is just worth zero XP.
 *
 * Three a day, per direction, is set well above genuine behaviour on purpose. The pair who
 * really do pair all day still get paid for the first three each way and lose nothing socially
 * after that, while a farming loop flattens to a constant instead of growing with message count.
 */
export const PAIR_AWARD_CAP = 3;
export const PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

export function pointsFor(kind: string): number {
  return POINTS[(kind as RecognitionKind)] ?? POINTS.answered;
}

/** Doc id for the per-direction award history. Ordered: credit flowing helper ← helped. */
export function pairKey(helperUid: string, helpedUid: string): string {
  return `${helperUid}__${helpedUid}`;
}

/** The award timestamps still inside the rolling window, oldest first. Pure, so it is unit-testable. */
export function awardsInWindow(times: number[], now: number, windowMs = PAIR_WINDOW_MS): number[] {
  return times.filter((t) => typeof t === 'number' && t > now - windowMs && t <= now).sort((a, b) => a - b);
}

/** True when this pair has already banked its allowance for the window — the next award is worth zero. */
export function pairCapReached(
  times: number[],
  now: number,
  cap = PAIR_AWARD_CAP,
  windowMs = PAIR_WINDOW_MS,
): boolean {
  return awardsInWindow(times, now, windowMs).length >= cap;
}

/**
 * Create a *suggested* recognition (server-only; clients can't). Detection calls this. Never
 * awards anything — a suggestion is an invitation to the helped peer, not a fait accompli.
 * Deduped by (helper, helped, sourceMsgRef) so re-running detection on the same message can't
 * spawn duplicate suggestions.
 *
 * `authorUid` records who actually wrote the source message. It defaults to the helped peer,
 * which is what today's detector always produces, and it is what lets confirm tell "someone
 * else credited you" apart from "you credited someone and then confirmed yourself".
 */
export async function suggestRecognition(
  db: Firestore,
  input: { helperUid: string; helpedUid: string; sourceMsgRef: string; kind: string; authorUid?: string },
): Promise<string | null> {
  if (input.helperUid === input.helpedUid) return null; // you don't get credit for helping yourself
  const kind = (input.kind as RecognitionKind) in POINTS ? (input.kind as RecognitionKind) : 'answered';
  const dedupeId = `sug_${input.helperUid}_${input.helpedUid}_${hash(input.sourceMsgRef)}`;
  const ref = db.collection('recognitions').doc(dedupeId);
  const created = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      helperUid: input.helperUid,
      helpedUid: input.helpedUid,
      authorUid: input.authorUid ?? input.helpedUid,
      sourceMsgRef: input.sourceMsgRef,
      kind,
      status: 'suggested',
      points: pointsFor(kind),
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  return created ? dedupeId : null;
}

export type ConfirmResult =
  | { ok: true; awarded: number; alreadyDone: boolean; capped: boolean }
  | { ok: false; reason: 'not_found' | 'not_helped_peer' | 'self_award' | 'declined' };

/**
 * Confirm a recognition as the helped peer. Awards XP to the helper, appends a pulse event, and
 * flips status — all in one transaction so a retry can't double-award. `actingUid` is the
 * authenticated caller (verified by the route); `now` is injectable so the rolling window is
 * testable without sleeping.
 *
 * Two economy guards run here, and neither can refuse the recognition itself:
 *   - the confirmer earns CONFIRM_THANKS only if they did not write the source message;
 *   - the helper earns the kind's points only if this pair is under its rolling-window cap.
 * A capped confirm still writes the ledger row (points 0, `capped: true`) and still posts the
 * pulse, so the record stays complete and the thank-you still reaches the feed.
 */
export async function confirmRecognition(
  db: Firestore,
  recognitionId: string,
  actingUid: string,
  now: number = Date.now(),
): Promise<ConfirmResult> {
  const recRef = db.collection('recognitions').doc(recognitionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(recRef);
    if (!snap.exists) return { ok: false, reason: 'not_found' } as const;
    const rec = snap.data()!;
    if (rec.helpedUid !== actingUid) return { ok: false, reason: 'not_helped_peer' } as const;
    if (rec.helperUid === actingUid) return { ok: false, reason: 'self_award' } as const;
    if (rec.status === 'declined') return { ok: false, reason: 'declined' } as const;
    // Idempotent: already confirmed → report success without re-awarding.
    if (rec.status === 'confirmed') {
      return { ok: true, awarded: 0, alreadyDone: true, capped: rec.capped === true } as const;
    }

    // Reads before writes: the pair's award history for this direction of credit.
    const pairRef = db.collection('recognitionPairs').doc(pairKey(rec.helperUid, rec.helpedUid));
    const pairSnap = await tx.get(pairRef);
    const history: number[] = Array.isArray(pairSnap.data()?.awardedAt) ? pairSnap.data()!.awardedAt : [];
    const recent = awardsInWindow(history, now);
    const capped = pairCapReached(history, now);

    // The author of the source message wrote the thanks. If they are also the one confirming it,
    // closing the loop is not a second act by a second person, so it pays nothing.
    const authorUid: string = rec.authorUid ?? rec.helpedUid;
    const thanks = authorUid === actingUid ? 0 : CONFIRM_THANKS;

    const points: number = capped ? 0 : (rec.points ?? pointsFor(rec.kind));

    // `confirmedAt` is the funnel instrumentation, and it is the whole reason Rally
    // can have a kill criterion at all. Until 2026-08-02 confirm flipped `status` in
    // place with no timestamp, so the suggested-to-confirmed transition left no trace
    // in time: you could count how many recognitions are confirmed RIGHT NOW, and you
    // could not ask what share of last month's suggestions ever got confirmed, or how
    // long people took. A snapshot ratio cannot answer either, because it mixes
    // suggestions from every week together and drifts as volume changes.
    //
    // One server timestamp turns that into a cohort measurement. See
    // `lib/kill-criteria.ts` and docs/DECISION_LOG.md §Kill criteria.
    tx.update(recRef, { status: 'confirmed', capped, confirmedAt: FieldValue.serverTimestamp() });

    // Ledger entries — deterministic ids keyed to the recognition so even a rules-bypassing
    // re-run can't create a second award for the same recognition.
    tx.set(db.collection('xpEvents').doc(`xp_help_${recognitionId}`), {
      profileUid: rec.helperUid,
      source: 'recognition',
      refId: recognitionId,
      points,
      capped,
      createdAt: FieldValue.serverTimestamp(),
    });
    // No points, no row: a zero-XP ledger entry would only pad the scan the leaderboard runs.
    if (thanks > 0) {
      tx.set(db.collection('xpEvents').doc(`xp_thanks_${recognitionId}`), {
        profileUid: rec.helpedUid,
        source: 'recognition_confirmed',
        refId: recognitionId,
        points: thanks,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.set(db.collection('pulseEvents').doc(`pulse_rec_${recognitionId}`), {
      actorUid: rec.helperUid,
      verb: 'recognition_confirmed',
      object: rec.helpedUid,
      points,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Only a point-bearing award consumes the allowance, so a capped confirm can never push the
    // window further out and starve a pair who go quiet and come back.
    if (!capped) {
      tx.set(
        pairRef,
        {
          helperUid: rec.helperUid,
          helpedUid: rec.helpedUid,
          awardedAt: [...recent, now],
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    return { ok: true, awarded: points, alreadyDone: false, capped } as const;
  });
}

/** Decline a recognition (helped peer only). No points, no pulse — quietly closes it. */
export async function declineRecognition(
  db: Firestore,
  recognitionId: string,
  actingUid: string,
): Promise<ConfirmResult> {
  const recRef = db.collection('recognitions').doc(recognitionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(recRef);
    if (!snap.exists) return { ok: false, reason: 'not_found' } as const;
    const rec = snap.data()!;
    if (rec.helpedUid !== actingUid) return { ok: false, reason: 'not_helped_peer' } as const;
    if (rec.status === 'confirmed') {
      return { ok: true, awarded: 0, alreadyDone: true, capped: rec.capped === true } as const;
    }
    tx.update(recRef, { status: 'declined' });
    return { ok: true, awarded: 0, alreadyDone: false, capped: false } as const;
  });
}

/** FNV-1a → 8 hex chars. A stable dedupe suffix from a message ref; not security-sensitive. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
