/**
 * Shared-context bus adapter against a real Firestore (the emulator via busDb()'s fallback).
 * Proves memory + activity are handle-keyed and cross-app readable, and that the agent-to-agent
 * task lifecycle (dispatch → claim → complete) is transactional and idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busDb } from '@/lib/admin';
import {
  claimTasks,
  completeTask,
  dispatchTask,
  forgetShared,
  logSharedActivity,
  readSharedActivity,
  readSharedMemory,
  rememberShared,
} from '@/lib/shared-context';
import { clearFirestore } from './helpers';
import type { Firestore } from 'firebase-admin/firestore';

let db: Firestore;

beforeEach(async () => {
  const got = busDb();
  if (!got) throw new Error('bus db unavailable');
  db = got;
  await clearFirestore();
});
afterEach(async () => {
  await clearFirestore();
});

describe('shared memory + activity — keyed by GitHub handle, readable by any app', () => {
  it('remembers a note under the handle (case-insensitive) and reads it back', async () => {
    expect(await rememberShared(db, 'NikJain15', 'is shipping the assistant', 1000)).toBe(true);
    const notes = await readSharedMemory(db, 'nikjain15');
    expect(notes.map((n) => n.text)).toContain('is shipping the assistant');
    expect(notes[0].app).toBe('rally'); // provenance is recorded so another app knows who wrote it
  });

  it('refuses to write for a caller with no handle (can\'t join the shared layer)', async () => {
    expect(await rememberShared(db, '', 'nope', 1)).toBe(false);
    expect(await readSharedMemory(db, '')).toEqual([]);
  });

  it('logs shared activity as the common history', async () => {
    await logSharedActivity(db, 'nikjain15', 'recognition', 'thanked a teammate', 1);
    const acts = await readSharedActivity(db, 'nikjain15');
    expect(acts[0]).toMatchObject({ app: 'rally', kind: 'recognition', summary: 'thanked a teammate' });
  });

  it('forgetShared erases a person\'s memory + history (right to be forgotten), only theirs', async () => {
    await rememberShared(db, 'nikjain15', 'a note', 1);
    await logSharedActivity(db, 'nikjain15', 'assistant', 'asked something', 2);
    await rememberShared(db, 'someoneelse', 'their note', 3);

    const removed = await forgetShared(db, 'nikjain15');
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await readSharedMemory(db, 'nikjain15')).toEqual([]);
    expect(await readSharedActivity(db, 'nikjain15')).toEqual([]);
    // Another person's record is untouched.
    expect((await readSharedMemory(db, 'someoneelse')).map((n) => n.text)).toEqual(['their note']);
  });
});

describe('agent-to-agent dispatch', () => {
  it('dispatches, claims once, and completes — the cross-app hand-off', async () => {
    const id = await dispatchTask(db, { toApp: 'rally', handle: 'nikjain15', intent: 'catch_up' }, 1000);
    expect(id).toBeTruthy();

    const first = await claimTasks(db, 'rally');
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('claimed');

    // A second claim finds nothing — a task is never worked twice.
    expect(await claimTasks(db, 'rally')).toHaveLength(0);

    await completeTask(db, id!, true, 'done: 2 things need you');
    const snap = await db.collection('agentTasks').doc(id!).get();
    expect(snap.data()?.status).toBe('done');
    expect(snap.data()?.result).toContain('2 things');
  });

  it('a task addressed to another app is not claimed by this one', async () => {
    await dispatchTask(db, { toApp: 'pulse', handle: 'nikjain15', intent: 'summarize_week' }, 1000);
    expect(await claimTasks(db, 'rally')).toHaveLength(0);
  });
});
