/**
 * firestore.rules — Rally's product promises, asserted.
 *
 * Read the test names, not the code: each states a promise Rally makes. If one goes red,
 * the product is lying. The two load-bearing groups are membership isolation (a channel you
 * are not in must be unreadable) and anti-gaming (a client can never mint XP or inflate a
 * points-bearing count).
 */
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import {
  ALICE,
  BOB,
  CAROL,
  as,
  channel,
  commitment,
  makeEnv,
  message,
  recognition,
  seed,
  xpEvent,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
});

/* ==========================================================================
 * membership isolation — a private room is private
 * ========================================================================== */
describe('channels — read only if you are a member', () => {
  it('lets a member read the channel they belong to', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await assertSucceeds(getDoc(doc(as(env, ALICE), 'channels/c1')));
  });

  it('denies a non-member reading a PRIVATE channel doc', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB], { isPrivate: true }));
    await assertFails(getDoc(doc(as(env, CAROL), 'channels/c1')));
  });

  it('lets any member read a PUBLIC channel doc (discover + join), but not its messages', async () => {
    await seed(env, 'channels/general', channel(ALICE, [ALICE], { isPrivate: false }));
    await seed(env, 'channels/general/messages/m1', message(ALICE));
    await assertSucceeds(getDoc(doc(as(env, CAROL), 'channels/general')));
    // …the doc is discoverable, but the conversation is members-only.
    await assertFails(getDoc(doc(as(env, CAROL), 'channels/general/messages/m1')));
  });

  it('lets a member read messages in their channel', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await seed(env, 'channels/c1/messages/m1', message(ALICE));
    await assertSucceeds(getDoc(doc(as(env, BOB), 'channels/c1/messages/m1')));
  });

  it('denies a non-member reading messages in a channel they are not in', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await seed(env, 'channels/c1/messages/m1', message(ALICE));
    await assertFails(getDoc(doc(as(env, CAROL), 'channels/c1/messages/m1')));
  });

  it('denies creating a channel that reads someone else in without yourself', async () => {
    await assertFails(
      setDoc(doc(as(env, ALICE), 'channels/c9'), channel(ALICE, [BOB, CAROL])),
    );
  });

  it('denies creating a channel whose creatorUid is not you', async () => {
    await assertFails(
      setDoc(doc(as(env, ALICE), 'channels/c9'), channel(BOB, [ALICE, BOB])),
    );
  });

  it('lets a non-member self-join a PUBLIC channel', async () => {
    await seed(env, 'channels/general', channel(ALICE, [ALICE], { isPrivate: false }));
    await assertSucceeds(
      updateDoc(doc(as(env, BOB), 'channels/general'), { memberUids: [ALICE, BOB] }),
    );
  });

  it('denies joining yourself into a PRIVATE channel', async () => {
    await seed(env, 'channels/secret', channel(ALICE, [ALICE], { isPrivate: true }));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/secret'), { memberUids: [ALICE, BOB] }),
    );
  });

  it('denies adding SOMEONE ELSE while joining a public channel', async () => {
    await seed(env, 'channels/general', channel(ALICE, [ALICE], { isPrivate: false }));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/general'), { memberUids: [ALICE, BOB, CAROL] }),
    );
  });

  it('denies renaming a public channel you are not a member of (join branch is memberUids-only)', async () => {
    await seed(env, 'channels/general', channel(ALICE, [ALICE], { isPrivate: false }));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/general'), { memberUids: [ALICE, BOB], name: 'Hijacked' }),
    );
  });

  it('denies inflating membership with duplicate uids (count = array length)', async () => {
    await seed(env, 'channels/general', channel(ALICE, [ALICE], { isPrivate: false }));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/general'), { memberUids: [ALICE, BOB, BOB, BOB] }),
    );
  });
});

describe('DMs — a private room for exactly two', () => {
  const dmId = 'dm_uid_alice_uid_bob';
  const seedDm = () =>
    seed(env, `channels/${dmId}`, channel(ALICE, [ALICE, BOB], { kind: 'dm', isPrivate: true, slug: dmId }));

  it('lets either participant read the DM', async () => {
    await seedDm();
    await assertSucceeds(getDoc(doc(as(env, ALICE), `channels/${dmId}`)));
    await assertSucceeds(getDoc(doc(as(env, BOB), `channels/${dmId}`)));
  });

  it('denies a third party reading the DM or its messages', async () => {
    await seedDm();
    await seed(env, `channels/${dmId}/messages/m1`, message(ALICE));
    await assertFails(getDoc(doc(as(env, CAROL), `channels/${dmId}`)));
    await assertFails(getDoc(doc(as(env, CAROL), `channels/${dmId}/messages/m1`)));
  });

  it('denies a third party self-joining a DM (private, not joinable)', async () => {
    await seedDm();
    await assertFails(
      updateDoc(doc(as(env, CAROL), `channels/${dmId}`), { memberUids: [ALICE, BOB, CAROL] }),
    );
  });

  it('lets a participant post, and a non-participant cannot', async () => {
    await seedDm();
    await assertSucceeds(addDoc(collection(as(env, BOB), `channels/${dmId}/messages`), message(BOB)));
    await assertFails(addDoc(collection(as(env, CAROL), `channels/${dmId}/messages`), message(CAROL)));
  });
});

/* ==========================================================================
 * authorship — you speak only as yourself, only where you belong
 * ========================================================================== */
describe('messages — posted as yourself, into a channel you are in', () => {
  it('lets a member post as themselves', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await assertSucceeds(
      addDoc(collection(as(env, BOB), 'channels/c1/messages'), message(BOB)),
    );
  });

  it('denies posting as someone else (impersonation)', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await assertFails(
      addDoc(collection(as(env, BOB), 'channels/c1/messages'), message(ALICE)),
    );
  });

  it('denies posting into a channel you are not a member of', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await assertFails(
      addDoc(collection(as(env, CAROL), 'channels/c1/messages'), message(CAROL)),
    );
  });

  it('denies an empty message body', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await assertFails(
      addDoc(collection(as(env, BOB), 'channels/c1/messages'), message(BOB, { body: '' })),
    );
  });

  it('denies an over-long message body (read-cost / abuse guard)', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await assertFails(
      addDoc(collection(as(env, BOB), 'channels/c1/messages'), message(BOB, { body: 'x'.repeat(4001) })),
    );
  });

  it('denies rewriting the author of an existing message', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await seed(env, 'channels/c1/messages/m1', message(BOB));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/c1/messages/m1'), { authorUid: ALICE }),
    );
  });

  it('lets an author edit their own message body', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await seed(env, 'channels/c1/messages/m1', message(BOB));
    await assertSucceeds(
      updateDoc(doc(as(env, BOB), 'channels/c1/messages/m1'), { body: 'edited', editedAt: new Date() }),
    );
  });
});

describe('reactions — one per person, self-scoped, uninflatable', () => {
  const setup = () =>
    Promise.all([
      seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB])),
      seed(env, 'channels/c1/messages/m1', message(ALICE, { reactions: {} })),
    ]);

  it('lets a member add their OWN reaction', async () => {
    await setup();
    await assertSucceeds(
      updateDoc(doc(as(env, BOB), 'channels/c1/messages/m1'), { 'reactions.uid_bob': '👍' }),
    );
  });

  it('denies reacting AS someone else (writing a different uid key)', async () => {
    await setup();
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/c1/messages/m1'), { 'reactions.uid_alice': '👍' }),
    );
  });

  it('denies clearing someone else\'s reaction', async () => {
    await seed(env, 'channels/c1', channel(ALICE, [ALICE, BOB]));
    await seed(env, 'channels/c1/messages/m1', message(ALICE, { reactions: { uid_alice: '🎉' } }));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/c1/messages/m1'), { 'reactions.uid_alice': '💀' }),
    );
  });

  it('denies smuggling a body edit in with your reaction', async () => {
    await setup();
    await assertFails(
      updateDoc(doc(as(env, BOB), 'channels/c1/messages/m1'), { 'reactions.uid_bob': '👍', body: 'hijacked' }),
    );
  });

  it('denies a NON-member reacting', async () => {
    await setup();
    await assertFails(
      updateDoc(doc(as(env, CAROL), 'channels/c1/messages/m1'), { 'reactions.uid_carol': '👍' }),
    );
  });
});

/* ==========================================================================
 * anti-gaming — XP cannot be minted or inflated by a client. LOAD-BEARING.
 * ========================================================================== */
describe('xpEvents — the append-only ledger is server-only', () => {
  it('denies a client creating an xpEvent (minting XP)', async () => {
    await assertFails(setDoc(doc(as(env, ALICE), 'xpEvents/e1'), xpEvent(ALICE)));
  });

  it('denies a client creating an xpEvent even for someone else', async () => {
    await assertFails(setDoc(doc(as(env, ALICE), 'xpEvents/e1'), xpEvent(BOB, { points: 9999 })));
  });

  it('lets any signed-in member READ the ledger (rank is computed from it)', async () => {
    await seed(env, 'xpEvents/e1', xpEvent(ALICE));
    await assertSucceeds(getDoc(doc(as(env, BOB), 'xpEvents/e1')));
  });

  it('denies editing or deleting a ledger row', async () => {
    await seed(env, 'xpEvents/e1', xpEvent(ALICE));
    await assertFails(updateDoc(doc(as(env, ALICE), 'xpEvents/e1'), { points: 9999 }));
    await assertFails(deleteDoc(doc(as(env, ALICE), 'xpEvents/e1')));
  });
});

describe('recognitions — points only on the helped peer\'s confirm', () => {
  it('denies a client creating a recognition (server suggests them)', async () => {
    await assertFails(setDoc(doc(as(env, ALICE), 'recognitions/r1'), recognition(ALICE, BOB)));
  });

  it('denies the HELPED peer confirming directly via the SDK (confirm is server-only)', async () => {
    // Confirm must go through the auth-gated route so status + the XP ledger write happen in
    // ONE transaction. A direct client flip would be "confirmed but unawarded".
    await seed(env, 'recognitions/r1', recognition(ALICE, BOB));
    await assertFails(
      updateDoc(doc(as(env, BOB), 'recognitions/r1'), { status: 'confirmed' }),
    );
  });

  it('denies the HELPER confirming their own recognition directly', async () => {
    await seed(env, 'recognitions/r1', recognition(ALICE, BOB));
    await assertFails(
      updateDoc(doc(as(env, ALICE), 'recognitions/r1'), { status: 'confirmed' }),
    );
  });

  it('denies a bystander touching a recognition', async () => {
    await seed(env, 'recognitions/r1', recognition(ALICE, BOB));
    await assertFails(
      updateDoc(doc(as(env, CAROL), 'recognitions/r1'), { status: 'confirmed' }),
    );
  });

  it('denies deleting a recognition', async () => {
    await seed(env, 'recognitions/r1', recognition(ALICE, BOB));
    await assertFails(deleteDoc(doc(as(env, BOB), 'recognitions/r1')));
  });
});

describe('commitments — you own your promise, the server owns its completion', () => {
  it('lets a member create their own commitment', async () => {
    await assertSucceeds(setDoc(doc(as(env, ALICE), 'commitments/k1'), commitment(ALICE)));
  });

  it('denies creating a commitment attributed to someone else', async () => {
    await assertFails(setDoc(doc(as(env, ALICE), 'commitments/k1'), commitment(BOB)));
  });

  it('denies a client writing pmTaskUrl or points onto their commitment', async () => {
    await seed(env, 'commitments/k1', commitment(ALICE));
    await assertFails(
      updateDoc(doc(as(env, ALICE), 'commitments/k1'), { pmTaskUrl: 'https://x', points: 50 }),
    );
  });
});
