import { NextResponse } from 'next/server';
import { adminDb, busDb } from '@/lib/admin';
import { verifyUid } from '@/lib/auth-server';
import { hasModel } from '@/lib/agent';
import { getHandle } from '@/lib/assistant-admin';
import { claimTasks, completeTask } from '@/lib/shared-context';
import { runAssistant } from '@/lib/assistant-run';

export const runtime = 'nodejs';

/**
 * Rally's inbox for cross-app requests: claims tasks another app addressed to "rally" for THIS
 * user, runs each through Rally's own assistant (so the result lands in the user's Rally
 * conversation), and reports the outcome back on the bus. The panel polls this so an incoming
 * request from Pulse's agent shows up in Rally automatically. Safe to call with nothing pending.
 */
export async function POST(req: Request) {
  const uid = await verifyUid(req);
  if (!uid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = adminDb();
  if (!db) return NextResponse.json({ error: 'ledger_unavailable' }, { status: 503 });

  const handle = await getHandle(db, uid);
  if (!handle) return NextResponse.json({ handled: 0 });

  const bus = busDb();
  if (!bus) return NextResponse.json({ handled: 0 });

  const tasks = await claimTasks(bus, 'rally', handle, 3);
  if (!tasks.length) return NextResponse.json({ handled: 0 });

  let handled = 0;
  for (const t of tasks) {
    if (!hasModel()) {
      await completeTask(bus, t.id!, false, 'Rally is unavailable right now.');
      continue;
    }
    const prompt = `A request came in from the ${t.fromApp} app: "${t.intent}". Handle it for the user.`;
    const res = await runAssistant(db, uid, prompt, Date.now());
    await completeTask(bus, t.id!, res.available, (res.reply ?? 'done').slice(0, 500));
    if (res.available) handled += 1;
  }
  return NextResponse.json({ handled });
}
