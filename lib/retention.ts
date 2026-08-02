import { Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';

/**
 * Data retention and member erasure (finding SH9).
 *
 * Rally stores messages, recognitions, an XP ledger and, since DL-6, a per-pair award history,
 * all of it tied to named people in a small team. Before this module there was no retention window
 * written anywhere and no way for a member to get their data out of the product. Both of those are
 * fixed here, and the important half is that the windows below are ENFORCED by `sweepRetention`,
 * not merely documented: a policy nothing runs is a sentence, not a control.
 *
 * Two separate mechanisms, deliberately:
 *
 *  - `sweepRetention` is the CLOCK. It ages data out on a schedule regardless of who anyone is.
 *  - `eraseMember` is the PERSON. It removes one member's data on request, immediately.
 *
 * They are not the same job and neither substitutes for the other: a retention window does not
 * answer "delete me", and an erasure does not stop the corpus growing forever.
 *
 * ## What erasure cannot reach, stated plainly
 *
 * `eraseMember` returns a `limits` list saying this out loud on every run, because a deletion path
 * that quietly under-delivers is worse than none:
 *
 *  1. **Other people's words.** If Ana wrote "thanks @bob, you unblocked me", that sentence is
 *     Ana's message. Erasing Bob does not rewrite it. Rally will not edit one member's speech to
 *     satisfy another member's request, and pretending otherwise by find-and-replacing handles
 *     inside message bodies would corrupt the record while still leaving the meaning intact.
 *  2. **The XP ledger.** `xpEvents` is append-only on purpose: every rank in Rally is recomputed
 *     from it, and mutable totals are exactly the thing the anti-gaming design refuses to have.
 *     Erasure therefore does not delete those rows; it RE-KEYS them to a fresh random tombstone id
 *     (`erased_<random>`) that is generated at erasure time and stored nowhere else. The arithmetic
 *     survives, the person does not. The same is done for `pulseEvents`. This is the one place
 *     where Rally chose the integrity of the ledger over complete removal, and it is a choice, not
 *     an oversight. Note what it costs: the leaderboard keeps a participant nobody can name.
 *  3. **Anything outside Firestore.** Firebase's own backups and point-in-time recovery, Vercel
 *     request logs, the GitHub issues `lib/pm-adapter.ts` creates, and the cross-app context bus if
 *     a real `SHARED_FIREBASE_SERVICE_ACCOUNT` is configured. Rally can delete its own documents;
 *     it has no authority over those stores and this module does not pretend to.
 *
 * None of this has been reviewed by a lawyer or a data protection officer (see docs/STAKEHOLDERS.md).
 * It is an engineering control, and it should not be cited as a compliance claim.
 */

/** A retention rule. `days: null` means "kept for the life of the deployment", with a reason. */
export type RetentionRule = {
  /** Human label used in reports and docs. */
  name: string;
  /** The timestamp field the age is measured from. */
  field: string;
  /** Window in days, or null for indefinite retention. */
  days: number | null;
  /** Why this number. Every window is a judgment; an undefended one drifts. */
  why: string;
};

/**
 * The windows. Chosen, not measured, exactly like the DL-6 constants: Rally has no data on how far
 * back anyone actually scrolls, so each one is set where the product stops needing the data rather
 * than tuned. They are exported so a reviewer can argue with the numbers instead of the prose.
 */
export const RETENTION: Record<string, RetentionRule> = {
  messages: {
    name: 'channel messages',
    field: 'createdAt',
    days: 400,
    why: 'A shade over a year, so an annual "what did we ship" look-back still works and the corpus stops growing without bound. Message bodies are the highest-sensitivity content Rally holds: they are free text about real colleagues.',
  },
  pulseEvents: {
    name: 'pulse feed events',
    field: 'createdAt',
    days: 180,
    why: 'The feed is ambient and only the last 50 are ever read (lib/data.ts subscribes with limit(50)). Six months is already far past the point anything is looked at.',
  },
  recognitionsUnresolved: {
    name: 'recognitions still suggested or declined',
    field: 'createdAt',
    days: 30,
    why: 'A suggestion nobody confirmed in a month will not be confirmed. Keeping it is an open invitation to award points for a conversation everyone has forgotten, which is a small but real gaming surface.',
  },
  recognitionPairs: {
    name: 'per-pair award history (DL-6)',
    field: 'updatedAt',
    days: 7,
    why: 'The cap it enforces is a rolling 24 hours (PAIR_WINDOW_MS). A week is a generous margin for clock skew and a paused sweep; beyond that the row can only be a record of who thanked whom, which is not what it exists for.',
  },
  assistantMessages: {
    name: 'assistant thread messages',
    field: 'createdAt',
    days: 90,
    why: 'Assistant threads are private, unstructured, and the most likely place for someone to type something personal. Only 60 are ever rendered. A quarter is long enough to keep context useful and short enough to bound the exposure.',
  },
  assistantMemory: {
    name: 'assistant memory',
    field: 'updatedAt',
    days: 180,
    why: 'Memory is a derived summary of the threads above, so it must not outlive them by much. Twice the thread window, because it is what makes the assistant feel continuous.',
  },
  commitments: {
    name: 'commitments',
    field: 'createdAt',
    days: 400,
    why: 'Matched to messages: a commitment is a claim about work and reads as part of the same record.',
  },
  xpEvents: {
    name: 'XP ledger',
    field: 'createdAt',
    days: null,
    why: 'INDEFINITE, deliberately. Every rank and every team total is recomputed from this ledger, so ageing rows out would silently rewrite history and re-open the "stored mutable total" hole the whole design avoids. The privacy cost is paid by erasure instead: eraseMember re-keys these rows to an unlinkable tombstone rather than deleting them.',
  },
  profiles: {
    name: 'member profiles',
    field: 'createdAt',
    days: null,
    why: 'INDEFINITE while the member is in the cohort. A profile is the identity every other document points at; expiring it on a clock would orphan live data. It is removed by erasure, which is the correct trigger.',
  },
};

/** The instant a rule starts deleting from. Null when the rule retains indefinitely. */
export function cutoffMs(rule: RetentionRule, nowMs: number): number | null {
  return rule.days === null ? null : nowMs - rule.days * 24 * 60 * 60 * 1000;
}

/** Whether a document of this age is past its window. Indefinite rules never expire anything. */
export function isExpired(rule: RetentionRule, createdAtMs: number | null, nowMs: number): boolean {
  const cutoff = cutoffMs(rule, nowMs);
  if (cutoff === null || createdAtMs === null) return false;
  return createdAtMs < cutoff;
}

export type SweepReport = {
  /** Documents deleted, per rule key. */
  deleted: Record<string, number>;
  total: number;
  /** True when the per-run budget was hit, so the next run still has work. */
  truncated: boolean;
  atMs: number;
};

/**
 * A single run deletes at most this many documents. The sweep is meant to be run repeatedly (a
 * daily cron), so a bounded run that finishes beats an unbounded one that a serverless timeout
 * kills halfway through with no record of where it stopped.
 */
export const SWEEP_BUDGET = 2_000;

const BATCH = 400;

/** Delete up to `budget` docs from a query, in batches. Returns how many went. */
async function deleteQuery(db: Firestore, q: Query, budget: number): Promise<number> {
  let gone = 0;
  while (gone < budget) {
    const snap = await q.limit(Math.min(BATCH, budget - gone)).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    gone += snap.size;
    if (snap.size < BATCH) break;
  }
  return gone;
}

/**
 * Enforce every window in RETENTION. Server-side only (the collections it touches are
 * client-unwritable by firestore.rules, which is why a trusted path has to do this).
 *
 * `now` is injected so the whole policy is testable against the emulator without waiting 400 days.
 */
export async function sweepRetention(
  db: Firestore,
  nowMs: number = Date.now(),
  budget: number = SWEEP_BUDGET,
): Promise<SweepReport> {
  const deleted: Record<string, number> = {};
  let remaining = budget;

  const spend = async (key: string, run: (left: number) => Promise<number>): Promise<void> => {
    if (remaining <= 0) return;
    const n = await run(remaining);
    deleted[key] = (deleted[key] ?? 0) + n;
    remaining -= n;
  };

  const at = (key: keyof typeof RETENTION): Timestamp | null => {
    const c = cutoffMs(RETENTION[key], nowMs);
    return c === null ? null : Timestamp.fromMillis(c);
  };

  // Channel messages live in a subcollection per channel. Rally runs a handful of channels, so
  // iterating them is cheaper and index-free compared with a collection-group query.
  const msgCutoff = at('messages');
  if (msgCutoff) {
    const channels = await db.collection('channels').get();
    for (const ch of channels.docs) {
      await spend('messages', (left) =>
        deleteQuery(db, ch.ref.collection('messages').where('createdAt', '<', msgCutoff), left),
      );
    }
  }

  const pulseCutoff = at('pulseEvents');
  if (pulseCutoff) {
    await spend('pulseEvents', (left) =>
      deleteQuery(db, db.collection('pulseEvents').where('createdAt', '<', pulseCutoff), left),
    );
  }

  const commitCutoff = at('commitments');
  if (commitCutoff) {
    await spend('commitments', (left) =>
      deleteQuery(db, db.collection('commitments').where('createdAt', '<', commitCutoff), left),
    );
  }

  // Only recognitions that never resolved. A CONFIRMED recognition is the provenance of a ledger
  // row and is kept for as long as the ledger is: deleting it would leave XP with no explanation,
  // which is the audit trail the anti-gaming story depends on.
  const recCutoff = at('recognitionsUnresolved');
  if (recCutoff) {
    for (const status of ['suggested', 'declined']) {
      await spend('recognitionsUnresolved', (left) =>
        deleteQuery(
          db,
          db.collection('recognitions').where('status', '==', status).where('createdAt', '<', recCutoff),
          left,
        ),
      );
    }
  }

  const pairCutoff = at('recognitionPairs');
  if (pairCutoff) {
    await spend('recognitionPairs', (left) =>
      deleteQuery(db, db.collection('recognitionPairs').where('updatedAt', '<', pairCutoff), left),
    );
  }

  const memCutoff = at('assistantMemory');
  if (memCutoff) {
    await spend('assistantMemory', (left) =>
      deleteQuery(db, db.collection('assistantMemory').where('updatedAt', '<', memCutoff), left),
    );
  }

  const threadCutoff = at('assistantMessages');
  if (threadCutoff) {
    const threads = await db.collection('assistantThreads').listDocuments();
    for (const t of threads) {
      await spend('assistantMessages', (left) =>
        deleteQuery(db, t.collection('messages').where('createdAt', '<', threadCutoff), left),
      );
    }
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  return { deleted, total, truncated: remaining <= 0, atMs: nowMs };
}

export type EraseReport = {
  uid: string;
  /** Documents deleted outright, per collection. */
  deleted: Record<string, number>;
  /** Documents kept but re-keyed to the tombstone, per collection. */
  rekeyed: Record<string, number>;
  /** The unlinkable id the ledger rows now carry. Returned once and stored nowhere. */
  tombstone: string;
  /** What this erasure did NOT reach. Returned on every run, on purpose. */
  limits: string[];
  atMs: number;
};

/**
 * The tombstone the ledger is re-keyed to. Random, generated per erasure, and never written to any
 * lookup table: nothing in Rally can map it back to the uid it replaced. A hash of the uid was
 * rejected because a hash of a known-small set of uids is trivially reversible by enumeration,
 * which would be pseudonymisation dressed up as anonymisation.
 */
function newTombstone(): string {
  return `erased_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** The honest limits, returned with every erasure so they cannot be lost between here and a doc. */
export const ERASURE_LIMITS: string[] = [
  "Message bodies written by OTHER members are not edited, so an @handle or a description of this person inside someone else's sentence remains. Rally does not rewrite one member's words to satisfy another's request.",
  'xpEvents and pulseEvents rows are kept and re-keyed to a random tombstone rather than deleted, because every rank is recomputed from the append-only ledger and removing rows would rewrite team history. The rows survive; the link to the person does not.',
  'Firebase backups and point-in-time recovery, Vercel request logs, GitHub issues created by lib/pm-adapter.ts, and the cross-app context bus are outside this codebase and are not touched.',
  'Anything already exported, screenshotted or read by another member is beyond reach by definition.',
];

/**
 * Erase one member. Deletes their identity and their own content, strips their reactions from
 * other people's messages, and re-keys the append-only ledger to an unlinkable tombstone.
 *
 * Idempotent: running it twice is safe, and the second run simply finds nothing. It does NOT delete
 * the Firebase Auth user; that is a separate credential store and the caller decides, because a
 * deleted auth user with live Firestore data would be worse than either alone.
 */
export async function eraseMember(db: Firestore, uid: string): Promise<EraseReport> {
  const deleted: Record<string, number> = {};
  const rekeyed: Record<string, number> = {};
  const tombstone = newTombstone();
  const bump = (rec: Record<string, number>, k: string, n: number) => {
    if (n > 0) rec[k] = (rec[k] ?? 0) + n;
  };

  // 1. Their own channel content, their reads, and their reactions on other people's messages.
  const channels = await db.collection('channels').get();
  for (const ch of channels.docs) {
    bump(deleted, 'messages', await deleteQuery(db, ch.ref.collection('messages').where('authorUid', '==', uid), 50_000));

    const readRef = ch.ref.collection('reads').doc(uid);
    if ((await readRef.get()).exists) {
      await readRef.delete();
      bump(deleted, 'reads', 1);
    }

    // A reaction is this person's data sitting on someone else's message: one uid key in a map.
    // Removing the key leaves the other member's message untouched, which is the correct split.
    // Scanned rather than queried: `reactions.<uid>` would need a per-uid index, and a per-member
    // erasure is a rare, bounded, background job where a scan at cohort scale is the cheaper trade.
    const msgs = await ch.ref.collection('messages').get();
    let reactionBatch = db.batch();
    let pending = 0;
    for (const m of msgs.docs) {
      const reactions = m.data().reactions as Record<string, unknown> | undefined;
      if (!reactions || !(uid in reactions)) continue;
      const next = { ...reactions };
      delete next[uid];
      reactionBatch.update(m.ref, { reactions: next });
      bump(deleted, 'reactions', 1);
      if (++pending >= BATCH) {
        await reactionBatch.commit();
        reactionBatch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) await reactionBatch.commit();
  }

  // 2. Their own top-level documents.
  bump(deleted, 'commitments', await deleteQuery(db, db.collection('commitments').where('authorUid', '==', uid), 10_000));
  bump(deleted, 'quests', await deleteQuery(db, db.collection('quests').where('profileUid', '==', uid), 10_000));

  // 3. The assistant, which is the most personal store Rally has.
  bump(
    deleted,
    'assistantMessages',
    await deleteQuery(db, db.collection('assistantThreads').doc(uid).collection('messages'), 10_000),
  );
  for (const ref of [db.collection('assistantThreads').doc(uid), db.collection('assistantMemory').doc(uid)]) {
    if ((await ref.get()).exists) {
      await ref.delete();
      bump(deleted, ref.parent.id, 1);
    }
  }

  // 4. Recognitions and the DL-6 pair history, from every side they can name this person.
  for (const field of ['helperUid', 'helpedUid', 'authorUid']) {
    bump(deleted, 'recognitions', await deleteQuery(db, db.collection('recognitions').where(field, '==', uid), 10_000));
  }
  for (const field of ['helperUid', 'helpedUid']) {
    bump(
      deleted,
      'recognitionPairs',
      await deleteQuery(db, db.collection('recognitionPairs').where(field, '==', uid), 10_000),
    );
  }

  // 5. The append-only ledger: re-keyed, never deleted. See the module comment for why.
  bump(rekeyed, 'xpEvents', await rekey(db, db.collection('xpEvents').where('profileUid', '==', uid), 'profileUid', tombstone));
  bump(rekeyed, 'pulseEvents', await rekey(db, db.collection('pulseEvents').where('actorUid', '==', uid), 'actorUid', tombstone));
  bump(rekeyed, 'pulseEvents', await rekey(db, db.collection('pulseEvents').where('object', '==', uid), 'object', tombstone));

  // 6. Identity last, so a crash mid-erasure leaves a findable member rather than orphaned rows.
  const profileRef = db.collection('profiles').doc(uid);
  if ((await profileRef.get()).exists) {
    await profileRef.delete();
    bump(deleted, 'profiles', 1);
  }

  return { uid, deleted, rekeyed, tombstone, limits: ERASURE_LIMITS, atMs: Date.now() };
}

/** Rewrite one uid-bearing field to the tombstone, in batches. */
async function rekey(db: Firestore, q: Query, field: string, tombstone: string): Promise<number> {
  const snap = await q.get();
  let done = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH) {
    const chunk = snap.docs.slice(i, i + BATCH);
    const batch = db.batch();
    for (const d of chunk) batch.update(d.ref, { [field]: tombstone, erased: true });
    await batch.commit();
    done += chunk.length;
  }
  return done;
}

/** True when this uid is a tombstone rather than a member. Used by anything that renders a name. */
export function isTombstone(uid: string): boolean {
  return uid.startsWith('erased_');
}

/** The documented policy, as data, so docs and code cannot drift apart. */
export function retentionSummary(): { rule: string; window: string; why: string }[] {
  return Object.values(RETENTION).map((r) => ({
    rule: r.name,
    window: r.days === null ? 'indefinite' : `${r.days} days`,
    why: r.why,
  }));
}
